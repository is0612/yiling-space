<script setup lang="ts">
withDefaults(defineProps<{
  active: "memory" | "events" | "snapshots";
}>(), {
  active: "memory",
});
</script>

<template>
  <nav class="memory-section-nav" aria-label="记忆系统导航">
    <NuxtLink
      to="/growth/memory"
      class="memory-section-link"
      :class="{ active: active === 'memory' }"
      :aria-current="active === 'memory' ? 'page' : undefined"
    >
      长期记忆
    </NuxtLink>
    <NuxtLink
      to="/growth/memory/events"
      class="memory-section-link"
      :class="{ active: active === 'events' }"
      :aria-current="active === 'events' ? 'page' : undefined"
    >
      忆泡日历
    </NuxtLink>
    <NuxtLink
      to="/growth/memory/snapshots"
      class="memory-section-link"
      :class="{ active: active === 'snapshots' }"
      :aria-current="active === 'snapshots' ? 'page' : undefined"
    >
      阶段总结
    </NuxtLink>
  </nav>
</template>

<style scoped>
.memory-section-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.memory-section-link {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 0 12px;
  border-bottom: 2px solid transparent;
  color: var(--dim);
  font-size: 13px;
  text-decoration: none;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.memory-section-link:hover {
  color: var(--text-2);
}
.memory-section-link.active {
  border-bottom-color: var(--accent, #0d9488);
  color: var(--text-2);
  font-weight: 600;
}
</style>
