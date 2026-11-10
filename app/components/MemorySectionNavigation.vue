<script setup lang="ts">
import { Calendar, Collection, Document, Grid } from "@element-plus/icons-vue";
const route = useRoute();
const characterQuery = computed(() => route.query.c ? { c: route.query.c } : {});
withDefaults(defineProps<{
  active?: "overview" | "long-term" | "events" | "snapshots";
}>(), { active: "overview" });
const sections = [
  { key: "overview", path: "/growth/memory", label: "总览", icon: Grid },
  { key: "long-term", path: "/growth/memory/long-term", label: "长期记忆", icon: Collection },
  { key: "events", path: "/growth/memory/events", label: "忆泡日历", icon: Calendar },
  { key: "snapshots", path: "/growth/memory/snapshots", label: "阶段总结", icon: Document },
];
</script>

<template>
  <nav
    class="memory-section-nav"
    aria-label="记忆系统导航"
  >
    <NuxtLink
      v-for="section in sections"
      :key="section.key"
      :to="{ path: section.path, query: characterQuery }"
      class="memory-section-link"
      :class="{ active: active === section.key }"
      :aria-current="active === section.key ? 'page' : undefined"
    >
      <el-icon><component :is="section.icon" /></el-icon>{{ section.label }}
    </NuxtLink>
  </nav>
</template>

<style scoped>
.memory-section-nav { display: flex; align-items: center; gap: 6px; margin-bottom: 20px; border-bottom: 1px solid var(--line); padding-bottom: 8px; overflow-x: auto; }
.memory-section-link { display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 7px; min-height: 36px; border-radius: 8px; padding: 0 14px; color: var(--dim); font-size: 13px; text-decoration: none; white-space: nowrap; transition: color .15s ease, background .15s ease; }
.memory-section-link .el-icon { font-size: 15px; }
.memory-section-link:hover { background: var(--surface); color: var(--text-2); }
.memory-section-link.active { background: var(--brand-soft); color: var(--brand-strong); font-weight: 600; }
.memory-section-link:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
@media (max-width: 640px) { .memory-section-link { gap: 5px; padding: 0 10px; } }
</style>
