/**
 * 总览页的数据契约。服务端 `/api/overview` 按此结构返回，页面只负责展示。
 * 所有时间点由服务端按角色时区格式化成 `label`，避免 SSR 与浏览器时区不一致导致的闪烁。
 */

export type OverviewCycle = {
  startISO: string;
  endISO: string;
  dayIndex: number;
  totalDays: number;
  /** 已过 nextSnapshotAt 但阶段总结未生成：周期逾期。 */
  missed: boolean;
};

export type OverviewCharacter = {
  id: string;
  name: string;
  avatar: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  status: "运行中" | "已暂停" | "未连接";
  channels: string[];
  intervalDays: number;
  autoSnapshotEnabled: boolean;
  nextSnapshotAt: string | null;
  nextSnapshotLabel: string;
  latestSnapshotAt: string | null;
  latestSnapshotLabel: string;
  latestSnapshotVersion: number | null;
  memoryCount: number;
  cycle: OverviewCycle | null;
  cycleMessageCount: number;
  cycleMemoryCount: number;
  chatModel: string;
  chatApiKeyConfigured: boolean;
  failedTaskCount: number;
  pendingTaskCount: number;
};

export type OverviewTaskItem = {
  id: string;
  type: string;
  status: string;
  typeLabel: string;
  statusLabel: string;
  characterId: string;
  characterName: string;
  lastError: string | null;
  createdAt: string;
};

export type OverviewEvent = {
  id: string;
  kind: "task" | "snapshot";
  tone: "ok" | "err" | "wait" | "run" | "mute";
  title: string;
  meta: string;
  atLabel: string;
  atISO: string;
};

export type OverviewAdminPanel = {
  database: "up" | "down";
  jobs: { queued: number; running: number; failed: number; succeeded: number };
  channels: { total: number; online: number };
  recentAudits: Array<{ id: string; action: string; entityType: string; atLabel: string }>;
};

/** 一天里某个角色的用量。金额只覆盖已定价的模型。 */
export type OverviewUsageDay = {
  day: string;
  totalTokens: number;
  calls: number;
  costCny: number;
  /** 未定价模型消耗的 token，这部分没有进 costCny。 */
  unpricedTokens: number;
  /** 缓存命中的输入 token（只算有明细的调用），命中价通常只有未命中价的几十分之一。 */
  cacheHitTokens: number;
  /** 没有缓存明细的调用数：这些只能按未命中价估算，金额偏高。 */
  uncachedCalls: number;
};

export type OverviewUsageCharacter = {
  characterId: string;
  /** 从旧到新，最后一个是今天；没有用量的日子会补零。 */
  days: OverviewUsageDay[];
  today: OverviewUsageDay;
  windowTokens: number;
  windowCostCny: number;
  unpricedModels: string[];
  /** 窗口内没有缓存明细的调用数。 */
  uncachedCalls: number;
};

export type OverviewUsage = {
  /** 今天的东八区日期，用来给最后一根柱子上色。 */
  day: string;
  days: string[];
  totalTokens: number;
  costCny: number;
  unpricedTokens: number;
  unpricedModels: string[];
  /** 今天命中缓存的输入 token。 */
  cacheHitTokens: number;
  /** 今天没有缓存明细的调用数。 */
  uncachedCalls: number;
  characters: OverviewUsageCharacter[];
};

export type OverviewNextSnapshot = {
  characterId: string;
  characterName: string;
  atISO: string;
  atLabel: string;
  /** 距下一次归档的毫秒数；负数表示已逾期。 */
  remainingMs: number;
};

export type OverviewCycleSummary = {
  messageCount: number;
  dayIndex: number;
  totalDays: number;
  endISOLabel: string;
};

export type OverviewLatestSnapshot = {
  id: string;
  characterId: string;
  characterName: string;
  atISO: string;
  atLabel: string;
  /** 只到日的日期（MM-DD），当主视觉用。 */
  dateLabel: string;
  version: number;
};

