import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import memorySettingsPatch from "../server/api/characters/[id]/memory-settings/index.patch";

/**
 * 关掉「自动生成阶段总结与忆泡」时，队列里的自动任务必须一起作废。
 *
 * 这里钉的是 2026-11-05 实际踩到的那条线：开关只决定「还排不排新任务」，
 * Worker 不看它，所以关掉之前排进去的忆泡任务会照常跑完，页面上表现为
 * 「明明关了还在自动生成」。四件事必须一致：
 * ① 等待中的 `GENERATE_SNAPSHOT` / `EXTRACT_EVENTS` 被作废；
 * ② 运行中的那条留给它跑完，不能抽走脚下的行；
 * ③ 手动的「重新生成总结」和日记/手账不归这个开关管，一条都不能碰；
 * ④ 别的角色的队列不受影响。
 */

// Refuse business databases even when this entry is invoked outside the isolated runner.
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const otherCharacterId = randomUUID();
const otherScopeId = randomUUID();
const now = new Date();
const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const dayEnd = new Date(now.getTime());

const app = createApp();
const router = createRouter();
router.patch("/characters/:id/memory-settings", memorySettingsPatch);
app.use(router);
const server = createServer(toNodeListener(app));

const body = {
  snapshotIntervalDays: 3,
  timezone: "Asia/Shanghai",
  anchorAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  rawMessageRetentionDays: 0,
  rawMessageCleanupEnabled: false,
  changePolicy: "NEXT_CYCLE",
};

try {
  await prisma.user.create({ data: { id: ownerId, username: `settings-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: "Auto off test", basePrompt: "test" } });
  await prisma.character.create({ data: { id: otherCharacterId, ownerId, name: "Other character", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } });
  await prisma.memoryScope.create({ data: { id: otherScopeId, characterId: otherCharacterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${otherScopeId}` } });
  await prisma.characterMemorySetting.create({
    data: {
      characterId,
      snapshotIntervalDays: 3,
      timezone: "Asia/Shanghai",
      anchorAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      nextSnapshotAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      autoSnapshotEnabled: true,
    },
  });

  const job = (type: string, status: string, scope = scopeId, extra: Record<string, unknown> = {}) => prisma.memoryJob.create({
    data: {
      memoryScopeId: scope,
      type: type as never,
      status: status as never,
      idempotencyKey: `${type}:${status}:${randomUUID()}`,
      periodStart: dayStart,
      periodEnd: dayEnd,
      ...extra,
    },
  });
  const pendingSnapshot = await job("GENERATE_SNAPSHOT", "QUEUED");
  const retryEvents = await job("EXTRACT_EVENTS", "RETRY_WAIT", scopeId, { attemptCount: 2 });
  const runningEvents = await job("EXTRACT_EVENTS", "RUNNING", scopeId, {
    lockedBy: "worker-a", lockedAt: now, startedAt: now, attemptCount: 1,
  });
  const journal = await job("GENERATE_JOURNAL", "QUEUED");
  const regenerated = await job("REGENERATE_SNAPSHOT", "QUEUED");
  const otherCharacterJob = await job("EXTRACT_EVENTS", "QUEUED", otherScopeId);

  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const patch = async (payload: Record<string, unknown>, target = characterId, cookie = session.token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/characters/${target}/memory-settings`, {
      method: "PATCH",
      headers: { cookie: `yiling_session=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  // ── 1. 鉴权与归属 ────────────────────────────────
  assert.equal((await patch({ ...body, autoSnapshotEnabled: false }, characterId, "invalid")).status, 401);
  assert.equal((await patch({ ...body, autoSnapshotEnabled: false }, randomUUID())).status, 404);

  // ── 2. 关闭：等待中的自动任务作废，运行中 / 手动 / 别人的都不动 ──
  const off = await patch({ ...body, autoSnapshotEnabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.autoSnapshotEnabled, false);
  assert.equal(off.body.nextSnapshotAt, null, "关闭后不再有下一次自动边界。");
  assert.equal(off.body.cancelledPendingJobs, 2, "排队中的阶段总结与忆泡各一条都要被作废。");

  const cancelledSnapshot = await prisma.memoryJob.findUniqueOrThrow({ where: { id: pendingSnapshot.id } });
  assert.equal(cancelledSnapshot.status, "CANCELLED");
  assert.ok(cancelledSnapshot.completedAt, "作废也要记完成时间，任务页才不会显示成永远等待。");
  assert.match(cancelledSnapshot.lastError ?? "", /自动生成已关闭/);
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: retryEvents.id } })).status, "CANCELLED",
    "等待重试的任务同样会被 Worker 再捡起来，必须一起作废。");

  const stillRunning = await prisma.memoryJob.findUniqueOrThrow({ where: { id: runningEvents.id } });
  assert.equal(stillRunning.status, "RUNNING", "运行中的任务不能和 Worker 抢，留给它跑完。");
  assert.equal(stillRunning.lockedBy, "worker-a");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: journal.id } })).status, "QUEUED",
    "日记与手账不归这个开关管。");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: regenerated.id } })).status, "QUEUED",
    "手动「重新生成阶段总结」是用户明确要求的，不能替用户取消。");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: otherCharacterJob.id } })).status, "QUEUED",
    "关一个角色的自动生成，不能动别的角色的队列。");

  const audits = await prisma.auditLog.findMany({
    where: { action: "memory.auto_generation_disabled", characterId },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(audits.length, 1, "关掉开关要留一条审计，事后能回答「什么时候关的」。");
  const details = audits[0]!.details as { cancelledPendingJobs?: number; cancelledJobTypes?: string[] };
  assert.equal(details.cancelledPendingJobs, 2);
  assert.deepEqual(details.cancelledJobTypes, ["EXTRACT_EVENTS", "GENERATE_SNAPSHOT"]);

  // ── 3. 再存一次关闭：幂等，不重复作废 ──────────────
  const again = await patch({ ...body, autoSnapshotEnabled: false });
  assert.equal(again.status, 200);
  assert.equal(again.body.cancelledPendingJobs, 0, "已经作废过的不该再记一次。");
  assert.equal(await prisma.auditLog.count({ where: { action: "memory.auto_generation_disabled", characterId } }), 2);

  // ── 4. 打开：一条都不能作废 ─────────────────────
  const on = await patch({ ...body, autoSnapshotEnabled: true, changePolicy: "IMMEDIATE_RECALC" });
  assert.equal(on.status, 200);
  assert.equal(on.body.autoSnapshotEnabled, true);
  assert.equal(on.body.cancelledPendingJobs, 0, "打开时只排期，不碰队列。");
  assert.ok(typeof on.body.nextSnapshotAt === "string", "重新打开要按锚点算出下一次边界。");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: journal.id } })).status, "QUEUED");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: regenerated.id } })).status, "QUEUED");

  console.log("Memory settings auto-off passed: pending auto jobs cancelled inside the settings transaction, running/manual/journal/other-character untouched, idempotent, audited; no model calls.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
