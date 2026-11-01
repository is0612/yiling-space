/**
 * Watchdog：在「进程还活着」之外，看「事情有没有在往前走」。
 *
 * 常规监控只探进程存活，但周期任务停摆的典型形态是：
 * 进程都在、状态全绿，只是排期没人排、任务没人认领、或者卡在「运行中」没人回收。
 * 这三种情况在页面上表现为「一切正常」，直到很多天后才发现一个总结都没生成。
 *
 * 这里只做判定，不调模型、不写库：
 * - 判定是纯函数（`evaluateWatchdog`），阈值都是常量，测试可以钉死；
 * - 取数在 `collectWatchdogFindings`，只读现有表（`memory_jobs` / `memory_snapshots`），
 *   不新增表、不新增迁移。
 *
 * 注意判定边界：模型没配置时任务本来就该留在队列里（那是产品决策），
 * 这时不能报「Worker 没在跑」—— 页面已有「未配置模型」的提示，报两遍只会让人以为坏了两处。
 */

import type { PrismaClient } from "../../src/generated/prisma/client";
import { parseDutyInput } from "./channel-adapter/bili/configure";
import { isChatModelConfigured } from "./chat-model-config";

export type WatchdogSeverity = "err" | "warn";

export type WatchdogFindingCode =
  /** 任务卡在「运行中」超过租约，没人回收：做回收的那个进程不在。 */
  | "task_stuck"
  /** 队列有活但没人认领：Worker 不在。 */
  | "worker_stalled"
  /** 归档时间已过、队列里却没有对应任务：排期进程不在。 */
  | "scheduler_stalled"
  /** 自动归档开着，却长期没有产出新总结。 */
  | "snapshot_silent"
  /** B站 值班开着，但很久没跑过一轮（适配器没跑 / CLI 不可用）。 */
  | "duty_silent";

export type WatchdogFinding = {
  code: WatchdogFindingCode;
  severity: WatchdogSeverity;
  characterId: string;
  characterName: string;
  /** 一句给人看的话，总览页直接拼在报警条里。 */
  message: string;
  /** 判定依据：为什么这么判，排查时看这一行。 */
  detail: string;
};

/** 每个角色判定所需的最小事实。字段都为 null / 0 时表示「没有这类记录」。 */
export type WatchdogCharacterFacts = {
  id: string;
  name: string;
  /** 角色模型是否可用（含服务端环境变量回退）。 */
  modelConfigured: boolean;
  autoSnapshotEnabled: boolean;
  nextSnapshotAt: Date | null;
  intervalDays: number;
  /** 该角色所有记忆范围里最新一份快照的生成时间。 */
  latestSnapshotAt: Date | null;
  /** QUEUED + RUNNING。 */
  pendingTaskCount: number;
  /** FAILED + RETRY_WAIT。 */
  failedTaskCount: number;
  /** 最早一条仍在排队的任务的入队时间。 */
  oldestQueuedAt: Date | null;
  /** 最早一条 RUNNING 任务的锁定时间；超期即说明没人回收。 */
  stuckLockedAt: Date | null;
  /** B站 值班：没有可用绑定或没开值班时为 null。 */
  duty?: {
    /** 每天轮次上限；0 = 关。 */
    perDay: number;
    /** 最近一轮报告的生成时间；null = 一轮都没跑过。 */
    lastRoundAt: Date | null;
    /** 最早一条相关绑定的创建时间：从没跑过时用它当起点。 */
    since: Date;
  } | null;
};

