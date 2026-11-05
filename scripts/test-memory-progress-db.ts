import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import memoryProgressHandler from "../server/api/memory-progress.get";
import { listMemoryProgress } from "../server/utils/memory-progress";
import { MEMORY_JOB_LEASE_MS } from "../server/utils/memory-job-lease";

/**
 * 「进行中的记忆任务」面板的数据源。
 *
 * 两个按钮都是在 HTTP 请求里当场执行的，切页面就看不见了；面板只能靠库里的任务行说话。
 * 这里钉的是「说了什么」和「不能说什么」：
 * ① 正在跑的忆泡整理要给出**真实**的已处理 / 总数（游标之前算已完成），能画确定进度条；
 * ② 阶段总结一次模型调用，中间没有可观测中间态 —— 必须 `done: null`，编个百分比就是骗人；
 * ③ 排队中的忆泡任务不给比例（一定是 0，没有信息量）；
 * ④ 运行中但租约过期要标出来，否则面板会把「进程可能已经没了」显示成「正在跑」；
 * ⑤ 只算当前账号；刚跑完的留 90 秒给面板显示结果，更早的不再冒出来。
 */

// Refuse business databases even when this entry is invoked outside the isolated runner.
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const otherOwnerId = randomUUID();
const otherCharacterId = randomUUID();
const otherScopeId = randomUUID();

/** 2026-11-05 00:00（Asia/Shanghai）—— 界面上的日期分组依赖这个时区换算。 */
const periodStart = new Date("2026-11-04T16:00:00Z");
const periodEnd = new Date(periodStart.getTime() + DAY_MS);
const dayKey = "2026-11-05";

const app = createApp();
const router = createRouter();
router.get("/memory-progress", memoryProgressHandler);
app.use(router);
const server = createServer(toNodeListener(app));

