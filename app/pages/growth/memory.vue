<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "记忆系统" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 记忆系统"
    description="她记得什么，以及这些记忆怎样被整理和取用。"
  />
</template>
