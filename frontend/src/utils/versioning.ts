import { type Transaction } from 'dexie'
import { db, createId } from '@/utils/db'
import { round } from '@/utils/ratio'
import type { Formula } from '@/types/formula'
import type { Material } from '@/types/material'
import type { Proportion, ProportionRole } from '@/types/proportion'
import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Cellar, CellarContainer, CellarState } from '@/types/cellar'
import type {
  BatchVersionTrail,
  ConflictDraft,
  FormulaVersion,
  ProportionDraftPayload,
  SnapshotCheck,
  SnapshotDiffItem,
  SnapshotState,
  VersionReason
} from '@/types/version'

/** 版本链服务：香方 / 配比 / 批次 / 窖藏共用同一套版本号与快照规则 */

/** 并发冲突：后保存者的内容已落为草稿 */
export class RevisionConflictError extends Error {
  baseRev: number
  latestRev: number
  draftId: string
  constructor(baseRev: number, latestRev: number, draftId: string) {
    super('香方已被他人修改，您的修改已存为草稿')
    this.name = 'RevisionConflictError'
    this.baseRev = baseRev
    this.latestRev = latestRev
    this.draftId = draftId
  }
}

/** 入窖被拒：批次处于待复核状态 */
export class PendingReviewError extends Error {
  diffs: SnapshotDiffItem[]
  constructor(diffs: SnapshotDiffItem[]) {
    super('批次快照待复核，不能入窖')
    this.name = 'PendingReviewError'
    this.diffs = diffs
  }
}

/** 入窖被拒：快照与现行配比不一致 */
export class SnapshotMismatchError extends Error {
  diffs: SnapshotDiffItem[]
  constructor(diffs: SnapshotDiffItem[]) {
    super('快照与现行配比不一致，已拒绝入窖')
    this.name = 'SnapshotMismatchError'
    this.diffs = diffs
  }
}

/** 配比快照指纹：仅按 materialId + ratio + role，与顺序、香料改名无关 */
export function snapshotFingerprint(snapshot: BatchSnapshotItem[]): string {
  return snapshot
    .map((item) => `${item.materialId}:${round(item.ratio, 2)}:${item.role}`)
    .sort()
    .join('|')
}

/** 由配比列表组装快照（按 seq 升序） */
export function snapshotFromProportions(
  proportions: Proportion[],
  nameOf: (id: string) => string
): BatchSnapshotItem[] {
  return [...proportions]
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => ({
      materialId: proportion.materialId,
      materialName: nameOf(proportion.materialId),
      ratio: round(proportion.ratio, 2),
      role: proportion.role
    }))
}

/** 事务内读取材料名映射 */
async function materialNameMap(tx: Transaction): Promise<Map<string, string>> {
  const materials = await tx.table<Material>('materials').toArray()
  return new Map(materials.map((material) => [material.id, material.name]))
}

/** 逐味比对快照与现行配比，返回香料差异（含新增 / 移除 / 占比调整） */
export function compareSnapshot(snapshot: BatchSnapshotItem[], current: BatchSnapshotItem[]): SnapshotCheck {
  const snapshotMap = new Map(snapshot.map((item) => [item.materialId, item]))
  const currentMap = new Map(current.map((item) => [item.materialId, item]))
  const ids = Array.from(new Set([...snapshotMap.keys(), ...currentMap.keys()]))

  const diffs: SnapshotDiffItem[] = ids.map((materialId) => {
    const old = snapshotMap.get(materialId)
    const now = currentMap.get(materialId)
    const name = now?.materialName ?? old?.materialName ?? '未知香料'
    const role = now?.role ?? old?.role ?? ''
    if (old && !now) {
      return {
        materialId,
        materialName: name,
        snapshotRatio: old.ratio,
        currentRatio: null,
        role,
        kind: 'removed',
        delta: null
      }
    }
    if (!old && now) {
      return {
        materialId,
        materialName: name,
        snapshotRatio: null,
        currentRatio: now.ratio,
        role,
        kind: 'added',
        delta: now.ratio
      }
    }
    const oldRatio = round((old as BatchSnapshotItem).ratio, 2)
    const nowRatio = round((now as BatchSnapshotItem).ratio, 2)
    const roleChanged = (old as BatchSnapshotItem).role !== role
    const delta = round(nowRatio - oldRatio, 2)
    return {
      materialId,
      materialName: name,
      snapshotRatio: oldRatio,
      currentRatio: nowRatio,
      role,
      kind: delta === 0 && !roleChanged ? 'same' : 'changed',
      delta
    }
  })

  const changed = diffs.filter((item) => item.kind !== 'same')
  return { consistent: changed.length === 0, diffs, changedCount: changed.length }
}

