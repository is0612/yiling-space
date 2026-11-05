import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
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
  const keys: string[] = [];
  const reusedIds: string[] = [];

  for (const scope of scopes) {
    // ① 已有在途任务：直接用它，不再新建。RETRY_WAIT 的任务手动触发时提到「现在」，
    //    否则用户点了按钮却什么都不发生（runAt 可能还在半小时后）。
    const active = await prisma.memoryJob.findFirst({
      where: {
        memoryScopeId: scope.id,
        type: "GENERATE_SNAPSHOT",
        status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, periodEnd: true },
    });
    if (active) {
      /**
       * 在途任务可能已经过时：上一版按 `[now-间隔, now]` 建的任务，如果之后已经有一份
       * 覆盖到更晚时间的成功总结，再把它跑完只会多出一份重复总结。这种直接作废，
       * 走下面正常的周期计算。
       */
      const newer = active.periodEnd
        ? await prisma.memorySnapshot.findFirst({
            where: { memoryScopeId: scope.id, kind: "AUTOMATIC", periodEnd: { gte: active.periodEnd } },
            select: { id: true },
          })
        : null;
      if (!active.periodEnd || newer) {
        if (active.status !== "RUNNING") {
          await prisma.memoryJob.update({
            where: { id: active.id },
            data: {
              status: "CANCELLED",
              completedAt: now,
              lastError: "该周期已有更晚的成功总结，本次任务作废。",
            },
          });
        }
        skipped.push(`有一条过时的归档任务已作废${scope.label}`);
      } else {
        if (active.status !== "RUNNING") {
          await prisma.memoryJob.update({ where: { id: active.id }, data: { runAt: now } });
        }
        reusedIds.push(active.id);
        queued.push(`接着跑上次没完成的归档${scope.label}`);
        continue;
      }
    }

    // ② 周期起点 = 上一份自动归档的结束点，首尾相接。
    const latest = await prisma.memorySnapshot.findFirst({
      where: { memoryScopeId: scope.id, kind: "AUTOMATIC" },
      orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
      select: { periodEnd: true },
    });
    const periodStart = latest?.periodEnd ?? new Date(now.getTime() - intervalDays * DAY_MS);
    const periodEnd = now;

    if (periodStart.getTime() >= periodEnd.getTime()) {
      skipped.push(`当前周期还没走到可归档的时间${scope.label}`);
      continue;
    }

    // ③ 冷却：刚归档过就别再花一次模型钱。
    if (now.getTime() - periodStart.getTime() < COOLDOWN_MS) {
      skipped.push(`刚在 ${clock(periodStart, timeZone)} 归档过，没有重复调用模型${scope.label}`);
      continue;
    }

    const hasMessages = await prisma.message.findFirst({
      where: {
        conversation: { is: { memoryScopeId: scope.id } },
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      select: { id: true },
    });
    if (!hasMessages) {
      skipped.push(`${clock(periodStart, timeZone)} 之后没有对话${scope.label}`);
      continue;
    }

    const key = `auto-snapshot:${scope.id}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;
    const created = await prisma.memoryJob.createMany({
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
    keys.push(key);
    if (created.count > 0) {
      queued.push(`归档 ${clock(periodStart, timeZone)} 之后的对话${scope.label}`);
    }
  }

  if (keys.length === 0 && reusedIds.length === 0) {
    return { queued, skipped, processed: [], pending: 0, advancedTo: null, intervalDays };
  }

  /**
   * 按幂等键把刚排的任务认回来：`processNextMemoryJob` 取的是「队列里下一条」，
   * 不保证就是这一条（同角色可能还有忆泡、清理任务在排）。只有认回自己的任务才算结果，
   * 顺手跑掉的别人的任务不进报告 —— 上一版把一条无关的超时任务混进了「本次结果」。
   */
  const targets = await prisma.memoryJob.findMany({
    where: {
      OR: [
        ...(keys.length ? [{ idempotencyKey: { in: keys } }] : []),
        ...(reusedIds.length ? [{ id: { in: reusedIds } }] : []),
      ],
    },
    select: { id: true, status: true, snapshotId: true },
  });

  const processed: Array<{ status: string; message: string }> = [];
  const pending = new Set(
    targets.filter((job) => job.status === "QUEUED" || job.status === "RETRY_WAIT").map((job) => job.id),
  );
  // 同一周期已有总结时 worker 会直接复用，这里提前说清楚，别让用户以为又跑了一次模型。
  for (const job of targets) {
    if (job.status === "SUCCEEDED" && job.snapshotId) {
      processed.push({ status: "SUCCEEDED", message: "该周期已有总结，直接复用，没有重复调用模型。" });
    }
  }

  // 队列里可能还有别的任务，多给几次机会；认到全部自己的任务就停。
  for (let index = 0; index < pending.size + 8 && pending.size > 0; index += 1) {
    const result = await processNextMemoryJob(prisma, { ownerId });
    if (!result.processed) break;
    if (!pending.has(result.jobId)) continue;
    processed.push({ status: result.status, message: result.message });
    pending.delete(result.jobId);
  }

  /**
   * 只有这一次排的全部任务都成功，才把周期边界推到 now + 间隔。
   * 有 RETRY_WAIT / FAILED 就保持原计划，让这段数据还能被下一次补上。
   */
  const succeeded = processed.some((item) => item.status === "SUCCEEDED");
  const hasFailure = processed.some((item) => item.status === "FAILED" || item.status === "RETRY_WAIT");
  const advancedTo = succeeded && !hasFailure && pending.size === 0
    ? new Date(now.getTime() + intervalDays * DAY_MS)
    : null;
  if (advancedTo) {
    await prisma.characterMemorySetting.updateMany({
      where: { characterId },
      data: { nextSnapshotAt: advancedTo },
    });
  }

  return {
    queued,
    skipped,
    processed,
    pending: pending.size,
    advancedTo: advancedTo ? advancedTo.toISOString() : null,
    intervalDays,
  };
});