export type WatchdogInput = {
  now: Date;
  characters: WatchdogCharacterFacts[];
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WATCHDOG_THRESHOLDS = {
  /** Worker 的租约是 5 分钟（`memory-worker.ts` 的 LEASE_MS）；超过 3 倍还没续上，就是没人管了。 */
  stuckLockMs: 15 * MINUTE,
  /** 队列里最老的一条等了这么久还没人认领：Worker 不在，或者它卡在别的地方。 */
  queueBacklogMs: 30 * MINUTE,
  /** 归档时间过了这么久还没排出任务：排期进程不在（留一小时给手动补跑）。 */
  schedulerGraceMs: 1 * HOUR,
  /** 自动归档开着却这么久没有产出：至少两个周期，且不少于两周。 */
  minSilentDays: 14,
  /**
   * B站 值班多久没跑算停摆。perDay ≥ 1 就意味着「每天至少一轮」，
   * 但谷时窗口、风控、额度用完都可能合法地空一天，所以给到 3 天再报。
   */
  dutySilentMs: 3 * DAY,
} as const;

function describeDuration(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)} 天`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)} 小时`;
  return `${Math.max(1, Math.floor(ms / MINUTE))} 分钟`;
}

/**
 * 记忆流水线的判定。顺序即因果顺序：卡住 > 没人认领 > 没人排期 > 长期没产出。
 * 前一条成立时不再报后一条 —— 「Worker 不在」已经解释了积压，
 * 再补一句「没产出新总结」只是把同一个原因说第二遍。
 */
function evaluateMemoryPipeline(now: number, character: WatchdogCharacterFacts): WatchdogFinding | null {
  const base = { characterId: character.id, characterName: character.name };
  const stuckFor = character.stuckLockedAt ? now - character.stuckLockedAt.getTime() : 0;
  const backlogFor = character.oldestQueuedAt ? now - character.oldestQueuedAt.getTime() : 0;
  const overdueFor = character.nextSnapshotAt ? now - character.nextSnapshotAt.getTime() : 0;
  const sinceSnapshot = character.latestSnapshotAt ? now - character.latestSnapshotAt.getTime() : 0;
  const silentDays = Math.max(WATCHDOG_THRESHOLDS.minSilentDays, character.intervalDays * 2);

  if (stuckFor > WATCHDOG_THRESHOLDS.stuckLockMs) {
    return {
      ...base,
      code: "task_stuck",
      severity: "err",
      message: `有任务卡在「运行中」，${describeDuration(stuckFor)}没被回收`,
      detail: "Worker 每 5 分钟续租一次；超过 15 分钟没续上，通常是 Worker 已经退出。任务会在 Worker 重新启动后被认领。",
    };
  }
  // 模型没配置时任务留在队列里是设计行为，不能归因到 Worker。
  if (character.modelConfigured && backlogFor > WATCHDOG_THRESHOLDS.queueBacklogMs) {
    return {
      ...base,
      code: "worker_stalled",
      severity: "err",
      message: `队列里的任务等了 ${describeDuration(backlogFor)}还没人执行`,
      detail: "模型已配置、队列里也有任务，但没有任何任务被认领：Worker 进程（yarn worker:watch）可能没在跑。",
    };
  }
  // 已经排过任务（排队中/运行中）就说明排期进程在动；有失败任务时另说，别把失败讲成没排期。
  if (
    character.autoSnapshotEnabled
    && overdueFor > WATCHDOG_THRESHOLDS.schedulerGraceMs
    && character.pendingTaskCount === 0
    && character.failedTaskCount === 0
  ) {
    return {
      ...base,
      code: "scheduler_stalled",
      severity: "err",
      message: `归档时间已过 ${describeDuration(overdueFor)}，队列里却没有对应任务`,
      detail: "自动归档开着、也没有失败任务，说明排期没发生：排期进程（yarn scheduler:watch）可能没在跑，下一个周期不会被排出来。",
    };
  }
  if (
    character.autoSnapshotEnabled
    && character.latestSnapshotAt !== null
    && sinceSnapshot > silentDays * DAY
    && character.pendingTaskCount === 0
    && character.failedTaskCount === 0
  ) {
    return {
      ...base,
      code: "snapshot_silent",
      severity: "warn",
      message: `自动归档开着，但已经 ${describeDuration(sinceSnapshot)}没有生成过总结`,
      detail: `周期是 ${character.intervalDays} 天；队列里没有等待或失败的任务，说明流程停在了更早的一环（排期或 Worker），而且没人发现。`,
    };
  }
  return null;
}

