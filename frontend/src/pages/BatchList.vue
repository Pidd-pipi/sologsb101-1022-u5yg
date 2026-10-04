<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Document, Edit, Histogram, Plus } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useFormulaStore } from '@/stores/formulaStore'
import { useMaterialStore } from '@/stores/materialStore'
import { useProportionStore } from '@/stores/proportionStore'
import { useCellarStore } from '@/stores/cellarStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db, createId } from '@/utils/db'
import { compareSnapshot, createVersionedBatch, reviewPendingBatch } from '@/utils/versioning'
import VersionTag from '@/components/common/VersionTag.vue'
import { round } from '@/utils/ratio'
import {
  FORMING_METHODS,
  createEmptyBatchFilter,
  type Batch,
  type BatchFilterState,
  type BatchRow,
  type BatchSnapshotItem,
  type FormingMethod
} from '@/types/batch'
import type { SnapshotDiffItem } from '@/types/version'

const route = useRoute()
const router = useRouter()
const formulaStore = useFormulaStore()
const materialStore = useMaterialStore()
const proportionStore = useProportionStore()
const cellarStore = useCellarStore()
const batchTable = useIdbTable<Batch>((database) => database.batches)
/** 用 useProportion 校验和香前的配比合计，避免用未平衡的方子开批次 */
const { rows: selectedProportionRows, total: selectedRatioTotal, checkLevel, checkMessage } = useProportion()

const filter = ref<BatchFilterState>(createEmptyBatchFilter())
const dialogVisible = ref(false)
const detailVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const detailBatchId = ref<string | null>(null)

const form = reactive<{
  formulaId: string
  mixedAt: string
  formingMethod: FormingMethod
  quantity: number
  operator: string
}>({
  formulaId: '',
  mixedAt: new Date().toISOString().slice(0, 10),
  formingMethod: '挤条',
  quantity: 100,
  operator: ''
})

const rules: FormRules = {
  formulaId: [{ required: true, message: '请选择香方', trigger: 'change' }],
  mixedAt: [{ required: true, message: '请选择和香日期', trigger: 'change' }],
  formingMethod: [{ required: true, message: '请选择成型方式', trigger: 'change' }],
  quantity: [
    { required: true, message: '请填写数量', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value <= 0) callback(new Error('数量需大于 0'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  operator: [{ required: true, message: '请填写制香人', trigger: 'blur' }]
}

const formulaOptions = computed(() =>
  formulaStore.formulas.map((formula) => ({
    label: `${formula.name}（${formula.scentType} · 配比合计 ${round(formula.totalRatio, 2)}%）`,
    value: formula.id
  }))
)

const filterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  formula: filter.value.formulas,
  forming: filter.value.formingMethods
}))

const filterSelects = computed(() => [
  {
    key: 'formula',
    label: '香方',
    options: formulaStore.formulas.map((formula) => ({ label: formula.name, value: formula.id }))
  },
  { key: 'forming', label: '成型方式', options: FORMING_METHODS.map((item) => ({ label: item, value: item })) }
])

function pushQuery(): void {
  const query: Record<string, string> = {}
  if (filter.value.keyword.trim()) query.kw = filter.value.keyword.trim()
  if (filter.value.formulas.length) query.formula = filter.value.formulas.join(',')
  if (filter.value.formingMethods.length) query.forming = filter.value.formingMethods.join(',')
  void router.replace({ query })
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0)
  return []
}

function readQuery(): void {
  const query = route.query
  filter.value = {
    keyword: typeof query.kw === 'string' ? query.kw : '',
    formulas: toArray(query.formula),
    formingMethods: toArray(query.forming).filter((item): item is FormingMethod =>
      (FORMING_METHODS as string[]).includes(item)
    )
  }
}

if (Object.keys(route.query).length > 0) readQuery()

watch(
  () => route.query,
  (query) => {
    if (Object.keys(query).length === 0 && hasFilter.value) {
      filter.value = createEmptyBatchFilter()
      return
    }
    readQuery()
  }
)

