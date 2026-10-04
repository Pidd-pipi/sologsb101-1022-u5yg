import {
  db,
  DB_VERSION,
  createId,
  stampBackupTime,
  exportSnapshot,
  importSnapshot,
  type IncenseSnapshot
} from '@/utils/db'
import {
  FORMULA_STATES,
  SCENT_TYPES,
  USAGE_SCENES,
  type Formula,
  type FormulaState,
  type ScentType,
  type UsageScene
} from '@/types/formula'
import { MATERIAL_GRADES, PROCESS_METHODS, type Material, type MaterialGrade, type ProcessMethod } from '@/types/material'
import { PROPORTION_ROLES, type Proportion, type ProportionRole } from '@/types/proportion'
import { FORMING_METHODS, type Batch, type FormingMethod } from '@/types/batch'
import { CELLAR_CONTAINERS, CELLAR_STATES, type Cellar, type CellarState, type CellarContainer } from '@/types/cellar'
import type { Tasting } from '@/types/tasting'
import type { FormulaVersion } from '@/types/version'

/** 单方香方导出文件结构：一个香方 + 其配比与版本链 + 派生批次、窖藏、品香 */
export interface FormulaExportPayload {
  app: 'gbincense'
  kind: 'formula'
  dbVersion: number
  exportedAt: string
  formula: Formula
  proportions: Proportion[]
  batches: Batch[]
  cellars: Cellar[]
  tastings: Tasting[]
  /** 该香方的版本链 */
  formulaVersions: FormulaVersion[]
  /** 台账依据：当前版本号、待复核批次数、各窖藏锚定版本 */
  ledger: {
    currentVersionNo: number
    pendingBatchCount: number
    frozenBatchCount: number
    /** 品香均分计入的批次 id（待复核批次不在其中） */
    scoreBatchIds: string[]
    exportedBy: 'formula-ledger'
  }
  /** 导出时一并携带被引用的香料主档，便于跨设备还原 */
  materials: Material[]
}

export interface ValidateResult<T> {
  ok: boolean
  errors: string[]
  payload: T | null
}

const MATERIAL_GRADE_SET = new Set<string>(MATERIAL_GRADES)
const PROCESS_METHOD_SET = new Set<string>(PROCESS_METHODS)
const SCENT_TYPE_SET = new Set<string>(SCENT_TYPES)
const USAGE_SET = new Set<string>(USAGE_SCENES)
const FORMULA_STATE_SET = new Set<string>(FORMULA_STATES)
const ROLE_SET = new Set<string>(PROPORTION_ROLES)
const FORMING_SET = new Set<string>(FORMING_METHODS)
const CELLAR_STATE_SET = new Set<string>(CELLAR_STATES)
const CELLAR_CONTAINER_SET = new Set<string>(CELLAR_CONTAINERS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function pickEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback
}

/** 把香方及其下游数据整理成导出结构 */
export async function buildFormulaPayload(formulaId: string): Promise<FormulaExportPayload | null> {
  const formula = await db.formulas.get(formulaId)
  if (!formula) return null
  const [proportions, batches] = await Promise.all([
    db.proportions.where('formulaId').equals(formulaId).toArray(),
    db.batches.where('formulaId').equals(formulaId).toArray()
  ])
  const batchIds = batches.map((batch) => batch.id)
  const [cellars, tastings] = await Promise.all([
    batchIds.length > 0 ? db.cellars.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([]),
    batchIds.length > 0 ? db.tastings.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([])
  ])
  const materialIds = Array.from(new Set(proportions.map((item) => item.materialId)))
  const [materials, formulaVersions] = await Promise.all([
    materialIds.length > 0 ? db.materials.where('id').anyOf(materialIds).toArray() : Promise.resolve([]),
    db.formulaVersions.where('formulaId').equals(formulaId).toArray()
  ])
  return {
    app: 'gbincense',
    kind: 'formula',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    formula,
    proportions: proportions.sort((a, b) => a.seq - b.seq),
    batches,
    cellars,
    tastings,
    formulaVersions: formulaVersions.sort((a, b) => a.versionNo - b.versionNo),
    ledger: {
      currentVersionNo: formula.versionNo,
      pendingBatchCount: batches.filter((batch) => batch.snapshotState === 'pending_review').length,
      frozenBatchCount: batches.filter((batch) => batch.snapshotState === 'frozen').length,
      scoreBatchIds: batches.filter((batch) => batch.snapshotState !== 'pending_review').map((batch) => batch.id),
      exportedBy: 'formula-ledger'
    },
    materials
  }
}

