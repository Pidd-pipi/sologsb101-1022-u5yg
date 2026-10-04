<script setup lang="ts">
import { computed } from 'vue'
import { SNAPSHOT_STATE_LABEL, type SnapshotState } from '@/types/version'

interface Props {
  /** 香方版本号 / 批次锚定版本 / 入窖依据版本；0 表示无依据（待复核） */
  versionNo?: number
  state?: SnapshotState
  /** 标签尺寸 */
  size?: 'small' | 'default'
}

const props = withDefaults(defineProps<Props>(), {
  versionNo: 0,
  state: undefined,
  size: 'small'
})

const tagType = computed<'success' | 'warning' | 'info' | 'danger' | 'primary'>(() => {
  if (props.state === 'frozen') return 'success'
  if (props.state === 'pending_review') return 'danger'
  if (props.state === 'current') return 'primary'
  return 'info'
})

const text = computed(() => {
  const base = props.versionNo > 0 ? `v${props.versionNo}` : '无版本'
  return props.state ? `${base} · ${SNAPSHOT_STATE_LABEL[props.state].split('（')[0]}` : base
})
</script>

<template>
  <el-tag :type="tagType" effect="plain" round :size="size" disable-transitions>{{ text }}</el-tag>
</template>
