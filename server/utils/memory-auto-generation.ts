import type { Prisma } from "../../src/generated/prisma/client";

/**
 * 「自动生成阶段总结与忆泡」关闭时要一起作废的排队任务。
 *
 * 开关只决定调度器**还排不排新任务**：`memory-scheduler` 每轮重新读一次设置，
 * 关掉就不再入队。但已经排进队列的存量任务不看这个开关，Worker 也不看 ——
 * 谁先排进去，谁就会照常跑完。于是关掉之后页面上还会冒出新的忆泡，
 * 看起来像「开关没生效」（2026-11-05 实际踩到的那条线）。
 *
 * 这里把等待中（`QUEUED` / `RETRY_WAIT`）的两类自动任务一并置为 `CANCELLED`：
 * - `GENERATE_SNAPSHOT`：按周期生成阶段总结；
 * - `EXTRACT_EVENTS`：按天整理的忆泡。
 *
 * 故意不碰的三类：
 * - `RUNNING`：已经开始调模型了，跟 Worker 抢同一行只会写出半截结果，
 *   这一轮跑完由它自己提交；
 * - `REGENERATE_SNAPSHOT`：用户在阶段总结详情里明确要求重新提炼，不是自动行为；
 * - `GENERATE_JOURNAL`：日记与手账本来就不归这个开关管（2026-11-01 P1-1）。
 *
 * 判定用「保存后是否为关闭」而不是「是否由开变关」：关是一个状态，任何一次
 * 保存成关闭都会留下同样的问题 —— 队列里躺着调度器不会再管、Worker 却照跑的任务。
 * 重复保存结果不变（没有可作废的行），所以这个操作是幂等的。
 */
export const AUTO_GENERATION_JOB_TYPES = ["GENERATE_SNAPSHOT", "EXTRACT_EVENTS"] as const;

export type CancelledAutoGenerationJobs = {
  count: number;
  /** 这次实际作废到的任务类型，按字母序去重；没有作废时为空数组。 */
  types: string[];
};

export async function cancelPendingAutoGenerationJobs(
  db: Prisma.TransactionClient,
  options: { characterId: string; now: Date },
): Promise<CancelledAutoGenerationJobs> {
  const pending = await db.memoryJob.findMany({
    where: {
      memoryScope: { is: { characterId: options.characterId } },
      type: { in: [...AUTO_GENERATION_JOB_TYPES] },
      status: { in: ["QUEUED", "RETRY_WAIT"] },
    },
    select: { id: true, type: true },
  });
  if (pending.length === 0) return { count: 0, types: [] };

  /**
   * 只作废「读的时候还在等、写的时候仍在等」的行。
   *
   * 读和写之间 Worker 可能刚好把某一条领走（变成 `RUNNING`）。那一条必须留着
   * 跑完：这里改它的状态，等于在 Worker 持有租约时抽走它脚下的任务行。
   */
  const updated = await db.memoryJob.updateMany({
    where: {
      id: { in: pending.map((job) => job.id) },
      status: { in: ["QUEUED", "RETRY_WAIT"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: options.now,
      lockedAt: null,
      lockedBy: null,
      lastError: "自动生成已关闭，排队中的任务随开关一并作废。",
    },
  });

  return {
    count: updated.count,
    types: [...new Set(pending.map((job) => job.type))].sort(),
  };
}
