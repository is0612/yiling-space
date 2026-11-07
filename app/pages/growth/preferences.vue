<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "偏好系统" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 偏好系统"
    description="她喜欢什么、不喜欢什么，以及这些偏好从哪里来。"
  />
</template>
