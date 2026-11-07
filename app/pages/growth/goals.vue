<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "目标与愿望" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 目标与愿望"
    description="她想做的事，以及一直惦记着的事。"
  />
</template>
