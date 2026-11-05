import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { processNextMemoryJob } from "../../../../utils/memory-worker";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 立即归档一次（手动触发「自动归档」）。
 *
 * 本地跑、没起常驻调度器时，周期任务永远不会自己来；这个按钮补的就是「现在就跑一次」。
 *
 * 三个必须守住的东西：
 * 1. **走队列，不直接调模型**。任务表是唯一执行入口，幂等键沿用调度器的
 *    `auto-snapshot:{scope}:{start}:{end}` —— 同周期重复点只会复用已有总结，不会多出一份。
 * 2. **当场执行**。排完立刻 `processNextMemoryJob`，不要求另开 worker 进程；
 *    如果另有 worker 在跑，它可能先领走，这时返回「已排队」也算正常。
 * 3. **要推进周期边界**。生成完把 `nextSnapshotAt` 挪到 now + 间隔，
 *    否则下次调度器醒来会把同一段时间再归档一遍。
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
      memorySetting: {
        select: {
          snapshotIntervalDays: true,
          timezone: true,
        },
      },
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
   * 群友私聊只进按天忆泡、不进阶段总结（8 天总结的边界在 memory-system.md 里写死了），
   * 所以这里不扩到 EXTERNAL_IDENTITY，避免「点一下突然多出别人的总结」。
   */
  const ownerPrivateScopeId = character.memoryScopes.find(
    (scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === character.ownerId,
  )?.id;

  // 周期上限按设置页的 1–8 收紧，库里可能还躺着历史更长的值。
  const intervalDays = Math.min(8, Math.max(1, character.memorySetting?.snapshotIntervalDays ?? 3));
  const now = new Date();
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - intervalDays * DAY_MS);
  const nextSnapshotAt = new Date(now.getTime() + intervalDays * DAY_MS);

  const scopes = [
    { id: globalScopeId, label: "" },
    ...(ownerPrivateScopeId ? [{ id: ownerPrivateScopeId, label: "（主人私聊）" }] : []),
  ];

  const queued: string[] = [];
  const skipped: string[] = [];
  const targetKeys: string[] = [];

  for (const scope of scopes) {
    const hasMessages = await prisma.message.findFirst({
      where: {
        conversation: { is: { memoryScopeId: scope.id } },
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      select: { id: true },
    });
    if (!hasMessages) {
      skipped.push(`最近 ${intervalDays} 天没有对话${scope.label}`);
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
    targetKeys.push(key);
    if (created.count > 0) queued.push(`归档最近 ${intervalDays} 天${scope.label}`);
  }

  if (targetKeys.length === 0) {
    return { queued, skipped, processed: [], advancedTo: null, intervalDays };
  }

  /**
   * 按幂等键把刚排的任务认回来：`processNextMemoryJob` 取的是「队列里下一条」，
   * 不保证就是这一条（同角色可能还有忆泡、清理任务在排），所以不能按次数硬循环。
   */
  const targets = await prisma.memoryJob.findMany({
    where: { idempotencyKey: { in: targetKeys } },
    select: { id: true, status: true, snapshotId: true },
  });

  const processed: Array<{ status: string; message: string }> = [];
  const pending = new Set(targets.filter((job) => job.status === "QUEUED" || job.status === "RETRY_WAIT").map((job) => job.id));
  // 同一周期已经有总结时 worker 会直接复用，这里提前说清楚，别让用户以为又跑了一次模型。
  for (const job of targets) {
    if (job.status === "SUCCEEDED" && job.snapshotId) {
      processed.push({ status: "SUCCEEDED", message: "该周期已有总结，直接复用，没有重复调用模型。" });
    }
  }

  // 队列里可能还有别的任务，多给几次机会；认到全部自己的任务就停。
  for (let index = 0; index < pending.size + 5 && pending.size > 0; index += 1) {
    const result = await processNextMemoryJob(prisma, { ownerId });
    if (!result.processed) break;
    processed.push({ status: result.status, message: result.message });
    pending.delete(result.jobId);
  }

  /**
   * 只有真的产出了总结才推进边界。全部 SKIPPED（比如周期内没消息）时保持原计划，
   * 免得「点一下没结果」也把周期推掉，之后调度器再也不补这段。
   */
  const succeeded = processed.some((item) => item.status === "SUCCEEDED");
  if (succeeded) {
    await prisma.characterMemorySetting.updateMany({
      where: { characterId },
      data: { nextSnapshotAt },
    });
  }

  return {
    queued,
    skipped,
    processed,
    advancedTo: succeeded ? nextSnapshotAt.toISOString() : null,
    intervalDays,
  };
});
