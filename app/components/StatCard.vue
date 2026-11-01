<script setup lang="ts">
/**
 * KPI 卡 —— 对齐 bili-desk 的 .kpi > .k / .v / .bar / .foot。
 * 数字 26px，单位 12px，可选进度条（progress: 0-100）。
 */
withDefaults(defineProps<{
  label: string;
  value: string | number;
  note: string;
  unit?: string;
  progress?: number;
}>(), { unit: "", progress: undefined });
</script>

<template>
  <div class="kpi">
    <div class="k">
      {{ label }}
    </div>
    <div class="v">
      {{ value }}<small v-if="unit">{{ unit }}</small>
    </div>
    <div
      v-if="progress !== undefined"
      class="bar"
    >
      <i :style="{ width: `${Math.min(100, Math.max(0, progress))}%` }" />
    </div>
    <div class="foot">
      {{ note }}
    </div>
  </div>
</template>
