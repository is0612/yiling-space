<script setup lang="ts">
/** 区块标题 —— 对齐 bili-desk 的 .sec-h（14px 标题 + 可选说明 + 右侧动作）。 */
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="sec-h">
    <h2>{{ title }}</h2>
    <span
      v-if="description"
      class="sub"
    >{{ description }}</span>
    <slot name="action" />
  </div>
</template>
