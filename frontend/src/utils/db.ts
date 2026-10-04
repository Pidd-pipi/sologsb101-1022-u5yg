import Dexie, { type Table, type Transaction } from 'dexie'
import type { Formula } from '@/types/formula'
import type { Material } from '@/types/material'
import type { Proportion } from '@/types/proportion'
import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Cellar } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'
import type { ConflictDraft, FormulaVersion } from '@/types/version'

/** 本地结构版本号：新增/修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** 本地存储键名（localStorage 侧的少量元数据） */
export const LS_KEYS = {
  dbVersion: 'gbincense:db-version',
  lastBackupAt: 'gbincense:last-backup-at',
  uiPrefs: 'gbincense:ui-prefs'
} as const

export interface UiPrefs {
  /** 上次浏览的香方 */
  lastFormulaId: string | null
  /** 配比页排序方式：手动编排 / 按君臣佐使权重 */
  proportionSort: 'manual' | 'role'
  /** 窖藏页排序方式：按临近出窖 / 按入窖时间 */
  cellarSort: 'remain' | 'start'
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastFormulaId: null,
  proportionSort: 'manual',
  cellarSort: 'remain'
}

/** 快照结构，供 export.ts 与品香页使用 */
export interface IncenseSnapshot {
  app: 'gbincense'
  dbVersion: number
  exportedAt: string
  formulas: Formula[]
  materials: Material[]
  proportions: Proportion[]
  batches: Batch[]
  cellars: Cellar[]
  tastings: Tasting[]
  /** 香方版本链 */
  formulaVersions: FormulaVersion[]
  /** 并发冲突草稿 */
  conflictDrafts: ConflictDraft[]
}

export class IncenseDatabase extends Dexie {
  formulas!: Table<Formula, string>
  materials!: Table<Material, string>
  proportions!: Table<Proportion, string>
  batches!: Table<Batch, string>
  cellars!: Table<Cellar, string>
  tastings!: Table<Tasting, string>
  formulaVersions!: Table<FormulaVersion, string>
  conflictDrafts!: Table<ConflictDraft, string>

  constructor() {
    super('gbincense')
    // v1：初版表结构，配比表尚未建立 seq 编排字段索引
    this.version(1).stores({
      formulas: 'id, name, scentType, usage, state, totalRatio',
      materials: 'id, name, origin, grade, processMethod',
      proportions: 'id, formulaId, materialId, role',
      batches: 'id, formulaId, mixedAt, formingMethod',
      cellars: 'id, batchId, startDate, endDate, state',
      tastings: 'id, batchId, tastedAt, smokeScore'
    })
    // v2：配比表补 seq 索引、批次与窖藏补日期索引，并回填历史脏数据
    this.version(2)
      .stores({
        formulas: 'id, name, scentType, usage, state, createdAt, totalRatio, updatedAt',
        materials: 'id, name, origin, grade, processMethod, updatedAt',
        proportions: 'id, formulaId, materialId, role, seq, updatedAt',
        batches: 'id, formulaId, mixedAt, formingMethod, updatedAt',
        cellars: 'id, batchId, startDate, endDate, state, updatedAt',
        tastings: 'id, batchId, tastedAt, smokeScore, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：v1 的配比记录没有 seq，按 formulaId 分组后按录入顺序补齐编排序号
        const grouped = new Map<string, Proportion[]>()
        await tx
          .table<Proportion>('proportions')
          .toCollection()
          .modify((proportion) => {
            if (typeof proportion.seq !== 'number' || Number.isNaN(proportion.seq)) {
              const list = grouped.get(proportion.formulaId) ?? []
              list.push(proportion)
              grouped.set(proportion.formulaId, list)
              proportion.seq = list.length
            }
            if (!Number.isFinite(proportion.updatedAt)) {
              proportion.updatedAt = Date.now()
            }
          })
        // 迁移 2：补齐批次缺失的快照字段，避免批次页对照时读到 undefined
        await tx
          .table<Batch>('batches')
          .toCollection()
          .modify((batch) => {
            if (!Array.isArray(batch.snapshot)) batch.snapshot = []
            if (typeof batch.snapshotAt !== 'number') batch.snapshotAt = 0
          })
        // 迁移 3：补齐品香评分的默认留香时长
        await tx
          .table<Tasting>('tastings')
          .toCollection()
          .modify((tasting) => {
            if (typeof tasting.lastingMin !== 'number' || Number.isNaN(tasting.lastingMin)) {
              tasting.lastingMin = 0
            }
          })
      })
    // v3：香方 / 配比 / 批次 / 窖藏共用版本链，新增版本表与冲突草稿表，并为旧档补版本
    this.version(DB_VERSION)
      .stores({
        formulas: 'id, name, scentType, usage, state, createdAt, totalRatio, versionNo, rev, updatedAt',
        materials: 'id, name, origin, grade, processMethod, updatedAt',
        proportions: 'id, formulaId, materialId, role, seq, updatedAt',
        batches: 'id, formulaId, mixedAt, formingMethod, snapshotState, updatedAt',
        cellars: 'id, batchId, startDate, endDate, state, updatedAt',
        tastings: 'id, batchId, tastedAt, smokeScore, updatedAt',
        formulaVersions: 'id, formulaId, versionNo, createdAt',
        conflictDrafts: 'id, formulaId, kind, resolved, createdAt'
      })
      .upgrade(async (tx) => {
        await migrateToVersionChain(tx)
      })
  }
}

