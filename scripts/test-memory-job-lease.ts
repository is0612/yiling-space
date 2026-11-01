/**
 * 任务租约与「手动重新入队」的放行规则。
 *
 * 这里钉的是 2026-11-01 实际踩到的那条线：一条 `EXTRACT_EVENTS` 任务在 15:08 被一次网页请求领走，
 * 请求没回来，租约 5 分钟就过期了；整机没有 Worker 在跑，于是没有任何进程回收它 ——
 * 页面上就一直显示「运行中」，3 小时没人管。三件事必须一致：
 * ① 5 分钟算过期；② 过期的运行中任务可以手动回收；③ 没过期的一律不许抢。
 *
 * 不连数据库、不调模型。
 */

import assert from "node:assert/strict";
import {
  isMemoryJobLeaseExpired,
  MEMORY_JOB_LEASE_MS,
  planJobRequeue,
  REQUEUEABLE_JOB_TYPES,
} from "../server/utils/memory-job-lease";

const now = new Date("2026-11-01T10:27:38.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

// ── 1. 5 分钟这条线 ────────────────────────────────────
assert.equal(isMemoryJobLeaseExpired(ago(4 * 60 * 1000), now), false, "4 分钟还在一份有效租约内。");
assert.equal(isMemoryJobLeaseExpired(ago(MEMORY_JOB_LEASE_MS + 1000), now), true, "超过 5 分钟就是过期。");
assert.equal(isMemoryJobLeaseExpired(ago(3 * 60 * 60 * 1000), now), true, "卡了 3 小时当然算过期。");
// RUNNING 却没有锁定时间 = 谁也说不清谁在执行，按过期处理（否则永远解不开）
assert.equal(isMemoryJobLeaseExpired(null, now), true, "没有锁定时间的运行中任务按过期处理。");

// ── 2. 失败 / 待重试 / 已取消：照旧可以重试 ──────────────
for (const status of ["FAILED", "RETRY_WAIT", "CANCELLED"]) {
  const plan = planJobRequeue({ type: "GENERATE_SNAPSHOT", status, lockedAt: null }, now);
  assert.equal(plan.ok, true, `${status} 的任务应该可以重新入队。`);
  assert.equal(plan.ok && plan.recoveredLease, false, `${status} 不是租约回收。`);
}

// ── 3. 运行中：过期才放行 ──────────────────────────────
const fresh = planJobRequeue({ type: "EXTRACT_EVENTS", status: "RUNNING", lockedAt: ago(60 * 1000) }, now);
assert.equal(fresh.ok, false, "租约没过期的运行中任务不能被抢。");

const stuck = planJobRequeue({ type: "EXTRACT_EVENTS", status: "RUNNING", lockedAt: ago(3 * 60 * 60 * 1000) }, now);
assert.equal(stuck.ok, true, "租约过期的运行中任务必须能手动回收。");
assert.equal(stuck.ok && stuck.recoveredLease, true, "回收要和普通重试区分开（前者要按原租约做乐观锁）。");

// ── 4. 类型白名单 ─────────────────────────────────────
assert.equal(
  planJobRequeue({ type: "UPDATE_LONG_TERM_MEMORY", status: "FAILED", lockedAt: null }, now).ok,
  false,
  "早就没人产出的类型不该出现在重新入队里。",
);
for (const type of ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES", "GENERATE_JOURNAL", "EXTRACT_EVENTS"]) {
  assert.ok((REQUEUEABLE_JOB_TYPES as readonly string[]).includes(type), `${type} 应该可以手动重新入队。`);
}

// ── 5. 其它状态一律拒绝（成功的不该被重跑）────────────────
for (const status of ["QUEUED", "SUCCEEDED", "SKIPPED"]) {
  assert.equal(
    planJobRequeue({ type: "GENERATE_SNAPSHOT", status, lockedAt: null }, now).ok,
    false,
    `${status} 的任务不该被重新入队。`,
  );
}

process.stdout.write("✓ 任务租约与重新入队规则：全部通过\n");