/**
 * B站 值班是**另一条流水线**，和记忆队列互不影响：记忆停着不代表值班没在跑，反之亦然。
 * 所以它单独出一项，不参与上面那条因果链 —— 一个角色可能同时坏在两处。
 */
function evaluateDutySilence(now: number, character: WatchdogCharacterFacts): WatchdogFinding | null {
  const duty = character.duty;
  if (!duty || duty.perDay <= 0) return null;
  // 从没跑过时以绑定时间为起点：刚绑上两天的角色不该被指责。
  const anchor = duty.lastRoundAt ?? duty.since;
  const idleFor = now - anchor.getTime();
  if (idleFor <= WATCHDOG_THRESHOLDS.dutySilentMs) return null;
  const base = { characterId: character.id, characterName: character.name };
  return {
    ...base,
    code: "duty_silent",
    severity: "warn",
    message: duty.lastRoundAt
      ? `B站 值班开着，但已经 ${describeDuration(idleFor)}没跑过一轮`
      : `B站 值班开着，但绑定后 ${describeDuration(idleFor)}一次都没跑过`,
    detail: `每天上限 ${duty.perDay} 轮；${duty.lastRoundAt ? "最近一轮的记录还在，问题出在这一轮之后" : "库里没有任何一轮报告"}。通常是值班适配器没在跑（yarn bili:run）、或者 bili CLI 不可用 —— 只看绑定和开关是看不出来的。`,
  };
}

export function evaluateWatchdog(input: WatchdogInput): WatchdogFinding[] {
  const findings: WatchdogFinding[] = [];
  const now = input.now.getTime();
  for (const character of input.characters) {
    const memory = evaluateMemoryPipeline(now, character);
    if (memory) findings.push(memory);
    const duty = evaluateDutySilence(now, character);
    if (duty) findings.push(duty);
  }
  return findings;
}

/**
 * 从数据库取数并判定。只读，不改任何状态。
 *
 * `ownerId` 传了就只看这个用户的角色（总览页用）；不传就是全站（常驻脚本用）。
 */
