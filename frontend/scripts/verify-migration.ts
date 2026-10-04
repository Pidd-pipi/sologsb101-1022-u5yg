import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import Dexie from 'dexie'
import { db, DB_VERSION } from '@/utils/db'

/** 构造一个 v2 结构的旧库，再打开 v3 触发迁移 */
async function buildV2Database() {
  await db.delete()
  const old = new Dexie('gbincense')
  old.version(2).stores({
    formulas: 'id, name, scentType, usage, state, createdAt, totalRatio, updatedAt',
    materials: 'id, name, origin, grade, processMethod, updatedAt',
    proportions: 'id, formulaId, materialId, role, seq, updatedAt',
    batches: 'id, formulaId, mixedAt, formingMethod, updatedAt',
    cellars: 'id, batchId, startDate, endDate, state, updatedAt',
    tastings: 'id, batchId, tastedAt, smokeScore, updatedAt'
  })
  const now = Date.now()
  await old.table('formulas').bulkPut([
    {
      id: 'f_old',
      name: '旧档案线香',
      scentType: '线香',
      usage: '静室',
      createdAt: '2023-01-01',
      totalRatio: 100,
      state: '在用',
      updatedAt: now
    }
  ])
  await old.table('materials').bulkPut([
    { id: 'm_a', name: '甲香', origin: '产地甲', grade: '一级', processMethod: '生用', aromaNote: '', createdAt: '2023-01-01', updatedAt: now },
    { id: 'm_b', name: '乙香', origin: '产地乙', grade: '二级', processMethod: '炒黄', aromaNote: '', createdAt: '2023-01-01', updatedAt: now },
    { id: 'm_c', name: '丙香', origin: '产地丙', grade: '二级', processMethod: '生用', aromaNote: '', createdAt: '2023-01-01', updatedAt: now }
  ])
  // 当前配比：甲 60 / 丙 40（乙已从现行方移除，但旧批次快照里仍是甲50/乙50）
  await old.table('proportions').bulkPut([
    { id: 'p1', formulaId: 'f_old', materialId: 'm_a', ratio: 60, role: '君', note: '', seq: 1, updatedAt: now },
    { id: 'p2', formulaId: 'f_old', materialId: 'm_c', ratio: 40, role: '臣', note: '', seq: 2, updatedAt: now }
  ])
  await old.table('batches').bulkPut([
    {
      // 已入窖旧批次：快照甲50/乙50，与现行方不同
      id: 'b_cellared',
      formulaId: 'f_old',
      mixedAt: '2023-02-01',
      formingMethod: '挤条',
      quantity: 100,
      operator: '旧人',
      snapshot: [
        { materialId: 'm_a', materialName: '甲香', ratio: 50, role: '君' },
        { materialId: 'm_b', materialName: '乙香', ratio: 50, role: '臣' }
      ],
      snapshotAt: new Date('2023-02-01').getTime(),
      updatedAt: now
    },
    {
      // 未入窖旧批次：旧快照应立即失效重算为现行方
      id: 'b_open',
      formulaId: 'f_old',
      mixedAt: '2023-03-01',
      formingMethod: '手搓',
      quantity: 50,
      operator: '旧人',
      snapshot: [
        { materialId: 'm_a', materialName: '甲香', ratio: 50, role: '君' },
        { materialId: 'm_b', materialName: '乙香', ratio: 50, role: '臣' }
      ],
      snapshotAt: new Date('2023-03-01').getTime(),
      updatedAt: now
    },
    {
      // 缺快照批次：待复核
      id: 'b_nosnap',
      formulaId: 'f_old',
      mixedAt: '2023-04-01',
      formingMethod: '压模',
      quantity: 20,
      operator: '旧人',
      snapshot: [],
      snapshotAt: 0,
      updatedAt: now
    }
  ])
  await old.table('cellars').bulkPut([
    {
      id: 'c1',
      batchId: 'b_cellared',
      startDate: '2023-02-05',
      endDate: '2024-02-05',
      temperatureC: 22,
      humidityPct: 60,
      container: '陶罐',
      state: '窖藏中',
      updatedAt: now
    }
  ])
  await old.close()
}

await buildV2Database()

// 打开新版库触发 v2→v3 upgrade
await db.open()

assert.equal(DB_VERSION, 3)

const formula = await db.formulas.get('f_old')
assert.ok(formula, '香方存在')
assert.ok(formula!.versionNo >= 2, `香方当前版本应为现行版本（≥2），实际 ${formula!.versionNo}`)
assert.equal(formula!.rev, 1)
assert.equal(formula!.totalRatio, 100)

const versions = await db.formulaVersions.where('formulaId').equals('f_old').toArray()
const sorted = versions.sort((a, b) => a.versionNo - b.versionNo)
console.log('迁移后版本链：', sorted.map((v) => `v${v.versionNo}(${v.reason},${v.snapshot.map((s) => `${s.materialName}${s.ratio}`).join('/')})`).join(' → '))
assert.ok(sorted.length >= 2, '应至少有历史版本 + 当前版本')

// 链尾快照必须是现行配比甲60/丙40
const tail = sorted[sorted.length - 1]
assert.equal(tail.snapshot.length, 2)
const tailIds = tail.snapshot.map((s) => s.materialId).sort()
assert.deepEqual(tailIds, ['m_a', 'm_c'])
assert.equal(tail.snapshot.find((s) => s.materialId === 'm_a')?.ratio, 60)

// 已入窖批次：冻结、锚到历史版本、快照保持甲50/乙50
const cellared = await db.batches.get('b_cellared')
assert.equal(cellared?.snapshotState, 'frozen')
assert.ok(cellared!.formulaVersionNo >= 1 && cellared!.formulaVersionNo < tail.versionNo)
assert.deepEqual(
  cellared!.snapshot.map((s) => s.materialId).sort(),
  ['m_a', 'm_b']
)
const c1 = await db.cellars.get('c1')
assert.equal(c1?.formulaVersionNo, cellared!.formulaVersionNo)

// 未入窖批次：现行、重算为甲60/丙40、锚链尾
const open = await db.batches.get('b_open')
assert.equal(open?.snapshotState, 'current')
assert.equal(open?.formulaVersionNo, tail.versionNo)
assert.deepEqual(open!.snapshot.map((s) => s.materialId).sort(), ['m_a', 'm_c'])

// 缺快照批次：待复核，版本号 0
const nosnap = await db.batches.get('b_nosnap')
assert.equal(nosnap?.snapshotState, 'pending_review')
assert.equal(nosnap?.formulaVersionNo, 0)

console.log('✓ v2→v3 迁移：旧档案补版本、已入窖冻结、未入窖重算、缺快照待复核，全部正确')
await db.close()
