<script setup lang="ts">
import {
  ArrowRight,
  User,
} from "@element-plus/icons-vue";
import { characterUrgency, describeCountdown, formatCny, type OverviewCharacter, type OverviewPayload } from "~/utils/overview";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文从异常条直接开始；refreshable 让顶栏出现刷新按钮。
definePageMeta({
  topbar: {
    title: "工作台",
    description: "异常、进度和花费，一屏看完。",
    refreshable: true,
  },
});

const { isAdmin } = useAuthSession();

// SSR 阶段必须转发 cookie，否则总览会以匿名身份请求并触发 401。
const request = import.meta.server ? useRequestFetch() : $fetch;
const { data: overview, pending, refresh } = await useAsyncData(
  "overview",
  () => request<OverviewPayload>("/api/overview"),
);

const characters = computed(() => overview.value?.characters ?? []);

/** 异常置顶：模型没配 / 任务失败 / 周期逾期 / 未连接，之后才是正常的。 */
const sortedCharacters = computed(() =>
  [...characters.value].sort((a, b) => {
    const byUrgency = characterUrgency(a) - characterUrgency(b);
    if (byUrgency !== 0) return byUrgency;
    const left = a.nextSnapshotAt ? Date.parse(a.nextSnapshotAt) : Number.MAX_SAFE_INTEGER;
    const right = b.nextSnapshotAt ? Date.parse(b.nextSnapshotAt) : Number.MAX_SAFE_INTEGER;
    return left - right;
  }),
);

/**
 * 报警条的一条：说什么 + 点「去处理」应该去哪。
 *
 * 以前所有报警都跳 `/tasks`，这对记忆流水线成立，对 B站 值班不成立 ——
 * 值班停摆的修复点是「B站 值班台」（看适配器在不在跑、自动刷开没开），
 * 任务监控里什么都没有，于是人点进去只看到一张空表，还以为按钮坏了。
 */
type AlertItem = { text: string; to: string; label: string };

const alerts = computed<AlertItem[]>(() => {
  const data = overview.value;
  if (!data) return [] as AlertItem[];
  const list: AlertItem[] = [];
  const taskTarget = isAdmin.value ? "/tasks" : "/characters";
  const taskLabel = isAdmin.value ? "去处理" : "去角色";
  // 停滞检测排在最前：它说的是「任务根本没被排 / 没被认领 / 没人回收」，
  // 比后面的「有任务失败」「归档逾期」更接近原因。最多列三条，剩下的合并成一句。
  const findings = data.watchdog?.findings ?? [];
  for (const finding of findings.slice(0, 3)) {
    // 值班是另一条流水线：它的动作在 B站 值班台，不在任务监控里
    const duty = finding.code === "duty_silent";
    list.push({
      text: `${finding.characterName}：${finding.message}`,
      to: duty ? "/bili" : taskTarget,
      label: duty ? "去值班台" : taskLabel,
    });
  }
  if (findings.length > 3) {
    list.push({ text: `另有 ${findings.length - 3} 项停滞`, to: taskTarget, label: taskLabel });
  }
  if (data.tasks.failed > 0) {
    list.push({ text: `${data.tasks.failed} 个后台任务失败或等待重试`, to: taskTarget, label: taskLabel });
  }
  const unconfigured = data.characters.filter((item) => !item.chatApiKeyConfigured).length;
  if (unconfigured > 0) {
    list.push({
      text: `${unconfigured} 个角色未配置模型，归档任务会留在队列里不执行`,
      to: taskTarget,
      label: taskLabel,
    });
  }
  // 已经由停滞检测点名过的角色不再重复说「归档已逾期」：那是一句话的因果两头，说两遍只是变长。
  const flagged = new Set(findings.map((finding) => finding.characterId));
  const missed = data.characters.filter((item) => item.cycle?.missed && !flagged.has(item.id)).length;
  if (missed > 0) list.push({ text: `${missed} 个角色的归档已逾期`, to: taskTarget, label: taskLabel });
  const disconnected = data.characters.filter((item) => item.status === "未连接").length;
  if (disconnected > 0) list.push({ text: `${disconnected} 个角色没有可用渠道`, to: taskTarget, label: taskLabel });
  return list;
});

/** 报警条右侧的按钮：按目标去重，两个目标就出两个按钮（值班和记忆本来就是两条线）。 */
const alertRoutes = computed(() => {
  const routes = new Map<string, string>();
  for (const alert of alerts.value) if (!routes.has(alert.to)) routes.set(alert.to, alert.label);
  return [...routes].map(([to, label]) => ({ to, label }));
});

