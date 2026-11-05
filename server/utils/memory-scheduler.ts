import type { PrismaClient } from "../../src/generated/prisma/client";
import { localDayHour, resolveDailyEventWindow, resolveDayWindow } from "./memory-event-time";
import { listFriendScopesWithActivity } from "./friends";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PERIODS_PER_SETTING = 24;
const MAX_EVENT_BACKFILL_DAYS_PER_SCOPE = 24;

export type DueMemoryPeriod = {
  periodStart: Date;
  periodEnd: Date;
  idempotencyKey: string;
};

export function buildDueMemoryPeriods(input: {
  memoryScopeId: string;
  nextSnapshotAt: Date | null;
  intervalDays: number;
  now: Date;
  pendingIntervalDays?: number | null;
  maxPeriods?: number;
}): { periods: DueMemoryPeriod[]; nextSnapshotAt: Date | null; stillDue: boolean } {
  const { memoryScopeId, nextSnapshotAt, intervalDays, now } = input;
  const pendingIntervalDays = input.pendingIntervalDays ?? null;
  const maxPeriods = input.maxPeriods ?? DEFAULT_MAX_PERIODS_PER_SETTING;
  if (
    !nextSnapshotAt ||
    !Number.isFinite(nextSnapshotAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(intervalDays) ||
    intervalDays < 1 ||
    intervalDays > 365 ||
    (pendingIntervalDays !== null && (!Number.isInteger(pendingIntervalDays) || pendingIntervalDays < 1 || pendingIntervalDays > 365)) ||
    !Number.isInteger(maxPeriods) ||
    maxPeriods < 1 ||
    nextSnapshotAt.getTime() > now.getTime()
  ) {
    return { periods: [], nextSnapshotAt, stillDue: false };
  }

  const periods: DueMemoryPeriod[] = [];
  let periodEnd = new Date(nextSnapshotAt);
  let intervalForCurrentPeriod = intervalDays;
  let pendingIntervalAppliesAfterCurrentPeriod = pendingIntervalDays !== null;

  while (periodEnd.getTime() <= now.getTime() && periods.length < maxPeriods) {
    const intervalMs = intervalForCurrentPeriod * DAY_MS;
    const periodStart = new Date(periodEnd.getTime() - intervalMs);
    periods.push({
      periodStart,
      periodEnd: new Date(periodEnd),
      idempotencyKey: `auto-snapshot:${memoryScopeId}:${periodStart.toISOString()}:${periodEnd.toISOString()}`,
    });

    // The in-flight period uses the active interval. The pending interval applies
    // to the period that starts at this boundary and all subsequent periods.
    const intervalForNextPeriod = pendingIntervalAppliesAfterCurrentPeriod
      ? pendingIntervalDays!
      : intervalForCurrentPeriod;
    periodEnd = new Date(periodEnd.getTime() + intervalForNextPeriod * DAY_MS);
    intervalForCurrentPeriod = intervalForNextPeriod;
    pendingIntervalAppliesAfterCurrentPeriod = false;
  }

  return {
    periods,
    nextSnapshotAt: periodEnd,
    stillDue: periodEnd.getTime() <= now.getTime(),
  };
}

export type MemorySchedulerReport = {
  settingsChecked: number;
  settingsEnabled: number;
  settingsDisabled: number;
  settingsWithoutNextSnapshotAt: number;
  settingsNotDue: number;
  settingsInitialized: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * 从渠道绑定里读「主人 QQ」。
 *
 * QQ 连接把主人账号写在 `metadata.ownerQq`（适配器据此判断 `speaker.isOwner`）。
 * 调度器与手动整理都要用它把主人自己的 `EXTERNAL_IDENTITY` 范围排除掉，
 * 所以抽出来，避免两处各写一套、以后只改了一边。
 */
export function collectOwnerQqs(
  bindings: ReadonlyArray<{ connection: { metadata: unknown } | null }>,
): Set<string> {
  const ownerQqs = new Set<string>();
  for (const binding of bindings) {
    const metadata = binding.connection?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const ownerQq = (metadata as Record<string, unknown>).ownerQq;
    if (typeof ownerQq === "string" && ownerQq.trim()) ownerQqs.add(ownerQq.trim());
    // 老数据可能把 QQ 号存成数字；按字符串归一，别因为类型不同漏掉主人范围。
    else if (typeof ownerQq === "number" && Number.isFinite(ownerQq)) ownerQqs.add(String(ownerQq));
  }
  return ownerQqs;
}

/**
 * 这个外部身份范围是不是主人自己的 QQ。
 *
 * 主人的私聊应该挂在 `USER_PRIVATE`；但功能上线前建的老会话还在该 QQ 的
 * `EXTERNAL_IDENTITY` 范围内。那段历史也会在主人下次开口时归位，但调度器不能把它
 * 当「别人的私聊」提前排忆泡 —— 写进 EXTERNAL 的事件主人聊天时读不到（他读的是
 * 全局 + USER_PRIVATE），等会话归位后又会在新范围重复提一遍。
 *
 * `scopeKey` 形如 `character:<id>:external:qq-onebot:<QQ号>`，按结尾匹配账号。
 */
export function isOwnerPrivateScopeKey(scopeKey: string, ownerQqs: Iterable<string>): boolean {
  for (const qq of ownerQqs) {
    if (qq && scopeKey.endsWith(`:qq-onebot:${qq}`)) return true;
  }
  return false;
}

export async function enqueueDueMemorySnapshots(
  prisma: PrismaClient,
  options: { now?: Date; ownerId?: string; maxPeriodsPerSetting?: number } = {},
): Promise<MemorySchedulerReport> {
  const now = options.now ?? new Date();
  const settings = await prisma.characterMemorySetting.findMany({
    where: {
      ...(options.ownerId ? { character: { is: { ownerId: options.ownerId } } } : {}),
    },
    select: {
      characterId: true,
      snapshotIntervalDays: true,
      pendingSnapshotIntervalDays: true,
      anchorAt: true,
      nextSnapshotAt: true,
      autoSnapshotEnabled: true,
      timezone: true,
      rawMessageRetentionDays: true,
      rawMessageCleanupEnabled: true,
      character: {
        select: {
          ownerId: true,
          memoryScopes: {
            select: { id: true, scopeType: true, userId: true },
          },
          // 主人 QQ 来自连接设置（metadata.ownerQq）：主人自己的私聊范围不能再当「别人的私聊」排忆泡。
          channelBindings: {
            select: { connection: { select: { platform: true, metadata: true } } },
          },
        },
      },
    },
  });

  const report: MemorySchedulerReport = {
    settingsChecked: settings.length,
    settingsEnabled: settings.filter((setting) => setting.autoSnapshotEnabled).length,
    settingsDisabled: settings.filter((setting) => !setting.autoSnapshotEnabled).length,
    settingsWithoutNextSnapshotAt: settings.filter((setting) => setting.autoSnapshotEnabled && !setting.nextSnapshotAt).length,
    settingsNotDue: 0,
    settingsInitialized: 0,
    settingsAdvanced: 0,
    jobsQueued: 0,
    periodsConsidered: 0,
    missingGlobalScope: 0,
    settingsStillDue: 0,
  };

  for (const setting of settings) {
    const globalScopeId = setting.character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id;

    // Queue retention cleanup independently from automatic snapshot generation.
    // Do not queue a cleanup while an older snapshot period is still pending.
    const retentionDays = setting.rawMessageRetentionDays;
    const cutoff = setting.rawMessageCleanupEnabled && retentionDays && retentionDays > 0
      ? addDays(now, -retentionDays)
      : null;
    const firstSnapshotBoundary = setting.nextSnapshotAt ?? addDays(setting.anchorAt, setting.snapshotIntervalDays);
    const hasUnqueuedExpiredSnapshotPeriods = Boolean(
      setting.autoSnapshotEnabled &&
      cutoff &&
      firstSnapshotBoundary.getTime() <= now.getTime() &&
      firstSnapshotBoundary.getTime() - setting.snapshotIntervalDays * DAY_MS < cutoff.getTime()
    );
    if (cutoff && !hasUnqueuedExpiredSnapshotPeriods) {
      for (const scope of setting.character.memoryScopes) {
        const pendingSnapshot = await prisma.memoryJob.findFirst({
          where: {
            memoryScopeId: scope.id,
            type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] },
            status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
            periodStart: { lt: cutoff },
          },
          select: { id: true },
        });
        if (pendingSnapshot) continue;
        const cutoffKey = cutoff.toISOString().slice(0, 10);
        await prisma.memoryJob.createMany({
          data: [{
            memoryScopeId: scope.id,
            type: "CLEAN_EXPIRED_MESSAGES",
            idempotencyKey: `clean-expired-messages:${scope.id}:${cutoffKey}`,
            periodEnd: cutoff,
            status: "QUEUED",
            runAt: now,
          }],
          skipDuplicates: true,
        });
      }
    }

    /**
     * 阶段总结开关只管阶段总结。
     *
     * 以前这里是 `if (!setting.autoSnapshotEnabled) continue;`，结果关掉「自动生成阶段总结」
     * 会把忆泡、日记、手账一起停掉 —— 三者取材相同，但不是同一件事。现在只把快照与
     * 忆泡挂在这个开关上，日记/手账按自己的条件排（2026-11-01 P1-1）。
     */
    const snapshotEnabled = setting.autoSnapshotEnabled;
    if (!globalScopeId) {
      report.missingGlobalScope += 1;
      continue;
    }
    const memoryScopeId = globalScopeId;

    // 主人专属私人范围：角色 owner 的 USER_PRIVATE scope。主人的私聊会话挂在这里，
    // 需要和全局一起排快照 —— 否则「角色记得主人」这一环只有写入、没有提炼。
    // 周期边界跟随全局（同一个 anchor/interval），只是 job 挂在 owner scope 上；
    // 该周期内没有主人私聊时 worker 会按既有逻辑 SKIPPED，不产生空总结。
    const ownerPrivateScopeId = setting.character.ownerId
      ? setting.character.memoryScopes.find((scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === setting.character.ownerId)?.id
      : null;

    // 忆泡按天整理：和 8 天快照周期解耦 —— 昨天的对话第二天就该查得到，
    // 不能等下一个周期。幂等键带日期，一天只排一次；当天没有对话就不排。
    // 自动记忆总开关关掉时，忆泡也不偷偷跑 —— 一次模型调用也是钱，不能绕过用户的选择。
    if (snapshotEnabled) {
      /**
       * 范围 = 全局 + 主人私人 + **每个有私聊的外部身份范围**。
       *
       * 群友私聊也是她这一天的记忆：以前只排全局和主人，别人的私聊虽然落了库却
       * 永远不进忆泡。这里只挑「确实有 `c:` 私聊会话」的范围，群聊不会因为挂在
       * 某个旧的外部身份范围下而被顺带整理。
       *
       * **主人自己的 QQ 范围除外**：老会话还挂在 EXTERNAL 时，写进去的事件主人
       * 聊天时读不到；它会由 `pipeline` 在主人下次开口时归位到 USER_PRIVATE。
       */
      const ownerQqs = collectOwnerQqs(setting.character.channelBindings);
      const externalPrivateScopes = (await prisma.memoryScope.findMany({
        where: {
          characterId: setting.characterId,
          scopeType: "EXTERNAL_IDENTITY",
          conversations: { some: { externalConversationId: { startsWith: "c:" } } },
        },
        select: { id: true, scopeKey: true },
      })).filter((scope) => !isOwnerPrivateScopeKey(scope.scopeKey, ownerQqs));
      const eventScopes = [
        { id: globalScopeId, privateOnly: false },
        ...(ownerPrivateScopeId ? [{ id: ownerPrivateScopeId, privateOnly: false }] : []),
        ...externalPrivateScopes.map((scope) => ({ id: scope.id, privateOnly: true })),
      ];

      const timeZone = setting.timezone || "Asia/Shanghai";
      const { dayKey: todayKey, hour } = localDayHour(now, timeZone);
      const todayWindow = resolveDayWindow(todayKey, timeZone);
      const recentCutoff = new Date(now.getTime() - 60 * 60_000);

      for (const scope of eventScopes) {
        // 外部身份范围可能还挂着历史群会话，只看私聊会话，别让群消息触发私聊忆泡。
        const conversationFilter = scope.privateOnly
          ? { externalConversationId: { startsWith: "c:" } }
          : {};
        // 增量：最近一小时有新消息才排，幂等键带小时 —— 同一天可以长很多次。
        const recent = await prisma.message.findFirst({
          where: {
            conversation: { is: { memoryScopeId: scope.id, ...conversationFilter } },
            occurredAt: { gte: recentCutoff, lt: now },
          },
          select: { id: true },
        });
        if (recent) {
          const created = await prisma.memoryJob.createMany({
            data: [{
              memoryScopeId: scope.id,
              type: "EXTRACT_EVENTS" as const,
              idempotencyKey: `events-hour:${scope.id}:${todayKey}:${hour}`,
              periodStart: todayWindow.start,
              periodEnd: todayWindow.end,
              status: "QUEUED" as const,
              runAt: now,
            }],
            skipDuplicates: true,
          });
          report.jobsQueued += created.count;
        }

        // 收口 + 停机补排：只找有原文、未 FINAL、也从未排过收口任务的历史日期。
        // 必须先排除已有任务再 LIMIT；否则最老的 24 天一直占着窗口，后面的日期永远排不到。
        // 已持久化的任务就是进度（不按状态过滤）：FAILED/CANCELLED 交给人工重试，
        // 不能用新键偷偷重排。无需另设游标，重启后也能继续，迟到的旧消息也不会漏扫。
        // SQL 只返回日期、不读消息正文；参数化 scope + character 双重隔离，外部身份只取 c:。
        const missingDays = await prisma.$queryRaw<Array<{ dayKey: string }>>`
          WITH message_days AS (
            SELECT DISTINCT to_char(m."occurredAt" AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS "dayKey"
            FROM "messages" m
            JOIN "conversations" c ON c.id = m."conversationId"
            WHERE c."memoryScopeId" = ${scope.id}::uuid
              AND c."characterId" = ${setting.characterId}::uuid
              AND (${scope.privateOnly}::boolean = false OR c."externalConversationId" LIKE 'c:%')
              AND m."occurredAt" < ${todayWindow.start}
          )
          SELECT d."dayKey" FROM message_days d
          WHERE NOT EXISTS (
            SELECT 1 FROM "memory_event_days" e
            WHERE e."memoryScopeId" = ${scope.id}::uuid
              AND e."dayKey" = d."dayKey" AND e.state = 'FINAL'
          ) AND NOT EXISTS (
            SELECT 1 FROM "memory_jobs" j
            WHERE j."memoryScopeId" = ${scope.id}::uuid AND j.type = 'EXTRACT_EVENTS'
              AND j."idempotencyKey" IN (
                'events-final:' || ${scope.id} || ':' || d."dayKey",
                'daily-events:' || ${scope.id} || ':' || d."dayKey"
              )
          )
          ORDER BY d."dayKey" ASC
          LIMIT ${MAX_EVENT_BACKFILL_DAYS_PER_SCOPE}
        `;
        if (missingDays.length === 0) continue;
        const finalized = await prisma.memoryJob.createMany({
          data: missingDays.map(({ dayKey }) => {
            const window = resolveDayWindow(dayKey, timeZone);
            return {
              memoryScopeId: scope.id,
              type: "EXTRACT_EVENTS" as const,
              idempotencyKey: `events-final:${scope.id}:${dayKey}`,
              periodStart: window.start,
              periodEnd: window.end,
              status: "QUEUED" as const,
              runAt: now,
            };
          }),
          // Unique idempotencyKey also protects concurrent scheduler rounds.
          skipDuplicates: true,
        });
        report.jobsQueued += finalized.count;
      }

    }

    /**
     * 日记 / 手账：每天一套，挂在角色全局范围下。
     *
     * 两处修正（2026-11-01）：
     * - P1-1：与阶段总结解耦。关掉「自动生成阶段总结」只停快照和忆泡，日记/手账照排。
     * - P1-2：不能只看日期主体在不在。`character_journals` 是「这一天」的主体，
     *   DIARY 与 HANDBOOK 是两份独立文本；只有其中一份时，另一份必须还能补齐。
     *   幂等键按「缺哪几种」区分，所以补齐会生成一个新任务，而不会撞上旧键被跳过。
     *   `SKIPPED` 同样不等于永久完成：那次判断之后如果又有新对话，允许重新评估一次。
     */
    const journalScopeIds = [globalScopeId, ownerPrivateScopeId].filter((id): id is string => Boolean(id));
    if (journalScopeIds.length > 0) {
      const journalTimeZone = setting.timezone || "Asia/Shanghai";
      const journalWindow = resolveDailyEventWindow(now, journalTimeZone);
      const [hasJournalMessage, hasJournalEvent, existingJournal] = await Promise.all([
        prisma.message.findFirst({
          where: {
            conversation: { is: { memoryScopeId: { in: journalScopeIds } } },
            occurredAt: { gte: journalWindow.start, lt: journalWindow.end },
          },
          select: { id: true },
        }),
        prisma.memoryEvent.findFirst({
          where: {
            memoryScopeId: { in: journalScopeIds },
            dayKey: journalWindow.dayKey,
            status: "ACTIVE",
          },
          select: { id: true },
        }),
        prisma.characterJournal.findUnique({
          where: { memoryScopeId_dayKey: { memoryScopeId: globalScopeId, dayKey: journalWindow.dayKey } },
          select: {
            updatedAt: true,
            diaryState: true,
            handbookState: true,
            diaryDecidedAt: true,
            handbookDecidedAt: true,
            revisions: { select: { kind: true } },
          },
        }),
      ]);
      const hasJournalSource = Boolean(hasJournalMessage || hasJournalEvent);
      const generatedKinds = new Set((existingJournal?.revisions ?? []).map((revision) => revision.kind));
      const missingKinds: Array<"DIARY" | "HANDBOOK"> = (["DIARY", "HANDBOOK"] as const)
        .filter((kind) => !generatedKinds.has(kind));

      /**
       * 缺一份不代表马上重跑模型：
       * - 没评估过（PENDING）→ 补；
       * - 评估过但 SKIPPED → 只有决定时间之后又来了新对话才补；
       * - 已有正文 / 已人工编辑 → 不在 missingKinds 里，不会被覆盖。
       */
      const eligibleKinds: Array<"DIARY" | "HANDBOOK"> = [];
      let retryDecidedAt: Date | null = null;
      if (hasJournalSource) {
        for (const kind of missingKinds) {
          if (!existingJournal) {
            eligibleKinds.push(kind);
            continue;
          }
          const state = kind === "DIARY" ? existingJournal.diaryState : existingJournal.handbookState;
          if (state !== "SKIPPED") {
            eligibleKinds.push(kind);
            continue;
          }
          const decidedAt = kind === "DIARY"
            ? existingJournal.diaryDecidedAt ?? existingJournal.updatedAt
            : existingJournal.handbookDecidedAt ?? existingJournal.updatedAt;
          const [hasNewMessage, hasNewEvent] = await Promise.all([
            prisma.message.findFirst({
              where: {
                conversation: { is: { memoryScopeId: { in: journalScopeIds } } },
                occurredAt: { gt: decidedAt, lt: journalWindow.end },
              },
              select: { id: true },
            }),
            prisma.memoryEvent.findFirst({
              where: {
                memoryScopeId: { in: journalScopeIds },
                dayKey: journalWindow.dayKey,
                status: "ACTIVE",
                occurredAt: { gt: decidedAt, lt: journalWindow.end },
              },
              select: { id: true },
            }),
          ]);
          if (!hasNewMessage && !hasNewEvent) continue;
          eligibleKinds.push(kind);
          if (!retryDecidedAt || decidedAt.getTime() > retryDecidedAt.getTime()) retryDecidedAt = decidedAt;
        }
      }

      if (eligibleKinds.length > 0) {
        const target: "BOTH" | "DIARY" | "HANDBOOK" = eligibleKinds.length === 2 ? "BOTH" : eligibleKinds[0]!;
        const suffix = target === "BOTH" ? "" : `:${target}`;
        const retrySuffix = retryDecidedAt ? `:retry-${retryDecidedAt.getTime()}` : "";
        const journalJob = await prisma.memoryJob.createMany({
          data: [{
            memoryScopeId: globalScopeId,
            type: "GENERATE_JOURNAL" as const,
            idempotencyKey: `journal:${globalScopeId}:${journalWindow.dayKey}${suffix}${retrySuffix}`,
            journalDayKey: journalWindow.dayKey,
            journalTarget: target,
            periodStart: journalWindow.start,
            periodEnd: journalWindow.end,
            status: "QUEUED" as const,
            runAt: now,
            // 模型没配 / 额度用完的情况会退避重试；默认 3 次会在半小时内耗光，
            // 第二天配置好也补不回来。给到 24 次（配合 30 分钟退避约 12 小时）。
            maxAttempts: 24,
          }],
          skipDuplicates: true,
        });
        report.jobsQueued += journalJob.count;
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const latest = await tx.characterMemorySetting.findUnique({
          where: { characterId: setting.characterId },
          select: {
            characterId: true,
            snapshotIntervalDays: true,
            pendingSnapshotIntervalDays: true,
            anchorAt: true,
            nextSnapshotAt: true,
            autoSnapshotEnabled: true,
          },
        });
        if (!latest?.autoSnapshotEnabled) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false, periods: [] };
        }

        // Repair an enabled setting missing its next boundary from the saved anchor.
        const firstBoundary = latest.nextSnapshotAt ?? addDays(latest.anchorAt, latest.snapshotIntervalDays);
        if (firstBoundary.getTime() > now.getTime()) {
          if (!latest.nextSnapshotAt) {
            const init = await tx.characterMemorySetting.updateMany({
              where: {
                characterId: latest.characterId,
                autoSnapshotEnabled: true,
                nextSnapshotAt: null,
                anchorAt: latest.anchorAt,
                snapshotIntervalDays: latest.snapshotIntervalDays,
                pendingSnapshotIntervalDays: latest.pendingSnapshotIntervalDays,
              },
              data: { nextSnapshotAt: firstBoundary },
            });
            if (init.count === 1) {
              return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: true, notDue: true, stillDue: false, periods: [] };
            }
          }
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: true, stillDue: false, periods: [] };
        }

        const built = buildDueMemoryPeriods({
          memoryScopeId,
          nextSnapshotAt: firstBoundary,
          intervalDays: latest.snapshotIntervalDays,
          pendingIntervalDays: latest.pendingSnapshotIntervalDays,
          now,
          maxPeriods: options.maxPeriodsPerSetting,
        });
        if (built.periods.length === 0 || !built.nextSnapshotAt) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false, periods: [] };
        }

        const createResult = await tx.memoryJob.createMany({
          data: built.periods.map((period) => ({
            memoryScopeId,
            type: "GENERATE_SNAPSHOT" as const,
            idempotencyKey: period.idempotencyKey,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            status: "QUEUED" as const,
            runAt: now,
          })),
          skipDuplicates: true,
        });

        /**
         * 主人私聊与朋友范围必须和周期游标在**同一个事务**里入队。
         *
         * 以前它们在事务提交之后才补排：只要进程在「游标已推进」和「补排」之间退出，
         * 下一轮就会从新游标反推周期，这些范围的那段时间永久没有任务，也不会自动追补。
         */
        const companionPeriods = built.periods;
        const ownerPeriods = ownerPrivateScopeId
          ? companionPeriods.map((period) => ({
              memoryScopeId: ownerPrivateScopeId,
              type: "GENERATE_SNAPSHOT" as const,
              idempotencyKey: `auto-snapshot:${ownerPrivateScopeId}:${period.periodStart.toISOString()}:${period.periodEnd.toISOString()}`,
              periodStart: period.periodStart,
              periodEnd: period.periodEnd,
              status: "QUEUED" as const,
              runAt: now,
            }))
          : [];
        const ownerResult = ownerPeriods.length
          ? await tx.memoryJob.createMany({ data: ownerPeriods, skipDuplicates: true })
          : { count: 0 };

        // 只排本周期有会话的朋友范围（见 `listFriendScopesWithActivity`），并且有数量上限。
        const first = companionPeriods[0]!;
        const last = companionPeriods[companionPeriods.length - 1]!;
        const friendScopeIds = await listFriendScopesWithActivity({
          characterId: setting.characterId,
          since: first.periodStart,
          until: last.periodEnd,
          client: tx,
        });
        const friendPeriods = friendScopeIds.flatMap((scopeId) => companionPeriods.map((period) => ({
          memoryScopeId: scopeId,
          type: "GENERATE_SNAPSHOT" as const,
          idempotencyKey: `auto-snapshot:${scopeId}:${period.periodStart.toISOString()}:${period.periodEnd.toISOString()}`,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          status: "QUEUED" as const,
          runAt: now,
        })));
        const friendResult = friendPeriods.length
          ? await tx.memoryJob.createMany({ data: friendPeriods, skipDuplicates: true })
          : { count: 0 };

        // 比较并设置：并发调度时只允许一个执行者推进周期游标。
        const updateResult = await tx.characterMemorySetting.updateMany({
          where: {
            characterId: latest.characterId,
            autoSnapshotEnabled: true,
            nextSnapshotAt: latest.nextSnapshotAt,
            snapshotIntervalDays: latest.snapshotIntervalDays,
            pendingSnapshotIntervalDays: latest.pendingSnapshotIntervalDays,
          },
          data: {
            nextSnapshotAt: built.nextSnapshotAt,
            ...(latest.pendingSnapshotIntervalDays !== null
              ? { snapshotIntervalDays: latest.pendingSnapshotIntervalDays, pendingSnapshotIntervalDays: null }
              : {}),
          },
        });
        if (updateResult.count !== 1) {
          throw new Error("MEMORY_SCHEDULER_RACE");
        }

        return {
          jobsQueued: createResult.count + ownerResult.count + friendResult.count,
          periodsConsidered: built.periods.length,
          advanced: true,
          initialized: latest.nextSnapshotAt === null,
          notDue: false,
          stillDue: built.stillDue,
          periods: built.periods,
        };
      });

      report.jobsQueued += result.jobsQueued;
      report.periodsConsidered += result.periodsConsidered;
      if (result.advanced) report.settingsAdvanced += 1;
      if (result.initialized) report.settingsInitialized += 1;
      if (result.notDue) report.settingsNotDue += 1;
      if (result.stillDue) report.settingsStillDue += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_SCHEDULER_RACE") continue;
      throw error;
    }
  }

  return report;
}