/** 导出单个香方为 JSON 文件并触发下载 */
export async function exportFormulaJson(formulaId: string): Promise<{ fileName: string; counts: Record<string, number> }> {
  const payload = await buildFormulaPayload(formulaId)
  if (!payload) throw new Error('香方不存在，无法导出')
  const fileName = `gbincense-formula-${payload.formula.name}-${payload.exportedAt.slice(0, 10)}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      proportions: payload.proportions.length,
      batches: payload.batches.length,
      cellars: payload.cellars.length,
      tastings: payload.tastings.length,
      materials: payload.materials.length
    }
  }
}

/** 导出全量本地快照为 JSON 文件 */
export async function exportSnapshotJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const snapshot = await exportSnapshot()
  const fileName = `gbincense-snapshot-v${snapshot.dbVersion}-${snapshot.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(snapshot.exportedAt)
  return {
    fileName,
    counts: {
      formulas: snapshot.formulas.length,
      materials: snapshot.materials.length,
      proportions: snapshot.proportions.length,
      batches: snapshot.batches.length,
      cellars: snapshot.cellars.length,
      tastings: snapshot.tastings.length,
      formulaVersions: snapshot.formulaVersions.length,
      conflictDrafts: snapshot.conflictDrafts.length
    }
  }
}

function parseFormula(input: unknown, errors: string[]): Formula | null {
  if (!isRecord(input)) {
    errors.push('formula 字段不是合法的对象')
    return null
  }
  const name = asString(input.name).trim()
  if (name.length === 0) errors.push('香方缺少 name 字段')
  const scentType = pickEnum<ScentType>(input.scentType, SCENT_TYPE_SET, '线香')
  if (typeof input.scentType !== 'string' || !SCENT_TYPE_SET.has(input.scentType)) {
    errors.push(`scentType 取值非法：${String(input.scentType)}`)
  }
  const usage = pickEnum<UsageScene>(input.usage, USAGE_SET, '静室')
  if (typeof input.usage !== 'string' || !USAGE_SET.has(input.usage)) {
    errors.push(`usage 取值非法：${String(input.usage)}`)
  }
  const state = pickEnum<FormulaState>(input.state, FORMULA_STATE_SET, '草稿')
  const createdAt = asString(input.createdAt, new Date().toISOString().slice(0, 10))
  const totalRatio = asNumber(input.totalRatio, 0)
  if (errors.length > 0) return null
  return {
    id: asString(input.id, createId('formula')),
    name,
    scentType,
    usage,
    createdAt,
    totalRatio,
    state,
    versionNo: asNumber(input.versionNo, 1) || 1,
    rev: asNumber(input.rev, 1) || 1,
    updatedAt: asNumber(input.updatedAt, Date.now())
  }
}

function parseMaterial(raw: unknown, errors: string[], index: number): Material | null {
  if (!isRecord(raw)) {
    errors.push(`materials[${index}] 不是合法对象`)
    return null
  }
  const name = asString(raw.name).trim()
  if (name.length === 0) {
    errors.push(`materials[${index}] 缺少 name`)
    return null
  }
  if (typeof raw.grade === 'string' && !MATERIAL_GRADE_SET.has(raw.grade)) {
    errors.push(`materials[${index}] grade 取值非法：${raw.grade}`)
    return null
  }
  if (typeof raw.processMethod === 'string' && !PROCESS_METHOD_SET.has(raw.processMethod)) {
    errors.push(`materials[${index}] processMethod 取值非法：${raw.processMethod}`)
    return null
  }
  return {
    id: asString(raw.id, createId('material')),
    name,
    origin: asString(raw.origin, '未记录'),
    grade: pickEnum<MaterialGrade>(raw.grade, MATERIAL_GRADE_SET, '二级'),
    processMethod: pickEnum<ProcessMethod>(raw.processMethod, PROCESS_METHOD_SET, '生用'),
    aromaNote: asString(raw.aromaNote),
    createdAt: asString(raw.createdAt, new Date().toISOString().slice(0, 10)),
    updatedAt: asNumber(raw.updatedAt, Date.now())
  }
}

/**
 * 校验并规范化导入的香方 JSON。
 * 校验失败时返回 errors，调用方据此给出 ElMessage 提示。
 */
export function validateFormulaJson(input: unknown): ValidateResult<FormulaExportPayload> {
  const errors: string[] = []
  if (!isRecord(input)) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  if (input.app !== 'gbincense') errors.push('app 字段应为 gbincense，文件来源不明')
  if (input.kind !== undefined && input.kind !== 'formula') errors.push('kind 字段应为 formula')
  const formula = parseFormula(input.formula, errors)
  if (!Array.isArray(input.proportions)) {
    errors.push('proportions 字段缺失或不是数组')
  }
  if (!Array.isArray(input.materials)) {
    errors.push('materials 字段缺失或不是数组')
  }
  if (errors.length > 0 || !formula) {
    return { ok: false, errors: errors.length > 0 ? errors : ['香方解析失败'], payload: null }
  }

  const materialIds = new Set<string>()
  const materials: Material[] = []
  ;(input.materials as unknown[]).forEach((raw, index) => {
    const material = parseMaterial(raw, errors, index)
    if (material) {
      materials.push(material)
      materialIds.add(material.id)
    }
  })

  const proportions: Proportion[] = []
  ;(input.proportions as unknown[]).forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`proportions[${index}] 不是合法对象`)
      return
    }
    const materialId = asString(raw.materialId)
    if (materialId.length === 0) {
      errors.push(`proportions[${index}] 缺少 materialId`)
      return
    }
    if (typeof raw.role !== 'string' || !ROLE_SET.has(raw.role)) {
      errors.push(`proportions[${index}] role 取值非法：${String(raw.role)}`)
      return
    }
    const ratio = asNumber(raw.ratio, 0)
    if (ratio < 0 || ratio > 100) {
      errors.push(`proportions[${index}] ratio 应在 0 ~ 100 之间`)
      return
    }
    proportions.push({
      id: asString(raw.id, createId('prop')),
      formulaId: formula.id,
      materialId,
      ratio,
      role: raw.role as ProportionRole,
      note: asString(raw.note),
      seq: asNumber(raw.seq, index + 1),
      updatedAt: asNumber(raw.updatedAt, Date.now())
    })
  })

  const batches: Batch[] = []
  const rawBatches = Array.isArray(input.batches) ? (input.batches as unknown[]) : []
  rawBatches.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`batches[${index}] 不是合法对象`)
      return
    }
    if (typeof raw.formingMethod === 'string' && !FORMING_SET.has(raw.formingMethod)) {
      errors.push(`batches[${index}] formingMethod 取值非法：${raw.formingMethod}`)
      return
    }
    const snapshot = Array.isArray(raw.snapshot)
      ? (raw.snapshot as unknown[]).filter(isRecord).map((item) => ({
          materialId: asString(item.materialId),
          materialName: asString(item.materialName, '未知香料'),
          ratio: asNumber(item.ratio, 0),
          role: asString(item.role, '君')
        }))
      : []
    const snapshotState = raw.snapshotState === 'frozen' || raw.snapshotState === 'pending_review' ? raw.snapshotState : 'current'
    batches.push({
      id: asString(raw.id, createId('batch')),
      formulaId: formula.id,
      mixedAt: asString(raw.mixedAt, new Date().toISOString().slice(0, 10)),
      formingMethod: pickEnum<FormingMethod>(raw.formingMethod, FORMING_SET, '挤条'),
      quantity: asNumber(raw.quantity, 0),
      operator: asString(raw.operator),
      snapshot,
      snapshotAt: asNumber(raw.snapshotAt, 0),
      snapshotState: snapshot.length === 0 ? 'pending_review' : snapshotState,
      formulaVersionNo: asNumber(raw.formulaVersionNo, 0),
      versionTrail: Array.isArray(raw.versionTrail)
        ? (raw.versionTrail as unknown[]).filter(isRecord).map((item) => ({
            versionNo: asNumber(item.versionNo, 0),
            state:
              item.state === 'frozen' || item.state === 'current' || item.state === 'pending_review'
                ? (item.state as import('@/types/version').SnapshotState)
                : 'current',
            reason: asString(item.reason, '档案补录') as import('@/types/version').VersionReason,
            at: asNumber(item.at, Date.now()),
            note: asString(item.note)
          }))
        : [],
      updatedAt: asNumber(raw.updatedAt, Date.now())
    })
  })

  const batchIds = new Set(batches.map((batch) => batch.id))
  const cellars: Cellar[] = []
  const rawCellars = Array.isArray(input.cellars) ? (input.cellars as unknown[]) : []
  rawCellars.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`cellars[${index}] 不是合法对象`)
      return
    }
    if (typeof raw.state === 'string' && !CELLAR_STATE_SET.has(raw.state)) {
      errors.push(`cellars[${index}] state 取值非法：${raw.state}`)
      return
    }
    const batchId = asString(raw.batchId)
    if (batchId.length === 0 || !batchIds.has(batchId)) {
      errors.push(`cellars[${index}] batchId 无法对应到本次导入的批次`)
      return
    }
    cellars.push({
      id: asString(raw.id, createId('cellar')),
      batchId,
      startDate: asString(raw.startDate, new Date().toISOString().slice(0, 10)),
      endDate: asString(raw.endDate, new Date().toISOString().slice(0, 10)),
      temperatureC: asNumber(raw.temperatureC, 22),
      humidityPct: asNumber(raw.humidityPct, 60),
      container: pickEnum<CellarContainer>(raw.container, CELLAR_CONTAINER_SET, '陶罐'),
      state: pickEnum<CellarState>(raw.state, CELLAR_STATE_SET, '窖藏中'),
      formulaVersionNo: asNumber(raw.formulaVersionNo, 0),
      updatedAt: asNumber(raw.updatedAt, Date.now())
    })
  })

  const tastings: Tasting[] = []
  const rawTastings = Array.isArray(input.tastings) ? (input.tastings as unknown[]) : []
  rawTastings.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`tastings[${index}] 不是合法对象`)
      return
    }
    const batchId = asString(raw.batchId)
    if (batchId.length === 0 || !batchIds.has(batchId)) {
      errors.push(`tastings[${index}] batchId 无法对应到本次导入的批次`)
      return
    }
    const smokeScore = asNumber(raw.smokeScore, 0)
    if (smokeScore < 1 || smokeScore > 10) {
      errors.push(`tastings[${index}] smokeScore 应在 1 ~ 10 之间`)
      return
    }
    tastings.push({
      id: asString(raw.id, createId('tasting')),
      batchId,
      tastedAt: asString(raw.tastedAt, new Date().toISOString().slice(0, 10)),
      aroma: asString(raw.aroma),
      lastingMin: asNumber(raw.lastingMin, 0),
      smokeScore,
      comment: asString(raw.comment),
      updatedAt: asNumber(raw.updatedAt, Date.now())
    })
  })

  const formulaVersions: FormulaVersion[] = []
  const rawVersions = Array.isArray(input.formulaVersions) ? (input.formulaVersions as unknown[]) : []
  rawVersions.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`formulaVersions[${index}] 不是合法对象`)
      return
    }
    const snapshot = Array.isArray(raw.snapshot)
      ? (raw.snapshot as unknown[]).filter(isRecord).map((item) => ({
          materialId: asString(item.materialId),
          materialName: asString(item.materialName, '未知香料'),
          ratio: asNumber(item.ratio, 0),
          role: asString(item.role, '君')
        }))
      : []
    formulaVersions.push({
      id: asString(raw.id, createId('fver')),
      formulaId: formula.id,
      versionNo: asNumber(raw.versionNo, index + 1) || index + 1,
      snapshot,
      totalRatio: asNumber(raw.totalRatio, 0),
      reason: asString(raw.reason, '建方') as FormulaVersion['reason'],
      operator: asString(raw.operator),
      createdAt: asNumber(raw.createdAt, Date.now()),
      updatedAt: asNumber(raw.updatedAt, Date.now())
    })
  })

  if (errors.length > 0) return { ok: false, errors, payload: null }

  return {
    ok: true,
    errors: [],
    payload: {
      app: 'gbincense',
      kind: 'formula',
      dbVersion: asNumber(input.dbVersion, DB_VERSION),
      exportedAt: asString(input.exportedAt, new Date().toISOString()),
      formula,
      proportions,
      batches,
      cellars,
      tastings,
      formulaVersions,
      ledger: isRecord(input.ledger)
        ? {
            currentVersionNo: asNumber(input.ledger.currentVersionNo, formula.versionNo),
            pendingBatchCount: asNumber(input.ledger.pendingBatchCount, 0),
            frozenBatchCount: asNumber(input.ledger.frozenBatchCount, 0),
            scoreBatchIds: Array.isArray(input.ledger.scoreBatchIds)
              ? (input.ledger.scoreBatchIds as unknown[]).map((item) => String(item))
              : batches.filter((batch) => batch.snapshotState !== 'pending_review').map((batch) => batch.id),
            exportedBy: 'formula-ledger'
          }
        : {
            currentVersionNo: formula.versionNo,
            pendingBatchCount: batches.filter((batch) => batch.snapshotState === 'pending_review').length,
            frozenBatchCount: batches.filter((batch) => batch.snapshotState === 'frozen').length,
            scoreBatchIds: batches.filter((batch) => batch.snapshotState !== 'pending_review').map((batch) => batch.id),
            exportedBy: 'formula-ledger' as const
          },
      materials
    }
  }
}