/**
 * v3 迁移：为旧档补一条版本链。
 * 1. 每款香方按当前配比生成 v1（旧档案补录）；
 * 2. 批次快照非空：能逐味对上的锚定 v1；对不上的为该方追加一个和香固化版本并锚定之；
 * 3. 已入窖批次冻结原快照，窖藏记录锚定其版本号；
 * 4. 未入窖批次：快照非空的立即按当前配比重算为现行；缺快照的置为待复核，不自动并入均分。
 */
async function migrateToVersionChain(tx: Transaction): Promise<void> {
  const now = Date.now()
  const formulas = await tx.table<Formula>('formulas').toArray()
  const proportions = await tx.table<Proportion>('proportions').toArray()
  const materials = await tx.table<Material>('materials').toArray()
  const batches = await tx.table<Batch>('batches').toArray()
  const cellars = await tx.table<Cellar>('cellars').toArray()

  const materialNameMap = new Map<string, string>()
  materials.forEach((material) => materialNameMap.set(material.id, material.name))

  const propsByFormula = new Map<string, Proportion[]>()
  proportions.forEach((proportion) => {
    const list = propsByFormula.get(proportion.formulaId) ?? []
    list.push(proportion)
    propsByFormula.set(proportion.formulaId, list)
  })
  const cellarsByBatch = new Map<string, Cellar[]>()
  cellars.forEach((cellar) => {
    const list = cellarsByBatch.get(cellar.batchId) ?? []
    list.push(cellar)
    cellarsByBatch.set(cellar.batchId, list)
  })

  const snapshotOf = (list: Proportion[]): BatchSnapshotItem[] =>
    [...list]
      .sort((a, b) => a.seq - b.seq)
      .map((proportion) => ({
        materialId: proportion.materialId,
        materialName: materialNameMap.get(proportion.materialId) ?? proportion.materialId,
        ratio: Math.round(proportion.ratio * 100) / 100,
        role: proportion.role
      }))

  const fingerprintOf = (snapshot: BatchSnapshotItem[]): string =>
    snapshot
      .map((item) => `${item.materialId}:${Math.round(item.ratio * 100) / 100}:${item.role}`)
      .sort()
      .join('|')

  const newVersions: FormulaVersion[] = []

  for (const formula of formulas) {
    const list = propsByFormula.get(formula.id) ?? []
    const currentSnapshot = snapshotOf(list)
    const currentTotal = Math.round(currentSnapshot.reduce((sum, item) => sum + item.ratio, 0) * 100) / 100

    let nextNo = 1
    const pushVersion = (snapshot: BatchSnapshotItem[], reason: FormulaVersion['reason'], createdAt: number): FormulaVersion => {
      const version: FormulaVersion = {
        id: createId('fver'),
        formulaId: formula.id,
        versionNo: nextNo,
        snapshot,
        totalRatio: Math.round(snapshot.reduce((sum, item) => sum + item.ratio, 0) * 100) / 100,
        reason,
        operator: '',
        createdAt,
        updatedAt: now
      }
      nextNo += 1
      newVersions.push(version)
      return version
    }

    // 1. 已入窖且快照与当前方不一致的批次：把原快照补为历史版本（相同指纹只补一个）
    const currentFingerprint = fingerprintOf(currentSnapshot)
    const historicalByFingerprint = new Map<string, FormulaVersion>()
    for (const batch of batches.filter((item) => item.formulaId === formula.id)) {
      if (!Array.isArray(batch.snapshot)) batch.snapshot = []
      if (typeof batch.snapshotAt !== 'number') batch.snapshotAt = 0
      batch.versionTrail = []
      const isCellared = (cellarsByBatch.get(batch.id) ?? []).length > 0
      if (!isCellared || batch.snapshot.length === 0) continue
      const fingerprint = fingerprintOf(batch.snapshot)
      if (fingerprint === currentFingerprint) continue
      if (!historicalByFingerprint.has(fingerprint)) {
        historicalByFingerprint.set(
          fingerprint,
          pushVersion(
            batch.snapshot.map((item) => ({ ...item })),
            '入窖冻结',
            batch.snapshotAt || batch.updatedAt || now
          )
        )
      }
    }

    // 2. 链尾补当前配比版本（旧档案补录）；没有历史版本时它就是 v1
    const currentVersion = pushVersion(currentSnapshot, '档案补录', formula.updatedAt || now)

    // 3. 逐批处理状态：缺快照待复核；已入窖冻结锚历史版本；未入窖立即按现行方重算
    for (const batch of batches.filter((item) => item.formulaId === formula.id)) {
      const isCellared = (cellarsByBatch.get(batch.id) ?? []).length > 0
      if (batch.snapshot.length === 0) {
        // 缺快照批次：先待复核，不自动并入均分；待人工复核后才锚定版本
        batch.snapshotState = 'pending_review'
        batch.formulaVersionNo = 0
        batch.versionTrail.push({
          versionNo: 0,
          state: 'pending_review',
          reason: '档案补录',
          at: now,
          note: '旧档批次缺少配比快照，已置为待复核'
        })
        continue
      }

      if (isCellared) {
        const fingerprint = fingerprintOf(batch.snapshot)
        const anchor =
          fingerprint === currentFingerprint
            ? currentVersion
            : historicalByFingerprint.get(fingerprint) ?? currentVersion
        // 已入窖：冻结原快照，锚定其依据版本
        batch.snapshotState = 'frozen'
        batch.formulaVersionNo = anchor.versionNo
        batch.versionTrail.push({
          versionNo: anchor.versionNo,
          state: 'frozen',
          reason: '入窖冻结',
          at: batch.snapshotAt || now,
          note: `旧档迁移：入窖批次冻结原快照 v${anchor.versionNo}`
        })
      } else {
        // 未入窖：旧快照立即失效，按当前配比重算并锚定现行版本
        batch.snapshot = currentSnapshot.map((item) => ({ ...item }))
        batch.snapshotAt = now
        batch.snapshotState = 'current'
        batch.formulaVersionNo = currentVersion.versionNo
        batch.versionTrail.push({
          versionNo: currentVersion.versionNo,
          state: 'current',
          reason: '档案补录',
          at: now,
          note: `旧档迁移：未入窖批次快照按现行配比重算至 v${currentVersion.versionNo}`
        })
      }
    }

    // 香方当前版本指向链尾（即当前配比）
    formula.versionNo = currentVersion.versionNo
    formula.rev = 1
    formula.totalRatio = currentTotal
  }

  // 窖藏锚定冻结批次的依据版本；待复核批次的窖藏保持 0 待人工处理
  for (const cellar of cellars) {
    const batch = batches.find((item) => item.id === cellar.batchId)
    cellar.formulaVersionNo = batch?.formulaVersionNo ?? 0
  }

  await tx.table<FormulaVersion>('formulaVersions').bulkPut(newVersions)
  await tx.table<Formula>('formulas').bulkPut(formulas)
  await tx.table<Batch>('batches').bulkPut(batches)
  await tx.table<Cellar>('cellars').bulkPut(cellars)
}

