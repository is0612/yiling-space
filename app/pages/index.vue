<script setup lang="ts">
import {
  ArrowRight,
  Calendar,
  ChatDotRound,
  Clock,
  Cpu,
  Files,
  Refresh,
  User,
} from "@element-plus/icons-vue";
import { characterUrgency, describeCountdown, describeUsageDay, formatCny, formatTokenCount, type OverviewCharacter, type OverviewPayload, type OverviewUsageDay } from "~/utils/overview";

const { isAdmin } = useAuthSession();

// SSR 阶段必须转发 cookie，否则总览会以匿名身份请求并触发 401。
const request = import.meta.server ? useRequestFetch() : $fetch;
const { data: overview, pending, refresh } = await useAsyncData(
  "overview",
  () => request<OverviewPayload>("/api/overview"),
);

const characters = computed(() => overview.value?.characters ?? []);
const primaryCharacter = computed(() => characters.value[0] ?? null);

/**
 * 实际使用中绝大多数账号只有 1 个角色。单角色时 KPI 四格和角色行说的是同一份数据，
 * 拆成两块等于把同一件事讲两遍，所以换成一张主角卡；多角色才回到「左列表 + 右动态」。
 */
const singleCharacter = computed(() => (characters.value.length === 1 ? characters.value[0] ?? null : null));
const isSingle = computed(() => singleCharacter.value !== null);
/** 主角卡的紧急度，与 role-card 的 is-bad / is-over 判定同源。 */
const heroUrgency = computed(() => (singleCharacter.value ? characterUrgency(singleCharacter.value) : 4));

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
 * 用量卡：服务端按角色返回「今天 + 近 7 天」，这里只把它和角色身份拼起来。
 * 柱子高度按各自 7 天里的峰值归一化 —— 三个角色并排比较没有意义，看的是自己哪天用得多。
 */
const usage = computed(() => overview.value?.usage ?? null);
/** 只要窗口内有过调用就画卡：今天没跑不代表昨天没花钱，趋势本身就是要给人看的。 */
const hasUsage = computed(() => (usage.value?.characters ?? []).some((item) => item.windowTokens > 0));
const usageRows = computed(() => {
  const data = overview.value;
  if (!data) return [];
  const characterById = new Map(data.characters.map((character) => [character.id, character]));
  return data.usage.characters.map((item) => {
    const character = characterById.get(item.characterId);
    return {
      ...item,
      name: character?.name ?? "未知角色",
      peakTokens: Math.max(1, ...item.days.map((day) => day.totalTokens)),
    };
  });
});

function barHeight(day: OverviewUsageDay, peakTokens: number) {
  if (day.totalTokens <= 0) return "4px";
  // 取偶数：柱高跟全页其余尺寸保持同一套「不留单数」的规矩
  const raw = Math.max(4, Math.round((day.totalTokens / peakTokens) * 36));
  return `${raw - (raw % 2)}px`;
}

/**
 * 金额说明要能解释「为什么和供应商账单不一样」：
 * 没有缓存明细的旧记录只能按未命中价算，会明显偏高；有新记录后才是真实命中价。
 */
const usageNotes = computed(() => {
  const data = usage.value;
  if (!data) return [] as string[];
  const notes: string[] = [];
  if (data.unpricedModels.length) {
    notes.push(`${data.unpricedModels.join(" / ")} 没有内置单价，只计 token 不计金额；可在服务端用 MODEL_PRICING 补价。`);
  }
  if (data.uncachedCalls > 0) {
    notes.push(`今天有 ${data.uncachedCalls} 次调用没有记录缓存命中，这部分按未命中价估算，金额偏高；新调用按真实命中价计（常驻进程需重启一次）。`);
  } else if (data.cacheHitTokens > 0) {
    notes.push(`今天有 ${formatTokenCount(data.cacheHitTokens)} 个输入 token 命中缓存，已按命中价计价；实际账单以供应商为准。`);
  } else {
    notes.push("金额按内置参考价估算，实际账单以供应商为准。");
  }
  return notes;
});

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

function roleFacts(character: OverviewCharacter) {
  const lastText = `上次归档 ${character.latestSnapshotLabel}`;
  const nextText = character.nextSnapshotAt
    ? `下次 ${character.nextSnapshotLabel}`
    : character.autoSnapshotEnabled
      ? "尚未排期"
      : "自动归档已关闭";
  const intervalText = character.pendingIntervalDays !== null
    ? `${character.intervalDays} 天周期（下周期起 ${character.pendingIntervalDays} 天）`
    : `${character.intervalDays} 天周期`;
  return [
    character.channels.length ? character.channels.join(" / ") : "未接渠道",
    intervalText,
    lastText,
    nextText,
  ].join(" · ");
}

