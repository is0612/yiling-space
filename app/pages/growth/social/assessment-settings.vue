<script setup lang="ts">
/** 兼容旧入口：模型配置已统一到模型设置页，保留角色与其余查询参数。 */
const route = useRoute();
await navigateTo(
  { path: "/models", query: { ...route.query, section: "social" }, hash: route.hash },
  { replace: true, redirectCode: 301 },
);
</script>

<template>
  <div />
</template>

<style scoped>
/* Preserve the former style-block endpoint while existing tabs finish their HMR refresh. */
</style>