/** 追加版本链节点（事务内） */
async function appendVersionInTx(
  tx: Transaction,
  params: { formulaId: string; snapshot: BatchSnapshotItem[]; reason: VersionReason; operator: string; at: number }
): Promise<FormulaVersion> {
  const table = tx.table<FormulaVersion>('formulaVersions')
  const list = await table.where('formulaId').equals(params.formulaId).toArray()
  const versionNo = list.reduce((max, item) => Math.max(max, item.versionNo), 0) + 1
  const version: FormulaVersion = {
    id: createId('fver'),
    formulaId: params.formulaId,
    versionNo,
    snapshot: params.snapshot.map((item) => ({ ...item })),
    totalRatio: round(params.snapshot.reduce((sum, item) => sum + item.ratio, 0), 2),
    reason: params.reason,
    operator: params.operator,
    createdAt: params.at,
    updatedAt: params.at
  }
  await table.put(version)
  return version
}

function pushTrail(batch: Batch, entry: BatchVersionTrail): void {
  const trail = Array.isArray(batch.versionTrail) ? batch.versionTrail : []
  trail.push(entry)
  batch.versionTrail = trail
}

/** 保存冲突草稿（独立事务，必须在引发回滚的业务事务之外调用） */
export async function saveConflictDraft(params: {
  kind: ConflictDraft['kind']
  formulaId: string
  source: string
  payload: string
  baseRev: number
  latestRev: number
}): Promise<string> {
  const now = Date.now()
  const draft: ConflictDraft = {
    id: createId('draft'),
    kind: params.kind,
    formulaId: params.formulaId,
    source: params.source,
    payload: params.payload,
    baseRev: params.baseRev,
    latestRev: params.latestRev,
    resolved: 0,
    createdAt: now,
    updatedAt: now
  }
  await db.conflictDrafts.put(draft)
  return draft.id
}

/**
 * 配比改动的统一入口：
 * - rev 与 baseRev 不一致时抛 RevisionConflictError，并把待保存内容落为冲突草稿；
 * - 指纹变化时追加版本链节点，未入窖批次快照立即失效重算，已入窖批次冻结；
 * - 指纹不变（仅备注 / 排序）时只递增 rev，不新增版本。
 */