try {
  await prisma.user.create({ data: { id: ownerId, username: `progress-${ownerId}`, passwordHash: "test-only" } });
  await prisma.user.create({ data: { id: otherOwnerId, username: `progress-other-${otherOwnerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: "进度角色", basePrompt: "test" } });
  await prisma.character.create({ data: { id: otherCharacterId, ownerId: otherOwnerId, name: "别人的角色", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `progress:${scopeId}` } });
  await prisma.memoryScope.create({ data: { id: otherScopeId, characterId: otherCharacterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `progress:${otherScopeId}` } });
  await prisma.characterMemorySetting.create({
    data: {
      characterId,
      snapshotIntervalDays: 3,
      timezone: "Asia/Shanghai",
      anchorAt: new Date(periodStart.getTime() - 3 * DAY_MS),
      nextSnapshotAt: periodEnd,
      autoSnapshotEnabled: true,
    },
  });

  const conversation = await prisma.conversation.create({
    data: { characterId, memoryScopeId: scopeId, title: "进度测试" },
  });
  const messages: Array<{ id: string; occurredAt: Date }> = [];
  for (let index = 0; index < 10; index += 1) {
    const occurredAt = new Date(periodStart.getTime() + index * 60 * 1000);
    const created = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        eventType: "message",
        content: `第 ${index + 1} 条聊天。`,
        occurredAt,
      },
      select: { id: true, occurredAt: true },
    });
    messages.push(created);
  }

  // 分块整理跑了一半：游标停在第 4 条，所以已完成 4 条、还剩 6 条。
  const cursor = messages[3]!;
  await prisma.memoryEventDay.create({
    data: {
      memoryScopeId: scopeId,
      dayKey,
      state: "DRAFT",
      eventCount: 3,
      extractedAt: cursor.occurredAt,
      extractedMessageId: cursor.id,
    },
  });

  const job = (input: {
    type: string; status: string; scope?: string; key?: string;
    periodStart?: Date | null; periodEnd?: Date | null; completedAt?: Date | null;
    lockedAt?: Date | null; startedAt?: Date | null; lastError?: string | null;
  }) => prisma.memoryJob.create({
    data: {
      memoryScopeId: input.scope ?? scopeId,
      type: input.type as never,
      status: input.status as never,
      idempotencyKey: input.key ?? `${input.type}:${randomUUID()}`,
      periodStart: input.periodStart === undefined ? periodStart : input.periodStart,
      periodEnd: input.periodEnd === undefined ? periodEnd : input.periodEnd,
      completedAt: input.completedAt ?? null,
      lockedAt: input.lockedAt ?? null,
      startedAt: input.startedAt ?? null,
      lastError: input.lastError ?? null,
    },
  });

  const runningExtract = await job({
    type: "EXTRACT_EVENTS",
    status: "RUNNING",
    key: `events-incremental:${scopeId}:${dayKey}`,
    lockedAt: new Date(now.getTime() - 10_000),
    startedAt: new Date(now.getTime() - 10_000),
  });
  // 租约过期：领走它的进程可能已经不在了。
  const stuckSnapshot = await job({
    type: "GENERATE_SNAPSHOT",
    status: "RUNNING",
    lockedAt: new Date(now.getTime() - MEMORY_JOB_LEASE_MS - 60_000),
    startedAt: new Date(now.getTime() - MEMORY_JOB_LEASE_MS - 60_000),
  });
  const queuedExtract = await job({ type: "EXTRACT_EVENTS", status: "QUEUED" });
  const recentFinished = await job({
    type: "GENERATE_SNAPSHOT",
    status: "SUCCEEDED",
    completedAt: new Date(now.getTime() - 10_000),
  });
  const oldFinished = await job({
    type: "GENERATE_SNAPSHOT",
    status: "SUCCEEDED",
    completedAt: new Date(now.getTime() - 10 * 60_000),
  });
  // 历史脏数据：没有周期，算不出标签，也不能让整块面板报错。
  const dirty = await job({ type: "EXTRACT_EVENTS", status: "QUEUED", periodStart: null, periodEnd: null });
  const otherOwnerJob = await job({ type: "EXTRACT_EVENTS", status: "RUNNING", scope: otherScopeId, lockedAt: now });

  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fetchProgress = async (cookie?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/memory-progress`, {
      headers: cookie ? { cookie: `yiling_session=${cookie}` } : {},
    });
    return { status: response.status, body: await response.json() as { jobs: Array<Record<string, unknown>>; checkedAt?: string } };
  };

  // ── 1. 只读接口也要鉴权 ──────────────────────────
  assert.equal((await fetchProgress()).status, 401, "没登录不能看别人在跑什么。");
  assert.equal((await fetchProgress("invalid")).status, 401);

  // ── 2. 面板内容 ─────────────────────────────────
  const listed = await fetchProgress(session.token);
  assert.equal(listed.status, 200);
  assert.ok(typeof listed.body.checkedAt === "string");
  const ids = listed.body.jobs.map((row) => row.id as string);
  assert.equal(ids.includes(runningExtract.id), true);
  assert.equal(ids.includes(stuckSnapshot.id), true);
  assert.equal(ids.includes(queuedExtract.id), true);
  assert.equal(ids.includes(recentFinished.id), true, "刚跑完的要留一会儿，面板才显示得出「完成」。");
  assert.equal(ids.includes(oldFinished.id), false, "十分钟前的历史任务不该占着面板。");
  assert.equal(ids.includes(otherOwnerJob.id), false, "只能看自己账号下的任务。");
  assert.equal(ids.includes(dirty.id), false, "缺周期的脏行直接跳过，别把面板搞崩。");

  const row = (id: string) => listed.body.jobs.find((item) => item.id === id)!;

  const extractRow = row(runningExtract.id);
  assert.equal(extractRow.status, "RUNNING");
  assert.equal(extractRow.characterName, "进度角色");
  assert.equal(extractRow.done, 4, "游标之前的就是已处理，这是能画确定进度条的唯一依据。");
  assert.equal(extractRow.total, 10);
  assert.equal(extractRow.eventCount, 3);
  assert.equal(extractRow.leaseExpired, false);
  assert.match(extractRow.label as string, /^忆泡整理 · 11\/05 增量$/);

  const snapshotRow = row(stuckSnapshot.id);
  assert.equal(snapshotRow.type, "GENERATE_SNAPSHOT");
  assert.equal(snapshotRow.done, null, "阶段总结是一次模型调用，中间没有可观测进度，不能编百分比。");
  assert.equal(snapshotRow.total, null);
  assert.equal(snapshotRow.eventCount, null);
  assert.equal(snapshotRow.leaseExpired, true, "租约过期要标出来，否则看起来像还在跑。");
  assert.match(snapshotRow.label as string, /^阶段总结 · 11\/05 — 11\/06$/);

  const queuedRow = row(queuedExtract.id);
  assert.equal(queuedRow.done, null, "排队中的比例一定是 0，给了等于没给。");
  assert.equal(queuedRow.total, null);
  assert.equal(queuedRow.leaseExpired, false);

  // ── 3. 顺序：最该看的在最上面 ────────────────────
  const rank = (status: string) => (status === "RUNNING" ? 0 : status === "QUEUED" || status === "RETRY_WAIT" ? 1 : 2);
  const ranks = listed.body.jobs.map((item) => rank(item.status as string));
  assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right), "运行中 > 排队 > 刚结束。");

  // ── 4. 收口任务与 privateOnly 作用域 ─────────────
  const finalizeJob = await job({
    type: "EXTRACT_EVENTS",
    status: "RUNNING",
    key: `events-final:${scopeId}:${dayKey}`,
    lockedAt: now,
  });
  const externalScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: `progress-external:${randomUUID()}` },
  });
  const externalConversation = await prisma.conversation.create({
    data: { characterId, memoryScopeId: externalScope.id, externalConversationId: `c:${randomUUID()}`, title: "私聊" },
  });
  await prisma.message.createMany({
    data: [0, 1].map((index) => ({
      conversationId: externalConversation.id,
      role: "USER" as const,
      eventType: "message",
      content: `私聊第 ${index + 1} 条。`,
      occurredAt: new Date(periodStart.getTime() + index * 60 * 1000),
    })),
  });
  const externalJob = await job({
    type: "EXTRACT_EVENTS",
    status: "RUNNING",
    scope: externalScope.id,
    lockedAt: now,
  });

  const second = await listMemoryProgress(prisma, { ownerId });
  const byId = (id: string) => second.find((item) => item.id === id)!;
  assert.match(byId(finalizeJob.id).label, /收口$/, "收口和增量在面板上要能分开看。");
  assert.equal(byId(finalizeJob.id).done, 4, "同一份游标仍然适用。");
  assert.equal(byId(externalJob.id).done, 0, "私聊作用域只数私聊消息，不能被主会话的存量带偏。");
  assert.equal(byId(externalJob.id).total, 2);
  assert.match(byId(externalJob.id).label, /（私聊）$/);

  console.log("Memory progress passed: real done/total for chunked extraction, no fake percentage for snapshots, lease expiry surfaced, owner scoped, finished rows expire.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
