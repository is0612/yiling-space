/**
 * 任务租约：`memory_jobs.lockedAt` 记「这条任务是什么时候被领走的」。
 *
 * 租约**不会续期** —— 领取者跑完就把锁清掉。超过 5 分钟仍 RUNNING 时，领取者可能失联，
 * 也可能还在等待长模型调用；此时允许回收，旧执行者随后提交必须被领取 token 拒绝。
 *
 * 回收也不是一个独立进程：**每一次领取都会顺带回收过期任务**（`memory-worker.ts` 的
 * `reclaimExpiredMemoryJobs`）。这句话的反面就是 2026-11-01 实际踩到的那个坑 ——
 * 整机没有 Worker 在跑时，没人会来领取，也就没人会回收，任务在页面上一直显示「运行中」。
 * 所以这里的三件东西必须是同一个 5 分钟：任务监控标「卡住」、手动重新入队放行过期任务、
 * Worker 自动回收。
 */

import type { Prisma } from "../../src/generated/prisma/client";

export const MEMORY_JOB_LEASE_MS = 5 * 60 * 1000;

/** 每次领取独立的 fencing token；不能用进程级 workerId 判断执行权。 */
export type MemoryJobLease = { jobId: string; claimToken: string };

export class MemoryJobLeaseLostError extends Error {
  constructor() {
    super("任务租约已失效；拒绝提交旧执行者的结果。");
    this.name = "MemoryJobLeaseLostError";
  }
}

export function memoryJobLeaseWhere(lease: MemoryJobLease) {
  return { id: lease.jobId, status: "RUNNING" as const, lockedBy: lease.claimToken };
}

/** 必须是产物事务的第一步：条件 UPDATE 同时校验 token 和持有行锁直到提交。 */
export async function lockMemoryJobLease(tx: Prisma.TransactionClient, lease: MemoryJobLease): Promise<void> {
  const locked = await tx.memoryJob.updateMany({
    where: memoryJobLeaseWhere(lease),
    data: { lastError: null },
  });
  if (locked.count !== 1) throw new MemoryJobLeaseLostError();
}

/** 运行中任务的租约是否已过期。`lockedAt` 为空 = 说不清谁在执行，按过期处理。 */
export function isMemoryJobLeaseExpired(lockedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lockedAt) return true;
  return now.getTime() - lockedAt.getTime() > MEMORY_JOB_LEASE_MS;
}

/**
 * 可以手动重新入队的任务类型。
 * `UPDATE_LONG_TERM_MEMORY` 早就不再产生，留着它也重跑不出东西，所以不在名单里。
 */
export const REQUEUEABLE_JOB_TYPES = [
  "GENERATE_SNAPSHOT",
  "REGENERATE_SNAPSHOT",
  "CLEAN_EXPIRED_MESSAGES",
  "GENERATE_JOURNAL",
  "EXTRACT_EVENTS",
] as const;

export type JobRequeuePlan =
  | { ok: true; previousStatus: string; recoveredLease: boolean }
  | { ok: false; message: string };

/**
 * 能不能把这条任务放回队列，以及放回去算「重试」还是「回收」。
 *
 * 运行中的任务只在**租约过期**时放行：没过期就抢，等于和还在写的 Worker 抢同一段数据。
 */
export function planJobRequeue(
  job: { type: string; status: string; lockedAt: Date | null },
  now: Date = new Date(),
): JobRequeuePlan {
  if (!(REQUEUEABLE_JOB_TYPES as readonly string[]).includes(job.type)) {
    return { ok: false, message: "该任务类型暂时不能手动重新入队。" };
  }
  if (job.status === "FAILED" || job.status === "RETRY_WAIT" || job.status === "CANCELLED") {
    return { ok: true, previousStatus: job.status, recoveredLease: false };
  }
  if (job.status === "RUNNING") {
    if (!isMemoryJobLeaseExpired(job.lockedAt, now)) {
      return { ok: false, message: "任务正在执行，租约还没过期，不能重新入队；等它跑完，或租约过期后再来。" };
    }
    return { ok: true, previousStatus: job.status, recoveredLease: true };
  }
  return { ok: false, message: "只有失败、等待重试、已取消或租约过期的运行中任务可以手动重新入队。" };
}


/**
 * 长任务发起下一次模型请求前刷新租约。
 *
 * lockedAt 表示最近一次领取/续租时间；startedAt 保留本次执行真正开始的时间。
 * 使用条件更新，旧 Worker 不能替新 Worker 延长租约。
 */
export async function renewMemoryJobLease(
  db: Pick<Prisma.TransactionClient, "memoryJob">,
  lease: MemoryJobLease,
  now: Date = new Date(),
): Promise<void> {
  const renewed = await db.memoryJob.updateMany({
    where: memoryJobLeaseWhere(lease),
    data: { lockedAt: now },
  });
  if (renewed.count !== 1) throw new MemoryJobLeaseLostError();
}
