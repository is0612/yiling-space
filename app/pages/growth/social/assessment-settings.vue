<script setup lang="ts">
/**
 * 兼容旧入口：关系评估助手已并入「对话模型」页（2026-11-12），
 * 不再有独立的 section，直接落到 chat。保留角色与其余查询参数。
 */
const route = useRoute();
await navigateTo(
  { path: "/models", query: { ...route.query, section: "chat" }, hash: route.hash },
  { replace: true, redirectCode: 301 },
);
</script>

<template>
  <div />
</template>

<style scoped>
/* Preserve the former style-block endpoint while existing tabs finish their HMR refresh. */
</style>
