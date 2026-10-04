import { db, createId } from '@/utils/db'
import { round } from '@/utils/ratio'
import type { Proportion } from '@/types/proportion'
import type {
  FormulaDraft,
  FormulaVersion,
  SnapshotDiff,
  SnapshotDiffItem,
  VersionSnapshotItem
} from '@/types/version'

/** 占比比对容差：配比写库时已舍入到两位小数，此处用容差兜底浮点误差 */
const RATIO_EPSILON = 0.01

/** 由配比记录构建固化快照（按 seq 排序），香料名从映射取，缺失记为「未知香料」 */
export function buildSnapshotFromProportions(
  proportions: Proportion[],
  materialNameMap: Map<string, string>
): VersionSnapshotItem[] {
  return proportions
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => ({
      materialId: proportion.materialId,
      materialName: materialNameMap.get(proportion.materialId) ?? '未知香料',
      ratio: round(proportion.ratio, 2),
      role: proportion.role
    }))
}

/** 按香料 id 批量取香料名映射 */
export async function materialNameMapOf(ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return new Map()
  const materials = await db.materials.where('id').anyOf(unique).toArray()
  return new Map(materials.map((material) => [material.id, material.name]))
}

/** 读取某香方的当前版本号（缺省兜底为 1，兼容旧档案） */
export async function getCurrentVersion(formulaId: string): Promise<number> {
  const formula = await db.formulas.get(formulaId)
  return typeof formula?.currentVersion === 'number' ? formula.currentVersion : 1
}

/** 读取某香方的全部版本记录，按版本号升序 */
export async function listFormulaVersions(formulaId: string): Promise<FormulaVersion[]> {
  const list = await db.formulaVersions.where('formulaId').equals(formulaId).toArray()
  return list.sort((a, b) => a.version - b.version)
}

/** 取某香方的最新一条版本记录 */
export async function getLatestVersion(formulaId: string): Promise<FormulaVersion | null> {
  const list = await listFormulaVersions(formulaId)
  return list.length > 0 ? list[list.length - 1] : null
}

/**
 * 比对两份快照的逐味差异：新增 / 移除 / 占比或角色变化。
 * 用于入窖前校验与批次页快照对照。
 */
export function diffSnapshots(
  oldSnapshot: VersionSnapshotItem[],
  currentSnapshot: VersionSnapshotItem[]
): SnapshotDiff {
  const oldMap = new Map(oldSnapshot.map((item) => [item.materialId, item]))
  const newMap = new Map(currentSnapshot.map((item) => [item.materialId, item]))
  const added: SnapshotDiffItem[] = []
  const removed: SnapshotDiffItem[] = []
  const changed: SnapshotDiffItem[] = []

  for (const [materialId, newItem] of newMap) {
    const oldItem = oldMap.get(materialId)
    if (!oldItem) {
      added.push({
        materialId,
        materialName: newItem.materialName,
        kind: 'added',
        oldRatio: null,
        newRatio: newItem.ratio,
        oldRole: null,
        newRole: newItem.role,
        ratioDelta: null
      })
    } else if (
      Math.abs(oldItem.ratio - newItem.ratio) > RATIO_EPSILON ||
      oldItem.role !== newItem.role
    ) {
      changed.push({
        materialId,
        materialName: newItem.materialName,
        kind: 'changed',
        oldRatio: oldItem.ratio,
        newRatio: newItem.ratio,
        oldRole: oldItem.role,
        newRole: newItem.role,
        ratioDelta: round(newItem.ratio - oldItem.ratio, 2)
      })
    }
  }

  for (const [materialId, oldItem] of oldMap) {
    if (!newMap.has(materialId)) {
      removed.push({
        materialId,
        materialName: oldItem.materialName,
        kind: 'removed',
        oldRatio: oldItem.ratio,
        newRatio: null,
        oldRole: oldItem.role,
        newRole: null,
        ratioDelta: null
      })
    }
  }

  return {
    matched: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed
  }
}

/**
 * 配比调整后递增香方版本，并联动重算未入窖批次的快照。
 * 已入窖批次冻结原快照与版本号，不随此次调整变化。
 * 若新快照与最新版本完全一致（如仅改备注），则不重复建版，仅刷新香方 updatedAt。
 * 返回调整后的当前版本号。
 */
export async function bumpFormulaVersion(formulaId: string, changeNote = '配比调整'): Promise<number> {
  const now = Date.now()
  return await db.transaction(
    'rw',
    [db.formulas, db.proportions, db.materials, db.batches, db.cellars, db.formulaVersions],
    async () => {
      const formula = await db.formulas.get(formulaId)
      if (!formula) throw new Error('香方不存在，无法递增版本')

      const proportions = await db.proportions.where('formulaId').equals(formulaId).sortBy('seq')
      const nameMap = await materialNameMapOf(proportions.map((item) => item.materialId))
      const snapshot = buildSnapshotFromProportions(proportions, nameMap)

      const latest = await getLatestVersion(formulaId)
      const snapshotUnchanged = latest !== null && diffSnapshots(latest.snapshot, snapshot).matched
      let nextVersion: number
      if (!latest) {
        // 尚无版本记录（如新建香方首次录入配比）：首版为 v1
        nextVersion = 1
      } else if (snapshotUnchanged) {
        nextVersion = latest.version
      } else {
        nextVersion = latest.version + 1
      }

      // 快照有变化（或首版）时写入新版本记录，形成不可变版本链
      if (!snapshotUnchanged) {
        await db.formulaVersions.put({
          id: createId('fver'),
          formulaId,
          version: nextVersion,
          snapshot,
          changedAt: now,
          changeNote,
          basedOn: latest?.version ?? 0
        })
      }

      await db.formulas.update(formulaId, { currentVersion: nextVersion, updatedAt: now })

      // 未入窖批次：快照立即失效并重算到新版本；已入窖批次保持冻结
      const batches = await db.batches.where('formulaId').equals(formulaId).toArray()
      if (batches.length > 0) {
        const batchIds = batches.map((batch) => batch.id)
        const cellaredRows = await db.cellars.where('batchId').anyOf(batchIds).toArray()
        const cellaredIds = new Set(cellaredRows.map((cellar) => cellar.batchId))
        for (const batch of batches) {
          if (cellaredIds.has(batch.id)) continue
          await db.batches.update(batch.id, {
            snapshot,
            formulaVersion: nextVersion,
            reviewState: snapshot.length === 0 ? 'pending' : 'ok',
            snapshotAt: now,
            updatedAt: now
          })
        }
      }

      return nextVersion
    }
  )
}

