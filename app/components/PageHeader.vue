<script setup lang="ts">
import { computed } from "vue";
import { ArrowLeft } from "@element-plus/icons-vue";

/**
 * 页面标题行 —— 对齐 bili-desk 的 .crumb + .page-h。
 * eyebrow 用「A / B」的写法，自动拆成面包屑，最后一段加粗。
 *
 * backTo / backLabel：返回入口放在标题左上角，不再塞进 #actions。
 * 右上角离视线起点太远，而返回是「读这一页之前」的动作，应该出现在第一个落点上。
 */
const props = defineProps<{
  eyebrow?: string;
  title: string;
  description?: string;
  backTo?: string;
  backLabel?: string;
}>();

const crumbs = computed(() =>
  (props.eyebrow ?? "").split("/").map((part) => part.trim()).filter(Boolean),
);
</script>

<template>
  <div>
    <NuxtLink
      v-if="backTo"
      :to="backTo"
      class="ph-back"
    >
      <el-icon><ArrowLeft /></el-icon>{{ backLabel || "返回" }}
    </NuxtLink>

    <div
      v-if="crumbs.length"
      class="crumb"
    >
      <template
        v-for="(part, index) in crumbs"
        :key="`${part}-${index}`"
      >
        <template v-if="index < crumbs.length - 1">
          <span>{{ part }}</span>
          <span>/</span>
        </template>
        <b v-else>{{ part }}</b>
      </template>
    </div>

    <div class="page-h">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="description">
          {{ description }}
        </p>
      </div>
      <div
        v-if="$slots.actions"
        class="ph-r"
      >
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 返回：文字链接 12px/600。颜色用 --dim，--faint(2.55:1) 承载不了文字 */
.ph-back {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  border-radius: var(--radius-xs);
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  transition: color .14s var(--ease);
}
.ph-back:hover { color: var(--brand-strong); }
.ph-back:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.ph-back .el-icon { font-size: 13px; }
</style>
