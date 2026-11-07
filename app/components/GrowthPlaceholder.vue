<script setup lang="ts">
/**
 * 成长系统各页的共用骨架。
 *
 * 只做三件事：套上 .page-wrap、给出 crumb 和一行说明、留一块空白占位。
 * 页面标题归顶栏（各页自己 definePageMeta 声明），这里不重复渲染 h1。
 * 具体板块（记忆 / 社交 / 偏好…）后续往各自页面里填，本组件不预置任何业务结构。
 */
defineProps<{
  eyebrow: string;
  description?: string;
}>();
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="eyebrow"
      :description="description"
    />
    <div class="card growth-blank">
      <p class="muted-note">
        页面框架已就绪，内容与数据在后续阶段接入。
      </p>
    </div>
  </div>
</template>

<style scoped>
.growth-blank { padding: 26px 22px; }
</style>