/**
 * 手动复核某批次：按当前配比重算快照并置为 ok。
 * 用于缺快照的旧批次补版本，使其品香重新并入均分。
 */
export async function recalculateBatchSnapshot(batchId: string): Promise<void> {
  const batch = await db.batches.get(batchId)
  if (!batch) return
  const now = Date.now()
  const proportions = await db.proportions.where('formulaId').equals(batch.formulaId).sortBy('seq')
  const nameMap = await materialNameMapOf(proportions.map((item) => item.materialId))
  const snapshot = buildSnapshotFromProportions(proportions, nameMap)
  const currentVersion = await getCurrentVersion(batch.formulaId)
  await db.batches.update(batchId, {
    snapshot,
    formulaVersion: currentVersion,
    reviewState: snapshot.length === 0 ? 'pending' : 'ok',
    snapshotAt: now,
    updatedAt: now
  })
}

/** 批次快照与当前配比的比对结果 */
export interface BatchSnapshotCheck {
  /** 快照是否与当前配比一致且已复核 */
  matched: boolean
  diff: SnapshotDiff
  currentVersion: number
  batchVersion: number
  pendingReview: boolean
}

/**
 * 入窖前校验：把批次冻结的快照与香方当前配比逐味比对。
 * 不一致（或批次待复核）时返回差异，调用方据此拒绝入窖并列出香料差异。
 */
export async function checkBatchSnapshot(batchId: string): Promise<BatchSnapshotCheck> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法校验快照')
  const proportions = await db.proportions.where('formulaId').equals(batch.formulaId).sortBy('seq')
  const nameMap = await materialNameMapOf(proportions.map((item) => item.materialId))
  const currentSnapshot = buildSnapshotFromProportions(proportions, nameMap)
  const diff = diffSnapshots(batch.snapshot ?? [], currentSnapshot)
  const currentVersion = await getCurrentVersion(batch.formulaId)
  const batchVersion = typeof batch.formulaVersion === 'number' ? batch.formulaVersion : 1
  const pendingReview = batch.reviewState === 'pending' || !Array.isArray(batch.snapshot) || batch.snapshot.length === 0
  return { matched: diff.matched && !pendingReview, diff, currentVersion, batchVersion, pendingReview }
}

/** 把差异汇总为可展示的香料差异文案 */
export function formatDiffSummary(diff: SnapshotDiff): string {
  const parts: string[] = []
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.length} 味`)
  if (diff.removed.length > 0) parts.push(`移除 ${diff.removed.length} 味`)
  if (diff.changed.length > 0) parts.push(`占比/角色变化 ${diff.changed.length} 味`)
  return parts.join('，')
}

/** 把差异条目格式化为逐味说明 */
export function formatDiffItem(item: SnapshotDiffItem): string {
  if (item.kind === 'added') return `${item.materialName}：当前方新增 ${item.newRatio}%（${item.newRole}）`
  if (item.kind === 'removed') return `${item.materialName}：已从方中移除（原 ${item.oldRatio}% · ${item.oldRole}）`
  const delta = item.ratioDelta ?? 0
  return `${item.materialName}：${item.oldRatio}% → ${item.newRatio}%（${delta > 0 ? '+' : ''}${delta}%），角色 ${item.oldRole} → ${item.newRole}`
}

// ---------- 香方编辑冲突草稿（localStorage） ----------

const DRAFT_PREFIX = 'gbincense:draft:formula:'

export function saveFormulaDraft(draft: FormulaDraft): void {
  localStorage.setItem(DRAFT_PREFIX + draft.formulaId, JSON.stringify(draft))
}

export function readFormulaDraft(formulaId: string): FormulaDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + formulaId)
    return raw ? (JSON.parse(raw) as FormulaDraft) : null
  } catch {
    return null
  }
}

export function clearFormulaDraft(formulaId: string): void {
  localStorage.removeItem(DRAFT_PREFIX + formulaId)
}

export function readAllFormulaDrafts(): FormulaDraft[] {
  const drafts: FormulaDraft[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith(DRAFT_PREFIX)) continue
    try {
      drafts.push(JSON.parse(localStorage.getItem(key) ?? '') as FormulaDraft)
    } catch {
      // 损坏的草稿忽略
    }
  }
  return drafts.sort((a, b) => b.savedAt - a.savedAt)
}
