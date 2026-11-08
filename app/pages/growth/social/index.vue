<script setup lang="ts">
definePageMeta({
  topbar: { title: "社交关系系统" },
});
</script>

<template>
  <div class="page-wrap social-page">
    <PageHeader
      eyebrow="成长系统 / 社交关系系统"
      description="管理她认识的人、对对方的判断，以及她应该怎样回应不同对象。"
    />

    <section class="social-current">
      <article class="social-card social-card-primary">
        <div class="social-kicker">已接入 · 好友档案</div>
        <h2>她的朋友</h2>
        <p>
          这里已经记录她在 QQ、B站等渠道遇到的人。可以查看平台身份、昵称、认识来源、互动情况，
          也可以给对方添加她自己的备注。
        </p>
        <ul>
          <li>同一个平台账号跨角色共享身份档案，各角色的关系分别保存。</li>
          <li>身份可标记为未知、真人或 AI；手动确认后不会被普通互动覆盖。</li>
          <li>可以按当前角色决定默认处理、允许交流或禁止交流。</li>
        </ul>
        <NuxtLink to="/growth/social/friends" class="social-action">
          打开好友档案与交流管理 <span aria-hidden="true">→</span>
        </NuxtLink>
      </article>

      <article class="social-card">
        <div class="social-kicker">关系成长 · 建设中</div>
        <h2>关系评估 AI</h2>
        <p>关系阶段和相处状态已经有独立数据与评估队列。下一步接入专职评估模型：它只提供建议，是否写入由证据核验和关系版本保护决定。</p>
        <NuxtLink to="/growth/social/assessment-settings" class="social-action">
          配置关系评估 AI <span aria-hidden="true">→</span>
        </NuxtLink>
      </article>

      <article class="social-card">
        <div class="social-kicker">当前规则</div>
        <h2>交流权限</h2>
        <div class="social-rule">
          <strong>默认</strong>
          <span>真人正常回应，AI 默认不主动接话。</span>
        </div>
        <div class="social-rule">
          <strong>允许交流</strong>
          <span>为指定对象开启交流，即使对方是 AI 也可以互动。</span>
        </div>
        <div class="social-rule">
          <strong>禁止交流</strong>
          <span>当前角色不回应指定对象；规则会在群聊接收和批次发送前检查。</span>
        </div>
        <p class="social-footnote">
          身份判断是平台账号级的；交流权限是角色级的。同一个 AI 可以被一个角色允许、被另一个角色屏蔽。
        </p>
      </article>
    </section>

    <section class="social-next">
      <div class="social-section-heading">
        <div>
          <div class="social-kicker">后续逐步建设</div>
          <h2>关系的自然成长</h2>
        </div>
        <p>先保留清晰边界，不把互动次数直接当成亲密程度。</p>
      </div>
      <div class="social-next-grid">
        <article class="social-next-card">
          <h3>身份自动识别建议</h3>
          <p>优先使用渠道提供的可信身份标记；证据不足时保持未知，只给出建议，不覆盖人工确认。</p>
          <span class="social-status">尚未实现</span>
        </article>
        <article class="social-next-card">
          <h3>关系阶段与相处状态</h3>
          <p>阶段描述亲疏，相处状态描述近期关系体验；两者分开保存，互动次数不会直接决定阶段。</p>
          <span class="social-status">数据与队列已接入</span>
        </article>
        <article class="social-next-card">
          <h3>评估证据</h3>
          <p>每次评估只分析已挂接的经历引用；新证据与历史背景分开，避免把旧经历重复算成新进展。</p>
          <span class="social-status">下一批实现</span>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.social-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.social-current {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr);
  gap: 14px;
}
.social-card,
.social-next-card {
  min-width: 0;
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 20px;
}
.social-card-primary {
  border: 1px solid var(--line, #e8eaf0);
}
.social-kicker {
  color: var(--dim);
  font-size: 12px;
  letter-spacing: .04em;
}
.social-card h2,
.social-section-heading h2 {
  margin: 12px 0 8px;
  color: var(--text-2);
  font-size: 17px;
  font-weight: 650;
}
.social-card p,
.social-next-card p,
.social-section-heading > p {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.85;
}
.social-card ul {
  display: grid;
  gap: 8px;
  margin: 16px 0 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.75;
}
.social-action {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 20px;
  color: var(--accent, #0d9488);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}
.social-action:hover {
  text-decoration: underline;
}
.social-rule {
  display: grid;
  gap: 4px;
  padding: 13px 0;
  border-bottom: 1px solid var(--line, #e8eaf0);
}
.social-rule strong {
  color: var(--text-2);
  font-size: 13px;
}
.social-rule span {
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
}
.social-footnote {
  margin-top: 14px !important;
  font-size: 12px !important;
}
.social-next {
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 20px;
}
.social-section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}
.social-section-heading h2 {
  margin-bottom: 0;
}
.social-section-heading > p {
  max-width: 360px;
  text-align: right;
}
.social-next-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.social-next-card {
  background: var(--surface-2, #f6f7fb);
  padding: 16px;
}
.social-next-card h3 {
  margin: 0 0 8px;
  color: var(--text-2);
  font-size: 14px;
}
.social-status {
  display: inline-block;
  margin-top: 14px;
  color: var(--dim);
  font-size: 11px;
}
@media (max-width: 900px) {
  .social-current,
  .social-next-grid {
    grid-template-columns: 1fr;
  }
  .social-section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .social-section-heading > p {
    text-align: left;
  }
}
</style>