/** 校验全量快照 JSON */
export function validateSnapshotJson(input: unknown): ValidateResult<IncenseSnapshot> {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  if (input.app !== 'gbincense') errors.push('app 字段应为 gbincense，文件来源不明')
  const keys = ['formulas', 'materials', 'proportions', 'batches', 'cellars', 'tastings'] as const
  keys.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const snapshot = input as unknown as IncenseSnapshot
  // 兼容 v2 导出：补齐版本链与冲突草稿表
  if (!Array.isArray(snapshot.formulaVersions)) snapshot.formulaVersions = []
  if (!Array.isArray(snapshot.conflictDrafts)) snapshot.conflictDrafts = []
  return { ok: true, errors: [], payload: snapshot }
}

/**
 * 导入单个香方：remap 为新的 id 后整体落库，避免覆盖同名香方。
 * 返回新建香方 id 与写入条数。
 */
export async function importFormulaPayload(
  payload: FormulaExportPayload
): Promise<{ formulaId: string; counts: Record<string, number> }> {
  const formulaId = createId('formula')
  const materialIdMap = new Map<string, string>()
  const batchIdMap = new Map<string, string>()

  const now = Date.now()
  const formula: Formula = { ...payload.formula, id: formulaId, updatedAt: now, rev: 1 }
  const materials: Material[] = payload.materials.map((material) => {
    const id = createId('material')
    materialIdMap.set(material.id, id)
    return { ...material, id, updatedAt: now }
  })
  const proportions: Proportion[] = payload.proportions.map((proportion, index) => ({
    ...proportion,
    id: createId('prop'),
    formulaId,
    materialId: materialIdMap.get(proportion.materialId) ?? proportion.materialId,
    seq: proportion.seq > 0 ? proportion.seq : index + 1,
    updatedAt: now
  }))
  const batches: Batch[] = payload.batches.map((batch) => {
    const id = createId('batch')
    batchIdMap.set(batch.id, id)
    return {
      ...batch,
      id,
      formulaId,
      snapshot: batch.snapshot.map((item) => ({
        ...item,
        materialId: materialIdMap.get(item.materialId) ?? item.materialId,
        materialName:
          materials.find((material) => material.id === (materialIdMap.get(item.materialId) ?? item.materialId))?.name ??
          item.materialName
      })),
      versionTrail: Array.isArray(batch.versionTrail)
        ? batch.versionTrail
        : [
            {
              versionNo: batch.formulaVersionNo || 1,
              state: batch.snapshotState,
              reason: '档案补录' as const,
              at: batch.snapshotAt || now,
              note: '随香方导入补登轨迹'
            }
          ],
      updatedAt: now
    }
  })

  // 版本链重排为从 v1 起的连续编号，并改写快照中的香料 id；无版本链时以当前配比补 v1
  const sortedVersions = [...payload.formulaVersions].sort((a, b) => a.versionNo - b.versionNo)
  const remappedVersions: FormulaVersion[] = sortedVersions.map((version, index) => ({
    ...version,
    id: createId('fver'),
    formulaId,
    versionNo: index + 1,
    snapshot: version.snapshot.map((item) => ({
      ...item,
      materialId: materialIdMap.get(item.materialId) ?? item.materialId
    }))
  }))
  if (remappedVersions.length === 0 && proportions.length > 0) {
    remappedVersions.push({
      id: createId('fver'),
      formulaId,
      versionNo: 1,
      snapshot: proportions.map((proportion) => ({
        materialId: proportion.materialId,
        materialName: materials.find((material) => material.id === proportion.materialId)?.name ?? '香料已删除',
        ratio: proportion.ratio,
        role: proportion.role
      })),
      totalRatio: formula.totalRatio,
      reason: '建方',
      operator: '',
      createdAt: now,
      updatedAt: now
    })
  }
  // 批次锚定版本号映射（旧版本号 → 重排后版本号）
  const versionNoMap = new Map<number, number>()
  sortedVersions.forEach((version, index) => versionNoMap.set(version.versionNo, index + 1))
  batches.forEach((batch) => {
    if (batch.formulaVersionNo > 0) {
      batch.formulaVersionNo = versionNoMap.get(batch.formulaVersionNo) ?? batch.formulaVersionNo
    }
    batch.versionTrail = (batch.versionTrail ?? []).map((trail) => ({
      ...trail,
      versionNo: trail.versionNo > 0 ? versionNoMap.get(trail.versionNo) ?? trail.versionNo : 0
    }))
  })
  formula.versionNo = remappedVersions.length > 0 ? remappedVersions[remappedVersions.length - 1].versionNo : 1

  const cellars: Cellar[] = payload.cellars
    .filter((cellar) => batchIdMap.has(cellar.batchId))
    .map((cellar) => ({
      ...cellar,
      id: createId('cellar'),
      batchId: batchIdMap.get(cellar.batchId) as string,
      formulaVersionNo:
        batches.find((batch) => batch.id === batchIdMap.get(cellar.batchId))?.formulaVersionNo ??
        cellar.formulaVersionNo ??
        0,
      updatedAt: now
    }))
  const tastings: Tasting[] = payload.tastings
    .filter((tasting) => batchIdMap.has(tasting.batchId))
    .map((tasting) => ({
      ...tasting,
      id: createId('tasting'),
      batchId: batchIdMap.get(tasting.batchId) as string,
      updatedAt: now
    }))

  await db.transaction(
    'rw',
    [
      db.formulas,
      db.materials,
      db.proportions,
      db.batches,
      db.cellars,
      db.tastings,
      db.formulaVersions
    ],
    async () => {
      await db.formulas.put(formula)
      if (materials.length > 0) await db.materials.bulkPut(materials)
      if (proportions.length > 0) await db.proportions.bulkPut(proportions)
      if (remappedVersions.length > 0) await db.formulaVersions.bulkPut(remappedVersions)
      if (batches.length > 0) await db.batches.bulkPut(batches)
      if (cellars.length > 0) await db.cellars.bulkPut(cellars)
      if (tastings.length > 0) await db.tastings.bulkPut(tastings)
    }
  )

  return {
    formulaId,
    counts: {
      materials: materials.length,
      proportions: proportions.length,
      batches: batches.length,
      cellars: cellars.length,
      tastings: tastings.length
    }
  }
}

