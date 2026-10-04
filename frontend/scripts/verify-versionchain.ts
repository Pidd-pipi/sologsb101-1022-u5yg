import 'fake-indexeddb/auto'
import { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db, resetDatabase, createId } from '@/utils/db'
import {
  applyProportionChange,
  compareSnapshot,
  createFormulaWithVersion,
  createVersionedBatch,
  enterCellar,
  PendingReviewError,
  reviewPendingBatch,
  RevisionConflictError,
  SnapshotMismatchError,
  unfreezeBatchIfNeeded,
  updateFormulaGuarded
} from '@/utils/versioning'
import type { Formula } from '@/types/formula'
import type { Proportion } from '@/types/proportion'

async function reset() {
  await db.delete()
  await db.open()
  await resetDatabase()
}

let passed = 0
async function check(name: string, fn: () => Promise<void>) {
  await reset()
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

beforeEach(() => {})

async function getFormula(id: string) {
  return (await db.formulas.get(id)) as Formula
}

async function seedProps(formulaId: string, rows: Array<[string, number, string]>) {
  const now = Date.now()
  await db.proportions.bulkPut(
    rows.map(([materialId, ratio, role], index) => ({
      id: createId('prop'),
      formulaId,
      materialId,
      ratio,
      role,
      note: '',
      seq: index + 1,
      updatedAt: now
    }))
  )
}

const M = {
  chen: 'seed_material_chen',
  tan: 'seed_material_tan',
  ruxiang: 'seed_material_ruxiang',
  ding: 'seed_material_ding'
}

// 1. 迁移播种：版本链完整、已入窖批次冻结、缺快照批次待复核
await check('播种：线香批次冻结 v1，现行方为 v2；缺快照批次待复核', async () => {
  const formula = await getFormula('seed_formula_line')
  assert.equal(formula.versionNo, 2)
  assert.ok(formula.rev >= 2)
  const versions = await db.formulaVersions.where('formulaId').equals(formula.id).toArray()
  assert.equal(versions.length, 2)
  const frozen = await db.batches.get('seed_batch_line')
  assert.equal(frozen?.snapshotState, 'frozen')
  assert.equal(frozen?.formulaVersionNo, 1)
  const cellar = await db.cellars.get('seed_cellar_line')
  assert.equal(cellar?.formulaVersionNo, 1)
  const pending = await db.batches.get('seed_batch_plate')
  assert.equal(pending?.snapshotState, 'pending_review')
  assert.equal(pending?.formulaVersionNo, 0)
})

// 2. 改配比：未入窖批次立即重算，已入窖冻结不变
await check('改配比：未入窖批次重算锚新版本，已入窖批次冻结', async () => {
  const pill = 'seed_formula_pill'
  const f = await getFormula(pill)
  const props = await db.proportions.where('formulaId').equals(pill).toArray()
  const chenProp = props.find((p) => p.materialId === M.chen)!
  await applyProportionChange({
    formulaId: pill,
    baseRev: f.rev,
    source: 'test',
    mutate: async (tx) => {
      await tx.table<Proportion>('proportions').update(chenProp.id, { ratio: 45 })
    }
  })
  const f2 = await getFormula(pill)
  assert.equal(f2.versionNo, 2)
  assert.equal(f2.rev, f.rev + 1)
  const batch = await db.batches.get('seed_batch_pill')
  assert.equal(batch?.snapshotState, 'current')
  assert.equal(batch?.formulaVersionNo, 2)
  assert.equal(batch?.snapshot.find((s) => s.materialId === M.chen)?.ratio, 45)
  // 冻结批次不动
  const line = await db.batches.get('seed_batch_line')
  assert.equal(line?.snapshotState, 'frozen')
  assert.equal(line?.formulaVersionNo, 1)
  assert.equal(line?.snapshot.find((s) => s.materialId === M.chen)?.ratio, 45)
})

// 3. 并发冲突：baseRev 过期时抛错并留草稿
await check('并发：后保存者报 RevisionConflictError 且留下草稿', async () => {
  const pill = 'seed_formula_pill'
  const f = await getFormula(pill)
  // 模拟另一处先保存
  await db.formulas.update(pill, { rev: f.rev + 5 })
  await assert.rejects(
    applyProportionChange({
      formulaId: pill,
      baseRev: f.rev,
      source: 'test-B',
      mutate: async () => {},
      draftPayload: { items: [] }
    }),
    RevisionConflictError
  )
  const drafts = await db.conflictDrafts.toArray()
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].source, 'test-B')
  assert.equal(drafts[0].resolved, 0)
  // 事务回滚：配比未变
  const f2 = await getFormula(pill)
  assert.equal(f2.versionNo, 1)
})