export const db = new IncenseDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表，供「清空本地数据」与导入前的覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.formulas,
      db.materials,
      db.proportions,
      db.batches,
      db.cellars,
      db.tastings,
      db.formulaVersions,
      db.conflictDrafts
    ],
    async () => {
      await Promise.all([
        db.formulas.clear(),
        db.materials.clear(),
        db.proportions.clear(),
        db.batches.clear(),
        db.cellars.clear(),
        db.tastings.clear(),
        db.formulaVersions.clear(),
        db.conflictDrafts.clear()
      ])
    }
  )
}

/** 各表记录数汇总，品香页与状态徽标消费 */
export async function countAll(): Promise<Record<string, number>> {
  const [formulas, materials, proportions, batches, cellars, tastings, formulaVersions, conflictDrafts] = await Promise.all([
    db.formulas.count(),
    db.materials.count(),
    db.proportions.count(),
    db.batches.count(),
    db.cellars.count(),
    db.tastings.count(),
    db.formulaVersions.count(),
    db.conflictDrafts.count()
  ])
  return { formulas, materials, proportions, batches, cellars, tastings, formulaVersions, conflictDrafts }
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastFormulaId: typeof parsed.lastFormulaId === 'string' ? parsed.lastFormulaId : null,
      proportionSort: parsed.proportionSort === 'role' ? 'role' : 'manual',
      cellarSort: parsed.cellarSort === 'start' ? 'start' : 'remain'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本到 localStorage，便于品香页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 组装本地全部数据的快照对象 */
export async function exportSnapshot(): Promise<IncenseSnapshot> {
  const [formulas, materials, proportions, batches, cellars, tastings, formulaVersions, conflictDrafts] = await Promise.all([
    db.formulas.toArray(),
    db.materials.toArray(),
    db.proportions.toArray(),
    db.batches.toArray(),
    db.cellars.toArray(),
    db.tastings.toArray(),
    db.formulaVersions.toArray(),
    db.conflictDrafts.toArray()
  ])
  return {
    app: 'gbincense',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    formulas,
    materials,
    proportions,
    batches,
    cellars,
    tastings,
    formulaVersions,
    conflictDrafts
  }
}

/** 按主键 bulkPut 写入快照；overwrite 为 true 时先清空全部表 */
export async function importSnapshot(snapshot: IncenseSnapshot, overwrite = false): Promise<void> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.formulas,
      db.materials,
      db.proportions,
      db.batches,
      db.cellars,
      db.tastings,
      db.formulaVersions,
      db.conflictDrafts
    ],
    async () => {
      await db.formulas.bulkPut(snapshot.formulas)
      await db.materials.bulkPut(snapshot.materials)
      await db.proportions.bulkPut(snapshot.proportions)
      await db.batches.bulkPut(snapshot.batches)
      await db.cellars.bulkPut(snapshot.cellars)
      await db.tastings.bulkPut(snapshot.tastings)
      if (Array.isArray(snapshot.formulaVersions)) await db.formulaVersions.bulkPut(snapshot.formulaVersions)
      if (Array.isArray(snapshot.conflictDrafts)) await db.conflictDrafts.bulkPut(snapshot.conflictDrafts)
    }
  )
}

