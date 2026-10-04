import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, createId, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  clearFormulaDraft,
  readAllFormulaDrafts,
  readFormulaDraft,
  saveFormulaDraft
} from '@/utils/version'
import type { FormulaDraft } from '@/types/version'
import type { Batch } from '@/types/batch'
import type { Tasting } from '@/types/tasting'
import {
  createEmptyFormulaFilter,
  FORMULA_STATE_FLOW,
  type Formula,
  type FormulaCard,
  type FormulaFilterState,
  type FormulaState,
  type ScentType,
  type UsageScene
} from '@/types/formula'
import { round } from '@/utils/ratio'

/**
 * 香方 store：维护香方列表、当前选中香方与跨页筛选条件，
 * 并派生出配比香料数与品香均分（卡片回显）。
 */
export const useFormulaStore = defineStore('formula', () => {
  const formulaTable = useIdbTable<Formula>((database) => database.formulas)
  const batchTable = useIdbTable<Batch>((database) => database.batches)
  const tastingTable = useIdbTable<Tasting>((database) => database.tastings)

  const prefs = readUiPrefs()
  const currentFormulaId = ref<string | null>(prefs.lastFormulaId)
  const filter = ref<FormulaFilterState>(createEmptyFormulaFilter())
  const materialCountMap = ref<Record<string, number>>({})

  watch(currentFormulaId, (value) => {
    writeUiPrefs({ ...readUiPrefs(), lastFormulaId: value })
  })

  const formulas = computed<Formula[]>(() => formulaTable.rows.value)
  const batches = computed<Batch[]>(() => batchTable.rows.value)
  const tastings = computed<Tasting[]>(() => tastingTable.rows.value)
  const loading = computed(() => formulaTable.loading.value)
  const ready = computed(() => formulaTable.ready.value)
  const error = computed(() => formulaTable.error.value)

  const currentFormula = computed<Formula | null>(
    () => formulas.value.find((formula) => formula.id === currentFormulaId.value) ?? null
  )

  /** 香方 id → 配比条数（由配比 store 同步，避免重复订阅同一张表） */
  function setMaterialCountMap(map: Record<string, number>): void {
    materialCountMap.value = map
  }

  /** 香方 id → 品香评鉴列表 */
  const tastingsByFormula = computed<Record<string, Tasting[]>>(() => {
    const batchToFormula = new Map<string, string>()
    batches.value.forEach((batch) => batchToFormula.set(batch.id, batch.formulaId))
    const grouped: Record<string, Tasting[]> = {}
    tastings.value.forEach((tasting) => {
      const formulaId = batchToFormula.get(tasting.batchId)
      if (!formulaId) return
      const list = grouped[formulaId] ?? []
      list.push(tasting)
      grouped[formulaId] = list
    })
    return grouped
  })

  const batchesByFormula = computed<Record<string, Batch[]>>(() => {
    const grouped: Record<string, Batch[]> = {}
    batches.value.forEach((batch) => {
      const list = grouped[batch.formulaId] ?? []
      list.push(batch)
      grouped[batch.formulaId] = list
    })
    return grouped
  })

  /** 待复核（缺快照）批次 id 集合：其品香不自动并入香方均分 */
  const pendingBatchIds = computed<Set<string>>(
    () => new Set(batches.value.filter((batch) => batch.reviewState === 'pending').map((batch) => batch.id))
  )

  /** 待复核批次数量，供台账与品香页提示 */
  const pendingBatchCount = computed(() => pendingBatchIds.value.size)

  /** 同香方全部品香的评分均分（待复核批次的品香不并入） */
  const scoreAggregates = computed<Record<string, { count: number; average: number; latestAt: string }>>(() => {
    const aggregate: Record<string, { count: number; average: number; latestAt: string }> = {}
    Object.entries(tastingsByFormula.value).forEach(([formulaId, list]) => {
      const valid = list.filter((item) => !pendingBatchIds.value.has(item.batchId))
      if (valid.length === 0) return
      const sum = valid.reduce((acc, item) => acc + item.smokeScore, 0)
      const latest = [...valid].sort((a, b) => b.tastedAt.localeCompare(a.tastedAt))[0]
      aggregate[formulaId] = {
        count: valid.length,
        average: round(sum / valid.length, 1),
        latestAt: latest?.tastedAt ?? ''
      }
    })
    return aggregate
  })

  /** 香方台账卡片：配比合计、香料数、品香均分、批次数量 */
  const cards = computed<FormulaCard[]>(() =>
    formulas.value.map((formula) => {
      const aggregate = scoreAggregates.value[formula.id]
      const formulaTastings = tastingsByFormula.value[formula.id] ?? []
      const latest = [...formulaTastings].sort((a, b) => b.tastedAt.localeCompare(a.tastedAt))[0]
      return {
        formula,
        materialCount: materialCountMap.value[formula.id] ?? 0,
        latestScore: latest?.smokeScore ?? null,
        averageScore: aggregate?.average ?? null,
        batchCount: (batchesByFormula.value[formula.id] ?? []).length,
        ratioGap: round(formula.totalRatio - 100, 2)
      }
    })
  )

  const cardMap = computed<Record<string, FormulaCard>>(() => {
    const map: Record<string, FormulaCard> = {}
    cards.value.forEach((card) => {
      map[card.formula.id] = card
    })
    return map
  })

  const filteredFormulas = computed<Formula[]>(() =>
    formulas.value.filter((formula) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${formula.name}${formula.scentType}${formula.usage}${formula.state}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.scentTypes.length > 0 && !filter.value.scentTypes.includes(formula.scentType)) return false
      if (filter.value.usages.length > 0 && !filter.value.usages.includes(formula.usage)) return false
      if (filter.value.states.length > 0 && !filter.value.states.includes(formula.state)) return false
      return true
    })
  )

  const filteredCards = computed<FormulaCard[]>(() =>
    filteredFormulas.value.map((formula) => cardMap.value[formula.id]).filter((card): card is FormulaCard => Boolean(card))
  )

  const hasFilter = computed(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.scentTypes.length > 0 ||
      filter.value.usages.length > 0 ||
      filter.value.states.length > 0
  )

  const stateCounts = computed<Record<FormulaState, number>>(() => {
    const counts: Record<FormulaState, number> = { 草稿: 0, 在用: 0, 停用: 0 }
    formulas.value.forEach((formula) => {
      counts[formula.state] += 1
    })
    return counts
  })

  const averageScoreAll = computed(() => {
    const list = Object.values(scoreAggregates.value)
    if (list.length === 0) return 0
    const totalCount = list.reduce((sum, item) => sum + item.count, 0)
    if (totalCount === 0) return 0
    return round(list.reduce((sum, item) => sum + item.average * item.count, 0) / totalCount, 1)
  })

  const inUseCount = computed(() => formulas.value.filter((formula) => formula.state === '在用').length)
  const balancedCount = computed(() => formulas.value.filter((formula) => Math.abs(formula.totalRatio - 100) <= 0.01).length)

  function setCurrentFormula(id: string | null): void {
    currentFormulaId.value = id
  }

  function patchFilter(patch: Partial<FormulaFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyFormulaFilter()
  }

  function formulaById(id: string): Formula | undefined {
    return formulas.value.find((formula) => formula.id === id)
  }

  function formulaName(id: string): string {
    return formulaById(id)?.name ?? '香方已删除'
  }

  async function createFormula(payload: {
    name: string
    scentType: ScentType
    usage: UsageScene
    createdAt: string
    state?: FormulaState
  }): Promise<Formula> {
    const formula = await formulaTable.create(
      {
        name: payload.name.trim(),
        scentType: payload.scentType,
        usage: payload.usage,
        createdAt: payload.createdAt,
        totalRatio: 0,
        state: payload.state ?? '草稿',
        currentVersion: 1
      },
      'formula'
    )
    currentFormulaId.value = formula.id
    return formula
  }

  async function updateFormula(id: string, patch: Partial<Formula>): Promise<void> {
    await formulaTable.update(id, patch)
  }

  /** 本地留存的编辑冲突草稿（localStorage），按香方 id 索引 */
  const drafts = ref<Record<string, FormulaDraft>>({})

  function loadDrafts(): void {
    const map: Record<string, FormulaDraft> = {}
    readAllFormulaDrafts().forEach((draft) => {
      map[draft.formulaId] = draft
    })
    drafts.value = map
  }

  /** 打开编辑时读取该香方是否有未应用的草稿 */
  function draftOf(formulaId: string): FormulaDraft | null {
    return drafts.value[formulaId] ?? readFormulaDraft(formulaId)
  }

  /**
   * 带冲突检测的香方保存：
   * 若自打开编辑后香方已被其他页面改动（updatedAt 变化），则不覆盖，
   * 把本次编辑存为草稿并返回 conflict=true，由页面提示冲突。
   */
  async function updateFormulaWithConflictCheck(
    id: string,
    patch: Partial<Formula>,
    baseUpdatedAt: number
  ): Promise<{ conflict: boolean; conflictVersion: number }> {
    const current = await db.formulas.get(id)
    if (!current) throw new Error('香方不存在，无法保存')
    if (current.updatedAt !== baseUpdatedAt) {
      const draft: FormulaDraft = {
        formulaId: id,
        conflictVersion: current.currentVersion,
        conflictAt: current.updatedAt,
        patch: {
          name: patch.name,
          scentType: patch.scentType,
          usage: patch.usage,
          state: patch.state,
          createdAt: patch.createdAt
        },
        savedAt: Date.now()
      }
      saveFormulaDraft(draft)
      drafts.value = { ...drafts.value, [id]: draft }
      return { conflict: true, conflictVersion: current.currentVersion }
    }
    await formulaTable.update(id, patch)
    clearFormulaDraft(id)
    const nextDrafts = { ...drafts.value }
    delete nextDrafts[id]
    drafts.value = nextDrafts
    return { conflict: false, conflictVersion: current.currentVersion }
  }

  /** 应用某香方的冲突草稿（覆盖当前主档） */
  async function applyDraft(formulaId: string): Promise<void> {
    const draft = drafts.value[formulaId] ?? readFormulaDraft(formulaId)
    if (!draft) return
    const patch: Partial<Formula> = {
      name: draft.patch.name,
      scentType: draft.patch.scentType as ScentType | undefined,
      usage: draft.patch.usage as UsageScene | undefined,
      state: draft.patch.state as FormulaState | undefined,
      createdAt: draft.patch.createdAt
    }
    await formulaTable.update(formulaId, patch)
    clearFormulaDraft(formulaId)
    const nextDrafts = { ...drafts.value }
    delete nextDrafts[formulaId]
    drafts.value = nextDrafts
  }

  /** 丢弃某香方的冲突草稿 */
  function discardDraft(formulaId: string): void {
    clearFormulaDraft(formulaId)
    const nextDrafts = { ...drafts.value }
    delete nextDrafts[formulaId]
    drafts.value = nextDrafts
  }

  loadDrafts()

  /** 状态流转：草稿 → 在用 → 停用 → 在用 */
  async function advanceState(id: string): Promise<FormulaState | null> {
    const formula = formulaById(id)
    if (!formula) return null
    const next = FORMULA_STATE_FLOW[formula.state]
    await formulaTable.update(id, { state: next })
    return next
  }

  async function setState(id: string, state: FormulaState): Promise<void> {
    await formulaTable.update(id, { state })
  }

  /** 级联删除：香方 → 配比 → 批次 → 窖藏 → 品香 */
  async function removeFormula(id: string): Promise<{ proportions: number; batches: number; cellars: number; tastings: number }> {
    const batchIds = batches.value.filter((batch) => batch.formulaId === id).map((batch) => batch.id)
    const proportionIds = await db.proportions.where('formulaId').equals(id).primaryKeys()
    const cellarIds = batchIds.length > 0 ? await db.cellars.where('batchId').anyOf(batchIds).primaryKeys() : []
    const tastingIds = batchIds.length > 0 ? await db.tastings.where('batchId').anyOf(batchIds).primaryKeys() : []
    await db.transaction(
      'rw',
      [db.formulas, db.proportions, db.batches, db.cellars, db.tastings],
      async () => {
        await db.tastings.bulkDelete(tastingIds)
        await db.cellars.bulkDelete(cellarIds)
        await db.batches.bulkDelete(batchIds)
        await db.proportions.bulkDelete(proportionIds)
        await db.formulas.delete(id)
      }
    )
    if (currentFormulaId.value === id) currentFormulaId.value = null
    return {
      proportions: proportionIds.length,
      batches: batchIds.length,
      cellars: cellarIds.length,
      tastings: tastingIds.length
    }
  }

  /** 复制香方：连同配比一起复制为新草稿，便于派生新方 */
  async function duplicateFormula(id: string): Promise<Formula | null> {
    const source = formulaById(id)
    if (!source) return null
    const proportions = await db.proportions.where('formulaId').equals(id).toArray()
    const now = Date.now()
    const copy = await formulaTable.create(
      {
        name: `${source.name}（副本）`,
        scentType: source.scentType,
        usage: source.usage,
        createdAt: new Date().toISOString().slice(0, 10),
        totalRatio: source.totalRatio,
        state: '草稿',
        currentVersion: 1
      },
      'formula'
    )
    if (proportions.length > 0) {
      await db.proportions.bulkPut(
        proportions.map((proportion, index) => ({
          ...proportion,
          id: createId('prop'),
          formulaId: copy.id,
          seq: proportion.seq > 0 ? proportion.seq : index + 1,
          updatedAt: now
        }))
      )
    }
    return copy
  }

  return {
    formulas,
    batches,
    tastings,
    loading,
    ready,
    error,
    currentFormulaId,
    currentFormula,
    filter,
    cards,
    cardMap,
    filteredFormulas,
    filteredCards,
    batchesByFormula,
    pendingBatchIds,
    pendingBatchCount,
    tastingsByFormula,
    scoreAggregates,
    stateCounts,
    hasFilter,
    averageScoreAll,
    inUseCount,
    balancedCount,
    drafts,
    draftOf,
    setCurrentFormula,
    setMaterialCountMap,
    patchFilter,
    resetFilter,
    formulaById,
    formulaName,
    createFormula,
    updateFormula,
    updateFormulaWithConflictCheck,
    applyDraft,
    discardDraft,
    advanceState,
    setState,
    removeFormula,
    duplicateFormula
  }
})
