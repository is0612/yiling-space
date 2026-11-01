import type {
  OverviewAdminPanel,
  OverviewCharacter,
  OverviewCycle,
  OverviewEvent,
  OverviewPayload,
  OverviewTaskItem,
  OverviewUsage,
} from "../../../app/utils/overview";
import { requireActor } from "../../utils/auth";
import { resolveAvatarTone } from "../../utils/character-dto";
import { resolveChatModelSettings } from "../../utils/chat-model-config";
import { readUsageReport, usageDayWindow } from "../../utils/model-usage";
import { getPrisma } from "../../utils/prisma";
import { collectWatchdogFindings, type WatchdogFinding } from "../../utils/watchdog";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 总览里用量趋势看最近 7 天：够看出"哪天烧得凶"，又不至于把页面变成报表。 */
const USAGE_WINDOW_DAYS = 7;

const TASK_TYPE_LABELS: Record<string, string> = {
  GENERATE_SNAPSHOT: "生成阶段总结",
  REGENERATE_SNAPSHOT: "重新生成总结",
  UPDATE_LONG_TERM_MEMORY: "长期记忆更新",
  CLEAN_EXPIRED_MESSAGES: "清理过期消息",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  QUEUED: "等待执行",
  RUNNING: "运行中",
  SUCCEEDED: "执行成功",
  FAILED: "执行失败",
  SKIPPED: "已跳过",
  RETRY_WAIT: "等待重试",
  CANCELLED: "已取消",
};

const PENDING_STATUSES = new Set(["QUEUED", "RUNNING"]);
const FAILED_STATUSES = new Set(["FAILED", "RETRY_WAIT"]);

function eventTone(status: string): OverviewEvent["tone"] {
  if (status === "SUCCEEDED") return "ok";
  if (status === "FAILED") return "err";
  if (status === "QUEUED" || status === "RETRY_WAIT") return "wait";
  if (status === "RUNNING") return "run";
  return "mute";
}

/**
 * 月-日 时:分 的固定格式。用 en-CA 取 parts 而不是直接格式化字符串，
 * 避免中文 locale 在不同 ICU 版本下输出 "10月29日 08:00" / "10/29 08:00" 两种写法。
 */
function formatClock(value: Date, timeZone: string, withTime = true): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone }).formatToParts(value);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).formatToParts(value);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = (values.month ?? "--") + "-" + (values.day ?? "--");
  return withTime ? date + " " + (values.hour ?? "00") + ":" + (values.minute ?? "00") : date;
}

type MemorySettingRecord = {
  snapshotIntervalDays: number;
  timezone: string;
  nextSnapshotAt: Date | null;
  autoSnapshotEnabled: boolean;
} | null;

/**
 * 当前周期 = [下次归档时间 - 间隔天数, 下次归档时间)。
 * 没有计划或自动归档关闭时返回 null，页面据此不画进度条 —— 不猜，也不编。
 */
function resolveCycle(setting: MemorySettingRecord, now: Date): OverviewCycle | null {
  if (!setting || !setting.autoSnapshotEnabled || !setting.nextSnapshotAt) return null;
  const end = setting.nextSnapshotAt;
  const totalDays = Math.max(1, setting.snapshotIntervalDays);
  const start = new Date(end.getTime() - totalDays * DAY_MS);
  const elapsedDays = Math.floor((now.getTime() - start.getTime()) / DAY_MS) + 1;
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    dayIndex: Math.min(totalDays, Math.max(1, elapsedDays)),
    totalDays,
    missed: end.getTime() < now.getTime(),
  };
}

