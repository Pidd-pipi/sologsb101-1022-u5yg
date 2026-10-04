import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db } from '@/utils/db'
import { resolveDraft } from '@/utils/versioning'
import type { ConflictDraft, FormulaDraftPayload, ProportionDraftPayload } from '@/types/version'

/**
 * 并发冲突草稿 store：
 * 两个页面 / 标签页同时编辑同一款香方时，后保存者的内容落到这里，
 * 由香方台账与配比编排页提示用户查看、应用或放弃。
 */
export const useConflictStore = defineStore('conflict', () => {
  const table = useIdbTable<ConflictDraft>((database) => database.conflictDrafts, {
    sortByUpdatedAt: false
  })

  const drafts = computed<ConflictDraft[]>(() =>
    [...table.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )
  const unresolved = computed<ConflictDraft[]>(() => drafts.value.filter((draft) => draft.resolved === 0))
  const unresolvedCount = computed(() => unresolved.value.length)

  function draftsOfFormula(formulaId: string): ConflictDraft[] {
    return unresolved.value.filter((draft) => draft.formulaId === formulaId)
  }

  function draftsOfFormulaByKind(formulaId: string, kind: ConflictDraft['kind']): ConflictDraft[] {
    return draftsOfFormula(formulaId).filter((draft) => draft.kind === kind)
  }

  function parseFormulaDraft(draft: ConflictDraft): FormulaDraftPayload | null {
    try {
      return JSON.parse(draft.payload) as FormulaDraftPayload
    } catch {
      return null
    }
  }

  function parseProportionDraft(draft: ConflictDraft): ProportionDraftPayload | null {
    try {
      return JSON.parse(draft.payload) as ProportionDraftPayload
    } catch {
      return null
    }
  }

  async function discard(draftId: string): Promise<void> {
    await resolveDraft(draftId)
  }

  /** 物理删除（已处理草稿清理） */
  async function purge(draftId: string): Promise<void> {
    await db.conflictDrafts.delete(draftId)
  }

  return {
    drafts,
    unresolved,
    unresolvedCount,
    loading: table.loading,
    draftsOfFormula,
    draftsOfFormulaByKind,
    parseFormulaDraft,
    parseProportionDraft,
    discard,
    purge
  }
})
