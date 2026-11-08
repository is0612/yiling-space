<script setup lang="ts">
definePageMeta({
  topbar: { title: "知识系统" },
});

const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);

const stages = [
  {
    number: "01",
    title: "收集",
    description: "从聊天、资料和手动录入中发现值得整理的知识线索。",
  },
  {
    number: "02",
    title: "处理",
    description: "提炼核心内容，识别重复、冲突和不确定信息，并保留来源。",
  },
  {
    number: "03",
    title: "入库",
    description: "通过处理后再正式保存，形成可维护、可追溯的知识条目。",
  },
  {
    number: "04",
    title: "检索",
    description: "需要时按问题召回相关知识，交给语境助手决定是否提供给主聊天模型。",
  },
];
</script>

<template>
  <div class="page-wrap knowledge-page">
    <PageHeader
      eyebrow="成长系统 / 知识系统"
      description="整理她接触和学到的知识，让知识经过处理后再沉淀，并在需要时能够找回来。"
    />

    <section v-if="activeCharacter" class="knowledge-context">
      <div class="knowledge-context-copy">
        <span>当前角色</span>
        <strong>{{ activeCharacter.name }}</strong>
      </div>
      <span class="knowledge-context-note">知识按角色独立积累</span>
    </section>

    <section class="knowledge-flow" aria-label="知识处理流程">
      <article v-for="stage in stages" :key="stage.number" class="knowledge-stage">
        <span class="knowledge-stage-number">{{ stage.number }}</span>
        <h2>{{ stage.title }}</h2>
        <p>{{ stage.description }}</p>
      </article>
    </section>

    <section class="knowledge-workspaces">
      <article class="knowledge-panel">
        <div class="knowledge-panel-heading">
          <div>
            <span class="knowledge-kicker">待整理</span>
            <h2>知识候选</h2>
          </div>
          <span class="knowledge-status">待接入</span>
        </div>
        <p>这里会集中展示从交流和资料中发现、尚未正式入库的知识线索。</p>
      </article>

      <article class="knowledge-panel">
        <div class="knowledge-panel-heading">
          <div>
            <span class="knowledge-kicker">已沉淀</span>
            <h2>知识库</h2>
          </div>
          <span class="knowledge-status">待接入</span>
        </div>
        <p>这里会管理已经处理并入库的知识，包括分类、来源、关联、修订和失效状态。</p>
      </article>
    </section>

    <p v-if="!activeCharacter" class="knowledge-empty">
      当前没有可用角色，请先创建角色或从左下角选择角色。
      <NuxtLink to="/characters">打开角色管理</NuxtLink>
    </p>
  </div>
</template>

<style scoped>
.knowledge-page { display: flex; flex-direction: column; gap: 18px; }
.knowledge-context {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 12px 16px;
}
.knowledge-context-copy { display: flex; flex-direction: column; gap: 3px; }
.knowledge-context-copy span, .knowledge-kicker, .knowledge-stage-number {
  color: var(--dim);
  font-size: 12px;
}
.knowledge-context-copy strong { color: var(--ink); font-size: 14px; }
.knowledge-context-note { margin-left: auto; color: var(--dim); font-size: 12px; }
.knowledge-flow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.knowledge-stage, .knowledge-panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 18px;
}
.knowledge-stage h2, .knowledge-panel h2 {
  margin: 10px 0 7px;
  color: var(--ink);
  font-size: 16px;
  font-weight: 650;
}
.knowledge-stage p, .knowledge-panel p {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.8;
}
.knowledge-workspaces {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.knowledge-panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.knowledge-panel-heading h2 { margin-top: 5px; }
.knowledge-status {
  flex: none;
  border-radius: 999px;
  background: var(--surface-2);
  padding: 4px 9px;
  color: var(--dim);
  font-size: 11px;
}
.knowledge-empty {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
}
.knowledge-empty a { margin-left: 8px; color: var(--accent); }
@media (max-width: 900px) {
  .knowledge-flow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 620px) {
  .knowledge-flow, .knowledge-workspaces { grid-template-columns: 1fr; }
  .knowledge-context { align-items: flex-start; flex-wrap: wrap; }
  .knowledge-context-note { width: 100%; margin-left: 0; }
}
</style>
