import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import generateHandler from "../server/api/characters/[id]/snapshots/generate.post";
import snapshotsHandler from "../server/api/characters/[id]/snapshots/index.post";
import { createSession, hashSessionToken } from "../server/utils/auth";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { getPrisma } from "../server/utils/prisma";

// Never allow this regression to write to the user's business database.
const database = new URL(process.env.DATABASE_URL ?? "");
assert(/^\/yiling_memory_test_[a-f0-9]{32}$/.test(database.pathname), "Run through the disposable memory reliability runner.");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));

const DAY_MS = 24 * 60 * 60 * 1000;
const prisma = getPrisma();
(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;

/** 模型返回合法的快照结构；B 场景用它当门闸，让第一个请求停在模型调用里。 */
let gate: { wait: Promise<void>; release: () => void } | null = null;
let modelCalls = 0;
const model = http.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  modelCalls += 1;
  void text;
  const current = gate;
  if (current) await current.wait;
  const body = JSON.stringify({
    summary: "这一段一起整理过项目。",
    importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [],
    goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [],
    memoryChanges: [], events: [],
  });
  response.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ choices: [{ message: { content: body } }] }));
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

const owner = await prisma.user.findFirstOrThrow();
const session = await createSession({ userId: owner.id });
const app = createApp();
const router = createRouter();
router.post("/characters/:id/snapshots/generate", generateHandler);
router.post("/characters/:id/snapshots", snapshotsHandler);
app.use(router);
const api = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const characterIds: string[] = [];

async function fixture(input: {
  /** 最近一份自动归档的结束点；生成会从这里接着排。 */
  archivedEnd: Date;
  messages: Date[];
  nextSnapshotAt: Date;
}) {
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name: `__generate_${randomUUID()}`,
      basePrompt: "测试角色",
      modelConfig: {
        chatModel: "ci-generate",
        chatApiBaseUrl: modelUrl,
        chatApiKeyEncrypted: await encryptApiKey("test-only-key"),
      },
      memorySetting: {
        create: {
          timezone: "UTC",
          anchorAt: new Date(input.archivedEnd.getTime() - 3 * DAY_MS),
          nextSnapshotAt: input.nextSnapshotAt,
          snapshotIntervalDays: 3,
          autoSnapshotEnabled: true,
        },
      },
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `generate:${randomUUID()}` } },
    },
    include: { memoryScopes: true },
  });
  characterIds.push(character.id);
  const scopeId = character.memoryScopes[0]!.id;
  await prisma.memorySnapshot.create({
    data: {
      snapshotKey: `auto-snapshot:${scopeId}:archived`,
      memoryScopeId: scopeId,
      kind: "AUTOMATIC",
      version: 1,
      periodStart: new Date(input.archivedEnd.getTime() - 3 * DAY_MS),
      periodEnd: input.archivedEnd,
      summary: "上一段",
      structuredContent: {},
      status: "CURRENT",
    },
  });
  const conversation = await prisma.conversation.create({
    data: { characterId: character.id, memoryScopeId: scopeId, title: "测试对话" },
  });
  await prisma.message.createMany({
    data: input.messages.map((occurredAt) => ({
      conversationId: conversation.id,
      role: "USER" as const,
      eventType: "message",
      content: "这段时间在整理阶段总结的生成链路。",
      occurredAt,
    })),
  });
  return { characterId: character.id, scopeId };
}