/** 重置本地库：清空后重新播种演示档案 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/** 固定 id 前缀，保证重复播种幂等（bulkPut 覆盖同 id 记录） */
const SEED_IDS = {
  formulaLine: 'seed_formula_line',
  formulaPill: 'seed_formula_pill',
  formulaPlate: 'seed_formula_plate',
  materialChen: 'seed_material_chen',
  materialTan: 'seed_material_tan',
  materialRuxiang: 'seed_material_ruxiang',
  materialDing: 'seed_material_ding',
  batchLine: 'seed_batch_line',
  batchPill: 'seed_batch_pill',
  batchPlate: 'seed_batch_plate',
  cellarLine: 'seed_cellar_line',
  cellarPill: 'seed_cellar_pill',
  tastingLine: 'seed_tasting_line',
  tastingPill: 'seed_tasting_pill',
  verLineV1: 'seed_fver_line_1',
  verLineV2: 'seed_fver_line_2',
  verPillV1: 'seed_fver_pill_1',
  verPlateV1: 'seed_fver_plate_1'
} as const

/**
 * 播种三层互相引用的演示档案：香方（父）→ 配比 / 和香批次（子）→ 窖藏 / 品香（孙）。
 * 使用固定 id + bulkPut，重复调用不会产生重复数据。
 */
