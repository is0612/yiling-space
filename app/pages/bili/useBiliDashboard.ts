import { computed, inject, provide, reactive, ref, type InjectionKey } from "vue";
import { ElMessage } from "element-plus";
import type { BiliAccount, DashboardData } from "./types";
import {
  coverStyle as coverGradientStyle, dur, formatTime, readErrorMessage, windowLabel,
} from "./utils";

/**
 * 概览用的数据源 —— dashboard 一次拉取 + 所有 KPI / 时间线派生值 + 封面缓存。
 *
 * 概览和运行记录看的是同一份 dashboard（一个要今天 3 条，一个要全部），
 * 所以放在页面级 provide 一份，两个视图 inject 同一个实例。
 * 「现在跑一轮」也在这里：它改的是 dashboard 的数据，和读取天然同源。
 */
export type BiliDashboard = ReturnType<typeof createDashboard>;

const DASH_KEY: InjectionKey<BiliDashboard> = Symbol("bili-dashboard");

function createDashboard() {
  const loading = ref(true);
  const dashboard = ref<DashboardData>({ today: "", accounts: [] });
  const lastRoundSeconds = ref<number | null>(null);

  const bindings = computed(() => dashboard.value.accounts.flatMap((account) => account.bindings));

  // ── KPI ──────────────────────────────────────────────────
  const totalPickedToday = computed(() => bindings.value.reduce((sum, b) => sum + b.pickedToday, 0));
  const totalPerDay = computed(() =>
    bindings.value.reduce((sum, b) => sum + b.perDay, 0) ||
    dashboard.value.accounts.reduce((sum, a) => sum + (a.duty.perDay ?? 0), 0),
  );
  const totalSeenToday = computed(() => bindings.value.reduce((sum, b) => sum + b.seenToday.length, 0));
  const skippedSeen = computed(() =>
    bindings.value.reduce((sum, b) => sum + b.seenToday.filter((v) => v.result !== "picked").length, 0),
  );
  const totalRounds = computed(() => bindings.value.reduce((sum, b) => sum + b.reports.length, 0));

  const quotaPct = computed(() =>
    totalPerDay.value > 0 ? Math.min(100, Math.round((totalPickedToday.value / totalPerDay.value) * 100)) : 0,
  );

  /** 判重命中率：跳过数 / 今天看过的总数。KPI 大数字已经说了条数，脚注就给比率。 */
  const skipPct = computed(() =>
    totalSeenToday.value ? Math.round((skippedSeen.value / totalSeenToday.value) * 100) : 0,
  );

  const lastRun = computed(() => dur(lastRoundSeconds.value));

  const lastHint = computed(() => {
    if (lastRoundSeconds.value !== null) return "最近一轮值班的耗时";
    if (totalRounds.value) return "上一轮耗时随重启清空了";
    return "跑过一轮才有耗时";
  });

  // ── 页头 ──────────────────────────────────────────────────
  /* 标题是固定的一句话，和总览页「今天的工作台」同一句式。
     以前 h1 是一句状态（「今天刷了 0 条，还剩 5 条配额」），和 KPI 第一格说同一份数据，
     而且页面本身没有稳定的名字。状态交给 KPI 讲，标题只管「这是哪一页」。 */
  const h1 = "今天的值班台";

  const windowText = computed(() => {
    const account = dashboard.value.accounts[0];
    if (!account) return "";
    if (account.nextWindow) return `下次谷时窗口 ${windowLabel(account.nextWindow)}`;
    return account.duty.peakValley ? "当前在谷时窗口内" : "峰谷自动刷已关闭";
  });

  /* 副标题只留 KPI 里看不全的信息：现在是不是谷时、配置存在哪个目录。
     轮次 / 判重条数都在 KPI 里，这里不再重复一遍。 */
  const subtitle = computed(() => {
    const bits: string[] = [];
    const w = windowText.value;
    if (w) bits.push(w);
    const home = dashboard.value.accounts.find((a) => a.dataHome)?.dataHome;
    if (home) bits.push(`配置在 ${home}`);
    return bits.join(" · ");
  });

  // ── 时间线 ────────────────────────────────────────────────
  /** 跨账号的「她今天看了什么」，概览取最新 3 条（和 bili-desk 首屏一致）。 */
  const recentSeen = computed(() =>
    bindings.value
      .flatMap((b) => b.seenToday.map((video) => ({ ...video, characterName: b.characterName })))
      .sort((a, b) => new Date(b.seenAt).getTime() - new Date(a.seenAt).getTime())
      .slice(0, 3),
  );

  /** 跨账号的今日报告。 */
  const recentReports = computed(() =>
    bindings.value
      .flatMap((b) => b.reports.map((report) => ({ ...report, characterName: b.characterName })))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  );

  /** 运行记录页要看全部，概览只看前几条 —— 同一份数据，两个视图各取所需。 */
  const allSeen = computed(() =>
    bindings.value
      .flatMap((b) => b.seenToday.map((video) => ({ ...video, characterName: b.characterName })))
      .sort((a, b) => new Date(b.seenAt).getTime() - new Date(a.seenAt).getTime()),
  );

  const allReports = computed(() => recentReports.value);

  /** 「今日轮次」的脚注：最近一轮是几点跑的（没有就直说没跑过）。 */
  const latestRoundLabel = computed(() => {
    const latest = recentReports.value[0];
    return latest ? `最近一轮 ${formatTime(latest.createdAt)}` : "还没有跑过值班";
  });

  /** 运行记录筛选：全部 / 今日报告 / 看过的视频。放这里而不是视图里 —— 视图是 v-if 切换，
   *  放在组件内的话每次离开都会丢筛选，回来又跳回「全部」。 */
  const historyFilter = ref<"all" | "report" | "seen">("all");

  // ── 封面 ──────────────────────────────────────────────────
  const coverCache = reactive<Record<string, string>>({});
  const coverBroken = reactive<Record<string, boolean>>({});

  /** 封面没加载出来时的占位渐变（纯函数在 utils.ts，这里只是把缓存状态带进去）。 */
  function coverStyle(bvid: string, index: number) {
    return coverGradientStyle(Boolean(coverCache[bvid]), index);
  }

  /** 图片挂了：标记坏图并撤掉缓存，模板会退回文字占位。 */
  function dropCover(bvid: string) {
    coverBroken[bvid] = true;
    delete coverCache[bvid];
  }

  async function resolveCover(bvid: string) {
    if (coverCache[bvid] || coverBroken[bvid]) return;
    try {
      const data = await $fetch<{ bvid: string; pic: string | null }>("/api/admin/bili/cover", { query: { bvid } });
      if (data.pic) coverCache[bvid] = data.pic;
      else coverBroken[bvid] = true;
    } catch {
      coverBroken[bvid] = true;
    }
  }

  async function loadCovers() {
    const bvids = bindings.value.flatMap((b) => b.seenToday.map((v) => v.bvid));
    await Promise.all([...new Set(bvids)].map((bvid) => resolveCover(bvid)));
  }

  // ── 读数据 / 跑一轮 ───────────────────────────────────────
  async function loadDashboard() {
    loading.value = true;
    try {
      dashboard.value = await $fetch<DashboardData>("/api/admin/bili/dashboard");
      await loadCovers();
    } catch (error) {
      ElMessage.error(readErrorMessage(error, "无法读取 B站 工作台数据。"));
    } finally {
      loading.value = false;
    }
  }

  /** 正在跑的 bindingId；null = 空闲。 */
  const running = ref<string | null>(null);

  async function runRound() {
    const account = dashboard.value.accounts[0];
    const binding = account?.bindings[0];
    if (!account || !binding) {
      ElMessage.warning("还没有绑定角色的 B站 账号，先在下方「账号与角色」里添加账号并绑定角色。");
      return;
    }
    running.value = binding.bindingId;
    try {
      const result = await $fetch<{
        ok: boolean; seconds: number; picked: number; skipped: number; error?: string; notes?: string[];
      }>(
        "/api/admin/bili/run-round",
        { method: "POST", body: { connectionId: account.connectionId, bindingId: binding.bindingId } },
      );
      lastRoundSeconds.value = result.seconds;
      const notes = result.notes ?? [];
      if (!result.ok) {
        ElMessage.warning(result.error || "这一轮没跑成。");
      } else if (result.picked === 0 && notes.length) {
        // 一条都没挑中时，「为什么」比「跑完了」有用 —— 否则只能对着「跳过 N 条」猜
        ElMessage.warning(`跑完了（${result.seconds}s），一条没挑中：${notes[0]}`);
      } else {
        ElMessage.success(`跑完了（${result.seconds}s），挑中 ${result.picked} 条、跳过 ${result.skipped} 条。`);
      }
      await loadDashboard();
    } catch (error) {
      ElMessage.error(readErrorMessage(error, "执行失败。"));
    } finally {
      running.value = null;
    }
  }

  /** 解绑 / 删号之后也得重新读 —— 对外就是同一个 loadDashboard，别造第二个名字 */
  return {
    loading, dashboard,
    totalPickedToday, totalPerDay, totalSeenToday, skippedSeen, totalRounds, quotaPct, skipPct,
    lastRun, lastHint, h1, subtitle,
    recentSeen, recentReports, allSeen, allReports, latestRoundLabel, historyFilter,
    coverCache, coverStyle, dropCover,
    running, runRound, loadDashboard,
    /** 给「绑定角色」弹窗用：账号列表 */
    accounts: computed<BiliAccount[]>(() => dashboard.value.accounts),
  };
}

export function provideBiliDashboard(): BiliDashboard {
  const store = createDashboard();
  provide(DASH_KEY, store);
  return store;
}

export function useBiliDashboard(): BiliDashboard {
  const store = inject(DASH_KEY, null);
  if (!store) throw new Error("useBiliDashboard() 必须在值班台页面子树里调用。");
  return store;
}
