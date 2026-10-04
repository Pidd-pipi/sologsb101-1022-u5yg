import type { BatchSnapshotItem } from '@/types/batch'

/** 香方版本链：香方 / 配比 / 批次 / 窖藏共用同一条版本号序列 */
export interface FormulaVersion {
  id: string
  /** 所属香方 */
  formulaId: string
  /** 同一香方内自增的版本号，从 1 开始 */
  versionNo: number
  /** 该版本固化时的配比快照（按 seq 升序） */
  snapshot: BatchSnapshotItem[]
  /** 快照合计 */
  totalRatio: number
  /** 产生该版本的原因 */
  reason: VersionReason
  /** 操作人（批次登记 / 入窖等场景带出，手工改配比为空） */
  operator: string
  createdAt: number
  updatedAt: number
}

/** 版本产生原因 */
export type VersionReason = '建方' | '配比调整' | '和香固化' | '入窖冻结' | '档案补录'

export const VERSION_REASONS: VersionReason[] = ['建方', '配比调整', '和香固化', '入窖冻结', '档案补录']

/** 批次快照在版本链上的状态 */
export type SnapshotState = 'current' | 'frozen' | 'pending_review'

export const SNAPSHOT_STATE_LABEL: Record<SnapshotState, string> = {
  current: '现行（随新方重算）',
  frozen: '已冻结（入窖原方）',
  pending_review: '待复核（旧档缺快照）'
}

/** 批次版本链轨迹：每次快照重算 / 冻结 / 复核留痕 */
export interface BatchVersionTrail {
  /** 当时锚定的香方版本号 */
  versionNo: number
  /** 快照状态 */
  state: SnapshotState
  reason: VersionReason
  at: number
  note: string
}

/** 并发编辑冲突时，后保存者留下的草稿 */
export interface ConflictDraft {
  id: string
  /** 草稿类型：香方主档 / 配比明细 */
  kind: 'formula' | 'proportion'
  /** 冲突涉及的香方 */
  formulaId: string
  /** 来源（页面 / 标签页标识），便于追溯 */
  source: string
  /** 冲突发生时尝试保存的内容（JSON 串，按 kind 解析） */
  payload: string
  /** 打开编辑时所基于的修订号 */
  baseRev: number
  /** 保存失败时库里的最新修订号 */
  latestRev: number
  /** 是否已处理（应用 / 放弃）：0 未处理 / 1 已处理 */
  resolved: 0 | 1
  createdAt: number
  updatedAt: number
}

/** 配比冲突草稿的载荷结构 */
export interface ProportionDraftPayload {
  /** 新增行：无 id；修改 / 删除行有 id */
  items: Array<{
    proportionId: string | null
    materialId: string
    materialName: string
    ratio: number
    role: string
    note: string
    seq: number
    deleted: boolean
  }>
}

/** 香方主档冲突草稿的载荷结构 */
export interface FormulaDraftPayload {
  name: string
  scentType: string
  usage: string
  state: string
  createdAt: string
}

/** 快照逐味差异条目 */
export interface SnapshotDiffItem {
  materialId: string
  materialName: string
  /** 快照中的占比，快照缺该味为 null */
  snapshotRatio: number | null
  /** 当前配比中的占比，当前缺该味（已移除）为 null */
  currentRatio: number | null
  role: string
  /** 差异类型：一致 / 占比调整 / 已移除 / 新增 */
  kind: 'same' | 'changed' | 'removed' | 'added'
  delta: number | null
}

/** 入窖前快照比对结果 */
export interface SnapshotCheck {
  /** 严格一致（逐味 materialId + ratio + role 相同） */
  consistent: boolean
  diffs: SnapshotDiffItem[]
  /** 存在差异的条目数 */
  changedCount: number
}
