<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "总览" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 总览"
    description="九个板块的入口都在左侧，具体内容按阶段逐步接入。"
  />
</template>