// 4. 香方主档并发
await check('并发：香方主档过期保存留草稿', async () => {
  const pill = 'seed_formula_pill'
  const f = await getFormula(pill)
  await db.formulas.update(pill, { rev: f.rev + 1 })
  await assert.rejects(
    updateFormulaGuarded({
      formulaId: pill,
      baseRev: f.rev,
      source: 'test-form',
      patch: { name: '改名冲突' }
    }),
    RevisionConflictError
  )
  const drafts = await db.conflictDrafts.toArray()
  assert.equal(drafts.length, 1)
  const payload = JSON.parse(drafts[0].payload)
  assert.equal(payload.name, '改名冲突')
})

// 5. 入窖一致：冻结并锚版本
await check('入窖：快照一致时冻结并锚定版本', async () => {
  const fid = createId('formula')
  await createFormulaWithVersion({
    id: fid,
    name: '测试方',
    scentType: '线香',
    usage: '静室',
    createdAt: '2025-01-01',
    state: '在用'
  })
  await seedProps(fid, [[M.chen, 50, '君'], [M.tan, 50, '臣']])
  // 建批次
  const { batch } = await createVersionedBatch({
    id: createId('batch'),
    formulaId: fid,
    mixedAt: '2025-02-01',
    formingMethod: '挤条',
    quantity: 10,
    operator: '甲'
  })
  const { cellar, versionNo } = await enterCellar({
    id: createId('cellar'),
    batchId: batch.id,
    startDate: '2025-02-02',
    endDate: '2025-03-02',
    temperatureC: 22,
    humidityPct: 60,
    container: '陶罐',
    state: '窖藏中'
  })
  assert.ok(versionNo >= 1)
  assert.equal(cellar.formulaVersionNo, versionNo)
  const frozen = await db.batches.get(batch.id)
  assert.equal(frozen?.snapshotState, 'frozen')
})

// 6. 入窖拒绝：改方后列出香料差异
await check('入窖：改方后拒绝并列出去除 / 新增 / 占比差异', async () => {
  const fid = createId('formula')
  await createFormulaWithVersion({
    id: fid,
    name: '测试方2',
    scentType: '线香',
    usage: '静室',
    createdAt: '2025-01-01',
    state: '在用'
  })
  await seedProps(fid, [[M.chen, 50, '君'], [M.tan, 50, '臣']])
  const { batch } = await createVersionedBatch({
    id: createId('batch'),
    formulaId: fid,
    mixedAt: '2025-02-01',
    formingMethod: '挤条',
    quantity: 10,
    operator: '甲'
  })
  // 改方：删檀香、降沉香占比、加丁香
  const props = await db.proportions.where('formulaId').equals(fid).toArray()
  const f = await getFormula(fid)
  await applyProportionChange({
    formulaId: fid,
    baseRev: f.rev,
    source: 'test',
    mutate: async (tx) => {
      const t = tx.table<Proportion>('proportions')
      await t.delete(props.find((p) => p.materialId === M.tan)!.id)
      await t.put({
        id: createId('prop'),
        formulaId: fid,
        materialId: M.ding,
        ratio: 20,
        role: '使',
        note: '',
        seq: 3,
        updatedAt: Date.now()
      })
      await t.update(props.find((p) => p.materialId === M.chen)!.id, { ratio: 80 })
    }
  })
  // 快照被重算为现行（未入窖），先恢复旧快照模拟"坚持原快照"场景
  await db.batches.update(batch.id, {
    snapshot: [
      { materialId: M.chen, materialName: '海南沉香', ratio: 50, role: '君' },
      { materialId: M.tan, materialName: '老山檀香', ratio: 50, role: '臣' }
    ],
    snapshotState: 'current'
  })
  try {
    await enterCellar({
      id: createId('cellar'),
      batchId: batch.id,
      startDate: '2025-02-02',
      endDate: '2025-03-02',
      temperatureC: 22,
      humidityPct: 60,
      container: '陶罐',
      state: '窖藏中'
    })
    assert.fail('应当拒绝入窖')
  } catch (err) {
    assert.ok(err instanceof SnapshotMismatchError)
    const kinds = err.diffs.map((d) => `${d.materialName}:${d.kind}`).sort()
    assert.ok(kinds.some((k) => k.includes('老山檀香:removed')))
    assert.ok(kinds.some((k) => k.includes('丁香:added')))
    assert.ok(kinds.some((k) => k.includes('海南沉香:changed')))
  }
})

