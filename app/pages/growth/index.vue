<script setup lang="ts">
// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "总览" },
});
</script>

<template>
  <div>
    <GrowthPlaceholder
      eyebrow="成长系统 / 总览"
      description="九个板块的入口都在左侧，具体内容按阶段逐步接入。"
    />
    <section class="page-wrap growth-delivery-entry">
      <div class="card growth-delivery-card">
        <div>
          <strong>成长事件投递</strong>
          <p>查看当前角色的投递状态、可执行积压、失败原因与恢复记录。</p>
        </div>
        <NuxtLink
          to="/growth/deliveries"
          class="card-link"
        >
          查看事件投递 →
        </NuxtLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.growth-delivery-entry { padding-top: 0; }
.growth-delivery-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 20px; font-size: 14px; }
.growth-delivery-card p { margin: 6px 0 0; color: var(--dim); font-size: 12px; line-height: 1.6; }
</style>
