/** 版本链：香方配比快照、版本差异与复核状态 */

/** 某一版配比的固化快照条目（与批次快照结构一致，便于逐味比对） */
export interface VersionSnapshotItem {
  materialId: string
  materialName: string
  ratio: number
  role: string
}

/**
 * 香方版本记录：每次配比调整都生成一条不可变记录，
 * 形成 香方 → 配比 → 批次 → 窖藏 共用的版本链。
 */
export interface FormulaVersion {
  id: string
  /** 所属香方 */
  formulaId: string
  /** 版本号，同一香方内从 1 递增 */
  version: number
  /** 该版本固化的配比快照 */
  snapshot: VersionSnapshotItem[]
  /** 成版时间戳 */
  changedAt: number
  /** 成版说明，如「君臣佐使配比调整」 */
  changeNote: string
  /** 上一版本号（首版为 0） */
  basedOn: number
}

/** 单味香料的差异条目 */
export interface SnapshotDiffItem {
  materialId: string
  materialName: string
  /** added=当前方新增 / removed=当前方移除 / changed=占比或角色变化 */
  kind: 'added' | 'removed' | 'changed'
  oldRatio: number | null
  newRatio: number | null
  oldRole: string | null
  newRole: string | null
  /** 占比差值（新 - 旧），仅 changed 时有意义 */
  ratioDelta: number | null
}

/** 快照与当前配比的逐味差异汇总 */
export interface SnapshotDiff {
  /** 是否完全一致（无新增 / 移除 / 变化） */
  matched: boolean
  added: SnapshotDiffItem[]
  removed: SnapshotDiffItem[]
  changed: SnapshotDiffItem[]
}

/** 批次复核状态：ok=快照有效 / pending=缺快照待复核（不并入品香均分） */
export type BatchReviewState = 'ok' | 'pending'

export const BATCH_REVIEW_STATES: BatchReviewState[] = ['ok', 'pending']

export const BATCH_REVIEW_LABEL: Record<BatchReviewState, string> = {
  ok: '快照有效',
  pending: '待复核'
}

/** 香方编辑冲突时留存的草稿 */
export interface FormulaDraft {
  formulaId: string
  /** 冲突时另一页面已保存的版本号 */
  conflictVersion: number
  /** 冲突时另一页面已保存的时间戳 */
  conflictAt: number
  /** 本页面未保存的编辑内容 */
  patch: {
    name?: string
    scentType?: string
    usage?: string
    state?: string
    createdAt?: string
  }
  savedAt: number
}

/** 空差异，用于初始化与无差异场景 */
export function emptyDiff(): SnapshotDiff {
  return { matched: true, added: [], removed: [], changed: [] }
}
