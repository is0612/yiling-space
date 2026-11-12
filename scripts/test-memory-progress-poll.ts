/**
 * 记忆进度面板的轮询节奏。
 *
 * 2026-11-07 实况：点了「立即 AI 归档」之后，一个 RUNNING 的阶段总结让面板每 2 秒问一次
 * `/api/memory-progress`；任务失败退回 RETRY_WAIT、又没有 Worker 领取时，那个 2 秒**永远不停** ——
 * 用户看到的就是「好慢，然后一直调接口」。这里钉住每条档位：只有真会变化的状才值得快问。
 *
 * 不连数据库、不调模型、不碰浏览器（纯函数）。
 */

import assert from "node:assert/strict";
import {
  MEMORY_PROGRESS_EVENT_POLL_MS,
  MEMORY_PROGRESS_IDLE_POLL_MS,
  MEMORY_PROGRESS_SNAPSHOT_POLL_MS,
  MEMORY_PROGRESS_WAITING_POLL_MS,
  memoryProgressPollDelay,
  memoryRetryScheduleLabel,
} from "../app/composables/useMemoryProgress";

const job = (
  type: "GENERATE_SNAPSHOT" | "EXTRACT_EVENTS",
  status: string,
  leaseExpired = false,
) => ({ type, status, leaseExpired });

// ── 1. 档位本身要拉开，否则「分档」只是换了个说法 ─────────────
assert.ok(
  MEMORY_PROGRESS_EVENT_POLL_MS < MEMORY_PROGRESS_SNAPSHOT_POLL_MS,
  "忆泡分块进度应该比阶段总结问得更勤。",
);
assert.ok(
  MEMORY_PROGRESS_SNAPSHOT_POLL_MS < MEMORY_PROGRESS_WAITING_POLL_MS,
  "正在跑的阶段总结应该比排队 / 退避问得勤。",
);
assert.ok(
  MEMORY_PROGRESS_WAITING_POLL_MS < MEMORY_PROGRESS_IDLE_POLL_MS,
  "有活任务（哪怕没人领取）应该比完全闲着问得勤。",
);

// ── 2. 闲着 ────────────────────────────────────────────
assert.equal(memoryProgressPollDelay([]), MEMORY_PROGRESS_IDLE_POLL_MS, "没有任务就是闲时档。");
for (const status of ["SUCCEEDED", "SKIPPED", "FAILED", "CANCELLED"]) {
  assert.equal(
    memoryProgressPollDelay([job("GENERATE_SNAPSHOT", status)]),
    MEMORY_PROGRESS_IDLE_POLL_MS,
    `${status} 已经结束，不应该再让面板快问。`,
  );
}

// ── 3. 在跑：阶段总结 5 秒，忆泡 2 秒 ─────────────────────
assert.equal(
  memoryProgressPollDelay([job("GENERATE_SNAPSHOT", "RUNNING")]),
  MEMORY_PROGRESS_SNAPSHOT_POLL_MS,
  "阶段总结中间没有可观测状态，2 秒问一次问不出新东西。",
);
assert.equal(
  memoryProgressPollDelay([job("EXTRACT_EVENTS", "RUNNING")]),
  MEMORY_PROGRESS_EVENT_POLL_MS,
  "忆泡整理分块提交，进度会变，2 秒才看得出在动。",
);
assert.equal(
  memoryProgressPollDelay([job("GENERATE_SNAPSHOT", "RUNNING"), job("EXTRACT_EVENTS", "RUNNING")]),
  MEMORY_PROGRESS_EVENT_POLL_MS,
  "同时有忆泡任务时按最快的那个走。",
);
assert.equal(
  memoryProgressPollDelay([job("GENERATE_SNAPSHOT", "RUNNING"), job("EXTRACT_EVENTS", "QUEUED")]),
  MEMORY_PROGRESS_SNAPSHOT_POLL_MS,
  "排队中的任务不该把正在跑的任务拖成慢档。",
);

// ── 4. 排队 / 退避 / 租约过期：没有进程会推进它 ─────────────
for (const status of ["QUEUED", "RETRY_WAIT"]) {
  assert.equal(
    memoryProgressPollDelay([job("GENERATE_SNAPSHOT", status)]),
    MEMORY_PROGRESS_WAITING_POLL_MS,
    `${status} 在有人领取之前不会自己变化，2 秒一次只是白问。`,
  );
}
assert.equal(
  memoryProgressPollDelay([job("EXTRACT_EVENTS", "RUNNING", true)]),
  MEMORY_PROGRESS_WAITING_POLL_MS,
  "租约过期的运行中任务只在人去重试时才变，按等待档。",
);

// ── 5. 上限：任何情况下都不该退回「永远 2 秒」───────────────
const worstCase = [
  job("GENERATE_SNAPSHOT", "QUEUED"),
  job("EXTRACT_EVENTS", "RUNNING", true),
  job("GENERATE_SNAPSHOT", "RETRY_WAIT"),
];
assert.equal(
  memoryProgressPollDelay(worstCase),
  MEMORY_PROGRESS_WAITING_POLL_MS,
  "只有排队 / 卡住的任务时必须是等待档 —— 这正是「一直调接口」的那次。",
);

const retryAt = Date.parse("2026-11-10T16:00:00Z");
const retry = { runAt: new Date(retryAt).toISOString(), attemptCount: 1, maxAttempts: 3 };
assert.match(memoryRetryScheduleLabel(retry, retryAt - 1), /已尝试 1\/3 次；下次尝试 .*（本地时间）；到点后等待执行进程领取/);
assert.match(memoryRetryScheduleLabel(retry, retryAt + 59_999), /已到重试时间，等待领取/);
const overdue = memoryRetryScheduleLabel(retry, retryAt + 60_000);
assert.match(overdue, /已到重试时间，尚未被领取/);
assert.doesNotMatch(overdue, /没跑 Worker|Worker 未运行/);
assert.equal(memoryRetryScheduleLabel({}, retryAt), "等待执行进程领取重试。", "旧接口不伪造次数或排期");
assert.equal(memoryRetryScheduleLabel({ runAt: "bad-date" }, retryAt), "等待执行进程领取重试。");
console.log("✓ memory-progress 轮询节奏及重试时间、次数、超时未领取、旧接口兼容检查通过。");
