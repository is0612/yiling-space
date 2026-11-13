<script setup lang="ts">
import MemoryWorkspace from "~/components/MemoryWorkspace.vue";

definePageMeta({
  topbar: {
    title: "长期记忆",
    crumbs: [{ label: "记忆系统", to: "/growth/memory" }],
  },
});
</script>

<template>
  <MemoryWorkspace />
</template>
