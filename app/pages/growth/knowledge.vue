<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "轻量知识系统" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 轻量知识系统"
    description="零碎但用得上的常识，不追求体系化。"
  />
</template>
