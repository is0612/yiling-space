<script setup lang="ts">
/**
 * 阶段总结统一进入成长系统的阶段总结页。
 * 这里只保留旧地址的跳转，避免书签、外部链接和历史对话里的链接落在空路由上。
 */
definePageMeta({
  middleware: [
    (to) => navigateTo(
      {
        path: "/growth/memory/snapshots",
        query: { ...to.query, c: String(to.params.id || "") },
        hash: to.hash,
      },
      { replace: true, redirectCode: 301 },
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