export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  // 现行配比（v2）：线香批次入窖后调整过配比，原批次冻结 v1 快照
  const lineRatio: Array<[string, string, number, Proportion['role'], string]> = [
    [SEED_IDS.materialChen, 'seed_prop_line_1', 46, '君', '陈化三年，去其燥气'],
    [SEED_IDS.materialTan, 'seed_prop_line_2', 29, '臣', '酒蒸后阴干，增其醇厚'],
    [SEED_IDS.materialRuxiang, 'seed_prop_line_3', 15, '佐', '乳香定香，缓其挥发'],
    [SEED_IDS.materialDing, 'seed_prop_line_4', 10, '使', '少许即足以引诸香']
  ]
  // 入窖冻结的旧配比（v1）
  const lineRatioV1: Array<[string, string, number, Proportion['role'], string]> = [
    [SEED_IDS.materialChen, 'seed_prop_line_1', 45, '君', '陈化三年，去其燥气'],
    [SEED_IDS.materialTan, 'seed_prop_line_2', 30, '臣', '酒蒸后阴干，增其醇厚'],
    [SEED_IDS.materialRuxiang, 'seed_prop_line_3', 15, '佐', '乳香定香，缓其挥发'],
    [SEED_IDS.materialDing, 'seed_prop_line_4', 10, '使', '少许即足以引诸香']
  ]
  const pillRatio: Array<[string, string, number, Proportion['role'], string]> = [
    [SEED_IDS.materialChen, 'seed_prop_pill_1', 40, '君', '取沉水者，香气沉静'],
    [SEED_IDS.materialRuxiang, 'seed_prop_pill_2', 35, '臣', '炼蜜时后下，保其香'],
    [SEED_IDS.materialDing, 'seed_prop_pill_3', 25, '佐', '压模前拌入']
  ]

  const formulas: Formula[] = [
    {
      id: SEED_IDS.formulaLine,
      name: '静室安神线香',
      scentType: '线香',
      usage: '静室',
      createdAt: '2024-03-12',
      totalRatio: 100,
      state: '在用',
      versionNo: 2,
      rev: 2,
      updatedAt: now
    },
    {
      id: SEED_IDS.formulaPill,
      name: '礼佛沉香丸',
      scentType: '香丸',
      usage: '礼佛',
      createdAt: '2024-05-08',
      totalRatio: 100,
      state: '在用',
      versionNo: 1,
      rev: 2,
      updatedAt: now
    },
    {
      id: SEED_IDS.formulaPlate,
      name: '佩香辟秽盘香',
      scentType: '盘香',
      usage: '佩香',
      createdAt: '2024-08-21',
      totalRatio: 0,
      state: '草稿',
      versionNo: 1,
      rev: 1,
      updatedAt: now
    }
  ]

  const materials: Material[] = [
    {
      id: SEED_IDS.materialChen,
      name: '海南沉香',
      origin: '海南尖峰岭',
      grade: '特级',
      processMethod: '生用',
      aromaNote: '清甜带凉，尾韵有蔗糖气',
      createdAt: '2024-02-18',
      updatedAt: now
    },
    {
      id: SEED_IDS.materialTan,
      name: '老山檀香',
      origin: '印度迈索尔',
      grade: '特级',
      processMethod: '酒蒸',
      aromaNote: '奶香厚重，留香绵长',
      createdAt: '2024-02-20',
      updatedAt: now
    },
    {
      id: SEED_IDS.materialRuxiang,
      name: '乳香',
      origin: '阿曼佐法尔',
      grade: '一级',
      processMethod: '醋浸',
      aromaNote: '树脂清香，微带柑橘前调',
      createdAt: '2024-04-02',
      updatedAt: now
    },
    {
      id: SEED_IDS.materialDing,
      name: '丁香',
      origin: '印尼马鲁古',
      grade: '二级',
      processMethod: '炒黄',
      aromaNote: '辛香穿透，少许即显',
      createdAt: '2024-04-06',
      updatedAt: now
    }
  ]

  const proportions: Proportion[] = []
  const buildProportions = (
    formulaId: string,
    rows: Array<[string, string, number, Proportion['role'], string]>
  ): void => {
    rows.forEach((row, index) => {
      proportions.push({
        id: row[1],
        formulaId,
        materialId: row[0],
        ratio: row[2],
        role: row[3],
        note: row[4],
        seq: index + 1,
        updatedAt: now
      })
    })
  }
  buildProportions(SEED_IDS.formulaLine, lineRatio)
  buildProportions(SEED_IDS.formulaPill, pillRatio)

  const toSnapshot = (rows: Array<[string, string, number, Proportion['role'], string]>) =>
    rows.map((row) => {
      const material = materials.find((item) => item.id === row[0])
      return {
        materialId: row[0],
        materialName: material?.name ?? '未知香料',
        ratio: row[2],
        role: row[3]
      }
    })

  const batches: Batch[] = [
    {
      id: SEED_IDS.batchLine,
      formulaId: SEED_IDS.formulaLine,
      mixedAt: '2024-04-01',
      formingMethod: '挤条',
      quantity: 320,
      operator: '林砚舟',
      snapshot: toSnapshot(lineRatioV1),
      snapshotAt: new Date('2024-04-01T09:00:00').getTime(),
      snapshotState: 'frozen',
      formulaVersionNo: 1,
      versionTrail: [
        {
          versionNo: 1,
          state: 'current',
          reason: '和香固化',
          at: new Date('2024-04-01T09:00:00').getTime(),
          note: '和香批次登记，固化当时配比'
        },
        {
          versionNo: 1,
          state: 'frozen',
          reason: '入窖冻结',
          at: new Date('2024-04-05T09:00:00').getTime(),
          note: '入窖窖藏，冻结原快照 v1'
        }
      ],
      updatedAt: now
    },
    {
      id: SEED_IDS.batchPill,
      formulaId: SEED_IDS.formulaPill,
      mixedAt: '2024-06-15',
      formingMethod: '炼蜜成丸',
      quantity: 120,
      operator: '周若谷',
      snapshot: toSnapshot(pillRatio),
      snapshotAt: new Date('2024-06-15T14:30:00').getTime(),
      snapshotState: 'current',
      formulaVersionNo: 1,
      versionTrail: [
        {
          versionNo: 1,
          state: 'current',
          reason: '和香固化',
          at: new Date('2024-06-15T14:30:00').getTime(),
          note: '和香批次登记，固化当时配比'
        }
      ],
      updatedAt: now
    },
    {
      // 旧档批次：缺快照、未入窖，等待人工复核，其品香不自动并入均分
      id: SEED_IDS.batchPlate,
      formulaId: SEED_IDS.formulaPill,
      mixedAt: '2024-08-02',
      formingMethod: '手搓',
      quantity: 60,
      operator: '周若谷',
      snapshot: [],
      snapshotAt: 0,
      snapshotState: 'pending_review',
      formulaVersionNo: 0,
      versionTrail: [
        {
          versionNo: 0,
          state: 'pending_review',
          reason: '档案补录',
          at: now,
          note: '旧档批次缺少配比快照，待人工复核'
        }
      ],
      updatedAt: now
    }
  ]

  const versions: FormulaVersion[] = [
    {
      id: SEED_IDS.verLineV1,
      formulaId: SEED_IDS.formulaLine,
      versionNo: 1,
      snapshot: toSnapshot(lineRatioV1),
      totalRatio: 100,
      reason: '建方',
      operator: '',
      createdAt: new Date('2024-03-12T10:00:00').getTime(),
      updatedAt: now
    },
    {
      id: SEED_IDS.verLineV2,
      formulaId: SEED_IDS.formulaLine,
      versionNo: 2,
      snapshot: toSnapshot(lineRatio),
      totalRatio: 100,
      reason: '配比调整',
      operator: '',
      createdAt: new Date('2024-09-01T10:00:00').getTime(),
      updatedAt: now
    },
    {
      id: SEED_IDS.verPillV1,
      formulaId: SEED_IDS.formulaPill,
      versionNo: 1,
      snapshot: toSnapshot(pillRatio),
      totalRatio: 100,
      reason: '建方',
      operator: '',
      createdAt: new Date('2024-05-08T10:00:00').getTime(),
      updatedAt: now
    },
    {
      id: SEED_IDS.verPlateV1,
      formulaId: SEED_IDS.formulaPlate,
      versionNo: 1,
      snapshot: [],
      totalRatio: 0,
      reason: '建方',
      operator: '',
      createdAt: new Date('2024-08-21T10:00:00').getTime(),
      updatedAt: now
    }
  ]

  const cellars: Cellar[] = [
    {
      id: SEED_IDS.cellarLine,
      batchId: SEED_IDS.batchLine,
      startDate: '2024-04-05',
      endDate: '2024-10-05',
      temperatureC: 22.5,
      humidityPct: 58,
      container: '陶罐',
      state: '窖藏中',
      formulaVersionNo: 1,
      updatedAt: now
    }
  ]

  const tastings: Tasting[] = [
    {
      id: SEED_IDS.tastingLine,
      batchId: SEED_IDS.batchLine,
      tastedAt: '2024-07-02',
      aroma: '初闻清甜，中段檀香渐起，尾调沉静',
      lastingMin: 65,
      smokeScore: 9,
      comment: '烟气柔和，静室午后一炷最宜（依据 v1 冻结方）',
      updatedAt: now
    },
    {
      // 挂在待复核批次上：不自动并入香方均分，待复核通过后才计入
      id: SEED_IDS.tastingPill,
      batchId: SEED_IDS.batchPlate,
      tastedAt: '2024-09-11',
      aroma: '蜜香裹沉香，凉意收尾',
      lastingMin: 48,
      smokeScore: 8,
      comment: '丸体稍硬，可再陈三月；批次快照待复核，暂不计入均分',
      updatedAt: now
    }
  ]

  await db.transaction(
    'rw',
    [
      db.formulas,
      db.materials,
      db.proportions,
      db.batches,
      db.cellars,
      db.tastings,
      db.formulaVersions,
      db.conflictDrafts
    ],
    async () => {
      await db.formulas.bulkPut(formulas)
      await db.materials.bulkPut(materials)
      await db.proportions.bulkPut(proportions)
      await db.batches.bulkPut(batches)
      await db.cellars.bulkPut(cellars)
      await db.tastings.bulkPut(tastings)
      await db.formulaVersions.bulkPut(versions)
    }
  )
}

/** 首屏初始化：打开数据库并在香方表为空时自动播种演示档案 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.formulas.count()) === 0) {
    await seedDatabase()
  }
}
