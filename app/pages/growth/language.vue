<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "语料 / 表达习惯" },
});
</script>

<template>
  <GrowthPlaceholder
    eyebrow="成长系统 / 语料与表达习惯"
    description="她平时怎么说话：用词、语气和句子的长短。"
  />
</template>
