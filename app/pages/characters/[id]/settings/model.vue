<script setup lang="ts">
const route = useRoute();
const sections = ["chat", "voice", "vision", "memoryAssistant", "contextAssistant", "knowledge", "social"];
const requested = String(route.query.section ?? route.query.tab ?? "chat");
await navigateTo({
  path: "/models",
  query: { ...route.query, c: String(route.params.id ?? ""), section: sections.includes(requested) ? requested : "chat" },
  hash: route.hash,
}, { replace: true });
</script>

<template>
  <div />
</template>

<style scoped>
/* Keep the former style-block URL valid for browsers holding a pre-migration HMR graph. */
</style>