const hasFilter = computed(
  () =>
    filter.value.keyword.trim().length > 0 ||
    filter.value.formulas.length > 0 ||
    filter.value.formingMethods.length > 0
)

const rows = computed<BatchRow[]>(() =>
  batchTable.rows.value.map((batch) => {
    const currentList = proportionStore.proportionsByFormula(batch.formulaId)
    const currentSnapshot: BatchSnapshotItem[] = currentList
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((proportion) => ({
        materialId: proportion.materialId,
        materialName: materialStore.materialName(proportion.materialId),
        ratio: round(proportion.ratio, 2),
        role: proportion.role
      }))
    const currentRatioTotal = round(
      currentSnapshot.reduce((sum, item) => sum + item.ratio, 0),
      2
    )
    const snapshotRatioTotal = round(
      batch.snapshot.reduce((sum, item) => sum + item.ratio, 0),
      2
    )
    const check = compareSnapshot(batch.snapshot, currentSnapshot)
    const cellars = cellarStore.cellarsOfBatch(batch.id)
    return {
      batch,
      formulaName: formulaStore.formulaName(batch.formulaId),
      snapshotCount: batch.snapshot.length,
      currentRatioTotal,
      snapshotRatioTotal,
      snapshotState: batch.snapshotState,
      formulaVersionNo: batch.formulaVersionNo,
      consistent: check.consistent,
      cellared: cellars.length > 0,
      cellarState: cellars.length === 0 ? '未入窖' : cellars.map((cellar) => cellar.state).join(' / ')
    }
  })
)

