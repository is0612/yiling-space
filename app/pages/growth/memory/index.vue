<script setup lang="ts">
import MemoryWorkspace from "~/components/MemoryWorkspace.vue";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文由长期记忆工作区负责。
definePageMeta({
  topbar: { title: "记忆系统" },
});
</script>

<template>
  <MemoryWorkspace growth-mode />
</template>