export async function applyProportionChange(params: {
  formulaId: string
  baseRev: number
  source: string
  mutate: (tx: Transaction) => Promise<void>
  draftPayload?: ProportionDraftPayload
}): Promise<{ newVersion: FormulaVersion | null }> {
  const { formulaId, baseRev, source, mutate, draftPayload } = params

  try {
    let result: { newVersion: FormulaVersion | null } = { newVersion: null }

    await db.transaction(
      'rw',
      [db.formulas, db.proportions, db.materials, db.batches, db.cellars, db.formulaVersions],
      async (tx) => {
        const formulas = tx.table<Formula>('formulas')
        const proportionsTable = tx.table<Proportion>('proportions')
        const batchesTable = tx.table<Batch>('batches')
        const cellarsTable = tx.table<Cellar>('cellars')

        const formula = await formulas.get(formulaId)
        if (!formula) throw new Error('香方不存在')
        if (typeof formula.rev !== 'number') formula.rev = 1
        // 冲突检测在事务内：冲突时直接抛错让整个事务回滚，草稿在外层补存
        if (formula.rev !== baseRev) {
          throw new RevisionConflictError(baseRev, formula.rev, '')
        }

        const names = await materialNameMap(tx)
        const nameOf = (id: string): string => names.get(id) ?? '香料已删除'

        const before = await proportionsTable.where('formulaId').equals(formulaId).toArray()
        const beforeSnapshot = snapshotFromProportions(before, nameOf)
        const beforeFingerprint = snapshotFingerprint(beforeSnapshot)

        await mutate(tx)

        const after = await proportionsTable.where('formulaId').equals(formulaId).toArray()
        const afterSnapshot = snapshotFromProportions(after, nameOf)
        const afterFingerprint = snapshotFingerprint(afterSnapshot)
        const afterTotal = round(afterSnapshot.reduce((sum, item) => sum + item.ratio, 0), 2)
        const now = Date.now()

        let versionNo = formula.versionNo ?? 1
        let newVersion: FormulaVersion | null = null
        if (afterFingerprint !== beforeFingerprint) {
          newVersion = await appendVersionInTx(tx, {
            formulaId,
            snapshot: afterSnapshot,
            reason: '配比调整',
            operator: '',
            at: now
          })
          versionNo = newVersion.versionNo
        }

        // 未入窖批次：现行快照立即失效重算；已入窖：冻结原快照；待复核：保留待人工处理
        const batches = await batchesTable.where('formulaId').equals(formulaId).toArray()
        const batchIds = batches.map((batch) => batch.id)
        const cellars = batchIds.length > 0 ? await cellarsTable.where('batchId').anyOf(batchIds).toArray() : []
        const cellaredBatchIds = new Set(cellars.map((cellar) => cellar.batchId))

        for (const batch of batches) {
          if (cellaredBatchIds.has(batch.id) || batch.snapshotState === 'frozen') {
            if (batch.snapshotState !== 'frozen') {
              batch.snapshotState = 'frozen'
              await batchesTable.put(batch)
            }
            continue
          }
          if (batch.snapshotState === 'pending_review') continue
          const wasFingerprint = snapshotFingerprint(batch.snapshot)
          batch.snapshot = afterSnapshot.map((item) => ({ ...item }))
          batch.snapshotAt = now
          batch.snapshotState = 'current'
          batch.formulaVersionNo = versionNo
          if (wasFingerprint !== afterFingerprint) {
            pushTrail(batch, {
              versionNo,
              state: 'current',
              reason: '配比调整',
              at: now,
              note: newVersion ? `配比改为 v${versionNo}，未入窖快照已重算` : '配比微调，快照同步刷新'
            })
          }
          await batchesTable.put(batch)
        }

        formula.rev = baseRev + 1
        formula.versionNo = versionNo
        formula.totalRatio = afterTotal
        formula.updatedAt = now
        await formulas.put(formula)

        result = { newVersion }
      }
    )

    return result
  } catch (err) {
    if (err instanceof RevisionConflictError) {
      // 事务已回滚：在独立事务里把后保存者的内容落为冲突草稿，再抛出给页面
      const draftId = await saveConflictDraft({
        kind: 'proportion',
        formulaId,
        source,
        payload: JSON.stringify(draftPayload ?? { items: [] }),
        baseRev: err.baseRev,
        latestRev: err.latestRev
      })
      throw new RevisionConflictError(err.baseRev, err.latestRev, draftId)
    }
    throw err
  }
}

/** 香方主档更新（带乐观锁）。冲突时抛 RevisionConflictError 并留草稿 */
export async function updateFormulaGuarded(params: {
  formulaId: string
  baseRev: number
  source: string
  patch: Partial<Pick<Formula, 'name' | 'scentType' | 'usage' | 'state' | 'createdAt'>>
}): Promise<void> {
  const { formulaId, baseRev, source, patch } = params
  let currentRev = 0
  let draftPayload: Record<string, unknown> = {}
  try {
    await db.transaction('rw', [db.formulas], async (tx) => {
      const formulas = tx.table<Formula>('formulas')
      const formula = await formulas.get(formulaId)
      if (!formula) throw new Error('香方不存在')
      currentRev = typeof formula.rev === 'number' ? formula.rev : 1
      if (currentRev !== baseRev) {
        draftPayload = {
          name: patch.name ?? formula.name,
          scentType: patch.scentType ?? formula.scentType,
          usage: patch.usage ?? formula.usage,
          state: patch.state ?? formula.state,
          createdAt: patch.createdAt ?? formula.createdAt
        }
        throw new RevisionConflictError(baseRev, currentRev, '')
      }
      await formulas.update(formulaId, { ...patch, rev: baseRev + 1, updatedAt: Date.now() })
    })
  } catch (err) {
    if (err instanceof RevisionConflictError) {
      const draftId = await saveConflictDraft({
        kind: 'formula',
        formulaId,
        source,
        payload: JSON.stringify(draftPayload),
        baseRev,
        latestRev: currentRev
      })
      throw new RevisionConflictError(baseRev, currentRev, draftId)
    }
    throw err
  }
}