// 倒计时每 60 秒按本地时间重算一次：首次渲染用服务端 remainingMs，避免 SSR 与浏览器时区差异导致闪烁。
const localNow = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;

const countdown = computed(() => {
  const next = overview.value?.nextSnapshot;
  if (!next) return null;
  const remaining = localNow.value ? Date.parse(next.atISO) - localNow.value : next.remainingMs;
  return { ...describeCountdown(remaining), characterName: next.characterName, atLabel: next.atLabel };
});

onMounted(() => {
  ticker = setInterval(() => {
    localNow.value = Date.now();
  }, 60_000);
});
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
});

function cyclePercent(character: OverviewCharacter) {
  if (!character.cycle) return 0;
  return Math.round((character.cycle.dayIndex / character.cycle.totalDays) * 100);
}

/**
 * 一屏一张卡：单角色就是一张，多角色就是把这同一张卡竖着叠起来 —— 不再有「单角色 hero / 多角色 KPI」两套模板。
 * 卡里的五个时点全部取角色自己的账（归档、周期、任务、花费），所以多角色时每张卡说的都是自己的事，
 * 不会出现「KPI 是全局合计、卡片是单角色」那种两套口径。
 * 倒计时的基准时间在 SSR 阶段用服务端的 generatedAt，挂载后才换成浏览器本地时间，
 * 避免服务端与浏览器时区不同导致首屏数字跳一下。
 */
const heroCards = computed(() => {
  const now = localNow.value || Date.parse(overview.value?.generatedAt ?? "") || Date.now();
  const costByCharacter = new Map(
    (overview.value?.usage.characters ?? []).map((item) => [item.characterId, item]),
  );
  return sortedCharacters.value.map((character) => ({
    character,
    urgency: characterUrgency(character),
    percent: cyclePercent(character),
    countdown: character.nextSnapshotAt ? describeCountdown(Date.parse(character.nextSnapshotAt) - now) : null,
    cost: costByCharacter.get(character.id) ?? null,
  }));
});

/**
 * 角色状态三档配色，和其余四个页面同一套映射。
 * 注意不能复用 pill-rose / pill-amber：本页那两个类被 override 成「实心深底白字」，
 * 是留给「模型未配置 / 任务失败 / 归档逾期」这类警报的；停用是常态信息，用警报式样会误报。
 */
function statusTone(status: OverviewCharacter["status"]) {
  if (status === "运行中") return "pill-status is-green";
  return status === "已暂停" ? "pill-status is-amber" : "pill-status is-gray";
}

function copyState() {
  if (alerts.value.length > 0) return `${alerts.value.length} 项需要处理`;
  if (countdown.value) return `一切正常 · ${countdown.value.characterName} 将在 ${countdown.value.atLabel} 归档`;
  return "一切正常 · 暂无归档计划";
}

async function handleRefresh() {
  await refresh();
}
</script>