async function generate(characterId: string) {
  const response = await fetch(`${apiUrl}/characters/${characterId}/snapshots/generate`, {
    method: "POST",
    headers: { cookie: `yiling_session=${session.token}` },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as {
    queued: string[]; skipped: string[]; processed: Array<{ status: string; message: string }>;
    pending: number; advancedTo: string | null; processing: boolean;
  };
}

try {
  /**
   * A. 复用一条旧的 RETRY_WAIT 任务时，计划边界必须按**实际归档到的结束点**推进。
   *
   * 旧实现用请求的 `now + 间隔` 推进：复用 [11/01, 11/04) 的任务成功后写下 11/09，
   * 调度器下一轮从 11/09 反推出 [11/06, 11/09)，中间的 [11/04, 11/06) 永久没有归档。
   */
  {
    const archivedEnd = new Date("2026-11-01T00:00:00Z");
    const { characterId, scopeId } = await fixture({
      archivedEnd,
      messages: [new Date("2026-11-02T00:00:00Z"), new Date("2026-11-03T00:00:00Z")],
      nextSnapshotAt: archivedEnd,
    });
    const retry = await prisma.memoryJob.create({
      data: {
        memoryScopeId: scopeId,
        type: "GENERATE_SNAPSHOT",
        idempotencyKey: `auto-snapshot:${scopeId}:2026-11-01T00:00:00.000Z:2026-11-04T00:00:00.000Z`,
        periodStart: archivedEnd,
        periodEnd: new Date("2026-11-04T00:00:00Z"),
        status: "RETRY_WAIT",
        runAt: new Date(Date.now() + 60 * 60 * 1000),
        attemptCount: 1,
      },
    });
    // 同一角色队列里还有别的任务：立即归档只能跑自己那一条。
    const unrelated = await prisma.memoryJob.create({
      data: {
        memoryScopeId: scopeId,
        type: "CLEAN_EXPIRED_MESSAGES",
        idempotencyKey: `cleanup:${scopeId}`,
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        status: "QUEUED",
        runAt: new Date(0),
      },
    });

    const result = await generate(characterId);
    assert.equal(result.processed.length, 1, JSON.stringify(result));
    assert.equal(result.processed[0]!.status, "SUCCEEDED");
    assert.equal(result.pending, 0);

    const reused = await prisma.memoryJob.findUniqueOrThrow({ where: { id: retry.id } });
    assert.equal(reused.status, "SUCCEEDED", "在途任务应当被接着跑完，而不是被作废");

    const archived = await prisma.memorySnapshot.findFirstOrThrow({
      where: { memoryScopeId: scopeId, kind: "AUTOMATIC", periodStart: archivedEnd },
    });
    assert.equal(archived.periodEnd.toISOString(), "2026-11-04T00:00:00.000Z");
    assert.equal(archived.status, "CURRENT");

    assert.equal(result.advancedTo, "2026-11-07T00:00:00.000Z",
      "边界必须按实际归档结束 + 间隔推进，不能用请求时刻，否则中间的周期会被永久跳过");
    const setting = await prisma.characterMemorySetting.findUniqueOrThrow({ where: { characterId } });
    assert.equal(setting.nextSnapshotAt?.toISOString(), "2026-11-07T00:00:00.000Z");

    const untouched = await prisma.memoryJob.findUniqueOrThrow({ where: { id: unrelated.id } });
    assert.equal(untouched.status, "QUEUED", "立即归档不得顺手消费队列里的其他任务");
    assert.equal(untouched.attemptCount, 0);
  }

  /**
   * B. 两个「立即归档」并发进来，只能有一个周期任务。
   *
   * 幂等键里带各自的毫秒 `now`，没有排期互斥时会各排一份重叠周期，两份都写 CURRENT。
   */
  {
    const archivedEnd = new Date("2026-11-01T00:00:00Z");
    const { characterId, scopeId } = await fixture({
      archivedEnd,
      messages: [new Date("2026-11-02T00:00:00Z")],
      nextSnapshotAt: archivedEnd,
    });

    let release!: () => void;
    gate = { wait: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
    const first = generate(characterId);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const running = await prisma.memoryJob.count({
        where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT", status: "RUNNING" },
      });
      if (running > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const second = await generate(characterId);
    gate!.release();
    gate = null;
    const firstResult = await first;

    assert.equal(second.queued.some((line) => line.includes("接着跑")), true, JSON.stringify(second));
    assert.equal(second.processed.length, 0, "运行中的任务不能被第二个请求重复执行");

    const jobs = await prisma.memoryJob.findMany({
      where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT" },
      select: { id: true, periodStart: true, periodEnd: true },
    });
    assert.equal(jobs.length, 1, `并发请求只能排一条周期任务，实际 ${jobs.length} 条`);

    const snapshots = await prisma.memorySnapshot.findMany({
      where: { memoryScopeId: scopeId, kind: "AUTOMATIC", periodStart: archivedEnd },
      select: { id: true, status: true, periodEnd: true },
    });
    assert.equal(snapshots.length, 1, `并发生成只能产出一份归档，实际 ${snapshots.length} 份`);
    assert.equal(snapshots[0]!.status, "CURRENT");
    assert.equal(firstResult.pending, 0);
    assert.equal(firstResult.processed[0]?.status, "SUCCEEDED");
  }

  /**
   * C. 同一份自动归档被连点两次「AI 重新提炼」，只能排一条任务。
   *
   * 在途检查原来在事务外、且按「这个快照 ID」查：双击或多标签页会各排一条。
   * 同一逻辑快照的不同版本本来就是同一段周期，重复排队等于重复消耗模型。
   */
  {
    const archivedEnd = new Date("2026-11-01T00:00:00Z");
    const { characterId, scopeId } = await fixture({
      archivedEnd,
      messages: [new Date("2026-10-30T00:00:00Z")],
      nextSnapshotAt: archivedEnd,
    });
    const target = await prisma.memorySnapshot.findFirstOrThrow({
      where: { memoryScopeId: scopeId, kind: "AUTOMATIC" },
    });
    process.env.LLM_API_KEY = "isolated-placeholder";
    process.env.LLM_MODEL = "isolated-placeholder";
    const ask = () => fetch(`${apiUrl}/characters/${characterId}/snapshots`, {
      method: "POST",
      headers: { cookie: `yiling_session=${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: target.id, mode: "ai" }),
    }).then(async (response) => {
      assert.equal(response.status, 202, await response.clone().text());
      return await response.json() as { jobId: string; duplicate: boolean };
    });
    const [left, right] = await Promise.all([ask(), ask()]);
    assert.equal(left.jobId, right.jobId, "两次请求必须指向同一条任务");
    assert.equal([left.duplicate, right.duplicate].filter(Boolean).length, 1, "第二条应当被识别为重复");
    const jobs = await prisma.memoryJob.count({
      where: { memoryScopeId: scopeId, type: "REGENERATE_SNAPSHOT" },
    });
    assert.equal(jobs, 1, `AI 重新提炼只能排一条任务，实际 ${jobs} 条`);
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
  }

  /**
   * D. 模型调用超过请求内的等待窗口，请求先回、任务照旧跑完。
   *
   * 进度条要能画，前提是「按钮按下去了」和「活儿干完了」不再绑在同一个请求里：
   * 请求超时就返回 `processing: true`，页面立刻能拿到响应并开始轮询；后台继续跑。
   * 最容易写错的是超时分支把执行丢掉了 —— 那样就是把任务改成「点了没反应」。
   */
  {
    const archivedEnd = new Date("2026-11-01T00:00:00Z");
    const { characterId, scopeId } = await fixture({
      archivedEnd,
      messages: [new Date("2026-11-02T00:00:00Z")],
      nextSnapshotAt: archivedEnd,
    });

    let release!: () => void;
    gate = { wait: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
    const slow = await generate(characterId);
    assert.equal(slow.processing, true, "模型还没回来，请求应当先返回并告诉页面「还在跑」");
    assert.equal(slow.processed.length, 0);
    assert.equal(slow.pending, 1);
    assert.equal(slow.advancedTo, null, "没跑完就不能推进边界");

    gate!.release();
    gate = null;

    const deadline = Date.now() + 20_000;
    let finished: { status: string } | null = null;
    while (Date.now() < deadline) {
      const current = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT" },
        select: { status: true },
      });
      if (current && current.status !== "RUNNING" && current.status !== "QUEUED") {
        finished = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finished?.status, "SUCCEEDED", "请求超时只是不再等，后台必须继续把任务跑完");
    const archived = await prisma.memorySnapshot.count({
      where: { memoryScopeId: scopeId, kind: "AUTOMATIC", periodStart: archivedEnd, status: "CURRENT" },
    });
    assert.equal(archived, 1, "后台接手后仍然要落一份归档");
  }

  console.log("Snapshot generate DB regression passed: reused retry keeps the cycle contiguous, targeted worker, no overlapping concurrent periods, single AI regeneration per logical snapshot.");} finally {
  gate?.release();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => model.close(() => resolve())),
  ]);
  for (const id of characterIds) {
    await prisma.modelUsage.deleteMany({ where: { characterId: id } });
    await prisma.memoryJob.deleteMany({ where: { memoryScope: { characterId: id } } });
    await prisma.memorySnapshot.deleteMany({ where: { memoryScope: { characterId: id } } });
    await prisma.conversation.deleteMany({ where: { characterId: id } });
    await prisma.memoryScope.deleteMany({ where: { characterId: id } });
    await prisma.characterMemorySetting.deleteMany({ where: { characterId: id } });
    await prisma.character.delete({ where: { id } });
  }
  await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(session.token) } });
  await prisma.$disconnect();
}