export type OverviewWatchdogFinding = {
  code: "task_stuck" | "worker_stalled" | "scheduler_stalled" | "snapshot_silent" | "duty_silent";
  severity: "err" | "warn";
  characterId: string;
  characterName: string;
  /** 一句给人看的话，页面直接显示。 */
  message: string;
  /** 判定依据，排查时看。 */
  detail: string;
};

/**
 * 停滞检测：回答「进程都活着，为什么没有产出」。
 * 和 `tasks.failed` 不同 —— 那是有任务失败了，这里是任务根本没被排、没被认领或没人回收。
 */
export type OverviewWatchdog = {
  checkedAt: string;
  findings: OverviewWatchdogFinding[];
};

export type OverviewPayload = {
  generatedAt: string;
  characters: OverviewCharacter[];
  tasks: {
    pending: number;
    failed: number;
    items: OverviewTaskItem[];
  };
  watchdog: OverviewWatchdog;
  nextSnapshot: OverviewNextSnapshot | null;
  cycle: OverviewCycleSummary | null;
  latestSnapshot: OverviewLatestSnapshot | null;
  events: OverviewEvent[];
  admin: OverviewAdminPanel | null;
  usage: OverviewUsage;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type CountdownText = {
  /** 主数字，直接放进 26px 的值位。 */
  value: string;
  /** 单位，跟在大数字后。 */
  unit: string;
  /** 逾期时用不同语气渲染。 */
  tone: "normal" | "warn" | "overdue";
  /** 完整文案，用于 title / 无障碍播报。 */
  label: string;
};

/** 把剩余毫秒折成「3 天 / 4 小时 / 12 分钟」，超过一天只显示天数，避免出现两层单位。 */
export function describeCountdown(remainingMs: number): CountdownText {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { value: "已逾期", unit: "", tone: "overdue", label: "已逾期" };
  }
  if (remainingMs >= DAY_MS) {
    const days = Math.floor(remainingMs / DAY_MS);
    return { value: String(days), unit: "天", tone: days <= 1 ? "warn" : "normal", label: `${days} 天` };
  }
  if (remainingMs >= HOUR_MS) {
    const hours = Math.floor(remainingMs / HOUR_MS);
    return { value: String(hours), unit: "小时", tone: hours <= 6 ? "warn" : "normal", label: `${hours} 小时` };
  }
  const minutes = Math.max(1, Math.floor(remainingMs / MINUTE_MS));
  return { value: String(minutes), unit: "分钟", tone: "warn", label: `${minutes} 分钟` };
}

/** 角色卡的紧急度：数字越小越靠前，异常角色必须先被看到。 */
export function characterUrgency(character: OverviewCharacter): number {
  if (!character.chatApiKeyConfigured) return 0;
  if (character.failedTaskCount > 0) return 1;
  if (character.cycle?.missed) return 2;
  if (character.status === "未连接") return 3;
  if (character.status === "已暂停") return 6;
  return 4;
}

/** token 数带千分位：总览里一眼要对上额度设置里的数字，不做 1.2 万这种换算。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Math.round(value).toLocaleString("zh-CN");
}

/**
 * 金额展示。一次调用常常只有几厘钱，所以小于 1 元时保留到 3 位小数；
 * 真到 0.0005 以下就直接说「不到一厘」，不要显示成 ¥0 让人以为免费。
 */
export function formatCny(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "¥0";
  if (value >= 1000) return "¥" + Math.round(value).toLocaleString("zh-CN");
  if (value >= 0.01) return "¥" + value.toFixed(2);
  if (value >= 0.001) return "¥" + value.toFixed(3);
  return "<¥0.001";
}

/** 柱状图的悬停说明：`10-29 · 12,345 tokens · ¥0.42`。 */
export function describeUsageDay(day: OverviewUsageDay): string {
  const label = day.day.slice(5);
  const tokens = `${formatTokenCount(day.totalTokens)} tokens`;
  const calls = `${day.calls} 次调用`;
  return `${label} · ${tokens} · ${calls} · ${formatCny(day.costCny)}`;
}