export async function collectWatchdogFindings(
  prisma: PrismaClient,
  now: Date = new Date(),
  ownerId?: string,
): Promise<WatchdogFinding[]> {
  const characters = await prisma.character.findMany({
    where: ownerId ? { ownerId } : {},
    select: {
      id: true,
      name: true,
      modelConfig: true,
      memorySetting: {
        select: {
          autoSnapshotEnabled: true,
          nextSnapshotAt: true,
          snapshotIntervalDays: true,
        },
      },
      memoryScopes: {
        select: {
          id: true,
          snapshots: {
            orderBy: [{ createdAt: "desc" }, { version: "desc" }],
            take: 1,
            select: { createdAt: true },
          },
        },
      },
    },
  });
  if (!characters.length) return [];

  const scopeOwner = new Map<string, string>();
  for (const character of characters) {
    for (const scope of character.memoryScopes) scopeOwner.set(scope.id, character.id);
  }

  // 一次 groupBy 拿到「每个范围 × 状态」的条数与最早时间，避免按角色逐个查。
  const groups = await prisma.memoryJob.groupBy({
    by: ["memoryScopeId", "status"],
    where: ownerId ? { memoryScope: { is: { character: { is: { ownerId } } } } } : {},
    _count: { _all: true },
    _min: { createdAt: true, lockedAt: true },
  });

  type Bucket = {
    pending: number;
    failed: number;
    oldestQueuedAt: Date | null;
    stuckLockedAt: Date | null;
  };
  const buckets = new Map<string, Bucket>();
  for (const group of groups) {
    const characterId = scopeOwner.get(group.memoryScopeId);
    if (!characterId) continue;
    const bucket = buckets.get(characterId) ?? { pending: 0, failed: 0, oldestQueuedAt: null, stuckLockedAt: null };
    const count = group._count._all;
    if (group.status === "QUEUED" || group.status === "RUNNING") bucket.pending += count;
    if (group.status === "FAILED" || group.status === "RETRY_WAIT") bucket.failed += count;
    if (group.status === "QUEUED" && group._min.createdAt) {
      const at = group._min.createdAt;
      if (!bucket.oldestQueuedAt || at < bucket.oldestQueuedAt) bucket.oldestQueuedAt = at;
    }
    if (group.status === "RUNNING" && group._min.lockedAt) {
      const at = group._min.lockedAt;
      if (!bucket.stuckLockedAt || at < bucket.stuckLockedAt) bucket.stuckLockedAt = at;
    }
    buckets.set(characterId, bucket);
  }

  // B站 值班：绑定挂在角色上，值班开关写在**连接**的 metadata 里（不是绑定 config）。
  const biliBindings = await prisma.characterChannelBinding.findMany({
    where: {
      status: "ACTIVE",
      connection: { is: { platform: "bili" } },
      ...(ownerId ? { character: { is: { ownerId } } } : {}),
    },
    select: {
      id: true,
      characterId: true,
      createdAt: true,
      connection: { select: { metadata: true } },
    },
  });

  const bindingIds = biliBindings.map((binding) => binding.id);
  const lastRoundByBinding = new Map<string, Date>();
  if (bindingIds.length) {
    const rounds = await prisma.biliRoundReport.groupBy({
      by: ["bindingId"],
      where: { bindingId: { in: bindingIds } },
      _max: { createdAt: true },
    });
    for (const round of rounds) {
      if (round._max.createdAt) lastRoundByBinding.set(round.bindingId, round._max.createdAt);
    }
  }

  // 一个角色可能挂多个 B站 小号：取最大的 perDay、最近的一轮、最早的绑定时间。
  const dutyByCharacter = new Map<string, NonNullable<WatchdogCharacterFacts["duty"]>>();
  for (const binding of biliBindings) {
    const metadata = (binding.connection.metadata ?? {}) as Record<string, unknown>;
    const perDay = parseDutyInput(metadata.duty).perDay;
    if (perDay <= 0) continue;
    const lastRoundAt = lastRoundByBinding.get(binding.id) ?? null;
    const previous = dutyByCharacter.get(binding.characterId);
    dutyByCharacter.set(binding.characterId, {
      perDay: Math.max(perDay, previous?.perDay ?? 0),
      lastRoundAt: previous?.lastRoundAt && lastRoundAt
        ? (previous.lastRoundAt > lastRoundAt ? previous.lastRoundAt : lastRoundAt)
        : previous?.lastRoundAt ?? lastRoundAt,
      since: previous && previous.since < binding.createdAt ? previous.since : binding.createdAt,
    });
  }

  const facts: WatchdogCharacterFacts[] = characters.map((character) => {
    const bucket = buckets.get(character.id) ?? { pending: 0, failed: 0, oldestQueuedAt: null, stuckLockedAt: null };
    const latestSnapshotAt = character.memoryScopes
      .flatMap((scope) => scope.snapshots)
      .map((snapshot) => snapshot.createdAt)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    return {
      id: character.id,
      name: character.name,
      modelConfigured: isChatModelConfigured(character.modelConfig),
      autoSnapshotEnabled: character.memorySetting?.autoSnapshotEnabled ?? false,
      nextSnapshotAt: character.memorySetting?.nextSnapshotAt ?? null,
      intervalDays: character.memorySetting?.snapshotIntervalDays ?? 8,
      latestSnapshotAt,
      pendingTaskCount: bucket.pending,
      failedTaskCount: bucket.failed,
      oldestQueuedAt: bucket.oldestQueuedAt,
      stuckLockedAt: bucket.stuckLockedAt,
      duty: dutyByCharacter.get(character.id) ?? null,
    };
  });

  return evaluateWatchdog({ now, characters: facts });
}