const filteredRows = computed<BatchRow[]>(() =>
  rows.value.filter((row) => {
    const keyword = filter.value.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${row.formulaName}${row.batch.formingMethod}${row.batch.operator}${row.batch.mixedAt}`
      if (!haystack.includes(keyword)) return false
    }
    if (filter.value.formulas.length > 0 && !filter.value.formulas.includes(row.batch.formulaId)) return false
    if (filter.value.formingMethods.length > 0 && !filter.value.formingMethods.includes(row.batch.formingMethod))
      return false
    return true
  })
)

const totalQuantity = computed(() => filteredRows.value.reduce((sum, row) => sum + row.batch.quantity, 0))
const cellaredCount = computed(() => rows.value.filter((row) => row.cellared).length)
const pendingCount = computed(() => rows.value.filter((row) => row.snapshotState === 'pending_review').length)
const driftedCount = computed(() =>
  rows.value.filter((row) => row.snapshotState !== 'pending_review' && !row.consistent && !row.cellared).length
)
const frozenCount = computed(() => rows.value.filter((row) => row.snapshotState === 'frozen').length)
const averageQuantity = computed(() =>
  rows.value.length === 0 ? 0 : Math.round(rows.value.reduce((sum, row) => sum + row.batch.quantity, 0) / rows.value.length)
)

const detailRow = computed<BatchRow | null>(() => rows.value.find((row) => row.batch.id === detailBatchId.value) ?? null)

/** 香方 id → 配比味数，用于快照对照时回显 */
const proportionCountMap = computed<Record<string, number>>(() => proportionStore.materialCountMap)

/** 对照抽屉：快照与当前配比的逐味差异（含新增 / 移除 / 占比调整） */
const detailDiffMap = computed<Record<string, SnapshotDiffItem>>(() => {
  if (!detailRow.value) return {}
  const currentList = proportionStore.proportionsByFormula(detailRow.value.batch.formulaId)
  const currentSnapshot: BatchSnapshotItem[] = currentList
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => ({
      materialId: proportion.materialId,
      materialName: materialStore.materialName(proportion.materialId),
      ratio: round(proportion.ratio, 2),
      role: proportion.role
    }))
  const check = compareSnapshot(detailRow.value.batch.snapshot, currentSnapshot)
  return Object.fromEntries(check.diffs.map((diff) => [diff.materialId, diff]))
})

function handleFilterChange(value: FilterModel): void {
  filter.value = {
    keyword: value.keyword,
    formulas: Array.isArray(value.formula) ? (value.formula as string[]) : [],
    formingMethods: Array.isArray(value.forming) ? (value.forming as FormingMethod[]) : []
  }
  pushQuery()
}

function handleReset(): void {
  filter.value = createEmptyBatchFilter()
  pushQuery()
}

function openCreate(): void {
  editingId.value = null
  form.formulaId = formulaStore.currentFormulaId ?? formulaStore.formulas[0]?.id ?? ''
  form.mixedAt = new Date().toISOString().slice(0, 10)
  form.formingMethod = '挤条'
  form.quantity = 100
  form.operator = ''
  dialogVisible.value = true
}

function openEdit(batch: Batch): void {
  editingId.value = batch.id
  form.formulaId = batch.formulaId
  form.mixedAt = batch.mixedAt
  form.formingMethod = batch.formingMethod
  form.quantity = batch.quantity
  form.operator = batch.operator
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value) {
      await batchTable.update(editingId.value, {
        formulaId: form.formulaId,
        mixedAt: form.mixedAt,
        formingMethod: form.formingMethod,
        quantity: form.quantity,
        operator: form.operator.trim()
      })
      ElMessage.success('批次已更新')
    } else {
      try {
        const { batch } = await createVersionedBatch({
          id: createId('batch'),
          formulaId: form.formulaId,
          mixedAt: form.mixedAt,
          formingMethod: form.formingMethod,
          quantity: form.quantity,
          operator: form.operator.trim()
        })
        ElMessage.success('已生成批次并固化当前配比快照，锚定现行香方版本')
        detailBatchId.value = batch.id
        dialogVisible.value = false
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : '批次生成失败')
      }
    }
  } finally {
    submitting.value = false
  }
}

async function removeBatch(row: BatchRow): Promise<void> {
  const cellars = cellarStore.cellarsOfBatch(row.batch.id)
  const confirmed = await ElMessageBox.confirm(
    `删除批次「${row.formulaName} · ${row.batch.mixedAt}」将同时删除其 ${cellars.length} 条窖藏与全部品香记录，是否继续？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  const cellarIds = cellars.map((cellar) => cellar.id)
  const tastingIds = await db.tastings.where('batchId').equals(row.batch.id).primaryKeys()
  await db.transaction('rw', [db.batches, db.cellars, db.tastings], async () => {
    await db.tastings.bulkDelete(tastingIds)
    await db.cellars.bulkDelete(cellarIds)
    await db.batches.delete(row.batch.id)
  })
  ElMessage.success(`已删除批次，连带清除窖藏 ${cellarIds.length} 条、品香 ${tastingIds.length} 条`)
}

async function refreshSnapshot(row: BatchRow): Promise<void> {
  if (row.batch.snapshotState === 'frozen') {
    ElMessage.warning('该批次已入窖，快照已冻结，不能按当前方重置；如需调整请先删除窖藏记录')
    return
  }
  if (row.batch.snapshotState === 'pending_review') {
    await reviewRow(row)
    return
  }
  ElMessage.info('现行批次的快照会随配比改动自动重算，无需手工重置')
}

async function reviewRow(row: BatchRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `按「${row.formulaName}」的现行配比重建该批次快照并锚定现行版本？复核后其品香评鉴才会计入香方均分。`,
    '待复核批次确认',
    { type: 'warning', confirmButtonText: '按现行方复核', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    const { versionNo, snapshot } = await reviewPendingBatch(row.batch.id)
    ElMessage.success(`复核通过：已补建 ${snapshot.length} 味快照并锚定 v${versionNo}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '复核失败')
  }
}

/** 待复核批次复核前的差异预览（空快照 → 全部现行味都是新增） */
const pendingCheck = computed(() => {
  if (!detailRow.value || detailRow.value.batch.snapshotState !== 'pending_review') return null
  const currentList = proportionStore.proportionsByFormula(detailRow.value.batch.formulaId)
  return currentList
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => ({
      materialName: materialStore.materialName(proportion.materialId),
      ratio: round(proportion.ratio, 2),
      role: proportion.role
    }))
})

function openDetail(row: BatchRow): void {
  detailBatchId.value = row.batch.id
  detailVisible.value = true
}

function goCellar(row: BatchRow): void {
  cellarStore.patchFilter({ keyword: row.formulaName })
  void router.push('/cellar')
}

function goProportion(row: BatchRow): void {
  formulaStore.setCurrentFormula(row.batch.formulaId)
  void router.push('/proportions')
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>和香工序与成型登记</h2>
        <p>
          共 {{ rows.length }} 个批次 · 已入窖 {{ cellaredCount }} 个（冻结 {{ frozenCount }}）· 待复核
          {{ pendingCount }} 个 · 现行配比改动 {{ driftedCount }} 个 · 当前筛选 {{ filteredRows.length }} 个
        </p>
      </div>
      <div class="page-title__actions">
        <el-button type="primary" :icon="Plus" @click="openCreate">登记和香批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="批次总数" :value="rows.length" suffix="个" icon="Box" tone="primary" />
      <StatBadge label="筛选中数量" :value="totalQuantity" suffix="支/丸" icon="Histogram" tone="info" />
      <StatBadge label="已入窖" :value="cellaredCount" suffix="个" icon="Coin" tone="success" />
      <StatBadge label="待复核" :value="pendingCount" suffix="个" icon="WarningFilled" tone="danger" hint="旧档缺快照批次，品香暂不并入均分" />
      <StatBadge label="现行已改方" :value="driftedCount" suffix="个" icon="Document" tone="warning" hint="未入窖批次快照已按新方重算" />
      <StatBadge label="平均产量" :value="averageQuantity" suffix="支/丸" icon="TrendCharts" tone="default" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="按香方名 / 制香人 / 和香日期搜索"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="section-card batch-table">
      <div v-if="filteredRows.length === 0" class="batch-empty">
        <EmptyPanel
          title="暂无和香批次"
          :description="
            rows.length === 0
              ? '和香前先在配比页把君臣佐使调到合计 100%，再回到这里登记成型批次与制香人。'
              : '当前筛选条件下没有匹配的批次，可重置条件或登记新批次。'
          "
          action-text="登记和香批次"
          :show-seed="false"
          @action="openCreate"
        />
      </div>

      <el-table v-else :data="filteredRows" row-key="batch.id" stripe>
        <el-table-column label="香方 / 批次号" min-width="210">
          <template #default="{ row }: { row: BatchRow }">
            <div class="cell-main">{{ row.formulaName }}</div>
            <div class="cell-sub muted mono">批次 {{ row.batch.id.slice(-8) }} · 快照 {{ row.snapshotCount }} 味</div>
            <VersionTag
              :version-no="row.formulaVersionNo"
              :state="row.snapshotState"
              style="margin-top: 2px"
            />
          </template>
        </el-table-column>
        <el-table-column label="和香日期" prop="batch.mixedAt" width="120" />
        <el-table-column label="成型方式" prop="batch.formingMethod" width="110" />
        <el-table-column label="数量" width="100">
          <template #default="{ row }: { row: BatchRow }">
            <span class="mono">{{ row.batch.quantity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="制香人" prop="batch.operator" width="110" />
        <el-table-column label="配比对照" min-width="200">
          <template #default="{ row }: { row: BatchRow }">
            <template v-if="row.snapshotState === 'pending_review'">
              <el-tag type="danger" size="small" effect="plain" round>缺快照 · 待复核</el-tag>
              <div class="cell-sub ratio-error">品香暂不并入均分，请打开对照后按现行方复核</div>
            </template>
            <template v-else-if="row.snapshotState === 'frozen'">
              <div class="cell-sub ratio-ok">已冻结依据 v{{ row.formulaVersionNo }} 的原快照</div>
              <div class="cell-sub muted">快照合计 {{ row.snapshotRatioTotal }}% · 现行 {{ row.currentRatioTotal }}%</div>
            </template>
            <template v-else>
              <div class="cell-sub">
                快照合计 <span class="mono">{{ row.snapshotRatioTotal }}%</span> · 当前合计
                <span class="mono">{{ row.currentRatioTotal }}%</span>
              </div>
              <div class="cell-sub" :class="row.consistent ? 'ratio-ok' : 'ratio-warn'">
                {{ row.consistent ? '配比与快照一致' : '改方后未入窖快照已按新方重算' }}
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="窖藏状态" width="140">
          <template #default="{ row }: { row: BatchRow }">
            <el-tag :type="row.cellared ? 'success' : 'info'" effect="plain" round>{{ row.cellarState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }: { row: BatchRow }">
            <el-button size="small" text type="primary" :icon="Document" @click="openDetail(row)">
              {{ row.snapshotState === 'pending_review' ? '待复核对照' : '快照对照' }}
            </el-button>
            <el-button size="small" text @click="goCellar(row)">窖藏</el-button>
            <el-button size="small" text :icon="Edit" @click="openEdit(row.batch)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑和香批次' : '登记和香批次'" width="580px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="104px">
        <el-form-item label="香方" prop="formulaId">
          <el-select
            v-model="form.formulaId"
            filterable
            placeholder="选择香方"
            style="width: 100%"
            :disabled="Boolean(editingId)"
          >
            <el-option v-for="item in formulaOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="editingId" class="muted form-hint">批次归属香方不可修改，快照与版本链均锚定原方</span>
        </el-form-item>
        <el-form-item label="和香日期" prop="mixedAt">
          <el-date-picker
            v-model="form.mixedAt"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择和香日期"
          />
        </el-form-item>
        <el-form-item label="成型方式" prop="formingMethod">
          <el-radio-group v-model="form.formingMethod">
            <el-radio v-for="item in FORMING_METHODS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="数量" prop="quantity">
          <el-input-number v-model="form.quantity" :min="1" :max="99999" :step="10" style="width: 200px" />
          <span class="muted form-hint">支 / 丸 / 饼</span>
        </el-form-item>
        <el-form-item label="制香人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：林砚舟" maxlength="20" />
        </el-form-item>
        <el-alert
          v-if="form.formulaId"
          class="ratio-alert"
          :type="checkLevel === 'ok' ? 'success' : checkLevel === 'warn' ? 'warning' : 'error'"
          :closable="false"
          show-icon
          :title="`当前方子配比：${selectedRatioTotal}%（${selectedProportionRows.length} 味）`"
          :description="checkMessage"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '生成批次并固化快照' }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="配比快照对照与版本链" size="600px" append-to-body>
      <template v-if="detailRow">
        <div class="snapshot-head">
          <h3>{{ detailRow.formulaName }}</h3>
          <p class="muted">
            和香 {{ detailRow.batch.mixedAt }} · {{ detailRow.batch.formingMethod }} · {{ detailRow.batch.quantity }} 支 ·
            {{ detailRow.batch.operator }}
          </p>
          <VersionTag :version-no="detailRow.formulaVersionNo" :state="detailRow.snapshotState" />
          <p class="muted">快照固化于 {{ new Date(detailRow.batch.snapshotAt || Date.now()).toLocaleString('zh-CN') }}</p>
        </div>

        <el-alert
          v-if="detailRow.snapshotState === 'frozen'"
          class="snapshot-alert"
          type="success"
          :closable="false"
          show-icon
          :title="`已入窖冻结：该批次永久锚定 v${detailRow.formulaVersionNo} 原快照，改方不影响本批次`"
        />
        <el-alert
          v-else-if="detailRow.snapshotState === 'pending_review'"
          class="snapshot-alert"
          type="error"
          :closable="false"
          show-icon
          title="旧档缺快照：批次待复核，其品香评鉴不会自动并入香方均分"
        >
          <template #default>
            <div v-if="pendingCheck && pendingCheck.length > 0">
              <p class="cell-sub">按现行配比复核后将补建以下 {{ pendingCheck.length }} 味快照：</p>
              <div v-for="item in pendingCheck" :key="item.materialName" class="cell-sub">
                {{ item.materialName }}（{{ item.role }}）· {{ item.ratio }}%
              </div>
            </div>
            <el-button class="review-btn" type="danger" plain size="small" @click="reviewRow(detailRow)">
              按现行配比复核并锚定当前版本
            </el-button>
          </template>
        </el-alert>

        <div class="snapshot-badges">
          <StatBadge label="快照合计" :value="detailRow.snapshotRatioTotal" suffix="%" size="small" icon="Histogram" tone="info" />
          <StatBadge label="当前合计" :value="detailRow.currentRatioTotal" suffix="%" size="small" icon="Histogram" tone="primary" />
          <StatBadge
            label="当前味数"
            :value="proportionCountMap[detailRow.batch.formulaId] ?? 0"
            suffix="味"
            size="small"
            icon="Files"
            tone="default"
          />
        </div>

        <h4 v-if="detailRow.snapshotState !== 'pending_review'">逐味香料差异</h4>
        <el-table
          v-if="detailRow.snapshotState !== 'pending_review'"
          :data="Object.values(detailDiffMap)"
          size="small"
          row-key="materialId"
        >
          <el-table-column label="香料" prop="materialName" min-width="110" />
          <el-table-column label="角色" prop="role" width="64" />
          <el-table-column label="快照占比" width="96">
            <template #default="{ row }: { row: SnapshotDiffItem }">
              <span class="mono">{{ row.snapshotRatio === null ? '—' : `${row.snapshotRatio}%` }}</span>
            </template>
          </el-table-column>
          <el-table-column label="现行占比" width="96">
            <template #default="{ row }: { row: SnapshotDiffItem }">
              <span class="mono">{{ row.currentRatio === null ? '—' : `${row.currentRatio}%` }}</span>
            </template>
          </el-table-column>
          <el-table-column label="差异" min-width="110">
            <template #default="{ row }: { row: SnapshotDiffItem }">
              <el-tag
                :type="row.kind === 'same' ? 'success' : row.kind === 'removed' ? 'danger' : row.kind === 'added' ? 'warning' : 'primary'"
                size="small"
                effect="plain"
              >
                {{ row.kind === 'same' ? '一致' : row.kind === 'removed' ? '已移除' : row.kind === 'added' ? '新增' : `差值 ${row.delta && row.delta > 0 ? '+' : ''}${row.delta}%` }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>

        <h4>版本链轨迹</h4>
        <el-timeline class="trail-list">
          <el-timeline-item
            v-for="(trail, index) in (detailRow.batch.versionTrail ?? []).slice().reverse()"
            :key="index"
            :timestamp="new Date(trail.at).toLocaleString('zh-CN')"
            placement="top"
          >
            <div class="cell-main">{{ trail.note }}</div>
            <div class="cell-sub muted">v{{ trail.versionNo }} · {{ trail.state === 'frozen' ? '已冻结' : trail.state === 'pending_review' ? '待复核' : '现行' }} · {{ trail.reason }}</div>
          </el-timeline-item>
        </el-timeline>

        <div class="snapshot-actions">
          <el-button v-if="detailRow.snapshotState === 'pending_review'" type="primary" @click="reviewRow(detailRow)">
            按现行配比复核
          </el-button>
          <el-button v-else-if="detailRow.snapshotState === 'current'" :icon="Document" @click="refreshSnapshot(detailRow)">
            现行快照说明
          </el-button>
          <el-button v-else :icon="Document" disabled>已入窖冻结，不可重置</el-button>
          <el-button :icon="Histogram" @click="goProportion(detailRow)">去改配比</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.batch-table {
  margin-top: 16px;
}

.batch-empty {
  padding: 8px 0;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.ratio-alert {
  margin-bottom: 12px;
}

.snapshot-alert {
  margin: 10px 0;
}

.review-btn {
  margin-top: 8px;
}

.trail-list {
  margin-top: 8px;
  padding: 0 4px;
}

.snapshot-head h3 {
  margin: 0 0 4px;
}

.snapshot-head p {
  margin: 0 0 4px;
  font-size: 12px;
}

.snapshot-badges {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.snapshot-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
