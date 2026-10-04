/** 和香批次：一次实际的配料与成型作业 */
export type FormingMethod = '挤条' | '手搓' | '压模' | '炼蜜成丸'

/** 批次生成时固化的配比快照条目，用于追溯改方前后的差异 */
export interface BatchSnapshotItem {
  materialId: string
  materialName: string
  ratio: number
  role: string
}

export interface Batch {
  id: string
  /** 所属香方 */
  formulaId: string
  /** 和香日期（ISO 日期串 yyyy-MM-dd） */
  mixedAt: string
  /** 成型方式：挤条/手搓/压模/炼蜜成丸 */
  formingMethod: FormingMethod
  /** 数量（支 / 丸 / 饼） */
  quantity: number
  /** 制香人 */
  operator: string
  /** 和香当刻固化的配比快照 */
  snapshot: BatchSnapshotItem[]
  /** 快照固化时间戳 */
  snapshotAt: number
  /** 快照状态：现行（随新方立即重算）/ 已冻结（入窖原方）/ 待复核（旧档缺快照） */
  snapshotState: import('@/types/version').SnapshotState
  /** 快照锚定的香方版本号；旧档缺失时为 0（待复核） */
  formulaVersionNo: number
  /** 批次在版本链上的留痕（重算 / 冻结 / 复核） */
  versionTrail: import('@/types/version').BatchVersionTrail[]
  updatedAt: number
}

export const FORMING_METHODS: FormingMethod[] = ['挤条', '手搓', '压模', '炼蜜成丸']

/** 批次列表行：批次 + 香方 + 窖藏状态 */
export interface BatchRow {
  batch: Batch
  formulaName: string
  /** 快照条目数 */
  snapshotCount: number
  /** 当前配比合计，用于对照快照差异 */
  currentRatioTotal: number
  /** 快照配比合计 */
  snapshotRatioTotal: number
  /** 快照状态标签 */
  snapshotState: import('@/types/version').SnapshotState
  /** 锚定的香方版本号 */
  formulaVersionNo: number
  /** 快照与当前配比是否一致（逐味比对） */
  consistent: boolean
  /** 是否已进入窖藏 */
  cellared: boolean
  cellarState: string
}

/** 批次筛选条件 */
export interface BatchFilterState {
  keyword: string
  formulas: string[]
  formingMethods: FormingMethod[]
}

export function createEmptyBatchFilter(): BatchFilterState {
  return { keyword: '', formulas: [], formingMethods: [] }
}
