<script setup lang="ts">
/**
 * 网页对话已下线：聊天统一在 QQ / B站 / 桌宠那边发生，工作台不再插一脚。
 * 这里只留旧地址的兜底跳转，免得书签和历史链接落在 404 上。
 */
definePageMeta({
  middleware: [
    (to) => navigateTo(
      {
        path: "/growth/memory/long-term",
        query: { ...to.query },
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
      正在打开角色记忆……
    </div>
  </div>
</template>
