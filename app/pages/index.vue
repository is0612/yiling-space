<script setup lang="ts">
import {
  ArrowRight,
  User,
} from "@element-plus/icons-vue";
import { characterUrgency, describeCountdown, formatCny, formatTokenCount, type OverviewCharacter, type OverviewPayload } from "~/utils/overview";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文从异常条直接开始；refreshable 让顶栏出现刷新按钮。
definePageMeta({
  topbar: {
    title: "工作台",
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

/* ══ 背景动态壁纸 ══════════════════════════════════════════════════
   静态图（.ov-a::before）先出来顶住首屏，视频解码出首帧再淡入盖上去；
   视频 404 / 自动播放被拦 / 用户开了「减少动态效果」，就一直是静态图。
   装饰层只能更差或更好，不能影响任何数据和可读性。

   素材：public/overview/overview-wallpaper.mp4
   1600×918 · H.264 · 60fps · 无音轨 · 10s 无缝循环（首尾帧几乎重合）。
   换视频只要覆盖这个文件，别改尺寸 —— 槽位由 --ov-w / --ov-h 定。 */
const wallpaperVideo = ref<HTMLVideoElement | null>(null);
const wallpaperArmed = ref(false); // 是否值得去下载（没开减少动态效果）
const wallpaperOn = ref(false); // 首帧已经画上去了，可以淡入

function playWallpaper() {
  void wallpaperVideo.value?.play().catch(() => {
    // 自动播放被策略拦下：留在静态图上，不重试也不再打扰用户
  });
}

// 切到后台就停 —— 一张看不在眼里的壁纸没理由继续吃 GPU
function onWallpaperVisibility() {
  if (!wallpaperArmed.value) return;
  if (document.hidden) wallpaperVideo.value?.pause();
  else playWallpaper();
}

onMounted(() => {
  // 动效是装饰不是功能，不该硬塞给会晕动的人
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  // 和 CSS 里那条 (max-width: 1240px) 同一条线：窄屏根本不显示壁纸，
  // 别为了一张看不见的图去下 4 MB
  if (window.matchMedia?.("(max-width: 1240px)").matches) return;

  // 首屏要抢的是接口和字体，这几 MB 的背景等浏览器闲下来再拉
  const arm = () => { wallpaperArmed.value = true; };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(arm, { timeout: 2500 });
  else window.setTimeout(arm, 1200);

  document.addEventListener("visibilitychange", onWallpaperVisibility);
});

watch(wallpaperArmed, async (armed) => {
  if (!armed) return;
  // 元素是 v-if 挂上来的，等它进了 DOM 才有 play() 可调
  await nextTick();
  playWallpaper();
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onWallpaperVisibility);
});
</script>

<template>
  <div class="page-wrap ov-a">
    <!-- 动态壁纸层：铺满 .ov-a 自己那块（也就是 main），和挂在 .ov-a 上的
         静态兜底图同一个盒子、同一套 cover 规则。摆在内容之前，层级压在
         .ov-stage 底下，纯装饰，不接指针事件。 -->
    <div
      v-if="wallpaperArmed"
      class="ov-media"
      aria-hidden="true"
    >
      <video
        ref="wallpaperVideo"
        class="ov-media-video"
        :class="{ 'is-on': wallpaperOn }"
        src="/overview/overview-wallpaper.mp4"
        muted
        loop
        playsinline
        preload="auto"
        @playing="wallpaperOn = true"
      />
    </div>
    <!-- 内容栏：靠左收窄，右边那截留白就是角色的位置 -->
    <div class="ov-stage">
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
          <li><span>3</span>在 QQ 上聊，到周期结束时自动归档</li>
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

          <!-- 四个数字：归档、记忆、花费，全部取这个角色自己的账。
               第二格原来放「本周期消息」，但它跟自动归档开关绑死：归档一关，
               周期不成立、数字恒为 0，看着像坏了。换成长期记忆条数，永远有值。
               不再放「待处理任务」—— 失败任务在顶部报警条里已经说过一次，
               这里再报一遍属于重复，而且挤掉了一行能放四格的宽度。 -->
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
              <span class="stat-k">角色记忆</span>
              <span class="stat-v">
                {{ card.character.memoryCount }}<small>条</small>
              </span>
              <span class="stat-f">长期记忆条目</span>
            </div>
            <div class="stat">
              <span class="stat-k">上次归档</span>
              <span class="stat-v">
                {{ card.character.latestSnapshotVersion ? card.character.latestSnapshotLabel : "—" }}<small v-if="card.character.latestSnapshotVersion">v{{ card.character.latestSnapshotVersion }}</small>
              </span>
              <span class="stat-f">{{ card.character.latestSnapshotVersion ? `已归档 ${card.character.latestSnapshotVersion} 次` : "还没有归档过" }}</span>
            </div>
            <div class="stat">
              <span class="stat-k">今日花费</span>
              <span class="stat-v">{{ card.cost ? formatCny(card.cost.today.costCny) : "—" }}</span>
              <span class="stat-f">{{ card.cost ? `近 7 天 ${formatCny(card.cost.windowCostCny)}` : "还没有模型调用" }}</span>
            </div>

          <!-- 用量金额是估算值：未定价 token 不计入金额，缺缓存明细的调用按未命中价估算。 -->
          <div
            v-if="card.cost && (card.cost.today.unpricedTokens > 0 || card.cost.unpricedModels.length > 0 || card.cost.uncachedCalls > 0)"
            class="usage-notes"
          >
            <p v-if="card.cost.today.unpricedTokens > 0">
              今日有 {{ formatTokenCount(card.cost.today.unpricedTokens) }} 个未定价 token，未计入今日金额。
            </p>
            <p v-if="card.cost.unpricedModels.length > 0">
              近 7 天出现未定价模型：{{ card.cost.unpricedModels.join("、") }}；相关费用未计入。
            </p>
            <p v-if="card.cost.uncachedCalls > 0">
              近 7 天有 {{ card.cost.uncachedCalls }} 次调用缺少缓存明细，按未命中价估算，金额可能偏高。
            </p>
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
              第 {{ card.character.cycle.dayIndex }}/{{ card.character.cycle.totalDays }} 天 · 本周期新增 {{ card.character.cycleMemoryCount }} 条记忆
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
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   A · 色块平铺 —— 一张白台面，只有异常才上色
   L0 画布（main.css 的 --bg 不动）→ L1 纸面 --paper（.88 白，见下）
   → L2 卡内 6px 内衬 → L3 行（无底色无分隔）→ L4 异常整行上色
   统一写 `.ov-a .xxx`：把作用域锁在本页，同时靠 (0,3,0) 压过
   main.css 里 .pill / .btn 的 (0,1,0)。

   字号收口（2026-11）：正文 16 / 小标题 18 / 注释 14 / 数值 26。
   页面标题不在正文里 —— 已搬到顶栏（见 utils/topbar.ts），本页不再需要放大 h1。
   间距、圆角、尺寸一律取偶数 —— 唯一保留的单数是分割线的 1px（描边量级，
   和卡片边框同类，改成 2px 会明显变粗）与药丸的 999 全圆角。
   ══════════════════════════════════════════════════════════════ */

/* ══ 内容栏 ══════════════════════════════════════════════════════
   背景分两层：静态兜底图直接挂在 .ov-a 的 background 上、动态壁纸挂在
   .ov-media，两张都只铺 main 这一块、压在内容底下（见下方「壁纸层」那段）。
   这里只管让内容靠左收窄 —— 卡片一旦铺满整页，右边那个角色就被压在底下了。
   36vw 是量出来的：壁纸右对齐以后，角色的左缘（头发和筷子）落在 43% 附近，
   卡片超过这条线就会压到她身上。几个尺寸逐个截图对过，脸始终在线右侧。 */
.ov-a .ov-stage {
  width: min(720px, 36vw);
  min-width: 0;
  /* 容器查询的锚点 —— 卡片里的五格换几列，看的是卡片自己多宽，不是视口 */
  container-type: inline-size;
  /* 壁纸层是 z-index:0 的 fixed 元素，内容得自己抬一层才压得住它。
     container-type 本身已经建了层叠上下文，这里只是把顺序写明白。 */
  position: relative;
  z-index: 1;
}

/* ══ 壁纸层 ══════════════════════════════════════════════════════
   壁纸只活在 main 里 —— 挂在页面根节点 .ov-a 上，不挂在视口上，所以侧栏和
   顶栏底下不会再有图。main 本身没有高度（它只有内容那么高），所以这里给它
   一个「至少一屏」的下限：100vh 减掉顶栏那 56px，否则会凭空多出一条滚动条。

   固定右上角 + cover，两条行为是刻意设计的，别改成 center 或 bottom：
   · 窗口变窄（16:9 → 16:10 → 4:3）：高度被下限钉着，图比窗口宽，cover 只能
     从**左边**裁 —— 裁掉窗帘和海，角色好好地留在右边缘。
   · 窗口变矮：宽度成为瓶颈，图比窗口高，从**下面**裁 —— 裁掉桌子和腿，
     头和脸留在最上面。
   一句话：右边那个角色永远在，窗口再矮也先保住她的脸。

   换图：public/overview/overview-bg.jpg（动态版是同目录的
   overview-wallpaper.mp4，两者都必须是 16:9 —— 裁切算法一样，淡入才不错位）。 */
.ov-a {
  position: relative;
  min-height: calc(100vh - var(--topbar-h));
  background: url("/overview/overview-bg.jpg") right top / cover no-repeat;

  /* 纸面：.88 白，用在压在这张画上的所有卡片。
     故意不用 backdrop-filter —— 背后是 60fps 的视频，毛玻璃每帧都要重算一次
     高斯模糊，等于拿 GPU 换一点氛围；而且压到 .55 透明时，12px 的 --faint
     灰字（"昨天 ¥4.10"这种）会糊在浅色海面上。0.88 是层次和可读性之间
     的一个点，渲染成本为零。 */
  --paper: rgba(255, 255, 255, .88);
}

/* 视频层：铺满 .ov-a 自己那块（含内边距），用同一套 cover 参数；
   静态图在它下面兜底，所以视频没下、没播、被拦，画面都是完整的。 */
.ov-a .ov-media {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}
.ov-a .ov-media-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: right top;
  /* 从 0 开始淡入：解码出首帧那一刻静态图正好在下面，接得住 */
  opacity: 0;
  transition: opacity 600ms ease;
}
.ov-a .ov-media-video.is-on { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .ov-a .ov-media-video { transition: none; }
}

/* 窄到这个份上就别放壁纸了：内容已经占满整屏，图只会变成一层噪点。
   和 JS 里那段 1240 的判断是同一条线，改一处得改两处。 */
@media (max-width: 1240px) {
  .ov-a { background-image: none; }
  .ov-a .ov-media { display: none; }
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
  background: var(--paper);
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

/* 空态引导：虚线框去掉，改成一块纸面 —— 和卡片同一种材质 */
.ov-a .guide {
  border: 0;
  border-radius: 10px;
  background: var(--paper);
  box-shadow: var(--sh-1);
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

/* 主角卡：一个角色一张纸，装下身份 + 五个时点 + 周期进度 */
.ov-a .hero {
  border: 0;
  border-radius: 12px;
  background: var(--paper);
  /* 加一层最轻的投影（复用 main.css 的 --sh-1）：卡片压在插画上，
     不给一点分离会跟背后的白色窗帘糊在一起。 */
  box-shadow: var(--sh-1);
  padding: 22px 24px;
  margin-bottom: 24px;
}
/* 异常：只给竖条，不铺整块底 —— 1000px 宽的 hero 铺粉底等于整页报警。
   竖条和上面的投影要一起写，box-shadow 是整条覆盖不是叠加。 */
.ov-a .hero.is-bad {
  box-shadow: inset 4px 0 0 var(--red), var(--sh-1);
}
.ov-a .hero.is-over {
  box-shadow: inset 4px 0 0 var(--amber), var(--sh-1);
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
.ov-a .usage-notes {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
  padding-left: 10px;
  border-left: 2px solid var(--amber);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.ov-a .usage-notes p {
  margin: 0;
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

/* 四格在窄屏会挤成一团：≤720 只保留卡片自己的内衬和标题换行，
   格子怎么排交给下面按卡片宽度判断的 @container。 */
@media (max-width: 720px) {
  .ov-a .hero { padding: 16px; }
  .ov-a .hero-head { flex-wrap: wrap; }
  .ov-a .hero-cycle { flex-wrap: wrap; gap: 8px; }
  .ov-a .hero-cycle-text { flex: none; }
}

/* 再窄下去卡片就只剩 480px 了，撑不起五个数字：背景收掉，内容重新铺满 */
@media (max-width: 1240px) {
  .ov-a .ov-stage { width: 100%; }
}

/* 卡片被角色挤窄之后，四格自己会挤成一团：500 以下退成 2×2。
   这里用 @container 而不是 @media —— 决定卡片多宽的是右边留了多少，
   不是屏幕多大；1920 的屏配上大角色，卡片一样可能只有 500px。
   退到两行时行首那根竖线会悬在卡片内衬里，索性一起收掉。
   原来是 5 格，用「6 栏 + 前 3 个各占 2 栏、后 2 个各占 3 栏」凑 3+2；
   去掉「待处理任务」只剩 4 格，直接 2×2 就够了。 */
@container (max-width: 500px) {
  .ov-a .hero-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 20px;
  }
  .ov-a .stat + .stat::before { display: none; }
}
</style>
