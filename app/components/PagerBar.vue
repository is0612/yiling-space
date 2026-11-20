<script setup lang="ts">
/**
 * 通用翻页条 —— 与「她的朋友」页同一套样式（白砖、零描边、蜜色选中）。
 *
 * 页码和 total 都由后端给，这里只负责渲染 + 把点击转成 `update:page`。
 * 只有一个页面时只留左侧「共 N 条」的说明，不摆一排废按钮。
 */
const props = withDefaults(defineProps<{
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  /** 计数单位：条 / 人 / 个 */
  unit?: string;
  /** 嵌在卡片内部（表格底部）时用，去掉自己的白底和圆角 */
  flush?: boolean;
  /** 窄列（日记左栏 ~306px）用箭头代替「上一页/下一页」文字，避免挤成两行 */
  compact?: boolean;
}>(), { unit: "条", flush: false, compact: false });

const emit = defineEmits<{ "update:page": [value: number] }>();

const rangeText = computed(() => {
  if (!props.total) return `0 ${props.unit}`;
  const start = (props.page - 1) * props.pageSize + 1;
  const end = Math.min(props.total, props.page * props.pageSize);
  return `${start}–${end} / 共 ${props.total} ${props.unit}`;
});

/** 页码最多摊七个位置，中间用 0 当省略号：1 … 4 5 6 … 20 */
const pageNumbers = computed(() => {
  const total = props.totalPages;
  const current = props.page;
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const picked = [...new Set([1, total, current - 1, current, current + 1])]
    .filter((value) => value >= 1 && value <= total)
    .sort((a, b) => a - b);
  const result: number[] = [];
  let previous = 0;
  for (const value of picked) {
    if (previous && value - previous > 1) result.push(0);
    result.push(value);
    previous = value;
  }
  return result;
});

function go(target: number) {
  const next = Math.min(props.totalPages, Math.max(1, target));
  if (next !== props.page) emit("update:page", next);
}

/** 越界纠正留在组件里：数据删到只剩一页时，父组件不必自己回夹页码 */
watch([() => props.totalPages, () => props.total], () => {
  if (props.page > props.totalPages) emit("update:page", props.totalPages);
});
</script>

<template>
  <div
    v-if="total > 0"
    class="pager"
    :class="{ 'is-flush': flush }"
  >
    <span class="pager-info">{{ rangeText }}</span>
    <div
      v-if="totalPages > 1"
      class="pager-btns"
    >
      <button
        type="button"
        class="pager-btn"
        :aria-label="compact ? '上一页' : undefined"
        :disabled="page === 1"
        @click="go(page - 1)"
      >
        {{ compact ? "‹" : "上一页" }}
      </button>
      <template
        v-for="(item, index) in pageNumbers"
        :key="index"
      >
        <span
          v-if="item === 0"
          class="pager-gap"
        >…</span>
        <button
          v-else
          type="button"
          class="pager-btn is-num"
          :class="{ 'is-on': item === page }"
          @click="go(item)"
        >
          {{ item }}
        </button>
      </template>
      <button
        type="button"
        class="pager-btn"
        :aria-label="compact ? '下一页' : undefined"
        :disabled="page === totalPages"
        @click="go(page + 1)"
      >
        {{ compact ? "›" : "下一页" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 窄容器（日记左栏 306px）里不能把「上一页」拆成两行：整组换行，按钮自身不许断字 */
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
  margin-top: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 8px 12px;
}
.pager.is-flush { margin-top: 0; border-radius: 0 0 10px 10px; background: none; }
.pager-info { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pager-btns { display: flex; flex: none; align-items: center; gap: 2px; flex-wrap: nowrap; }
.pager-btn {
  display: inline-flex;
  height: 28px;
  min-width: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 0 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.pager-btn:hover:not(:disabled) { background: var(--surface-2); }
.pager-btn:disabled { color: var(--faint); cursor: default; }
.pager-btn.is-num.is-on { background: var(--brand-soft); color: var(--brand-strong); }
.pager-gap { padding: 0 2px; color: var(--faint); font-size: 12px; }
</style>