<template>
  <div class="page-wrap ov-a">
    <div
      v-if="alerts.length"
      class="alert-bar"
      role="status"
    >
      <span class="alert-dot" />
      <div class="alert-body">
        <span
          v-for="alert in alerts"
          :key="alert.text"
          class="alert-item"
        >{{ alert.text }}</span>
      </div>
      <button
        v-for="route in alertRoutes"
        :key="route.to"
        class="card-link"
        type="button"
        @click="navigateTo(route.to)"
      >
        {{ route.label }}<el-icon><ArrowRight /></el-icon>
      </button>
    </div>
    <div
      v-else-if="characters.length"
      class="alert-bar is-quiet"
      role="status"
    >
      <span class="alert-dot is-ok" />
      <span>{{ copyState() }}</span>
    </div>

    <!-- 空状态：还没建角色时，总览应该告诉人第一步做什么 -->
    <div
      v-if="overview && !characters.length"
      class="guide"
    >
      <div class="guide-icon">
        <el-icon><User /></el-icon>
      </div>
      <h3>还没有角色</h3>
      <p class="guide-note">
        忆灵空间把「对话 → 阶段总结 → 长期记忆」串成一条线。建一个角色，配好模型，就能开始积累记忆。
      </p>
      <ol class="guide-steps">
        <li><span>1</span>新建角色，填人设</li>
        <li><span>2</span>在模型设置里填模型 API</li>
        <li><span>3</span>开始对话，到周期结束时自动归档</li>
      </ol>
      <button
        class="btn primary lg"
        type="button"
        @click="navigateTo('/characters')"
      >
        去建第一个角色
      </button>
    </div>

    <template v-else-if="overview">
      <!-- 一张卡一个角色：单角色就是一屏一张，多角色就把它竖着叠起来 -->
      <section
        v-for="card in heroCards"
        :key="card.character.id"
        class="hero"
        :class="{ 'is-bad': card.urgency <= 1, 'is-over': card.urgency === 2 }"
      >
        <div class="hero-head">
          <div
            class="avatar hero-avatar"
            :class="'avatar-' + card.character.avatarTone"
          >
            {{ card.character.avatar }}
          </div>
          <div class="hero-id">
            <div class="hero-name-row">
              <NuxtLink
                class="hero-name"
                :to="`/memory?c=${card.character.id}`"
              >
                {{ card.character.name }}
              </NuxtLink>
              <span
                v-if="!card.character.chatApiKeyConfigured"
                class="pill pill-rose"
              >模型未配置</span>
              <span
                v-else-if="card.character.failedTaskCount > 0"
                class="pill pill-rose"
              >{{ card.character.failedTaskCount }} 个任务失败</span>
              <span
                v-else-if="card.character.cycle?.missed"
                class="pill pill-amber"
              >归档逾期</span>
              <span
                class="pill"
                :class="statusTone(card.character.status)"
              >{{ card.character.status }}</span>
            </div>
            <div class="hero-facts">
              {{ card.character.channels.length ? card.character.channels.join(" / ") : "未接渠道" }} · {{ card.character.intervalDays }} 天周期<template v-if="card.character.pendingIntervalDays !== null">
                （下周期起 {{ card.character.pendingIntervalDays }} 天）
              </template>
            </div>
          </div>
        </div>

        <!-- 五个时点：归档、周期、任务、花费，全部取这个角色自己的账 -->
        <div class="hero-stats">
          <div class="stat">
            <span class="stat-k">距下次归档</span>
            <span
              class="stat-v"
              :class="{ 'is-overdue': card.countdown?.tone === 'overdue', 'is-warn': card.countdown?.tone === 'warn' }"
            >
              <template v-if="card.countdown">
                {{ card.countdown.value }}<small>{{ card.countdown.unit }}</small>
              </template>
              <template v-else>
                —
              </template>
            </span>
            <span class="stat-f">{{ card.character.nextSnapshotAt ? card.character.nextSnapshotLabel : "没有开启自动归档" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">本周期消息</span>
            <span class="stat-v">
              {{ card.character.cycleMessageCount }}<small>条</small>
            </span>
            <span class="stat-f">{{ card.character.cycle ? `第 ${card.character.cycle.dayIndex}/${card.character.cycle.totalDays} 天` : "暂无进行中的周期" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">上次归档</span>
            <span class="stat-v">
              {{ card.character.latestSnapshotVersion ? card.character.latestSnapshotLabel : "—" }}<small v-if="card.character.latestSnapshotVersion">v{{ card.character.latestSnapshotVersion }}</small>
            </span>
            <span class="stat-f">{{ card.character.latestSnapshotVersion ? `已归档 ${card.character.latestSnapshotVersion} 次` : "还没有归档过" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">待处理任务</span>
            <span class="stat-v">
              {{ card.character.pendingTaskCount }}<small>项</small>
            </span>
            <span class="stat-f">
              <template v-if="card.character.failedTaskCount > 0">
                <em class="is-err">{{ card.character.failedTaskCount }} 个失败待处理</em>
              </template>
              <template v-else>
                暂无异常
              </template>
            </span>
          </div>
          <div class="stat">
            <span class="stat-k">今日花费</span>
            <span class="stat-v">{{ card.cost ? formatCny(card.cost.today.costCny) : "—" }}</span>
            <span class="stat-f">{{ card.cost ? `近 7 天 ${formatCny(card.cost.windowCostCny)}` : "还没有模型调用" }}</span>
          </div>
        </div>

        <!-- 本周期进度 -->
        <div
          v-if="card.character.cycle"
          class="hero-cycle"
        >
          <div
            class="hero-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="card.percent"
            :aria-label="`${card.character.name} 第 ${card.character.cycle?.dayIndex}/${card.character.cycle?.totalDays} 天`"
          >
            <i
              :class="{ overdue: card.character.cycle?.missed }"
              :style="{ width: card.percent + '%' }"
            />
          </div>
          <span class="hero-cycle-text">
            第 {{ card.character.cycle.dayIndex }}/{{ card.character.cycle.totalDays }} 天 · 本周期 {{ card.character.cycleMessageCount }} 条消息
          </span>
        </div>
      </section>
    </template>

    <div
      v-else
      class="loading-hint"
    >
      <template v-if="pending">
        正在读取工作台数据…
      </template>
      <template v-else>
        工作台数据暂时读不到，<button
          class="card-link"
          type="button"
          @click="handleRefresh"
        >
          重试
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   A · 色块平铺 —— 一张白台面，只有异常才上色
   L0 画布（main.css 的 --bg 不动）→ L1 白卡 #fff（零描边零阴影）
   → L2 卡内 6px 内衬 → L3 行（无底色无分隔）→ L4 异常整行上色
   统一写 `.ov-a .xxx`：把作用域锁在本页，同时靠 (0,3,0) 压过
   main.css 里 .pill / .btn 的 (0,1,0)。

   字号收口（2026-11）：正文 16 / 小标题 18 / 注释 14 / 数值 26。
   页面标题不在正文里 —— 已搬到顶栏（见 utils/topbar.ts），本页不再需要放大 h1。
   间距、圆角、尺寸一律取偶数 —— 唯一保留的单数是分割线的 1px（描边量级，
   和卡片边框同类，改成 2px 会明显变粗）与药丸的 999 全圆角。
   ══════════════════════════════════════════════════════════════ */

/* 异常条：有问题时整条醒目，没问题时退成一块白砖。
   右边可能有不止一个动作（值班问题去值班台、记忆问题去任务监控），窄屏允许换行。 */
.ov-a .alert-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  border: 0;
  border-radius: 10px;
  background: var(--red-soft);
  padding: 12px 16px;
  color: var(--red-text);
  font-size: 16px;
}
.ov-a .alert-bar.is-quiet {
  border: 0;
  background: var(--surface);
  color: var(--text-2);
}
.ov-a .alert-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--red);
}
.ov-a .alert-dot.is-ok {
  background: var(--green);
}
.ov-a .alert-body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  min-width: 0;
  flex: 1;
}
.ov-a .alert-item {
  white-space: nowrap;
}
.ov-a .alert-bar .card-link {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 4px;
  flex: none;
}
.ov-a .alert-bar .card-link .el-icon {
  font-size: 14px;
}

/* 空态引导：虚线框去掉，改成一块纯白砖 */
.ov-a .guide {
  border: 0;
  border-radius: 10px;
  background: var(--surface);
  padding: 36px 24px 32px;
  text-align: center;
}
.ov-a .guide-icon {
  display: grid;
  width: 48px;
  height: 48px;
  margin: 0 auto 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 24px;
}
.ov-a .guide h3 {
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
}
.ov-a .guide-note {
  max-width: 480px;
  margin: 8px auto 0;
  color: var(--dim);
  font-size: 16px;
  line-height: 1.7;
}
.ov-a .guide-steps {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 18px 0 22px;
  padding: 0;
  list-style: none;
}
.ov-a .guide-steps li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 999px;
  background: var(--surface-3);
  padding: 6px 14px 6px 8px;
  color: var(--text-2);
  font-size: 14px;
}
.ov-a .guide-steps li span {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface);
  color: var(--dim);
  font-size: 14px;
  font-weight: 600;
}

