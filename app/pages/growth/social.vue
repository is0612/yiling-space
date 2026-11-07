<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "社交关系系统" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 社交关系系统"
    description="她认识谁，以及跟每个人熟到什么程度。"
  />
</template>
