<script setup lang="ts">
/**
 * 阶段总结已升级成菜单页 `/snapshots`（顶部下拉切换角色）。
 * 这里只保留旧地址的跳转，避免书签、外部链接和历史对话里的链接落在空路由上。
 */
definePageMeta({
  middleware: [
    (to) => navigateTo(
      { path: "/snapshots", query: { c: String(to.params.id || "") } },
      { replace: true },
    ),
  ],
});
</script>

<template>
  <div class="page-wrap">
    <div class="empty-state">
      正在打开阶段总结……
    </div>
  </div>
</template>