// 7. 待复核批次不能入窖，复核后可入窖且品香状态改变
await check('待复核：拒绝入窖；人工复核后锚定版本可入窖', async () => {
  const pending = await db.batches.get('seed_batch_plate')
  assert.equal(pending?.snapshotState, 'pending_review')
  await assert.rejects(
    enterCellar({
      id: createId('cellar'),
      batchId: pending!.id,
      startDate: '2025-01-01',
      endDate: '2025-02-01',
      temperatureC: 22,
      humidityPct: 60,
      container: '陶罐',
      state: '窖藏中'
    }),
    PendingReviewError
  )
  const { versionNo, snapshot } = await reviewPendingBatch(pending!.id)
  assert.ok(versionNo >= 1)
  assert.ok(snapshot.length > 0)
  const reviewed = await db.batches.get(pending!.id)
  assert.equal(reviewed?.snapshotState, 'current')
})

// 8. 删除窖藏：解除冻结并按现行方重算
await check('删窖藏：批次解冻，快照重算为现行', async () => {
  const line = await db.batches.get('seed_batch_line')
  assert.equal(line?.snapshotState, 'frozen')
  await db.cellars.clear()
  await unfreezeBatchIfNeeded(line!.id)
  const refreshed = await db.batches.get(line!.id)
  assert.equal(refreshed?.snapshotState, 'current')
  assert.equal(refreshed?.formulaVersionNo, 2)
  assert.equal(refreshed?.snapshot.find((s) => s.materialId === M.chen)?.ratio, 46)
})

// 9. compareSnapshot 单元逻辑
{
  const check = compareSnapshot(
    [
      { materialId: 'a', materialName: '甲', ratio: 40, role: '君' },
      { materialId: 'b', materialName: '乙', ratio: 60, role: '臣' }
    ],
    [
      { materialId: 'a', materialName: '甲', ratio: 42, role: '君' },
      { materialId: 'c', materialName: '丙', ratio: 58, role: '佐' }
    ]
  )
  assert.equal(check.consistent, false)
  assert.equal(check.changedCount, 3)
  const byId = Object.fromEntries(check.diffs.map((d) => [d.materialId, d.kind]))
  assert.equal(byId.a, 'changed')
  assert.equal(byId.b, 'removed')
  assert.equal(byId.c, 'added')
}

// 10. 仅备注 / 排序变化不产生新版本
await check('指纹不变（仅备注）：只递增 rev，不加版本', async () => {
  const pill = 'seed_formula_pill'
  const f = await getFormula(pill)
  const props = await db.proportions.where('formulaId').equals(pill).toArray()
  const result = await applyProportionChange({
    formulaId: pill,
    baseRev: f.rev,
    source: 'test',
    mutate: async (tx) => {
      await tx.table<Proportion>('proportions').update(props[0].id, { note: '仅改备注' })
    }
  })
  assert.equal(result.newVersion, null)
  const f2 = await getFormula(pill)
  assert.equal(f2.versionNo, 1)
  assert.equal(f2.rev, f.rev + 1)
})

console.log(`\n全部 ${passed} 项场景测试通过`)
await db.close()