/** 建方：写入香方并建立版本链 v1（空配比） */
export async function createFormulaWithVersion(params: {
  id: string
  name: string
  scentType: Formula['scentType']
  usage: Formula['usage']
  createdAt: string
  state: Formula['state']
}): Promise<void> {
  const now = Date.now()
  const formula: Formula = {
    id: params.id,
    name: params.name,
    scentType: params.scentType,
    usage: params.usage,
    createdAt: params.createdAt,
    totalRatio: 0,
    state: params.state,
    versionNo: 1,
    rev: 1,
    updatedAt: now
  }
  await db.transaction('rw', [db.formulas, db.formulaVersions], async (tx) => {
    await tx.table<Formula>('formulas').put(formula)
    await appendVersionInTx(tx, {
      formulaId: params.id,
      snapshot: [],
      reason: '建方',
      operator: '',
      at: now
    })
  })
}

/** 登记和香批次：固化现行配比快照并锚定当前版本 */
export async function createVersionedBatch(params: {
  id: string
  formulaId: string
  mixedAt: string
  formingMethod: Batch['formingMethod']
  quantity: number
  operator: string
}): Promise<{ batch: Batch; version: FormulaVersion }> {
  const now = Date.now()
  let batch!: Batch
  let version!: FormulaVersion
  await db.transaction(
    'rw',
    [db.formulas, db.proportions, db.materials, db.batches, db.formulaVersions],
    async (tx) => {
      const formulas = tx.table<Formula>('formulas')
      const formula = await formulas.get(params.formulaId)
      if (!formula) throw new Error('香方不存在')
      const proportions = await tx.table<Proportion>('proportions').where('formulaId').equals(params.formulaId).toArray()
      if (proportions.length === 0) throw new Error('该香方还没有配比，无法登记批次')
      const names = await materialNameMap(tx)
      const snapshot = snapshotFromProportions(proportions, (id) => names.get(id) ?? '香料已删除')

      // 现行配比指纹与链尾不同（例如导入的数据）时补一个和香固化版本
      const tail = await latestVersionOf(tx, params.formulaId)
      if (!tail || snapshotFingerprint(tail.snapshot) !== snapshotFingerprint(snapshot)) {
        version = await appendVersionInTx(tx, {
          formulaId: params.formulaId,
          snapshot,
          reason: '和香固化',
          operator: params.operator,
          at: now
        })
        formula.versionNo = version.versionNo
      } else {
        version = tail
      }

      batch = {
        id: params.id,
        formulaId: params.formulaId,
        mixedAt: params.mixedAt,
        formingMethod: params.formingMethod,
        quantity: params.quantity,
        operator: params.operator,
        snapshot: snapshot.map((item) => ({ ...item })),
        snapshotAt: now,
        snapshotState: 'current',
        formulaVersionNo: version.versionNo,
        versionTrail: [
          {
            versionNo: version.versionNo,
            state: 'current',
            reason: '和香固化',
            at: now,
            note: `和香批次登记，固化 v${version.versionNo} 配比`
          }
        ],
        updatedAt: now
      }
      await tx.table<Batch>('batches').put(batch)
      // 和香登记不改香方内容，只递增修订号
      formula.rev = (typeof formula.rev === 'number' ? formula.rev : 1) + 1
      formula.updatedAt = now
      await formulas.put(formula)
    }
  )
  return { batch, version }
}

async function latestVersionOf(tx: Transaction, formulaId: string): Promise<FormulaVersion | null> {
  const list = await tx.table<FormulaVersion>('formulaVersions').where('formulaId').equals(formulaId).toArray()
  if (list.length === 0) return null
  return list.sort((a, b) => a.versionNo - b.versionNo).slice(-1)[0]
}

