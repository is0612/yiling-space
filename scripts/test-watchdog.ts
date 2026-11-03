/**
 * 停滞检测（Watchdog）的判定测试。
 *
 * 这一层唯一会骗人的地方是「归因」：把「模型没配」说成「Worker 没在跑」，
 * 或者把「排期没发生」说成「任务失败」。认错原因比不报警更糟 ——
 * 人会照着提示去重启一个本来就好的进程，然后还是不产出。
 *
 * 不连数据库、不调模型：`evaluateWatchdog` 是纯函数。
 */

import assert from "node:assert/strict";
import {
  evaluateWatchdog,
  WATCHDOG_THRESHOLDS,
  type WatchdogCharacterFacts,
} from "../server/utils/watchdog";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date("2026-10-31T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const later = (ms: number) => new Date(now.getTime() + ms);

const healthy: WatchdogCharacterFacts = {
  id: "char-1",
  name: "群友乙",
  modelConfigured: true,
  autoSnapshotEnabled: true,
  nextSnapshotAt: later(3 * DAY),
  intervalDays: 8,
  latestSnapshotAt: ago(2 * DAY),
  pendingTaskCount: 0,
  failedTaskCount: 0,
  oldestQueuedAt: null,
  stuckLockedAt: null,
};

const run = (patch: Partial<WatchdogCharacterFacts>) =>
  evaluateWatchdog({ now, characters: [{ ...healthy, ...patch }] });

const codes = (findings: ReturnType<typeof run>) => findings.map((finding) => finding.code);

// ── 1. 一切正常就不该说话 ──────────────────────────────
// 看门狗最容易被关掉的原因就是「没事也在响」。
assert.deepEqual(run({}), [], "健康时不报任何项。");

// ── 2. 排期没发生（该归档了，队列里却没有活）─────────────
const schedulerStalled = run({ nextSnapshotAt: ago(2 * HOUR) });
assert.deepEqual(codes(schedulerStalled), ["scheduler_stalled"]);
assert.equal(schedulerStalled[0]!.severity, "err");
assert.match(schedulerStalled[0]!.message, /队列里却没有对应任务/);

// 刚过期不到一小时先不报：手动补跑一次是常见操作。
assert.deepEqual(run({ nextSnapshotAt: ago(WATCHDOG_THRESHOLDS.schedulerGraceMs / 2) }), []);

// 队列里已经有任务，说明排期在动，不是「没排期」。
assert.deepEqual(codes(run({ nextSnapshotAt: ago(2 * HOUR), pendingTaskCount: 1 })), []);

// 有失败任务时另说：「没排期」和「排了但失败」是两件事，不能混着报。
assert.deepEqual(codes(run({ nextSnapshotAt: ago(2 * HOUR), failedTaskCount: 2 })), []);

// ── 3. Worker 不在（队列积压没人认领）────────────────────
const workerStalled = run({ oldestQueuedAt: ago(2 * HOUR), pendingTaskCount: 1 });
assert.deepEqual(codes(workerStalled), ["worker_stalled"]);
assert.match(workerStalled[0]!.message, /还没人执行/);

// 积压 10 分钟不报：Worker 可能正在处理上一个任务。
assert.deepEqual(codes(run({ oldestQueuedAt: ago(10 * MINUTE), pendingTaskCount: 1 })), []);

// 模型没配置时任务留在队列是设计行为，不能归因成 Worker 挂了。
assert.deepEqual(codes(run({ oldestQueuedAt: ago(2 * HOUR), pendingTaskCount: 1, modelConfigured: false })), []);

// ── 4. 任务卡在运行中（没人回收）────────────────────────
const stuck = run({ stuckLockedAt: ago(40 * MINUTE), pendingTaskCount: 1 });
assert.deepEqual(codes(stuck), ["task_stuck"]);
assert.equal(stuck[0]!.severity, "err");
// 租约不续期，所以别写「续租」；要说清楚两件事：5 分钟就过期、怎么解（起 Worker 或手动回收）。
assert.match(stuck[0]!.detail, /租约 5 分钟/);
assert.match(stuck[0]!.detail, /回收/);
assert.match(stuck[0]!.detail, /worker:watch/);

// 刚锁上 3 分钟是正常执行中。
assert.deepEqual(codes(run({ stuckLockedAt: ago(3 * MINUTE), pendingTaskCount: 1 })), []);

// ── 5. 一个角色只报最上游的那一条 ───────────────────────
// 卡住解释了积压，也解释了没产出；三条一起报只会让人以为坏在三处。
const both = run({ stuckLockedAt: ago(40 * MINUTE), oldestQueuedAt: ago(3 * HOUR), pendingTaskCount: 2 });
assert.deepEqual(codes(both), ["task_stuck"], "上游原因成立时不再补报下游症状。");

// ── 6. 长期零产出（进程都活着，就是没结果）──────────────
const silent = run({ latestSnapshotAt: ago(30 * DAY) });
assert.deepEqual(codes(silent), ["snapshot_silent"]);
assert.equal(silent[0]!.severity, "warn", "零产出是「不太对」，不是「已经坏了」。");

// 周期 30 天的角色，60 天没产出才算静默（两个周期）。
assert.deepEqual(codes(run({ intervalDays: 30, latestSnapshotAt: ago(30 * DAY) })), []);
assert.deepEqual(codes(run({ intervalDays: 30, latestSnapshotAt: ago(61 * DAY) })), ["snapshot_silent"]);

// 关掉自动归档就不该有「没产出」这种指责。
assert.deepEqual(codes(run({ autoSnapshotEnabled: false, latestSnapshotAt: ago(90 * DAY) })), []);

// 从没生成过快照、但下次归档还没到：新角色，正常。
assert.deepEqual(codes(run({ latestSnapshotAt: null })), []);

// ── 7. 多个角色各报各的，不合并 ─────────────────────────
const multi = evaluateWatchdog({
  now,
  characters: [
    { ...healthy, id: "a", name: "群友乙", nextSnapshotAt: ago(2 * HOUR) },
    { ...healthy, id: "b", name: "小满", oldestQueuedAt: ago(2 * HOUR), pendingTaskCount: 1 },
  ],
});
assert.equal(multi.length, 2, "一个角色的停滞不能盖住另一个。");
assert.deepEqual(multi.map((finding) => finding.characterName), ["群友乙", "小满"]);
assert.deepEqual(multi.map((finding) => finding.code), ["scheduler_stalled", "worker_stalled"]);

// ── 8. B站 值班静默（另一条流水线）────────────────────────
// 值班是脚本 + CLI 驱动的，和记忆队列完全无关：记忆停着不代表值班没跑。
const dutyIdle = run({ duty: { perDay: 5, autoDuty: true, lastRoundAt: ago(5 * DAY), since: ago(30 * DAY) } });
assert.deepEqual(codes(dutyIdle), ["duty_silent"]);
assert.equal(dutyIdle[0]!.severity, "warn", "值班停摆先提示，不是「已经坏了」。");
assert.match(dutyIdle[0]!.message, /没跑过一轮/);

// 昨天刚跑过：正常，谷时窗口本来就可能空一天。
assert.deepEqual(codes(run({ duty: { perDay: 5, autoDuty: true, lastRoundAt: ago(1 * DAY), since: ago(30 * DAY) } })), []);

// perDay=0 是「关掉值班」，不是「停摆」。
assert.deepEqual(codes(run({ duty: { perDay: 0, autoDuty: true, lastRoundAt: null, since: ago(30 * DAY) } })), []);

// 峰谷自动刷关掉：perDay 还在，但没有任何进程会到点触发 —— 这不是停摆，是配置。
// 报了也没用：它的修复点在 B站 值班台（打开自动刷），不在任务监控里。
assert.deepEqual(
  codes(run({ duty: { perDay: 5, autoDuty: false, lastRoundAt: ago(10 * DAY), since: ago(30 * DAY) } })),
  [],
  "自动刷关着时不报「值班停摆」：没有自动执行者，归因到流水线断裂会把人引到错的地方。",
);

// 刚绑定一天、还没跑过：新设备还在等窗口，不该被指责。
assert.deepEqual(codes(run({ duty: { perDay: 5, autoDuty: true, lastRoundAt: null, since: ago(1 * DAY) } })), []);

// 绑定十天一次没跑：适配器/CLI 从没起来过。
const neverRan = run({ duty: { perDay: 5, autoDuty: true, lastRoundAt: null, since: ago(10 * DAY) } });
assert.deepEqual(codes(neverRan), ["duty_silent"]);
assert.match(neverRan[0]!.message, /一次都没跑过/, "「从没跑过」和「跑过但停了」要说清楚，排查方向不同");

// 两条流水线各报各的：记忆停了不该把值班的问题吞掉。
const bothPipelines = run({
  nextSnapshotAt: ago(2 * HOUR),
  duty: { perDay: 5, autoDuty: true, lastRoundAt: ago(5 * DAY), since: ago(30 * DAY) },
});
assert.deepEqual(codes(bothPipelines), ["scheduler_stalled", "duty_silent"], "两个独立管线各自一条，不能只报一个。");

console.log("[watchdog] 18 组判定通过");
