<script setup lang="ts">
import MemoryWorkspace from "~/components/MemoryWorkspace.vue";

definePageMeta({
  topbar: { title: "长期记忆" },
});
</script>

<template>
  <MemoryWorkspace growth-mode />
</template>