/** 入窖：比对快照与现行配比，一致才冻结并写入窖藏；不一致拒绝并返回香料差异 */
export async function enterCellar(params: {
  id: string
  batchId: string
  startDate: string
  endDate: string
  temperatureC: number
  humidityPct: number
  container: CellarContainer
  state: CellarState
}): Promise<{ cellar: Cellar; versionNo: number }> {
  const now = Date.now()
  let cellar!: Cellar
  let versionNo = 0
  await db.transaction(
    'rw',
    [db.formulas, db.proportions, db.materials, db.batches, db.cellars, db.formulaVersions],
    async (tx) => {
      const batchesTable = tx.table<Batch>('batches')
      const cellarsTable = tx.table<Cellar>('cellars')
      const batch = await batchesTable.get(params.batchId)
      if (!batch) throw new Error('批次不存在')
      const formula = await tx.table<Formula>('formulas').get(batch.formulaId)
      if (!formula) throw new Error('香方不存在')

      const existed = await cellarsTable.where('batchId').equals(params.batchId).toArray()
      if (existed.length > 0) throw new Error('该批次已登记窖藏')

      const proportions = await tx.table<Proportion>('proportions').where('formulaId').equals(batch.formulaId).toArray()
      const names = await materialNameMap(tx)
      const currentSnapshot = snapshotFromProportions(proportions, (id) => names.get(id) ?? '香料已删除')
      const check = compareSnapshot(batch.snapshot, currentSnapshot)

      if (batch.snapshotState === 'pending_review') throw new PendingReviewError(check.diffs)
      if (!check.consistent) throw new SnapshotMismatchError(check.diffs)

      // 一致：冻结批次原快照，入窖锁定的是和香时锚定的版本
      const anchorNo = batch.formulaVersionNo || formula.versionNo || 1
      batch.snapshotState = 'frozen'
      batch.formulaVersionNo = anchorNo
      pushTrail(batch, {
        versionNo: anchorNo,
        state: 'frozen',
        reason: '入窖冻结',
        at: now,
        note: `入窖冻结，依据 v${anchorNo}`
      })
      batch.updatedAt = now
      await batchesTable.put(batch)

      cellar = {
        id: params.id,
        batchId: params.batchId,
        startDate: params.startDate,
        endDate: params.endDate,
        temperatureC: params.temperatureC,
        humidityPct: params.humidityPct,
        container: params.container,
        state: params.state,
        formulaVersionNo: anchorNo,
        updatedAt: now
      }
      await cellarsTable.put(cellar)
      versionNo = anchorNo
    }
  )
  return { cellar, versionNo }
}

/** 删除窖藏记录时：批次解除冻结，按现行配比重算为现行快照 */
export async function unfreezeBatchIfNeeded(batchId: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.cellars, db.proportions, db.materials, db.formulas], async (tx) => {
    const cellarsTable = tx.table<Cellar>('cellars')
    const remaining = await cellarsTable.where('batchId').equals(batchId).toArray()
    if (remaining.length > 0) return
    const batchesTable = tx.table<Batch>('batches')
    const batch = await batchesTable.get(batchId)
    if (!batch || batch.snapshotState !== 'frozen') return
    const formula = await tx.table<Formula>('formulas').get(batch.formulaId)
    const proportions = await tx.table<Proportion>('proportions').where('formulaId').equals(batch.formulaId).toArray()
    const names = await materialNameMap(tx)
    const snapshot = snapshotFromProportions(proportions, (id) => names.get(id) ?? '香料已删除')
    const now = Date.now()
    const versionNo = formula?.versionNo ?? batch.formulaVersionNo
    batch.snapshot = snapshot.map((item) => ({ ...item }))
    batch.snapshotAt = now
    batch.snapshotState = proportions.length > 0 ? 'current' : 'pending_review'
    batch.formulaVersionNo = proportions.length > 0 ? versionNo : 0
    pushTrail(batch, {
      versionNo: proportions.length > 0 ? versionNo : 0,
      state: proportions.length > 0 ? 'current' : 'pending_review',
      reason: '配比调整',
      at: now,
      note:
        proportions.length > 0
          ? '窖藏记录已删除，批次解除冻结并按现行配比重算快照'
          : '窖藏记录已删除且香方已无配比，转为待复核'
    })
    batch.updatedAt = now
    await batchesTable.put(batch)
  })
}

