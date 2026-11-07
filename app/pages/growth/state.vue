<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "状态系统" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 状态系统"
    description="她此刻的情绪与状态，以及状态怎样随时间变化。"
  />
</template>