/** 覆盖式导入全量快照 */
export async function importSnapshotPayload(
  snapshot: IncenseSnapshot,
  overwrite: boolean
): Promise<Record<string, number>> {
  await importSnapshot(snapshot, overwrite)
  await reconcileImportedVersionChain(snapshot)
  return {
    formulas: snapshot.formulas.length,
    materials: snapshot.materials.length,
    proportions: snapshot.proportions.length,
    batches: snapshot.batches.length,
    cellars: snapshot.cellars.length,
    tastings: snapshot.tastings.length
  }
}

/**
 * 导入对账：为缺少版本字段的旧版记录补齐版本链。
 * - 香方缺 versionNo / rev：按当前配比补 v1；
 * - 批次缺快照：置为待复核；有快照但缺状态：未入窖现行 / 已入窖冻结；
 * - 窖藏缺依据版本：取批次锚定版本。
 */
async function reconcileImportedVersionChain(snapshot: IncenseSnapshot): Promise<void> {
  const now = Date.now()
  const propsByFormula = new Map<string, Proportion[]>()
  snapshot.proportions.forEach((proportion) => {
    const list = propsByFormula.get(proportion.formulaId) ?? []
    list.push(proportion)
    propsByFormula.set(proportion.formulaId, list)
  })
  const cellaredBatchIds = new Set(snapshot.cellars.map((cellar) => cellar.batchId))
  const materialNames = new Map(snapshot.materials.map((material) => [material.id, material.name]))
  const existingVersions = new Set(snapshot.formulaVersions.map((version) => version.id))
  const appendedVersions: FormulaVersion[] = []
  let formulasChanged = false
  let batchesChanged = false
  let cellarsChanged = false

  for (const formula of snapshot.formulas) {
    if (typeof formula.versionNo !== 'number' || formula.versionNo < 1) formula.versionNo = 1
    if (typeof formula.rev !== 'number' || formula.rev < 1) formula.rev = 1
    const hasVersion = snapshot.formulaVersions.some((version) => version.formulaId === formula.id)
    if (!hasVersion) {
      const list = (propsByFormula.get(formula.id) ?? []).slice().sort((a, b) => a.seq - b.seq)
      appendedVersions.push({
        id: createId('fver'),
        formulaId: formula.id,
        versionNo: 1,
        snapshot: list.map((proportion) => ({
          materialId: proportion.materialId,
          materialName: materialNames.get(proportion.materialId) ?? '香料已删除',
          ratio: proportion.ratio,
          role: proportion.role
        })),
        totalRatio: formula.totalRatio,
        reason: '档案补录',
        operator: '',
        createdAt: now,
        updatedAt: now
      })
    }
    formulasChanged = true
  }

  for (const batch of snapshot.batches) {
    if (!Array.isArray(batch.versionTrail)) batch.versionTrail = []
    if (!Array.isArray(batch.snapshot) || batch.snapshot.length === 0) {
      batch.snapshot = Array.isArray(batch.snapshot) ? batch.snapshot : []
      batch.snapshotState = 'pending_review'
      batch.formulaVersionNo = 0
      batch.versionTrail.push({
        versionNo: 0,
        state: 'pending_review',
        reason: '档案补录',
        at: now,
        note: '导入记录缺快照，置为待复核'
      })
    } else if (batch.snapshotState !== 'frozen' && batch.snapshotState !== 'current') {
      batch.snapshotState = cellaredBatchIds.has(batch.id) ? 'frozen' : 'current'
      batch.formulaVersionNo = batch.formulaVersionNo || 1
    }
    batchesChanged = true
  }

  for (const cellar of snapshot.cellars) {
    if (typeof cellar.formulaVersionNo !== 'number' || cellar.formulaVersionNo < 1) {
      const batch = snapshot.batches.find((item) => item.id === cellar.batchId)
      cellar.formulaVersionNo = batch?.formulaVersionNo ?? 0
      cellarsChanged = true
    }
  }

  const newVersions = appendedVersions.filter((version) => !existingVersions.has(version.id))
  if (newVersions.length === 0 && !formulasChanged && !batchesChanged && !cellarsChanged) return

  await db.transaction(
    'rw',
    [db.formulas, db.batches, db.cellars, db.formulaVersions],
    async () => {
      if (newVersions.length > 0) await db.formulaVersions.bulkPut(newVersions)
      if (batchesChanged) await db.batches.bulkPut(snapshot.batches)
      if (cellarsChanged) await db.cellars.bulkPut(snapshot.cellars)
      if (formulasChanged) await db.formulas.bulkPut(snapshot.formulas)
    }
  )
}

/** 读取用户选择的本地文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}
