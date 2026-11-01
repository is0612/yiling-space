<script setup lang="ts">
/**
 * 系统设置。
 *
 * 分栏按「能不能动手」切：左边只放能改的（密码、登录设备），右边只放只能看的（系统状态、关于）。
 * 原来「运行状态」那两张卡里三行全是「未接入 / 规划中」，占一整块却什么也做不了 ——
 * 收成右侧一列状态行，一眼看出哪项接上了、哪项还空着。
 */
const STATUS_ROWS = [
  { label: "管理员登录与密码", note: "已接入真实数据库", live: true },
  { label: "数据库连接检测", note: "未接入", live: false },
  { label: "后台任务告警", note: "邮件 / Webhook 未接入", live: false },
];

const ABOUT_ROWS = [
  { label: "版本", value: "预览版 v0.1" },
  { label: "前端", value: "Vue 3 + Nuxt" },
  { label: "UI", value: "Element Plus" },
  { label: "数据库", value: "PostgreSQL" },
  { label: "数据访问", value: "Prisma ORM 7" },
];
</script>

<template>
  <div class="page-wrap set-a">
    <PageHeader
      eyebrow="系统管理 / 系统设置"
      title="系统设置"
      description="管理员密码与登录设备，以及各模块的接入状态。"
    />

    <div class="set-grid">
      <div class="set-main">
        <AccountSecurityPanel />
      </div>

      <aside class="set-aside">
        <section class="brick">
          <div class="card-h">
            <h2>系统状态</h2>
          </div>
          <dl class="status-list">
            <div
              v-for="row in STATUS_ROWS"
              :key="row.label"
              class="status-row"
            >
              <span
                class="dot"
                :class="{ 'is-live': row.live }"
              />
              <dt>{{ row.label }}</dt>
              <dd :class="{ 'is-live': row.live }">
                {{ row.note }}
              </dd>
            </div>
          </dl>
          <p class="aside-hint">
            数据库密码、模型 API Key、渠道 Token 都不进前端配置；模型 API Key 在角色的模型设置页加密保存。
          </p>
        </section>

        <section class="brick">
          <div class="card-h">
            <h2>关于</h2>
          </div>
          <div class="about-head">
            <span class="about-mark">忆</span>
            <div>
              <div class="about-name">
                忆灵空间
              </div>
              <div class="about-sub">
                多角色 AI 养成 · Yiling Space
              </div>
            </div>
          </div>
          <dl class="about-list">
            <div
              v-for="row in ABOUT_ROWS"
              :key="row.label"
            >
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影 */
.set-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--sp-4); align-items: start; }
.set-main { min-width: 0; }
.set-aside { display: flex; flex-direction: column; gap: var(--sp-4); }

.brick { border-radius: 10px; background: var(--surface); padding: 18px 20px 16px; }
.card-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.card-h h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }

/* 状态行：小圆点 + 名称 + 右侧状态字。圆点是唯一的颜色信号，且不单靠颜色（右侧还有文字） */
.status-list { display: flex; flex-direction: column; gap: 9px; margin: 0; }
.status-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); transform: translateY(-1px); }
.dot.is-live { background: var(--green); }
.status-row dt { color: var(--text-2); font-size: 14px; line-height: 1.5; }
.status-row dd { margin: 0; color: var(--dim); font-size: 12px; text-align: right; }
/* 接上了的那一项给绿色文字：圆点之外再给一层文字信号，不只靠颜色区分 */
.status-row dd.is-live { color: #0b7a54; font-weight: 600; }

.aside-hint { margin: 14px 0 0; border-top: 1px solid var(--surface-3); padding-top: 12px; color: var(--dim); font-size: 12px; line-height: 1.75; }

/* 关于：小品牌块 + 5 行技术信息（只读，字号压到 12/14） */
.about-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.about-mark {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-btn);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}
.about-name { color: var(--text); font-size: 14px; font-weight: 700; }
.about-sub { margin-top: 1px; color: var(--dim); font-size: 12px; }

.about-list { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.about-list > div { display: flex; align-items: baseline; gap: 10px; }
.about-list dt { flex: 0 0 64px; color: var(--dim); font-size: 12px; }
.about-list dd { margin: 0; color: var(--text-2); font-size: 12px; font-weight: 600; }

@media (max-width: 1040px) {
  .set-grid { grid-template-columns: minmax(0, 1fr); }
  /* 单列时状态/关于排在安全面板后面，别抢到第一屏 */
  .set-aside { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .set-aside { grid-template-columns: minmax(0, 1fr); }
}
</style>
