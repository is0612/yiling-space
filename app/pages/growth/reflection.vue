<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "反思与成长" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 反思与成长"
    description="她从发生过的事里得出了什么结论，又因此改变了什么。"
  />
</template>
