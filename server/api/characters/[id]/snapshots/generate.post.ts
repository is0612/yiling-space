import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { INLINE_MEMORY_WORK_MS, waitBriefly } from "../../../../utils/background-run";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { processNextMemoryJob } from "../../../../utils/memory-worker";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 刚归档过就不再来一次。
 *
 * 这个按钮会让人连点（等不及，或者以为没点上）。第一版用 `[now - 间隔, now]` 算周期、
 * 幂等键里带毫秒级 now，结果每点一次都是新周期、新任务、新的一份总结 ——
 * 实测 46 秒内点两次，库里多出两份几乎完全重叠的总结。
 */
const COOLDOWN_MS = 60 * 60 * 1000;

function clock(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString().slice(5, 16).replace("T", " ");
  }
}

/**
 * 立即归档一次（手动触发「自动归档」）。
 *
 * 本地跑、没起常驻调度器时，周期任务永远不会自己来；这个按钮补的就是「现在就跑一次」。
 *
 * 四条必须守住的东西：
 * 1. **周期首尾相接**：起点取上一份自动归档的 `periodEnd`，不是 `now - 间隔`。
 *    否则每点一次都把最近 N 天重做一遍，两份结论互相打架。
 * 2. **一个范围一份**：该范围已有 `QUEUED / RUNNING / RETRY_WAIT` 的归档任务就复用它；
 *    刚归档过（冷却期内）什么都不做。
 * 3. **走队列，不直接调模型**：任务表是唯一执行入口，幂等键沿用调度器的
 *    `auto-snapshot:{scope}:{start}:{end}`；排完当场 `processNextMemoryJob`，不要求另开 worker。
 * 4. **只有全部成功才推进周期边界**：否则失败的那段会被永久跳过。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      ownerId: true,
      memorySetting: { select: { snapshotIntervalDays: true, timezone: true } },
      memoryScopes: { select: { id: true, scopeType: true, userId: true } },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const globalScopeId = character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id;
  if (!globalScopeId) {
    throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围，请先重新保存角色档案。" });
  }

  /**
   * 和调度器同一批范围：全局 + 主人私人。
   *
   * 群友私聊只进按天忆泡、不进阶段总结（边界写在 memory-system.md 里），
   * 所以这里不扩到 EXTERNAL_IDENTITY，避免「点一下突然多出别人的总结」。
   */
  const ownerPrivateScopeId = character.memoryScopes.find(
    (scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === character.ownerId,
  )?.id;
  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";

  // 周期上限按设置页的 1–8 收紧，库里可能还躺着历史更长的值。
  const intervalDays = Math.min(8, Math.max(1, character.memorySetting?.snapshotIntervalDays ?? 3));
  const now = new Date();

  const scopes = [
    { id: globalScopeId, label: "" },
    ...(ownerPrivateScopeId ? [{ id: ownerPrivateScopeId, label: "（主人私聊）" }] : []),
  ];

  const queued: string[] = [];
  const skipped: string[] = [];
  const targetIds: string[] = [];

  for (const scope of scopes) {
    const planned = await prisma.$transaction(async (tx) => {
      // 计划互斥：与手动版本、Worker 提交共用范围行的锁。两个请求各算一份周期时，
      // 幂等键里的 `now` 毫秒不同，`skipDuplicates` 挡不住重叠 —— 必须让排期本身串行。
      await tx.$queryRaw`SELECT id FROM "memory_scopes" WHERE id = ${scope.id}::uuid FOR UPDATE`;

      // ① 在途任务按周期最早的接着跑，不能因为「后面已有更新的总结」就作废它：
      //    中间那段没有归档过，作废等于永久跳过。只有该周期确实已被完整覆盖才作废。
      const active = await tx.memoryJob.findFirst({
        where: {
          memoryScopeId: scope.id,
          type: "GENERATE_SNAPSHOT",
          status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
        },
        orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }],
        select: { id: true, status: true, periodStart: true, periodEnd: true },
      });
      if (active?.periodStart && active.periodEnd) {
        const covered = await tx.memorySnapshot.findFirst({
          where: {
            memoryScopeId: scope.id,
            kind: "AUTOMATIC",
            periodStart: { lte: active.periodStart },
            periodEnd: { gte: active.periodEnd },
          },
          select: { id: true },
        });
        if (!covered) {
          // RETRY_WAIT 的手动触发要提到「现在」，否则用户点了按钮却什么都不发生。
          if (active.status !== "RUNNING") {
            await tx.memoryJob.updateMany({ where: { id: active.id, status: active.status }, data: { runAt: now } });
          }
          return { action: "reuse" as const, id: active.id };
        }
        if (active.status === "RUNNING") {
          return { action: "skip" as const, message: `该周期已有归档覆盖，正在运行的任务不会重复排队${scope.label}` };
        }
        await tx.memoryJob.updateMany({
          where: { id: active.id, status: active.status },
          data: {
            status: "CANCELLED",
            completedAt: now,
            lastError: `该周期（${clock(active.periodStart, timeZone)} 起）已有归档覆盖，本次任务作废。`,
          },
        });
      }

      // ② 周期起点 = 上一份自动归档的结束点，首尾相接。
      const latest = await tx.memorySnapshot.findFirst({
        where: { memoryScopeId: scope.id, kind: "AUTOMATIC" },
        orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
        select: { periodEnd: true },
      });
      const periodStart = latest?.periodEnd ?? new Date(now.getTime() - intervalDays * DAY_MS);
      const periodEnd = now;

      if (periodStart.getTime() >= periodEnd.getTime()) {
        return { action: "skip" as const, message: `当前周期还没走到可归档的时间${scope.label}` };
      }

      // ③ 冷却：刚归档过就别再花一次模型钱。
      if (now.getTime() - periodStart.getTime() < COOLDOWN_MS) {
        return { action: "skip" as const, message: `刚在 ${clock(periodStart, timeZone)} 归档过，没有重复调用模型${scope.label}` };
      }

      const hasMessages = await tx.message.findFirst({
        where: {
          conversation: { is: { memoryScopeId: scope.id } },
          occurredAt: { gte: periodStart, lt: periodEnd },
        },
        select: { id: true },
      });
      if (!hasMessages) {
        return { action: "skip" as const, message: `${clock(periodStart, timeZone)} 之后没有对话${scope.label}` };
      }

      const key = `auto-snapshot:${scope.id}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;
      await tx.memoryJob.createMany({
        data: [{
          memoryScopeId: scope.id,
          type: "GENERATE_SNAPSHOT",
          idempotencyKey: key,
          periodStart,
          periodEnd,
          status: "QUEUED",
          runAt: now,
          maxAttempts: 3,
        }],
        skipDuplicates: true,
      });
      // 认回这一条（可能是本次新建的，也可能是同周期的旧任务）：只认它，不认别人的。
      const created = await tx.memoryJob.findFirst({
        where: { memoryScopeId: scope.id, type: "GENERATE_SNAPSHOT", idempotencyKey: key },
        select: { id: true },
      });
      if (!created) return { action: "skip" as const, message: `归档任务排队失败${scope.label}` };
      return { action: "queued" as const, id: created.id, message: `归档 ${clock(periodStart, timeZone)} 之后的对话${scope.label}` };
    });

    if (planned.action === "skip") {
      skipped.push(planned.message);
      continue;
    }
    queued.push(planned.action === "reuse" ? `接着跑上次没完成的归档${scope.label}` : planned.message);
    targetIds.push(planned.id);
  }

  if (targetIds.length === 0) {
    return { queued, skipped, jobIds: [], processed: [], pending: 0, advancedTo: null, intervalDays, processing: false };
  }

  /**
   * 「这一次归档」的完整动作：执行目标任务，然后决定要不要推进周期边界。
   *
   * 两件事必须在同一个后台任务里：推进边界的前提是**全部成功**，如果响应先回去、
   * 执行留在后台，边界推进也得跟着留在后台，否则那段周期下次会被重新跑一遍。
   */
  const execution = (async () => {
    const done: Array<{ status: string; message: string }> = [];
    // 只执行本次的目标任务：不传 jobId 时 worker 取的是「队列里下一条」，
    // 同角色还排着忆泡/清理任务，会把别人的结果混进本次报告。
    for (const jobId of targetIds) {
      const result = await processNextMemoryJob(prisma, { ownerId, jobId });
      if (result.processed) done.push({ status: result.status, message: result.message });
    }

    const targets = await prisma.memoryJob.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, status: true, snapshotId: true },
    });
    // 仍在队列或运行中的都算未完成，不能因为另一条成功就推进计划。
    const pending = targets.filter((job) => job.status === "QUEUED" || job.status === "RUNNING" || job.status === "RETRY_WAIT");

    /**
     * 计划边界按**实际归档到的结束时间**推进，不用请求的 `now + 间隔`。
     *
     * 复用一条旧的 RETRY_WAIT 任务时，它只覆盖到 `periodEnd` 那一天；若拿 now 推进，
     * 中间 `[periodEnd, now)` 会被下一轮反推时永久跳过。以最新自动归档的 periodEnd
     * 为准，剩下的缺口下一次点击（或调度器）会从那里接着补。
     */
    const globalArchived = await prisma.memorySnapshot.findFirst({
      where: { memoryScopeId: globalScopeId, kind: "AUTOMATIC" },
      orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
      select: { periodEnd: true },
    });
    const allSucceeded = pending.length === 0 && done.length > 0
      && done.every((item) => item.status === "SUCCEEDED" || item.status === "SKIPPED");
    const desired = allSucceeded && globalArchived
      ? new Date(globalArchived.periodEnd.getTime() + intervalDays * DAY_MS)
      : null;

    let advancedTo: Date | null = null;
    if (desired) {
      // 只向前推进，并且用 CAS 避免和服务端调度器互相覆盖。
      const current = await prisma.characterMemorySetting.findUnique({
        where: { characterId },
        select: { nextSnapshotAt: true },
      });
      if (current && (!current.nextSnapshotAt || current.nextSnapshotAt.getTime() < desired.getTime())) {
        const updated = await prisma.characterMemorySetting.updateMany({
          where: { characterId, nextSnapshotAt: current.nextSnapshotAt },
          data: { nextSnapshotAt: desired },
        });
        if (updated.count === 1) advancedTo = desired;
      }
    }
    return { processed: done, pending: pending.length, advancedTo };
  })();

  /**
   * 只等一小会儿（见 `background-run.ts`）：归档是一次整段模型调用，几十秒很常见。
   * 超过窗口就先把「已经排了什么」回给页面，执行留在后台跑完 —— 切页面不会中断，
   * 进度看右下角那块面板（它读的是任务行，不是这个请求）。
   */
  const waited = await waitBriefly(execution, INLINE_MEMORY_WORK_MS);
  if (waited.timedOut) {
    void execution.catch(() => undefined);
    return {
      queued,
      skipped,
      jobIds: targetIds,
      processed: [],
      pending: targetIds.length,
      advancedTo: null,
      intervalDays,
      processing: true,
    };
  }
  if ("failed" in waited) throw waited.error;

  return {
    queued,
    skipped,
    jobIds: targetIds,
    processed: waited.value.processed,
    pending: waited.value.pending,
    advancedTo: waited.value.advancedTo ? waited.value.advancedTo.toISOString() : null,
    intervalDays,
    processing: false,
  };
});