/** 待复核批次人工复核：按现行配比重建快照并锚定现行版本（复核前不并入均分） */
export async function reviewPendingBatch(batchId: string): Promise<{ versionNo: number; snapshot: BatchSnapshotItem[] }> {
  const now = Date.now()
  let versionNo = 0
  let snapshot: BatchSnapshotItem[] = []
  await db.transaction(
    'rw',
    [db.formulas, db.proportions, db.materials, db.batches, db.cellars, db.formulaVersions],
    async (tx) => {
      const batchesTable = tx.table<Batch>('batches')
      const batch = await batchesTable.get(batchId)
      if (!batch) throw new Error('批次不存在')
      if (batch.snapshotState !== 'pending_review') throw new Error('该批次不处于待复核状态')
      const proportions = await tx.table<Proportion>('proportions').where('formulaId').equals(batch.formulaId).toArray()
      if (proportions.length === 0) throw new Error('香方当前没有配比，无法重建快照')
      const names = await materialNameMap(tx)
      snapshot = snapshotFromProportions(proportions, (id) => names.get(id) ?? '香料已删除')
      const formula = await tx.table<Formula>('formulas').get(batch.formulaId)
      versionNo = formula?.versionNo ?? 1

      const stillCellared = (await tx.table<Cellar>('cellars').where('batchId').equals(batchId).toArray()).length > 0
      const state: SnapshotState = stillCellared ? 'frozen' : 'current'
      batch.snapshot = snapshot.map((item) => ({ ...item }))
      batch.snapshotAt = now
      batch.snapshotState = state
      batch.formulaVersionNo = versionNo
      pushTrail(batch, {
        versionNo,
        state,
        reason: '档案补录',
        at: now,
        note: `人工复核通过，按现行配比补建快照并锚定 v${versionNo}`
      })
      batch.updatedAt = now
      await batchesTable.put(batch)
    }
  )
  return { versionNo, snapshot }
}

/** 香料改名：同步刷新现行批次快照中的香料名（冻结批次与历史版本不动） */
export async function refreshMaterialName(materialId: string, nextName: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.cellars], async (tx) => {
    const batchesTable = tx.table<Batch>('batches')
    const batches = await batchesTable.toArray()
    const cellars = await tx.table<Cellar>('cellars').toArray()
    const cellaredIds = new Set(cellars.map((cellar) => cellar.batchId))
    const now = Date.now()
    for (const batch of batches) {
      if (cellaredIds.has(batch.id) || batch.snapshotState !== 'current') continue
      let changed = false
      batch.snapshot = batch.snapshot.map((item) => {
        if (item.materialId === materialId && item.materialName !== nextName) {
          changed = true
          return { ...item, materialName: nextName }
        }
        return item
      })
      if (changed) {
        batch.updatedAt = now
        await batchesTable.put(batch)
      }
    }
  })
}

/** 删除香料级联后：受影响香方按新配比推进版本并重算未入窖批次快照 */
export async function advanceAfterMaterialDeleted(formulaIds: string[]): Promise<void> {
  for (const formulaId of Array.from(new Set(formulaIds))) {
    const formula = await db.formulas.get(formulaId)
    if (!formula) continue
    await applyProportionChange({
      formulaId,
      baseRev: formula.rev ?? 1,
      source: '香料库删除香料',
      mutate: async () => {},
      draftPayload: { items: [] }
    })
  }
}

/** 组装配比冲突草稿载荷（弹窗保存失败时用） */
export function buildProportionDraftPayload(
  items: Array<{
    proportionId: string | null
    materialId: string
    materialName: string
    ratio: number
    role: ProportionRole
    note: string
    seq: number
    deleted: boolean
  }>
): ProportionDraftPayload {
  return { items }
}

/** 标记冲突草稿已处理 */
export async function resolveDraft(draftId: string): Promise<void> {
  await db.conflictDrafts.update(draftId, { resolved: 1, updatedAt: Date.now() })
}

/** 非事务地计算入窖前差异预览 */
export async function previewCellarCheck(batchId: string): Promise<{
  batch: Batch | undefined
  check: SnapshotCheck
  pending: boolean
}> {
  const batch = await db.batches.get(batchId)
  if (!batch) return { batch: undefined, check: { consistent: false, diffs: [], changedCount: 0 }, pending: false }
  const proportions = await db.proportions.where('formulaId').equals(batch.formulaId).toArray()
  const materials = await db.materials.toArray()
  const nameOf = (id: string): string => materials.find((item) => item.id === id)?.name ?? '香料已删除'
  const currentSnapshot = snapshotFromProportions(proportions, nameOf)
  return {
    batch,
    check: compareSnapshot(batch.snapshot, currentSnapshot),
    pending: batch.snapshotState === 'pending_review'
  }
}