export default defineEventHandler(async (event): Promise<OverviewPayload> => {
  const actor = await requireActor(event);
  const ownerId = actor.user.id;
  const prisma = getPrisma();
  const now = new Date();

  const characters = await prisma.character.findMany({
    where: { ownerId },
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      avatar: true,
      status: true,
      modelConfig: true,
      memorySetting: {
        select: {
          snapshotIntervalDays: true,
          timezone: true,
          nextSnapshotAt: true,
          autoSnapshotEnabled: true,
        },
      },
      channelBindings: {
        where: { status: "ACTIVE" },
        select: { connection: { select: { displayName: true } } },
      },
      memoryScopes: {
        select: {
          id: true,
          memoryItems: { where: { status: "ACTIVE" }, select: { createdAt: true } },
          snapshots: {
            orderBy: [{ createdAt: "desc" }, { version: "desc" }],
            take: 1,
            select: { createdAt: true, version: true },
          },
        },
      },
    },
  });

  const jobScope = { memoryScope: { is: { character: { is: { ownerId } } } } };
  const characterIds = characters.map((character) => character.id);
  const usageDays = usageDayWindow(USAGE_WINDOW_DAYS, now);

  const [jobGroups, recentJobs, recentSnapshots, usageReports, watchdogFindings] = await Promise.all([
    prisma.memoryJob.groupBy({
      by: ["memoryScopeId", "status"],
      where: jobScope,
      _count: { _all: true },
    }),
    prisma.memoryJob.findMany({
      where: jobScope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 6,
      select: {
        id: true,
        type: true,
        status: true,
        lastError: true,
        createdAt: true,
        memoryScope: { select: { character: { select: { id: true, name: true } } } },
      },
    }),
    prisma.memorySnapshot.findMany({
      where: { memoryScope: { is: { character: { is: { ownerId } } } } },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      take: 5,
      select: {
        id: true,
        version: true,
        createdAt: true,
        periodStart: true,
        periodEnd: true,
        memoryScope: { select: { character: { select: { id: true, name: true } } } },
      },
    }),
    readUsageReport(characterIds, USAGE_WINDOW_DAYS, now),
    // 停滞检测是「附加信息」，不是总览的主体。它出任何问题（SQL 报错、字段类型变了）
    // 都不能把整页打挂 —— 少一行提醒，好过一个 500。失败只记日志，常驻脚本那边仍然会报。
    collectWatchdogFindings(prisma, now, ownerId).catch((error: unknown) => {
      console.error("[watchdog] 总览页判定失败：", error instanceof Error ? error.message : String(error));
      return [] as WatchdogFinding[];
    }),
  ]);

  // memoryScopeId → characterId，用于把任务计数摊回角色。
  const scopeOwner = new Map<string, string>();
  for (const character of characters) {
    for (const scope of character.memoryScopes) scopeOwner.set(scope.id, character.id);
  }

  const taskCountByCharacter = new Map<string, { pending: number; failed: number }>();
  for (const group of jobGroups) {
    const characterId = scopeOwner.get(group.memoryScopeId);
    if (!characterId) continue;
    const bucket = taskCountByCharacter.get(characterId) ?? { pending: 0, failed: 0 };
    const count = group._count._all;
    if (PENDING_STATUSES.has(group.status)) bucket.pending += count;
    if (FAILED_STATUSES.has(group.status)) bucket.failed += count;
    taskCountByCharacter.set(characterId, bucket);
  }

  // 每个角色各算一次周期消息数：周期起点取决于该角色自己的 nextSnapshotAt，无法用一次 groupBy 覆盖。
  const cycleMessageCounts = await Promise.all(
    characters.map(async (character) => {
      const cycle = resolveCycle(character.memorySetting, now);
      if (!cycle) return 0;
      return prisma.message.count({
        where: {
          conversation: { is: { characterId: character.id } },
          occurredAt: { gte: new Date(cycle.startISO) },
        },
      });
    }),
  );

  const overviewCharacters: OverviewCharacter[] = characters.map((character, index) => {
    const setting = character.memorySetting;
    const timeZone = setting?.timezone || "Asia/Shanghai";
    const cycle = resolveCycle(setting, now);
    const memoryItems = character.memoryScopes.flatMap((scope) => scope.memoryItems);
    const cycleMemories = cycle
      ? memoryItems.filter((item) => item.createdAt.getTime() >= new Date(cycle.startISO).getTime()).length
      : 0;
    const latestSnapshot = character.memoryScopes
      .flatMap((scope) => scope.snapshots)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const chatSettings = resolveChatModelSettings(character.modelConfig as Record<string, unknown>);
    const tasks = taskCountByCharacter.get(character.id) ?? { pending: 0, failed: 0 };

    return {
      id: character.id,
      name: character.name,
      avatar: character.avatar || character.name.slice(0, 1),
      avatarTone: resolveAvatarTone(character.name, (character.modelConfig ?? {}) as Record<string, unknown>),
      status: character.status === "ACTIVE" ? "运行中" : character.status === "PAUSED" ? "已暂停" : "未连接",
      channels: character.channelBindings.map((binding) => binding.connection.displayName),
      intervalDays: setting?.snapshotIntervalDays ?? 8,
      autoSnapshotEnabled: setting?.autoSnapshotEnabled ?? false,
      nextSnapshotAt: setting?.nextSnapshotAt?.toISOString() ?? null,
      nextSnapshotLabel: setting?.nextSnapshotAt
        ? formatClock(setting.nextSnapshotAt, timeZone)
        : setting && !setting.autoSnapshotEnabled
          ? "已暂停"
          : "尚未计划",
      latestSnapshotAt: latestSnapshot?.createdAt.toISOString() ?? null,
      latestSnapshotLabel: latestSnapshot ? formatClock(latestSnapshot.createdAt, timeZone, false) : "暂无总结",
      latestSnapshotVersion: latestSnapshot?.version ?? null,
      memoryCount: memoryItems.length,
      cycle,
      cycleMessageCount: cycleMessageCounts[index] ?? 0,
      cycleMemoryCount: cycleMemories,
      chatModel: chatSettings.model,
      chatApiKeyConfigured: chatSettings.apiKeyConfigured,
      failedTaskCount: tasks.failed,
      pendingTaskCount: tasks.pending,
    };
  });

  // 最近要归档的角色：决定「距下次归档」和「周期第几天」这两格看谁。
  const nextCharacter = overviewCharacters
    .filter((character) => character.cycle && character.nextSnapshotAt)
    .sort((a, b) => Date.parse(a.nextSnapshotAt!) - Date.parse(b.nextSnapshotAt!))[0];

  const pending = overviewCharacters.reduce((total, character) => total + character.pendingTaskCount, 0);
  const failed = overviewCharacters.reduce((total, character) => total + character.failedTaskCount, 0);
  const cycleMessageTotal = overviewCharacters.reduce((total, character) => total + character.cycleMessageCount, 0);

  const tasks: OverviewPayload["tasks"] = {
    pending,
    failed,
    items: recentJobs.map((job): OverviewTaskItem => ({
      id: job.id,
      type: job.type,
      status: job.status,
      typeLabel: TASK_TYPE_LABELS[job.type] ?? job.type,
      statusLabel: TASK_STATUS_LABELS[job.status] ?? job.status,
      characterId: job.memoryScope.character.id,
      characterName: job.memoryScope.character.name,
      lastError: job.lastError,
      createdAt: job.createdAt.toISOString(),
    })),
  };

  // 同一角色同一周期的重复事件（例如多次触发后失败重试留下同版本记录）只保留最近一条，
  // 否则事件流会被同类记录刷满。
  const mergedEvents = [
    ...recentJobs.map((job) => ({
      id: "job:" + job.id,
      kind: "task" as const,
      tone: eventTone(job.status),
      title: (TASK_TYPE_LABELS[job.type] ?? job.type) + " · " + (TASK_STATUS_LABELS[job.status] ?? job.status),
      meta: job.status === "FAILED" && job.lastError
        ? job.memoryScope.character.name + " · " + job.lastError.slice(0, 60)
        : job.memoryScope.character.name,
      atLabel: formatClock(job.createdAt, "Asia/Shanghai"),
      atISO: job.createdAt.toISOString(),
    })),
    ...recentSnapshots.map((snapshot) => ({
      id: "snapshot:" + snapshot.id,
      kind: "snapshot" as const,
      tone: "ok" as const,
      title: "阶段总结已生成 · v" + snapshot.version,
      meta: snapshot.memoryScope.character.name + " · " + formatClock(snapshot.periodStart, "Asia/Shanghai", false) + " — " + formatClock(snapshot.periodEnd, "Asia/Shanghai", false),
      atLabel: formatClock(snapshot.createdAt, "Asia/Shanghai"),
      atISO: snapshot.createdAt.toISOString(),
    })),
  ].sort((a, b) => Date.parse(b.atISO) - Date.parse(a.atISO));

  const seenEventKeys = new Set<string>();
  const events: OverviewEvent[] = [];
  for (const event of mergedEvents) {
    const key = event.kind + "|" + event.title + "|" + event.meta;
    if (seenEventKeys.has(key)) continue;
    seenEventKeys.add(key);
    events.push(event);
    if (events.length >= 8) break;
  }

  let admin: OverviewAdminPanel | null = null;
  if (actor.user.role === "ADMIN") {
    let database: "up" | "down" = "up";
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      database = "down";
    }

    const [globalJobGroups, connections, audits] = await Promise.all([
      prisma.memoryJob.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.platformConnection.findMany({ select: { status: true } }),
      prisma.auditLog.findMany({
        orderBy: [{ createdAt: "desc" }],
        take: 5,
        select: { id: true, action: true, entityType: true, createdAt: true },
      }),
    ]);

    const jobCount = (status: string) =>
      globalJobGroups.find((group) => group.status === status)?._count._all ?? 0;

    admin = {
      database,
      jobs: {
        queued: jobCount("QUEUED"),
        running: jobCount("RUNNING"),
        failed: jobCount("FAILED") + jobCount("RETRY_WAIT"),
        succeeded: jobCount("SUCCEEDED"),
      },
      channels: {
        total: connections.length,
        online: connections.filter((connection) => connection.status === "CONNECTED").length,
      },
      recentAudits: audits.map((audit) => ({
        id: audit.id,
        action: audit.action,
        entityType: audit.entityType,
        atLabel: formatClock(audit.createdAt, "Asia/Shanghai"),
      })),
    };
  }

  const latest = recentSnapshots[0];

  // readUsageReport 保证每个传入的角色都有一份报告（没用量的补零），这里直接取。
  // 只透出契约里的字段：prompt/completion 拆分属于内部记账细节，页面用不到。
  const toUsageDay = (day: {
    day: string;
    totalTokens: number;
    calls: number;
    costCny: number;
    unpricedTokens: number;
    cacheHitTokens: number;
    uncachedCalls: number;
  }) => ({
    day: day.day,
    totalTokens: day.totalTokens,
    calls: day.calls,
    costCny: day.costCny,
    unpricedTokens: day.unpricedTokens,
    cacheHitTokens: day.cacheHitTokens,
    uncachedCalls: day.uncachedCalls,
  });
  const usageCharacters = characterIds.map((characterId) => {
    const report = usageReports.get(characterId)!;
    return {
      characterId: report.characterId,
      days: report.days.map(toUsageDay),
      today: toUsageDay(report.today),
      windowTokens: report.windowTokens,
      windowCostCny: report.windowCostCny,
      unpricedModels: report.unpricedModels,
      uncachedCalls: report.uncachedCalls,
    };
  });

  const roundCny = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const usage: OverviewUsage = {
    day: usageDays[usageDays.length - 1] ?? "",
    days: usageDays,
    totalTokens: usageCharacters.reduce((sum, item) => sum + item.today.totalTokens, 0),
    costCny: roundCny(usageCharacters.reduce((sum, item) => sum + item.today.costCny, 0)),
    unpricedTokens: usageCharacters.reduce((sum, item) => sum + item.today.unpricedTokens, 0),
    unpricedModels: [...new Set(usageCharacters.flatMap((item) => item.unpricedModels))].sort(),
    cacheHitTokens: usageCharacters.reduce((sum, item) => sum + item.today.cacheHitTokens, 0),
    uncachedCalls: usageCharacters.reduce((sum, item) => sum + item.today.uncachedCalls, 0),
    characters: usageCharacters,
  };

  return {
    generatedAt: now.toISOString(),
    characters: overviewCharacters,
    usage,
    tasks,
    watchdog: {
      checkedAt: now.toISOString(),
      findings: watchdogFindings,
    },
    nextSnapshot: nextCharacter
      ? {
          characterId: nextCharacter.id,
          characterName: nextCharacter.name,
          atISO: nextCharacter.nextSnapshotAt!,
          atLabel: nextCharacter.nextSnapshotLabel,
          remainingMs: Date.parse(nextCharacter.nextSnapshotAt!) - now.getTime(),
        }
      : null,
    cycle: nextCharacter?.cycle
      ? {
          messageCount: cycleMessageTotal,
          dayIndex: nextCharacter.cycle.dayIndex,
          totalDays: nextCharacter.cycle.totalDays,
          endISOLabel: nextCharacter.nextSnapshotLabel,
        }
      : null,
    latestSnapshot: latest
      ? {
          id: latest.id,
          characterId: latest.memoryScope.character.id,
          characterName: latest.memoryScope.character.name,
          atISO: latest.createdAt.toISOString(),
          atLabel: formatClock(latest.createdAt, "Asia/Shanghai"),
          dateLabel: formatClock(latest.createdAt, "Asia/Shanghai", false),
          version: latest.version,
        }
      : null,
    events,
    admin,
  };
});