function cyclePercent(character: OverviewCharacter) {
  if (!character.cycle) return 0;
  return Math.round((character.cycle.dayIndex / character.cycle.totalDays) * 100);
}

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
    <PageHeader
      eyebrow="工作空间 / 总览"
      title="今天的工作台"
      description="异常、进度和最近发生的事，一屏看完。"
    >
      <template #actions>
        <button
          class="btn"
          type="button"
          :disabled="pending"
          @click="handleRefresh"
        >
          <el-icon><Refresh /></el-icon>{{ pending ? "刷新中" : "刷新" }}
        </button>
        <button
          class="btn"
          type="button"
          :disabled="!primaryCharacter"
          @click="primaryCharacter && navigateTo(`/chat?c=${primaryCharacter.id}`)"
        >
          {{ primaryCharacter ? `开始对话 · ${primaryCharacter.name}` : "开始对话" }}
        </button>
        <button
          class="btn primary"
          type="button"
          @click="navigateTo('/characters')"
        >
          <el-icon><User /></el-icon>新建角色
        </button>
      </template>
    </PageHeader>

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
      <!-- 单角色：一张主角卡顶掉 KPI 四格 + 角色列表，同一份数据只讲一遍 -->
      <section
        v-if="singleCharacter"
        class="hero"
        :class="{ 'is-bad': heroUrgency <= 1, 'is-over': heroUrgency === 2 }"
      >
        <div class="hero-head">
          <div
            class="avatar hero-avatar"
            :class="'avatar-' + singleCharacter.avatarTone"
          >
            {{ singleCharacter.avatar }}
          </div>
          <div class="hero-id">
            <div class="hero-name-row">
              <NuxtLink
                class="hero-name"
                :to="`/memory?c=${singleCharacter.id}`"
              >
                {{ singleCharacter.name }}
              </NuxtLink>
              <span
                v-if="!singleCharacter.chatApiKeyConfigured"
                class="pill pill-rose"
              >模型未配置</span>
              <span
                v-else-if="singleCharacter.failedTaskCount > 0"
                class="pill pill-rose"
              >{{ singleCharacter.failedTaskCount }} 个任务失败</span>
              <span
                v-else-if="singleCharacter.cycle?.missed"
                class="pill pill-amber"
              >归档逾期</span>
              <span
                class="pill"
                :class="statusTone(singleCharacter.status)"
              >{{ singleCharacter.status }}</span>
            </div>
            <div class="hero-facts">
              {{ singleCharacter.channels.length ? singleCharacter.channels.join(" / ") : "未接渠道" }} · {{ singleCharacter.intervalDays }} 天周期<template v-if="singleCharacter.pendingIntervalDays !== null">
                （下周期起 {{ singleCharacter.pendingIntervalDays }} 天）
              </template>
            </div>
          </div>
          <div class="hero-actions">
            <button
              class="btn primary"
              type="button"
              @click="navigateTo(`/chat?c=${singleCharacter.id}`)"
            >
              开始对话
            </button>
            <NuxtLink
              :to="`/memory?c=${singleCharacter.id}`"
              :aria-label="`查看 ${singleCharacter.name} 的记忆`"
            >
              记忆
            </NuxtLink>
            <NuxtLink
              :to="`/snapshots?c=${singleCharacter.id}`"
              :aria-label="`查看 ${singleCharacter.name} 的归档`"
            >
              归档
            </NuxtLink>
          </div>
        </div>

        <!-- 四个数据：替代多角色时的 KPI 四格 -->
        <div class="hero-stats">
          <div class="stat">
            <span class="stat-k">距下次归档</span>
            <span
              class="stat-v"
              :class="{ 'is-overdue': countdown?.tone === 'overdue', 'is-warn': countdown?.tone === 'warn' }"
            >
              <template v-if="countdown">
                {{ countdown.value }}<small>{{ countdown.unit }}</small>
              </template>
              <template v-else>
                —
              </template>
            </span>
            <span class="stat-f">{{ countdown ? countdown.atLabel : "没有开启自动归档" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">本周期消息</span>
            <span class="stat-v">
              {{ overview.cycle?.messageCount ?? 0 }}<small>条</small>
            </span>
            <span class="stat-f">{{ overview.cycle ? `第 ${overview.cycle.dayIndex}/${overview.cycle.totalDays} 天 · ${overview.cycle.endISOLabel} 归档` : "暂无进行中的周期" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">上次归档</span>
            <span class="stat-v">
              {{ overview.latestSnapshot?.dateLabel ?? "—" }}<small v-if="overview.latestSnapshot">v{{ overview.latestSnapshot.version }}</small>
            </span>
            <span class="stat-f">{{ overview.latestSnapshot ? `${overview.latestSnapshot.atLabel} 生成` : "还没有归档过" }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">待处理任务</span>
            <span class="stat-v">
              {{ overview.tasks.pending }}<small>项</small>
            </span>
            <span class="stat-f">
              <template v-if="overview.tasks.failed > 0">
                <em class="is-err">{{ overview.tasks.failed }} 个失败待处理</em>
              </template>
              <template v-else>
                暂无异常
              </template>
            </span>
          </div>
        </div>

        <!-- 本周期进度 -->
        <div
          v-if="singleCharacter.cycle"
          class="hero-cycle"
        >
          <div
            class="hero-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="cyclePercent(singleCharacter)"
            :aria-label="`${singleCharacter.name} 第 ${singleCharacter.cycle?.dayIndex}/${singleCharacter.cycle?.totalDays} 天`"
          >
            <i
              :class="{ overdue: singleCharacter.cycle?.missed }"
              :style="{ width: cyclePercent(singleCharacter) + '%' }"
            />
          </div>
          <span class="hero-cycle-text">
            第 {{ singleCharacter.cycle.dayIndex }}/{{ singleCharacter.cycle.totalDays }} 天 · 本周期 {{ singleCharacter.cycleMessageCount }} 条消息
          </span>
        </div>
      </section>

      <!-- 四格：都是「时点」，不是累计总量（多角色才需要并排扫一眼） -->
      <div
        v-if="!isSingle"
        class="kpi-row"
      >
        <button
          class="kpi is-action"
          type="button"
          :disabled="!overview.nextSnapshot"
          @click="overview.nextSnapshot && navigateTo(`/snapshots?c=${overview.nextSnapshot.characterId}`)"
        >
          <div class="k">
            <el-icon><Calendar /></el-icon>距下次归档
          </div>
          <div
            class="v"
            :class="{ 'is-overdue': countdown?.tone === 'overdue', 'is-warn': countdown?.tone === 'warn' }"
          >
            <template v-if="countdown">
              {{ countdown.value }}<small v-if="countdown.unit">{{ countdown.unit }}</small>
            </template>
            <span
              v-else
              class="na"
            >—</span>
          </div>
          <div class="foot">
            <template v-if="countdown">
              {{ countdown.atLabel }} · {{ countdown.characterName }}
            </template>
            <template v-else>
              没有开启自动归档的角色
            </template>
          </div>
        </button>

        <div class="kpi">
          <div class="k">
            <el-icon><ChatDotRound /></el-icon>本周期消息
          </div>
          <div class="v">
            {{ overview.cycle?.messageCount ?? 0 }}<small>条</small>
          </div>
          <div class="foot">
            <template v-if="overview.cycle">
              第 {{ overview.cycle.dayIndex }} / {{ overview.cycle.totalDays }} 天 · {{ overview.cycle.endISOLabel }} 归档
            </template>
            <template v-else>
              暂无进行中的周期
            </template>
          </div>
        </div>

        <button
          class="kpi is-action"
          type="button"
          :disabled="!overview.latestSnapshot"
          @click="overview.latestSnapshot && navigateTo(`/snapshots?c=${overview.latestSnapshot.characterId}`)"
        >
          <div class="k">
            <el-icon><Files /></el-icon>最近一次归档
          </div>
          <div class="v">
            <template v-if="overview.latestSnapshot">
              {{ overview.latestSnapshot.dateLabel }}<small>v{{ overview.latestSnapshot.version }}</small>
            </template>
            <span
              v-else
              class="na"
            >—</span>
          </div>
          <div class="foot">
            <template v-if="overview.latestSnapshot">
              {{ overview.latestSnapshot.characterName }} · {{ overview.latestSnapshot.atLabel }} 生成
            </template>
            <template v-else>
              还没有归档过
            </template>
          </div>
        </button>

        <button
          class="kpi is-action"
          type="button"
          @click="navigateTo(isAdmin ? '/tasks' : '/characters')"
        >
          <div class="k">
            <el-icon><Clock /></el-icon>待处理任务
          </div>
          <div class="v">
            {{ overview.tasks.pending }}<small>项</small>
          </div>
          <div class="foot">
            <span v-if="overview.tasks.failed > 0">{{ overview.tasks.failed }} 个失败待处理</span>
            <span v-else>暂无异常</span>
          </div>
        </button>
      </div>

      <!-- 用量与花费：今日 token + 近 7 天趋势。金额是估算，未定价模型只计 token -->
      <section
        v-if="usage"
        class="usage-wrap"
      >
        <div class="sec-h">
          <h2>用量与花费</h2>
          <span class="sub">东八区自然日 · 近 7 天 · 按参考价估算</span>
          <span class="usage-total">
            今日合计 {{ formatTokenCount(usage.totalTokens) }} tokens · {{ formatCny(usage.costCny) }}
          </span>
        </div>
        <div class="card">
          <template v-if="hasUsage">
            <div
              v-for="row in usageRows"
              :key="row.characterId"
              class="usage-row"
            >
              <div class="usage-id">
                <span class="usage-name">{{ row.name }}</span>
                <span class="usage-sub">今日 {{ formatTokenCount(row.today.totalTokens) }} tokens · {{ row.today.calls }} 次调用</span>
              </div>
              <div
                class="usage-bars"
                role="img"
                :aria-label="`${row.name} 近 7 天 token 用量`"
              >
                <i
                  v-for="day in row.days"
                  :key="day.day"
                  :class="{ 'is-today': day.day === usage.day, 'is-empty': day.totalTokens === 0 }"
                  :style="{ height: barHeight(day, row.peakTokens) }"
                  :title="describeUsageDay(day)"
                />
              </div>
              <div class="usage-cost">
                <b>{{ formatCny(row.today.costCny) }}</b>
                <span>近 7 天 {{ formatCny(row.windowCostCny) }}</span>
              </div>
            </div>
          </template>
          <div
            v-else
            class="card-empty"
          >
            <el-icon><Cpu /></el-icon>
            <span>最近 7 天还没有模型调用</span>
            <span>对话、归档或值班跑起来后，这里会按天累计</span>
          </div>
          <p
            v-for="note in usageNotes"
            :key="note"
            class="usage-note"
          >
            {{ note }}
          </p>
        </div>
      </section>

      <div
        class="home-cols"
        :class="{ 'is-single': isSingle }"
      >
        <!-- 左：角色，异常置顶（单角色时由上面的 hero 顶替，整块不渲染） -->
        <div
          v-if="!isSingle"
          class="col-roles"
        >
          <div class="sec-h">
            <h2>角色</h2>
            <span class="sub">异常优先，其余按归档时间</span>
            <button
              class="more"
              type="button"
              @click="navigateTo('/characters')"
            >
              全部<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card">
            <div
              v-for="character in sortedCharacters"
              :key="character.id"
              class="role-card"
              :class="{ 'is-bad': characterUrgency(character) <= 1, 'is-over': characterUrgency(character) === 2 }"
            >
              <div
                class="avatar"
                :class="'avatar-' + character.avatarTone"
              >
                {{ character.avatar }}
              </div>
              <div class="role-body">
                <div class="role-head">
                  <NuxtLink
                    class="role-name"
                    :to="`/memory?c=${character.id}`"
                  >
                    {{ character.name }}
                  </NuxtLink>
                  <span
                    v-if="!character.chatApiKeyConfigured"
                    class="pill pill-rose"
                  >模型未配置</span>
                  <span
                    v-else-if="character.failedTaskCount > 0"
                    class="pill pill-rose"
                  >{{ character.failedTaskCount }} 个任务失败</span>
                  <span
                    v-else-if="character.cycle?.missed"
                    class="pill pill-amber"
                  >归档逾期</span>
                  <span
                    class="pill"
                    :class="statusTone(character.status)"
                  >{{ character.status }}</span>
                </div>
                <div class="role-facts">
                  {{ roleFacts(character) }}
                </div>
                <div class="role-cycle">
                  <div
                    v-if="character.cycle"
                    class="role-track"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="cyclePercent(character)"
                    :aria-label="`${character.name} 第 ${character.cycle?.dayIndex}/${character.cycle?.totalDays} 天`"
                  >
                    <i
                      :class="{ paused: character.status === '已暂停', overdue: character.cycle?.missed }"
                      :style="{ width: cyclePercent(character) + '%' }"
                    />
                  </div>
                  <span class="role-cycle-text">
                    <template v-if="character.cycle">
                      第 {{ character.cycle.dayIndex }}/{{ character.cycle.totalDays }} 天 · 本周期 {{ character.cycleMessageCount }} 条消息
                    </template>
                    <template v-else>
                      共 {{ character.memoryCount }} 条长期记忆
                    </template>
                  </span>
                </div>
              </div>
              <div class="role-links">
                <NuxtLink
                  :to="`/chat?c=${character.id}`"
                  :aria-label="`与 ${character.name} 对话`"
                >
                  <el-icon><ChatDotRound /></el-icon>对话
                </NuxtLink>
                <NuxtLink
                  :to="`/memory?c=${character.id}`"
                  :aria-label="`查看 ${character.name} 的记忆`"
                >
                  <el-icon><Cpu /></el-icon>记忆
                </NuxtLink>
                <NuxtLink
                  :to="`/snapshots?c=${character.id}`"
                  :aria-label="`查看 ${character.name} 的归档`"
                >
                  <el-icon><Calendar /></el-icon>归档
                </NuxtLink>
              </div>
            </div>
          </div>
        </div>

        <!-- 中：最近发生 -->
        <div class="col-events">
          <div class="sec-h">
            <h2>最近发生</h2>
            <span class="sub">任务与归档</span>
            <button
              v-if="isAdmin"
              class="more"
              type="button"
              @click="navigateTo('/tasks')"
            >
              任务监控<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card">
            <div
              v-for="event in overview.events"
              :key="event.id"
              class="event-row"
            >
              <span
                class="event-dot"
                :class="event.tone"
              />
              <div class="event-body">
                <div class="event-title">
                  {{ event.title }}
                </div>
                <div class="event-meta">
                  {{ event.meta }}
                </div>
              </div>
              <span class="event-time">{{ event.atLabel }}</span>
            </div>
            <div
              v-if="!overview.events.length"
              class="card-empty"
            >
              <el-icon><Clock /></el-icon>
              <span>还没有执行记录</span>
              <span>跑一次阶段总结或记忆更新，这里就会出现</span>
            </div>
          </div>
        </div>

        <!-- 右：最近任务 -->
        <div class="col-tasks">
          <div class="sec-h">
            <h2>最近任务</h2>
            <span class="sub">{{ overview.tasks.pending + overview.tasks.failed }} 项未结束</span>
          </div>
          <div class="card">
            <div
              v-for="task in overview.tasks.items.slice(0, 4)"
              :key="task.id"
              class="task-row"
            >
              <div class="task-body">
                <div class="task-title">
                  {{ task.typeLabel }}
                </div>
                <div class="task-meta">
                  {{ task.characterName }}
                </div>
              </div>
              <span
                class="task-pill"
                :class="{
                  ok: task.status === 'SUCCEEDED',
                  err: task.status === 'FAILED',
                  wait: task.status === 'QUEUED' || task.status === 'RETRY_WAIT',
                  run: task.status === 'RUNNING',
                }"
              >{{ task.statusLabel }}</span>
            </div>
            <div
              v-if="!overview.tasks.items.length"
              class="card-empty"
            >
              <el-icon><Clock /></el-icon>
              <span>还没有后台任务</span>
              <span>开启自动归档后，到点会自动排进队列</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 仅管理员：数据库、队列与渠道的即时状态 -->
      <div
        v-if="isAdmin && overview.admin"
        class="admin-wrap"
      >
        <div class="sec-h">
          <h2>系统状况</h2>
          <span class="sub">仅管理员可见</span>
        </div>
        <div class="card">
          <div class="admin-grid">
            <div class="admin-cell">
              <span class="admin-label">数据库</span>
              <b :class="overview.admin.database === 'up' ? 'is-ok' : 'is-err'">
                {{ overview.admin.database === "up" ? "正常" : "连接异常" }}
              </b>
            </div>
            <div class="admin-cell">
              <span class="admin-label">任务队列</span>
              <b>{{ overview.admin.jobs.queued }} 等待 / {{ overview.admin.jobs.running }} 运行 / {{ overview.admin.jobs.failed }} 失败</b>
            </div>
            <div class="admin-cell">
              <span class="admin-label">渠道</span>
              <b>{{ overview.admin.channels.online }} / {{ overview.admin.channels.total }} 在线</b>
            </div>
          </div>
          <div
            v-if="overview.admin.recentAudits.length"
            class="audit-list"
          >
            <div class="audit-caption">
              最近操作
            </div>
            <div
              v-for="audit in overview.admin.recentAudits"
              :key="audit.id"
              class="audit-row"
            >
              <span class="audit-action">{{ audit.action }}</span>
              <span class="audit-entity">{{ audit.entityType }}</span>
              <span class="audit-time">{{ audit.atLabel }}</span>
            </div>
          </div>
        </div>
      </div>
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
   main.css 里 .card / .kpi / .pill / .btn 的 (0,1,0)。

   字号收口（2026-11）：正文 16 / 小标题 18 / 注释 14 / 数值 26 / 页面标题 32。
   间距、圆角、尺寸一律取偶数 —— 唯一保留的单数是分割线的 1px（描边量级，
   和卡片边框同类，改成 2px 会明显变粗）与药丸的 999 全圆角。
   ══════════════════════════════════════════════════════════════ */

/* 页面头部：只在总览页放大，其余 15 个页面仍走 main.css 的 22/14 */
.ov-a :deep(.crumb) {
  gap: 8px;
  font-size: 14px;
}
.ov-a :deep(.page-h) {
  margin-bottom: 20px;
}
.ov-a :deep(.page-h h1) {
  font-size: 32px;
  letter-spacing: -.02em;
}
.ov-a :deep(.page-h p) {
  margin-top: 6px;
  font-size: 16px;
}

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

/* 白卡：零描边零阴影，卡内 6px 内衬 —— 分层只靠明度差与间距 */
.ov-a .card {
  border: 0;
  box-shadow: none;
  padding: 6px;
}

/* 区块标题：18px 深色。标题行固定 28px —— 右栏有 .more 时是 28px，只有 .sub 时
   也要撑到同一高度，两栏卡片起始位置才齐。用 min-height 而不是 height：
   窄屏 .sub 折行时能自然撑开，不会溢出压到下面的卡片上。 */
.ov-a .sec-h {
  min-height: 28px;
  margin: 22px 0 12px;
}
.ov-a .sec-h h2 {
  color: var(--text);
  font-size: 18px;
}
.ov-a .sec-h .sub {
  color: var(--dim);
  font-family: inherit;
  font-size: 14px;
}
.ov-a .sec-h .more {
  min-height: 28px;
  gap: 4px;
  border-radius: 6px;
  padding: 0 8px;
  color: var(--brand-strong);
  font-size: 14px;
}
.ov-a .sec-h .more:hover {
  text-underline-offset: 4px;
}
.ov-a .card-link {
  color: var(--brand-strong);
  font-size: 16px;
}

/* KPI：四块零描边白砖，缝 16px（12px 会让白砖在画布上粘成一整块） */
.ov-a .kpi-row {
  gap: 16px;
  margin-bottom: 20px;
}
.ov-a .kpi {
  border: 0;
  box-shadow: none;
  padding: 16px 18px 18px;
}
.ov-a .kpi.is-action:hover {
  border-color: transparent;
  background: var(--surface-2);
}
.ov-a .kpi .k {
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
}
.ov-a .kpi .v small {
  color: var(--dim);
  font-size: 14px;
}
.ov-a .kpi .foot {
  margin-top: 8px;
  color: var(--dim);
  font-size: 14px;
}
.ov-a .kpi .bar {
  height: 8px;
  margin-top: 10px;
  border-radius: 4px;
}
.ov-a .kpi .bar i {
  border-radius: 4px;
}
.ov-a .kpi .v.is-overdue {
  color: var(--red);
}
.ov-a .kpi .v.is-warn {
  color: var(--amber);
}

/* 用量与花费：一行一个角色。柱子只做「自己跟自己比」，所以按各自 7 天的峰值归一化 */
.ov-a .usage-wrap {
  margin: 4px 0 24px;
}
.ov-a .usage-total {
  margin-left: auto;
  color: var(--text-2);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ov-a .usage-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px auto;
  grid-template-areas: "id bars cost";
  gap: 16px;
  align-items: center;
  border-radius: 8px;
  padding: 10px 12px;
}
.ov-a .usage-row + .usage-row {
  margin-top: 4px;
}
.ov-a .usage-id {
  display: flex;
  grid-area: id;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.ov-a .usage-name {
  overflow: hidden;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-a .usage-sub {
  color: var(--dim);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.ov-a .usage-bars {
  display: flex;
  grid-area: bars;
  height: 40px;
  align-items: flex-end;
  gap: 6px;
}
.ov-a .usage-bars i {
  min-width: 4px;
  flex: 1;
  border-radius: 4px;
  background: var(--brand);
  /* 历史日期压淡、今天实色：一眼看出哪根是今天，又不至于七根一样重 */
  opacity: .45;
}
.ov-a .usage-bars i.is-today {
  opacity: 1;
}
.ov-a .usage-bars i.is-empty {
  /* 没用量的日子留一条浅轨道，柱状图才读得成「7 天」而不是两根孤立的柱子 */
  background: var(--line);
  opacity: 1;
}
.ov-a .usage-cost {
  display: flex;
  grid-area: cost;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  text-align: right;
}
.ov-a .usage-cost b {
  color: var(--text);
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  white-space: nowrap;
}
.ov-a .usage-cost span {
  color: var(--dim);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ov-a .usage-note {
  margin: 4px 0 0;
  padding: 0 12px 4px;
  color: var(--dim);
  font-size: 14px;
  line-height: 1.6;
}

/* 主角卡（单角色）：一张白砖装下角色身份 + 四个时点 + 周期进度 */
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
.ov-a .hero-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.ov-a .hero-actions a {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--dim);
  font-size: 16px;
}
.ov-a .hero-actions a:hover {
  background: var(--surface-2);
  color: var(--brand-strong);
}
/* 异常时文字仍抬到 --text-2：白底上只会更清楚，也顺手兜住 role-card 那套配色 */
.ov-a .hero.is-bad .hero-actions a,
.ov-a .hero.is-bad .stat-k,
.ov-a .hero.is-bad .stat-f,
.ov-a .hero.is-bad .hero-cycle-text {
  color: var(--text-2);
}
.ov-a .hero.is-bad .hero-actions a:hover {
  color: var(--brand-strong);
}

/* 四个时点：列与列之间用最淡的 --surface-3 竖线切开。
   竖线用 ::before 画在 24px 的列缝里，而不是 border-left —— 后者会把内衬算进列宽，
   四列就不等宽了，数字的左缘会一行比一行靠右。 */
.ov-a .hero-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

/* 两栏：多角色 = 左列表 + 右（发生 / 任务）上下叠 */
.ov-a .home-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  grid-template-areas: "roles events" "roles tasks";
  gap: 24px;
  align-items: start;
}
.ov-a .col-roles {
  grid-area: roles;
  min-width: 0;
}
.ov-a .col-events {
  grid-area: events;
  min-width: 0;
}
.ov-a .col-tasks {
  grid-area: tasks;
  min-width: 0;
}
/* 单角色：角色块不渲染，事件与任务并排 */
.ov-a .home-cols.is-single {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-areas: "events tasks";
  /* 两栏等高：跟内容较多的那一栏走，卡片底边才能齐 */
  align-items: stretch;
}
/* 光有 grid 的 stretch 不够：内层 .card 是普通块级元素，不会自己吃掉剩余高度，
   所以 col 变 flex column、卡片 flex:1，三件事一起做才成立。 */
.ov-a .home-cols.is-single .col-events,
.ov-a .home-cols.is-single .col-tasks {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ov-a .home-cols.is-single .col-events > .card,
.ov-a .home-cols.is-single .col-tasks > .card {
  display: flex;
  flex-direction: column;
  flex: 1;
}
/* 空态在被拉高的卡里垂直居中，否则内容贴顶、下面空一大块，比不拉齐还难看 */
.ov-a .home-cols.is-single .card-empty {
  flex: 1;
  justify-content: center;
}

/* 角色行：分隔线去掉，改成行间 4px 缝 + 行内 12px 内衬（净高不变） */
.ov-a .role-card {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  border-bottom: 0;
  border-radius: 8px;
  padding: 12px;
  transition: background .14s ease;
}
.ov-a .role-card + .role-card {
  margin-top: 4px;
}
.ov-a .role-card:hover,
.ov-a .role-card:focus-within {
  background: var(--surface-2);
}
/* 异常：inset 竖条（不用 border-left，会切圆角并把内容右移） */
.ov-a .role-card.is-bad {
  background: var(--red-soft);
  box-shadow: inset 4px 0 0 var(--red);
}
/* 逾期只给竖条不给整行底色：浅底是全页唯一的分块信号，一屏铺满会变拼贴 */
.ov-a .role-card.is-over {
  box-shadow: inset 4px 0 0 var(--amber);
}
.ov-a .role-card.is-bad:hover,
.ov-a .role-card.is-bad:focus-within {
  background: #fbdfe3;
}
.ov-a .role-card.is-over:hover,
.ov-a .role-card.is-over:focus-within {
  background: var(--surface-2);
}
/* #fdecee 底会把灰字压到 4.3:1，只在异常行把信息文字抬到 --text-2 */
.ov-a .role-card.is-bad .role-facts,
.ov-a .role-card.is-bad .role-cycle-text,
.ov-a .role-card.is-bad .role-links a {
  color: var(--text-2);
}
/* 上面这条抬字规则特异性高，hover 色要单独补一条才压得住 */
.ov-a .role-card.is-bad .role-links a:hover {
  color: var(--brand-strong);
}
.ov-a .role-card .avatar {
  width: 36px;
  height: 36px;
  font-size: 16px;
}
.ov-a .role-body {
  min-width: 0;
}
.ov-a .role-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ov-a .role-name {
  color: var(--text);
  font-size: 18px;
  font-weight: 700;
}
.ov-a .role-name:hover {
  color: var(--brand-strong);
}
.ov-a .role-facts {
  margin-top: 4px;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1.5;
}
.ov-a .role-cycle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.ov-a .role-track {
  height: 8px;
  width: 96px;
  flex: none;
  overflow: hidden;
  border-radius: 4px;
  background: var(--surface-3);
}
/* 纯色，不用渐变：浅底上的渐变显廉价 */
.ov-a .role-track i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--brand);
}
.ov-a .role-track i.paused {
  background: #d5d9df;
}
.ov-a .role-track i.overdue {
  background: var(--amber);
}
.ov-a .role-cycle-text {
  color: var(--dim);
  font-size: 14px;
}
.ov-a .role-links {
  display: flex;
  gap: 4px;
  flex: none;
}
.ov-a .role-links a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: var(--radius-xs);
  padding: 6px 8px;
  color: var(--dim);
  font-size: 16px;
  white-space: nowrap;
  transition: background .14s ease, color .14s ease;
}
.ov-a .role-links a:hover {
  background: var(--surface-2);
  color: var(--brand-strong);
}
.ov-a .role-links .el-icon {
  font-size: 14px;
}

/* 状态药丸：14px，比正文小一档；异常实心深底白字，正常软底深字 */
.ov-a .pill {
  gap: 6px;
  padding: 6px 10px;
  font-size: 14px;
}
.ov-a .role-head .pill,
.ov-a .hero-name-row .pill {
  border: 0;
}
.ov-a .role-head .pill-rose,
.ov-a .hero-name-row .pill-rose {
  background: var(--red);
  color: #fff;
}
.ov-a .role-head .pill-amber,
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

/* 事件流：无分隔线，行即砖 */
.ov-a .event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-bottom: 0;
  border-radius: 8px;
  padding: 12px;
}
.ov-a .event-dot {
  width: 8px;
  height: 8px;
  margin-top: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--dim);
}
.ov-a .event-dot.ok {
  background: var(--green);
}
.ov-a .event-dot.err {
  background: var(--red);
}
.ov-a .event-dot.wait {
  background: var(--amber);
}
.ov-a .event-dot.run {
  background: var(--blue);
}
.ov-a .event-body {
  min-width: 0;
  flex: 1;
}
.ov-a .event-title {
  overflow: hidden;
  color: var(--text-2);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-a .event-meta {
  overflow: hidden;
  margin-top: 4px;
  color: var(--dim);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-a .event-time {
  flex: none;
  color: var(--dim);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

/* 最近任务：状态从「标题里的尾巴」搬成右侧药丸 —— 一列对齐才好扫 */
.ov-a .task-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 0;
  border-radius: 8px;
  padding: 12px;
}
.ov-a .task-body {
  min-width: 0;
  flex: 1;
}
.ov-a .task-title {
  overflow: hidden;
  color: var(--text-2);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-a .task-meta {
  margin-top: 4px;
  color: var(--dim);
  font-size: 14px;
}
.ov-a .task-pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.ov-a .task-pill.ok {
  background: var(--green-soft);
  color: var(--green);
}
.ov-a .task-pill.err {
  background: var(--red-soft);
  color: var(--red-text);
}
.ov-a .task-pill.wait {
  background: var(--amber-soft);
  color: var(--amber);
}
.ov-a .task-pill.run {
  background: var(--blue-soft);
  color: #3d4dab;
}

/* 管理员块 */
.ov-a .admin-wrap {
  margin-top: 8px;
}
.ov-a .admin-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 28px;
  border-bottom: 0;
  padding: 8px;
}
.ov-a .admin-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.ov-a .admin-label {
  color: var(--dim);
}
.ov-a .admin-cell b {
  color: var(--text-2);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ov-a .admin-cell b.is-ok {
  color: var(--green);
}
.ov-a .admin-cell b.is-err {
  color: var(--red);
}
.ov-a .audit-list {
  padding: 0 8px 6px;
}
.ov-a .audit-caption {
  margin: 0;
  padding: 6px 0 4px;
  color: var(--dim);
  font-size: 14px;
}
.ov-a .audit-row {
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 6px;
  padding: 4px 0;
  font-size: 14px;
}
.ov-a .audit-action {
  color: var(--text-2);
  font-family: Consolas, monospace;
}
.ov-a .audit-entity {
  color: var(--dim);
}
.ov-a .audit-time {
  margin-left: auto;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

/* 空态 / 加载态 */
.ov-a .card-empty {
  color: var(--dim);
  font-size: 14px;
}
.ov-a .card-empty span:first-of-type {
  font-size: 16px;
}
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

@media (max-width: 1150px) {
  .ov-a .home-cols {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "roles" "events" "tasks";
  }
  .ov-a .home-cols.is-single {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "events" "tasks";
  }
}
@media (max-width: 720px) {
  .ov-a :deep(.page-h h1) { font-size: 26px; }
  .ov-a .role-card { grid-template-columns: 36px minmax(0, 1fr); }
  .ov-a .role-links { grid-column: 2; margin-top: 4px; }
  .ov-a .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ov-a .usage-wrap .sec-h { flex-wrap: wrap; }
  .ov-a .usage-total { margin-left: 0; }
  .ov-a .usage-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "id cost" "bars bars";
    row-gap: 8px;
  }
  .ov-a .usage-bars { height: 32px; }
  .ov-a .hero { padding: 16px; }
  .ov-a .hero-head { flex-wrap: wrap; }
  .ov-a .hero-actions { width: 100%; flex-wrap: wrap; }
  .ov-a .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 20px; }
  /* 两列时竖线会落在第二行左边缘外，变成一根悬空的线，直接收掉 */
  .ov-a .stat + .stat::before { display: none; }
  .ov-a .hero-cycle { flex-wrap: wrap; gap: 8px; }
  .ov-a .hero-cycle-text { flex: none; }
}
</style>