.ov-a .card-link {
  color: var(--brand-strong);
  font-size: 16px;
}

/* 主角卡：一个角色一张白砖，装下身份 + 五个时点 + 周期进度 */
.ov-a .hero {
  border: 0;
  border-radius: 12px;
  background: var(--surface);
  padding: 22px 24px;
  margin-bottom: 24px;
}
/* 异常：只给竖条，不铺整块底 —— 1000px 宽的 hero 铺粉底等于整页报警 */
.ov-a .hero.is-bad {
  box-shadow: inset 4px 0 0 var(--red);
}
.ov-a .hero.is-over {
  box-shadow: inset 4px 0 0 var(--amber);
}
.ov-a .hero-head {
  display: flex;
  align-items: center;
  gap: 16px;
}
.ov-a .hero-avatar {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  font-size: 24px;
}
.ov-a .hero-id {
  min-width: 0;
  flex: 1;
}
.ov-a .hero-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ov-a .hero-name {
  color: var(--text);
  font-size: 18px;
  font-weight: 700;
  line-height: 28px;
}
.ov-a .hero-name:hover {
  color: var(--brand-strong);
}
.ov-a .hero-facts {
  margin-top: 4px;
  color: var(--text-2);
  font-size: 16px;
}
/* 异常卡上的次要文字抬一档：竖条已经在喊了，说明性文字也要跟得上 */
.ov-a .hero.is-bad .stat-k,
.ov-a .hero.is-bad .stat-f,
.ov-a .hero.is-bad .hero-cycle-text {
  color: var(--text-2);
}

