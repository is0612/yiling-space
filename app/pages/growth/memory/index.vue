<script setup lang="ts">
definePageMeta({
  topbar: { title: "记忆系统" },
});
</script>

<template>
  <div class="page-wrap">
    <MemorySectionNavigation active="overview" />
    <PageHeader
      eyebrow="成长系统 / 记忆系统"
      description="管理她记住的内容、每天发生的事，以及一段时间里的成长总结。"
    />

    <section class="memory-overview-grid" aria-label="记忆功能">
      <NuxtLink to="/growth/memory/long-term" class="memory-overview-card">
        <span class="memory-overview-kicker">01 · 长期记忆</span>
        <h2>长期记忆</h2>
        <p>查看、搜索和编辑已经沉淀下来的事实、偏好、关系、目标与约定，也能追溯来源。</p>
        <span class="memory-overview-action">管理长期记忆 <span aria-hidden="true">→</span></span>
      </NuxtLink>

      <NuxtLink to="/growth/memory/events" class="memory-overview-card">
        <span class="memory-overview-kicker">02 · 忆泡日历</span>
        <h2>忆泡日历</h2>
        <p>按日期回看整理过的事件，查看当时的对话原文，修改或隐藏不需要的忆泡。</p>
        <span class="memory-overview-action">查看日历 / 整理忆泡 <span aria-hidden="true">→</span></span>
      </NuxtLink>

      <NuxtLink to="/growth/memory/snapshots" class="memory-overview-card">
        <span class="memory-overview-kicker">03 · 阶段总结</span>
        <h2>阶段总结</h2>
        <p>回顾一段时间内的经历、变化、关系与目标，查看 AI 提炼结果和历史版本。</p>
        <span class="memory-overview-action">查看阶段总结 <span aria-hidden="true">→</span></span>
      </NuxtLink>
    </section>

    <section class="memory-overview-tools">
      <div>
        <h2>常用操作</h2>
        <p>把常用入口放在这里，不在总览展示具体记忆数据。</p>
      </div>
      <div class="memory-overview-shortcuts">
        <NuxtLink to="/growth/memory/long-term">新增 / 编辑长期记忆</NuxtLink>
        <NuxtLink to="/growth/memory/events">立即整理忆泡</NuxtLink>
        <NuxtLink to="/growth/memory/snapshots">查看与管理历史总结</NuxtLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.memory-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 18px;
}
.memory-overview-card {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 20px;
  color: inherit;
  text-decoration: none;
  transition: background .15s ease, transform .15s ease;
}
.memory-overview-card:hover {
  background: var(--surface-2, #f6f7fb);
  transform: translateY(-2px);
}
.memory-overview-kicker {
  color: var(--dim);
  font-size: 12px;
  letter-spacing: .04em;
}
.memory-overview-card h2 {
  margin: 18px 0 8px;
  color: var(--text-2);
  font-size: 17px;
  font-weight: 650;
}
.memory-overview-card p {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.85;
}
.memory-overview-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 20px;
  color: var(--accent, #0d9488);
  font-size: 13px;
  font-weight: 600;
}
.memory-overview-tools {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-top: 18px;
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 18px 20px;
}
.memory-overview-tools h2 {
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
}
.memory-overview-tools p {
  margin: 6px 0 0;
  color: var(--dim);
  font-size: 12px;
}
.memory-overview-shortcuts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.memory-overview-shortcuts a {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  border-radius: 7px;
  background: var(--surface-2, #f6f7fb);
  padding: 0 11px;
  color: var(--text-2);
  font-size: 12px;
  text-decoration: none;
}
.memory-overview-shortcuts a:hover {
  color: var(--accent, #0d9488);
}
@media (max-width: 900px) {
  .memory-overview-grid { grid-template-columns: 1fr; }
  .memory-overview-card { min-height: 180px; }
  .memory-overview-tools { flex-direction: column; }
  .memory-overview-shortcuts { justify-content: flex-start; }
}
</style>
