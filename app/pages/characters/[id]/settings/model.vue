<script setup lang="ts">
/**
 * 兼容旧入口：角色设置里的模型页已经统一到 /models。
 * 2026-11-12 起四个助手并进对话模型页，所以只有三个 section 还能对上，
 * 老书签里的 memoryAssistant / contextAssistant / knowledge / social 一律落到 chat。
 */
const route = useRoute();
const sections = ["chat", "voice", "vision"];
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
