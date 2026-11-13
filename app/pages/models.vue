<script setup lang="ts">
/**
 * 兼容旧入口：模型设置已经并到「角色管理 → 某个角色 → 模型设置」这一层
 * （`/characters/:id/settings/model`，2026-11-13）。
 *
 * 老书签和外部链接里的 `/models` 带上 `?c=` 就原样转过去；
 * 没带的话用共享的角色选择（cookie / 上次选中的）来定，一个角色都没有就回角色列表。
 * 侧栏里已经没有这一项，只剩这条转发。
 */
const route = useRoute();
const { id } = useCharacterSelection("/models");
await navigateTo(
  id.value
    ? {
        path: `/characters/${encodeURIComponent(id.value)}/settings/model`,
        query: { ...route.query, c: id.value },
        hash: route.hash,
      }
    : { path: "/characters", query: route.query, hash: route.hash },
  { replace: true, redirectCode: 301 },
);
</script>

<template>
  <div />
</template>

<style scoped>
/* Keep the former style-block URL valid for browsers holding a pre-migration HMR graph. */
</style>
