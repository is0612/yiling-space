<script setup lang="ts">
import { Avatar, Connection, DocumentChecked, Setting } from "@element-plus/icons-vue";

definePageMeta({ topbar: { title: "社交系统" } });
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
function roleHref(path: string) {
  return characterId.value ? `${path}?c=${encodeURIComponent(characterId.value)}` : path;
}
const entries = [
  { title: "好友档案", kicker: "认识谁 · 怎样交流", description: "查看她认识的人、互动记录与备注，管理身份分类和交流权限。", href: "/growth/social/friends", action: "管理好友", icon: Avatar },
  { title: "关系评估历史", kicker: "为什么变化 · 由你决定", description: "查看每次评估的结论和真实证据，审阅关系阶段与相处状态的变化建议。", href: "/growth/social/assessments", action: "查看评估与建议", icon: DocumentChecked },
  { title: "评估设置", kicker: "何时评估 · 使用什么模型", description: "配置关系评估助手的独立模型、凭据与调用预算，启用后由后台处理任务。", href: "/growth/social/assessment-settings", action: "配置评估助手", icon: Setting },
];
</script>

<template>
  <div class="page-wrap social-page">
    <PageHeader
      eyebrow="成长系统 / 社交系统"
      description="认识她身边的人，回看共同经历，认真决定一段关系的变化。"
    />
    <section class="social-intro">
      <div>
        <span class="social-kicker">每段关系，都有自己的来处</span>
        <h1>从一次相遇，到彼此熟悉。</h1>
        <p v-if="activeCharacter">
          当前角色「{{ activeCharacter.name }}」。好友关系、交流权限与评估记录均随角色分别保存。
        </p>
        <p v-else>
          请先从全局角色选择器选一个角色，再查看她的好友与评估记录。
        </p>
      </div>
      <el-icon
        class="social-intro-icon"
        aria-hidden="true"
      >
        <Connection />
      </el-icon>
    </section>

    <section
      class="social-entry-grid"
      aria-label="社交功能入口"
    >
      <article
        v-for="entry in entries"
        :key="entry.href"
        class="social-card"
      >
        <div class="social-card-top">
          <el-icon
            class="social-entry-icon"
            aria-hidden="true"
          >
            <component :is="entry.icon" />
          </el-icon>
          <span class="social-kicker">{{ entry.kicker }}</span>
        </div>
        <h2>{{ entry.title }}</h2>
        <p>{{ entry.description }}</p>
        <NuxtLink
          :to="roleHref(entry.href)"
          class="social-action"
        >
          {{ entry.action }} <span aria-hidden="true">→</span>
        </NuxtLink>
      </article>
    </section>

    <section
      class="social-guidance"
      aria-label="如何理解关系评估"
    >
      <div class="social-section-heading">
        <div>
          <span class="social-kicker">从经历到建议</span>
          <h2>看懂建议，再决定是否采纳。</h2>
        </div>
        <p>互动次数是一份记录，不是亲密度分数。</p>
      </div>
      <ol class="social-steps">
        <li>
          <span class="step-number">01</span>
          <div><h3>留下共同经历</h3><p>重要社交经历引用已有忆泡，不另造一份事实。不同角色与同一账号的关系各自独立。</p></div>
        </li>
        <li>
          <span class="step-number">02</span>
          <div><h3>区分新证据与背景</h3><p>NEW 是本轮新经历，CONTEXT 是历史背景。旧经历不能反复当作新的关系进展。</p></div>
        </li>
        <li>
          <span class="step-number">03</span>
          <div><h3>人工审阅变化</h3><p>AI 只给建议；采纳后才更新关系并留痕。关系已变化的过期建议不能继续应用。</p></div>
        </li>
      </ol>
    </section>

    <section
      class="social-boundaries"
      aria-label="身份与交流规则"
    >
      <article class="social-rule-card">
        <h2>身份分类，不等于关系阶段。</h2>
        <p>真人、AI、未知描述对方的身份；陌生、认识、朋友、好朋友描述她与对方的关系。身份分类不会直接决定关系亲疏，人工确认的身份不会被普通互动覆盖。</p>
      </article>
      <article class="social-rule-card">
        <h2>交流权限，由当前角色单独决定。</h2>
        <p>在好友档案中选择默认处理、允许交流或禁止交流。允许 AI 互动不代表关系自动升级；禁止交流也不是删除好友经历。</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.social-page { display: flex; flex-direction: column; gap: 24px; }
.social-intro { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 28px; border-radius: 10px; background: var(--surface); border-left: 3px solid var(--brand); }
.social-kicker { color: var(--dim); font-size: 12px; }
.social-intro h1 { margin: 10px 0; color: var(--text); font-size: 26px; font-weight: 650; line-height: 1.5; }
.social-intro p { margin: 0; color: var(--dim); font-size: 14px; line-height: 1.8; }
.social-intro-icon { flex: none; width: 72px; height: 72px; border-radius: 50%; color: var(--brand-strong); background: var(--brand-soft); font-size: 32px; }
.social-entry-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.social-card { min-width: 0; display: flex; flex-direction: column; padding: 24px; border-radius: 10px; background: var(--surface); }
.social-card-top { display: flex; align-items: center; gap: 12px; }
.social-entry-icon { flex: none; width: 36px; height: 36px; border-radius: 8px; color: var(--brand-strong); background: var(--brand-soft); font-size: 20px; }
.social-card h2, .social-section-heading h2 { margin: 18px 0 10px; color: var(--text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.social-card p, .social-steps p, .social-rule-card p { margin: 0; color: var(--dim); font-size: 14px; line-height: 1.85; }
.social-action { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 24px; color: var(--brand-strong); font-size: 14px; font-weight: 600; text-decoration: none; }
.social-action:hover { text-decoration: underline; }
.social-guidance { padding: 24px; border-radius: 10px; background: var(--surface); }
.social-section-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; }
.social-section-heading h2 { margin-top: 8px; margin-bottom: 0; }
.social-section-heading > p { margin: 0; color: var(--dim); font-size: 12px; }
.social-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; padding: 0; margin: 0; list-style: none; }
.social-steps li { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.step-number { color: var(--brand-strong); background: var(--brand-soft); border-radius: 8px; padding: 6px 8px; font-size: 12px; }
.social-steps h3 { margin: 4px 0 8px; color: var(--text-2); font-size: 14px; font-weight: 600; }
.social-steps p { font-size: 12px; }
.social-boundaries { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.social-rule-card { padding: 20px 24px; border: 1px solid var(--line); border-radius: 10px; }
.social-rule-card h2 { margin: 0 0 8px; color: var(--text-2); font-size: 14px; font-weight: 600; }
.social-rule-card p { font-size: 12px; }
@media (max-width: 1000px) { .social-entry-grid, .social-steps { grid-template-columns: 1fr; } .social-card { padding: 20px; } .social-section-heading { align-items: flex-start; flex-direction: column; gap: 12px; } }
@media (max-width: 640px) { .social-page { gap: 16px; } .social-intro { padding: 20px; } .social-intro h1 { font-size: 22px; } .social-intro-icon { display: none; } .social-boundaries { grid-template-columns: 1fr; } .social-guidance { padding: 20px; } }
</style>