/* 四个时点：列与列之间用最淡的 --surface-3 竖线切开。
   竖线用 ::before 画在 24px 的列缝里，而不是 border-left —— 后者会把内衬算进列宽，
   四列就不等宽了，数字的左缘会一行比一行靠右。 */
.ov-a .hero-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 24px;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--surface-3);
}
.ov-a .stat {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.ov-a .stat + .stat::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -12px;
  width: 1px;
  background: var(--surface-3);
}
.ov-a .stat-k {
  color: var(--dim);
  font-size: 14px;
  font-weight: 500;
}
.ov-a .stat-v {
  color: var(--text);
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  line-height: 1.15;
}
.ov-a .stat-v small {
  margin-left: 4px;
  color: var(--dim);
  font-size: 14px;
  font-weight: 500;
}
.ov-a .stat-v.is-overdue {
  color: var(--red);
}
.ov-a .stat-v.is-warn {
  color: var(--amber);
}
.ov-a .stat-f {
  overflow: hidden;
  color: var(--dim);
  font-size: 14px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-a .stat-f .is-err {
  color: var(--red);
  font-style: normal;
}
.ov-a .hero-cycle {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
}
.ov-a .hero-track {
  height: 8px;
  flex: 1;
  overflow: hidden;
  border-radius: 4px;
  background: var(--surface-3);
}
.ov-a .hero-track i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--brand);
}
.ov-a .hero-track i.overdue {
  background: var(--amber);
}
.ov-a .hero-cycle-text {
  flex: none;
  color: var(--dim);
  font-size: 14px;
}

/* 状态药丸：14px，比正文小一档；异常实心深底白字，正常软底深字 */
.ov-a .pill {
  gap: 6px;
  padding: 6px 10px;
  font-size: 14px;
}
.ov-a .hero-name-row .pill {
  border: 0;
}
.ov-a .hero-name-row .pill-rose {
  background: var(--red);
  color: #fff;
}
.ov-a .hero-name-row .pill-amber {
  background: var(--amber);
  color: #fff;
}

/* 角色状态：软底深字三档。类名独立于 pill-*，避开上面那套实心警报式样 */
.ov-a .pill-status {
  border: 0;
}
.ov-a .pill-status.is-green {
  background: var(--green-soft);
  color: var(--green);
}
.ov-a .pill-status.is-amber {
  background: var(--amber-soft);
  color: var(--amber);
}
.ov-a .pill-status.is-gray {
  background: var(--surface-3);
  color: var(--text-2);
}

/* 加载态 */
.ov-a .loading-hint {
  padding: 40px 0;
  color: var(--dim);
  font-size: 16px;
  text-align: center;
}

/* A 的次要按钮是文字按钮：无底无框，hover 才出下划线 */
.ov-a .btn {
  height: 38px;
  border: 0;
  background: none;
  box-shadow: none;
  gap: 8px;
  padding: 0 12px;
  color: var(--text-2);
  font-size: 16px;
  font-weight: 600;
  border-radius: 8px;
}
.ov-a .btn:hover {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 4px;
}
.ov-a .btn .el-icon {
  font-size: 16px;
}
.ov-a .btn.primary {
  background: var(--brand-btn);
  color: #fff;
  padding: 0 16px;
}
.ov-a .btn.primary:hover {
  background: var(--brand-btn-h);
  color: #fff;
  text-decoration: none;
}

/* 五格在窄屏会挤成一团：先退到 3 列，≤720 再退到 2 列。
   两种情况都会有格子被挤到行首，行首那根竖线会悬在卡片内衬里，索性一起收掉。 */
@media (max-width: 1000px) {
  .ov-a .hero-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 20px; }
  .ov-a .stat + .stat::before { display: none; }
}
@media (max-width: 720px) {
  .ov-a .hero { padding: 16px; }
  .ov-a .hero-head { flex-wrap: wrap; }
  .ov-a .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 20px; }
  .ov-a .hero-cycle { flex-wrap: wrap; gap: 8px; }
  .ov-a .hero-cycle-text { flex: none; }
}
</style>
