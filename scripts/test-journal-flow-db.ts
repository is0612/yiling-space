import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDailyEventWindow, resolveDayWindow } from "../server/utils/memory-event-time";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";
import { processNextMemoryJob } from "../server/utils/memory-worker";
import { generateJournalForDay, restoreJournalRevision, saveJournalEdit } from "../server/utils/journal-service";
import type { DiaryAiEntry, HandbookAiEntry, JournalAiResult } from "../server/utils/journal-ai";

/**
 * Scheduler → Worker → Journal Service → Database 的手账链路回归。
 *
 * 和 test-journal-db 的分工：那边验版本 / 引用 / 编辑；这里专门验
 * 「缺一份时怎么补、SKIP 后怎么重试、Worker 读哪个日期和目标」。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，手账链路测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TIME_ZONE = "Asia/Shanghai";
const BASE_URL = "https://journal-flow.invalid/v1";
const dayKey = resolveDailyEventWindow(new Date(), TIME_ZONE).dayKey;
const dayStart = resolveDayWindow(dayKey, TIME_ZONE).start;
const dayEnd = resolveDayWindow(dayKey, TIME_ZONE).end;
const HOUR = 60 * 60_000;

const oldApiKey = process.env.LLM_API_KEY;
const oldBaseUrl = process.env.LLM_BASE_URL;
process.env.LLM_API_KEY = "journal-flow-test-key";
process.env.LLM_BASE_URL = BASE_URL;

const diaryContent = "今天其实有点累，下午把拖了很久的事情做完了。做完之后没有想象中轻松，反而有点空。晚上想了想，可能我需要的不是完成，而是有人看见我完成了。";
const quote = "今天其实有点累";

function result<T>(entry: T): JournalAiResult<T> {
  return { entry, model: "fake-model", promptVersion: "journal-flow-test" };
}

function diaryCreate(messageId: string): JournalAiResult<DiaryAiEntry> {
  return result({
    action: "CREATE",
    title: "有点累的一天",
    content: diaryContent,
    sourceMessageIds: [messageId],
    sourceEventIds: [],
  });
}

function diarySkip(): JournalAiResult<DiaryAiEntry> {
  return result({ action: "SKIP", reason: "今天没什么想写的。" });
}

function handbookCreate(messageId: string, withQuote = false): JournalAiResult<HandbookAiEntry> {
  return result({
    action: "CREATE",
    content: "## 今日片段\n- 把拖了很久的事情做完了\n\n## 待续事项\n- 明天看看效果",
    thought: "完成之后的空，比没完成时的焦虑更难说。",
    ...(withQuote ? { quote } : {}),
    tags: ["拖延", "自我观察"],
    sourceMessageIds: [messageId],
    sourceEventIds: [],
  });
}

function handbookSkip(): JournalAiResult<HandbookAiEntry> {
  return result({ action: "SKIP", reason: "今天没有值得记进手账的东西。" });
}

/** 真实模型输出的手账 JSON（snippets 等），Worker 走验证链时要这个形状。 */
function handbookWireEntry(messageId: string, withQuote = false) {
  return {
    action: "CREATE",
    snippets: ["把拖了很久的事情做完了"],
    followUps: ["明天看看效果"],
    thought: "完成之后的空，比没完成时的焦虑更难说。",
    ...(withQuote ? { quote } : {}),
    tags: ["拖延", "自我观察"],
    sourceMessageIds: [messageId],
    sourceEventIds: [],
    evidence: [{
      text: "把拖了很久的事情做完了",
      quote: "把拖了很久的事情做完了",
      sourceMessageIds: [messageId],
      sourceEventIds: [],
    }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const flowOwnerId = randomUUID();
  const characterIds: string[] = [];
  const scopeIds: string[] = [];

  await prisma.user.create({
    data: { id: flowOwnerId, username: `journal-flow-${randomUUID().slice(0, 8)}`, passwordHash: "test", role: "USER" },
  });

  const buildScaffold = async (label: string, withMessage = true) => {
    const characterId = randomUUID();
    characterIds.push(characterId);
    await prisma.character.create({
      data: {
        id: characterId,
        ownerId: flowOwnerId,
        name: `journal-flow-${label}`,
        basePrompt: "test persona",
        modelConfig: { chatModel: "fake-model", chatApiBaseUrl: BASE_URL },
      },
    });
    const scope = await prisma.memoryScope.create({
      data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
      select: { id: true },
    });
    scopeIds.push(scope.id);
    const conversation = await prisma.conversation.create({
      data: { characterId, memoryScopeId: scope.id, title: `手账链路 ${label}` },
      select: { id: true },
    });
    let messageId = "";
    if (withMessage) {
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "USER",
          content: "今天把拖了很久的事情做完了，有点累。",
          occurredAt: new Date(dayStart.getTime() + 12 * HOUR),
        },
        select: { id: true },
      });
      messageId = message.id;
    }
    await prisma.characterMemorySetting.create({
      data: {
        characterId,
        timezone: TIME_ZONE,
        autoSnapshotEnabled: true,
        anchorAt: new Date(),
        nextSnapshotAt: new Date(Date.now() + 100 * 24 * HOUR),
      },
    });
    return { characterId, scopeId: scope.id, messageId, conversationId: conversation.id };
  };

  try {
    // 0. 原始消息已被清理、只剩忆泡：仍然可以用事件素材生成，不能直接 SKIP。
    {
      const scaffold = await buildScaffold("events-only", false);
      const event = await prisma.memoryEvent.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          dayKey,
          state: "DRAFT",
          occurredAt: new Date(dayStart.getTime() + 12 * HOUR),
          precision: "part_of_day",
          title: "把拖了很久的事情做完了",
          detail: "下午把拖了很久的事情做完了，做完之后有点空。",
          dedupeKey: `journal-flow-event-${scaffold.scopeId}`,
        },
        select: { id: true },
      });
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      const eventJob = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" },
        select: { id: true, journalTarget: true },
      });
      assert.ok(eventJob, "只有忆泡、没有原始消息时也应排手账任务");
      assert.equal(eventJob?.journalTarget, "BOTH");
      await prisma.memoryJob.deleteMany({ where: { id: eventJob!.id } });
      const outcome = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "manual", target: "BOTH" },
        prisma,
        {
          generateDiary: async () => result({
            action: "CREATE",
            content: diaryContent,
            sourceMessageIds: [],
            sourceEventIds: [event.id],
          }),
          generateHandbook: async () => result({
            action: "CREATE",
            content: "## 今日片段\n- 把拖了很久的事情做完了\n\n## 待续事项\n- 明天看看效果",
            thought: "完成之后的空，比没完成时的焦虑更难说。",
            tags: ["事件"],
            sourceMessageIds: [],
            sourceEventIds: [event.id],
          }),
        },
      );
      assert.equal(outcome.status, "created", "只有忆泡时也应能生成，不能当成没有素材");
      const revisions = await prisma.journalRevision.findMany({
        where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } } },
        select: { kind: true, sourceEventIds: true },
      });
      assert.equal(revisions.length, 2);
      for (const revision of revisions) {
        assert.deepEqual(revision.sourceEventIds, [event.id], "只有忆泡时来源应记在事件上");
      }
    }

    // 0.1 原始消息清理必须等待未完成的手账任务；任务完成后才能删除。
    {
      const scaffold = await buildScaffold("cleanup-dependency");
      const oldMessage = await prisma.message.create({
        data: {
          conversationId: scaffold.conversationId,
          role: "USER",
          content: "很久以前的一条原始消息。",
          occurredAt: new Date(Date.now() - 3 * 24 * HOUR),
        },
        select: { id: true },
      });
      await prisma.characterMemorySetting.update({
        where: { characterId: scaffold.characterId },
        data: { rawMessageCleanupEnabled: true, rawMessageRetentionDays: 1 },
      });
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      const cutoff = new Date(Date.now() - 26 * HOUR);
      const cleanupJob = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "CLEAN_EXPIRED_MESSAGES",
          idempotencyKey: `journal-flow-cleanup:${scaffold.scopeId}`,
          periodEnd: cutoff,
          status: "QUEUED",
          runAt: new Date(),
        },
        select: { id: true },
      });
      const journalJob = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "GENERATE_JOURNAL",
          idempotencyKey: `journal:${scaffold.scopeId}:${dayKey}:HANDBOOK`,
          journalDayKey: dayKey,
          journalTarget: "HANDBOOK",
          periodStart: dayStart,
          periodEnd: dayEnd,
          status: "QUEUED",
          runAt: new Date(Date.now() + 10 * 60_000),
          maxAttempts: 3,
        },
        select: { id: true },
      });
      const firstCleanup = await processNextMemoryJob(prisma, {
        ownerId: flowOwnerId,
        workerId: "journal-cleanup-worker",
        now: new Date(),
      });
      assert.equal(firstCleanup.status, "RETRY_WAIT", "有未完成手账任务时清理应延后");
      assert.equal(
        await prisma.message.count({ where: { id: oldMessage.id } }),
        1,
        "手账任务的原始素材不能被提前删除",
      );
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: cleanupJob.id }, select: { status: true } }))?.status, "RETRY_WAIT");

      await prisma.memoryJob.update({ where: { id: journalJob.id }, data: { status: "SUCCEEDED", completedAt: new Date() } });
      const secondCleanup = await processNextMemoryJob(prisma, {
        ownerId: flowOwnerId,
        workerId: "journal-cleanup-worker-2",
        now: new Date(Date.now() + 61_000),
      });
      assert.equal(secondCleanup.status, "SUCCEEDED", "手账任务完成后清理应继续");
      assert.equal(
        await prisma.message.count({ where: { id: oldMessage.id } }),
        0,
        "依赖完成后过期原始消息应被删除",
      );

      // 超过宽限期的 FAILED 任务不能再永久钉住原文；近期 FAILED 仍会延后。
      const staleMessage = await prisma.message.create({
        data: {
          conversationId: scaffold.conversationId,
          role: "USER",
          content: "另一条过期原文。",
          occurredAt: new Date(Date.now() - 4 * 24 * HOUR),
        },
        select: { id: true },
      });
      const failedJournal = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "GENERATE_JOURNAL",
          idempotencyKey: `journal:${scaffold.scopeId}:${dayKey}:DIARY`,
          journalDayKey: dayKey,
          journalTarget: "DIARY",
          periodStart: dayStart,
          periodEnd: dayEnd,
          status: "FAILED",
          runAt: new Date(),
          lastError: "模拟两天前失败的任务。",
          completedAt: new Date(Date.now() - 2 * 24 * HOUR),
        },
        select: { id: true },
      });
      await prisma.$executeRaw`UPDATE "memory_jobs" SET "updatedAt" = ${new Date(Date.now() - 2 * 24 * HOUR)} WHERE "id" = ${failedJournal.id}::uuid`;
      const staleCleanup = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "CLEAN_EXPIRED_MESSAGES",
          idempotencyKey: `journal-flow-cleanup-stale:${scaffold.scopeId}`,
          periodEnd: new Date(Date.now() - 26 * HOUR),
          status: "QUEUED",
          runAt: new Date(),
        },
        select: { id: true },
      });
      const staleResult = await processNextMemoryJob(prisma, {
        ownerId: flowOwnerId,
        workerId: "journal-cleanup-stale-worker",
        now: new Date(),
      });
      assert.equal(staleResult.status, "SUCCEEDED", "超过宽限期的失败手账任务不应永久阻止清理");
      assert.equal(await prisma.message.count({ where: { id: staleMessage.id } }), 0);
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: staleCleanup.id }, select: { status: true } }))?.status, "SUCCEEDED");
    }

    // 1. 并发只生成 HANDBOOK：复用方必须返回 existing，不能误判成 skipped（P1-4）。
    {
      const scaffold = await buildScaffold("concurrent-handbook");
      const gate = deferred();
      let entered = 0;
      const fakeHandbook = async () => {
        entered += 1;
        if (entered === 2) gate.resolve();
        await gate.promise;
        return handbookCreate(scaffold.messageId);
      };
      const [a, b] = await Promise.all([
        generateJournalForDay({ characterId: scaffold.characterId, dayKey, mode: "manual", target: "HANDBOOK" }, prisma, { generateHandbook: fakeHandbook }),
        generateJournalForDay({ characterId: scaffold.characterId, dayKey, mode: "manual", target: "HANDBOOK" }, prisma, { generateHandbook: fakeHandbook }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), ["created", "existing"], "并发只生成手账：一个新写、一个复用");
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        1,
        "并发只生成手账不能写两版",
      );
      const row = await prisma.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: scaffold.scopeId, dayKey } },
        select: { status: true, diaryState: true, handbookState: true },
      });
      assert.equal(row?.status, "ACTIVE");
      assert.equal(row?.handbookState, "GENERATED", "复用后本地状态也要是 GENERATED");
      assert.equal(row?.diaryState, "PENDING", "没生成日记不能顺手标成已生成");
    }

    // 2. 并发只生成 DIARY：和手账对称。
    {
      const scaffold = await buildScaffold("concurrent-diary");
      const gate = deferred();
      let entered = 0;
      const fakeDiary = async () => {
        entered += 1;
        if (entered === 2) gate.resolve();
        await gate.promise;
        return diaryCreate(scaffold.messageId);
      };
      const [a, b] = await Promise.all([
        generateJournalForDay({ characterId: scaffold.characterId, dayKey, mode: "manual", target: "DIARY" }, prisma, { generateDiary: fakeDiary }),
        generateJournalForDay({ characterId: scaffold.characterId, dayKey, mode: "manual", target: "DIARY" }, prisma, { generateDiary: fakeDiary }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), ["created", "existing"], "并发只生成日记：一个新写、一个复用");
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        1,
        "并发只生成日记不能写两版",
      );
      const row = await prisma.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: scaffold.scopeId, dayKey } },
        select: { status: true, diaryState: true, handbookState: true },
      });
      assert.equal(row?.diaryState, "GENERATED");
      assert.equal(row?.handbookState, "PENDING");
    }

    // 2.1 只有 DIARY：Scheduler 排 HANDBOOK 补齐任务，Worker 真的把它补出来。
    {
      const scaffold = await buildScaffold("only-diary");
      await prisma.characterJournal.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          dayKey,
          status: "ACTIVE",
          diaryState: "GENERATED",
          diaryDecidedAt: new Date(dayStart.getTime() + 12 * HOUR),
          revisions: {
            create: {
              kind: "DIARY",
              version: 1,
              revisionType: "AI_GENERATED",
              content: diaryContent,
              sourceMessageIds: [scaffold.messageId],
              sourceEventIds: [],
            },
          },
        },
      });
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      const job = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" },
        select: { id: true, journalDayKey: true, journalTarget: true },
      });
      assert.ok(job, "只有日记时应排手账补齐任务");
      assert.equal(job?.journalTarget, "HANDBOOK");
      await prisma.memoryJob.deleteMany({
        where: {
          memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } },
          id: { not: job!.id },
        },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handbookWireEntry(scaffold.messageId, true)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-handbook-fill-worker", now: new Date() });
        assert.equal(workerResult.status, "SUCCEEDED");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        1,
        "Worker 应只补出缺失的手账",
      );
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        1,
        "已有日记不能被补齐任务覆盖",
      );
    }

    // 2.2 只有 HANDBOOK：Scheduler 排 DIARY 补齐任务，Worker 只补日记。
    {
      const scaffold = await buildScaffold("only-handbook");
      await prisma.characterJournal.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          dayKey,
          status: "ACTIVE",
          handbookState: "GENERATED",
          handbookDecidedAt: new Date(dayStart.getTime() + 12 * HOUR),
          revisions: {
            create: {
              kind: "HANDBOOK",
              version: 1,
              revisionType: "AI_GENERATED",
              content: "## 今日片段\n- 已经有手账了",
              tags: [],
            },
          },
        },
      });
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      const job = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" },
        select: { id: true, journalTarget: true },
      });
      assert.ok(job, "只有手账时应排日记补齐任务");
      assert.equal(job?.journalTarget, "DIARY");
      await prisma.memoryJob.deleteMany({
        where: {
          memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } },
          id: { not: job!.id },
        },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(diaryCreate(scaffold.messageId).entry) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-diary-fill-worker", now: new Date() });
        assert.equal(workerResult.status, "SUCCEEDED");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        1,
        "Worker 应只补出缺失的日记",
      );
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        1,
        "已有手账不能被补齐任务覆盖",
      );
    }

    // 2.3 regenerate：明确要求重写时追加新版本，不能被 auto 的复用分支吃掉。
    {
      const scaffold = await buildScaffold("regenerate");
      const first = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "manual", target: "DIARY" },
        prisma,
        { generateDiary: async () => diaryCreate(scaffold.messageId) },
      );
      assert.equal(first.status, "created");
      const second = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "regenerate", target: "DIARY" },
        prisma,
        { generateDiary: async () => diaryCreate(scaffold.messageId) },
      );
      assert.equal(second.status, "created");
      assert.equal(second.created?.DIARY?.version, 2);
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        2,
        "regenerate 应追加，而不是复用",
      );
    }

    // 2.4 regenerate 期间用户手工编辑：人工版本必须保留，AI 不能盖到它后面。
    {
      const scaffold = await buildScaffold("edit-vs-regenerate");
      await prisma.characterJournal.create({
        data: { memoryScopeId: scaffold.scopeId, dayKey, status: "ACTIVE" },
      });
      const first = await saveJournalEdit({
        characterId: scaffold.characterId,
        dayKey,
        kind: "DIARY",
        content: "人工写的第一版日记，先记下今天发生的这些事。",
        actorUserId: flowOwnerId,
      }, prisma);
      assert.equal(first.ok, true);
      const gate = deferred();
      let entered = false;
      const fakeDiary = async () => {
        entered = true;
        await gate.promise;
        return result({
          action: "CREATE",
          content: diaryContent,
          sourceMessageIds: [scaffold.messageId],
          sourceEventIds: [],
        });
      };
      const regenerated = generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "regenerate", target: "DIARY" },
        prisma,
        { generateDiary: fakeDiary },
      );
      for (let index = 0; index < 100 && !entered; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(entered, true, "AI 重写应已进入模型调用");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const manual = await saveJournalEdit({
        characterId: scaffold.characterId,
        dayKey,
        kind: "DIARY",
        content: "人工在 AI 生成期间保存的第二版，这一版必须是最新。",
        actorUserId: flowOwnerId,
      }, prisma);
      assert.equal(manual.ok, true);
      gate.resolve();
      const outcome = await regenerated;
      assert.equal(outcome.status, "existing", "生成期间被人工改过时，不能返回 created");
      assert.match(outcome.reason ?? "", /手动改过/, "API 要说明保留了人工版本");
      const revisions = await prisma.journalRevision.findMany({
        where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" },
        orderBy: { version: "desc" },
        select: { version: true, revisionType: true, content: true },
      });
      assert.equal(revisions.length, 2, "AI 不应在人工编辑后再落一版");
      assert.equal(revisions[0]?.revisionType, "USER_EDITED");
      assert.equal(revisions[0]?.content, "人工在 AI 生成期间保存的第二版，这一版必须是最新。");
    }

    // 2.5 regenerate 期间用户恢复旧版：RESTORED 也属于人工决定，AI 不能盖到它后面。
    {
      const scaffold = await buildScaffold("restore-vs-regenerate");
      await prisma.characterJournal.create({
        data: { memoryScopeId: scaffold.scopeId, dayKey, status: "ACTIVE" },
      });
      const first = await saveJournalEdit({
        characterId: scaffold.characterId,
        dayKey,
        kind: "DIARY",
        content: "人工保存的第一版日记，作为稍后恢复的来源。",
        actorUserId: flowOwnerId,
      }, prisma);
      assert.equal(first.ok, true);

      const gate = deferred();
      let entered = false;
      const fakeDiary = async () => {
        entered = true;
        await gate.promise;
        return result({
          action: "CREATE",
          content: diaryContent,
          sourceMessageIds: [scaffold.messageId],
          sourceEventIds: [],
        });
      };
      const regenerated = generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "regenerate", target: "DIARY" },
        prisma,
        { generateDiary: fakeDiary },
      );
      for (let index = 0; index < 100 && !entered; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(entered, true, "AI 重写应已进入模型调用");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const restored = await restoreJournalRevision({
        characterId: scaffold.characterId,
        dayKey,
        kind: "DIARY",
        version: 1,
        actorUserId: flowOwnerId,
      }, prisma);
      assert.equal(restored.ok, true, "模型生成期间应能恢复旧版");

      gate.resolve();
      const outcome = await regenerated;
      assert.equal(outcome.status, "existing", "生成期间被人工恢复时，不能返回 created");
      assert.match(outcome.reason ?? "", /手动改过/, "API 要说明保留了人工恢复版本");
      const revisions = await prisma.journalRevision.findMany({
        where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" },
        orderBy: { version: "desc" },
        select: { version: true, revisionType: true, content: true },
      });
      assert.equal(revisions.length, 2, "AI 不应在 RESTORED 版本后再落一版");
      assert.equal(revisions[0]?.revisionType, "RESTORED");
      assert.equal(revisions[0]?.content, "人工保存的第一版日记，作为稍后恢复的来源。");
    }

    // 3. DIARY 已存在、HANDBOOK 返回 SKIP：不能把整天当成完成；新聊天后允许重评。
    {
      const scaffold = await buildScaffold("skip-retry");
      const journal = await prisma.characterJournal.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          dayKey,
          status: "ACTIVE",
          diaryState: "GENERATED",
          diaryDecidedAt: new Date(dayStart.getTime() + 12 * HOUR),
          revisions: {
            create: {
              kind: "DIARY",
              version: 1,
              revisionType: "AI_GENERATED",
              content: diaryContent,
              sourceMessageIds: [scaffold.messageId],
              sourceEventIds: [],
            },
          },
        },
        select: { id: true },
      });
      const skipped = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "manual", target: "HANDBOOK" },
        prisma,
        { generateHandbook: async () => handbookSkip() },
      );
      assert.equal(skipped.status, "skipped", "只有手账 SKIP 时不能返回 created/existing");
      let row = await prisma.characterJournal.findUnique({
        where: { id: journal.id },
        select: { status: true, handbookState: true, handbookDecidedAt: true, diaryState: true },
      });
      assert.equal(row?.status, "ACTIVE", "有日记时整天不能被标成 SKIPPED");
      assert.equal(row?.handbookState, "SKIPPED", "缺的手账要单独记 SKIPPED");
      assert.equal(row?.diaryState, "GENERATED");
      assert.ok(row?.handbookDecidedAt, "SKIPPED 要记决定时间");

      await prisma.memoryJob.deleteMany({ where: { memoryScopeId: scaffold.scopeId } });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      assert.equal(
        await prisma.memoryJob.count({ where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" } }),
        0,
        "没有新聊天时，SKIP 不能反复排任务",
      );

      // 把决定时间放回这一天内，再补一条更晚的聊天：允许重评。
      const decidedAt = new Date(dayStart.getTime() + 13 * HOUR);
      await prisma.characterJournal.update({ where: { id: journal.id }, data: { handbookDecidedAt: decidedAt } });
      await prisma.message.create({
        data: {
          conversationId: (await prisma.conversation.findFirst({ where: { memoryScopeId: scaffold.scopeId }, select: { id: true } }))!.id,
          role: "USER",
          content: "后来又想起一件事，想记一下。",
          occurredAt: new Date(dayStart.getTime() + 14 * HOUR),
        },
      });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      const retryJob = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" },
        select: { id: true, idempotencyKey: true, journalDayKey: true, journalTarget: true },
      });
      assert.ok(retryJob, "SKIP 后新增聊天应重新排任务");
      assert.equal(retryJob?.journalDayKey, dayKey);
      assert.equal(retryJob?.journalTarget, "HANDBOOK", "只补缺失的手账");
      assert.match(retryJob!.idempotencyKey, /:retry-\d+$/, "重评任务要带 retry 标记");
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      assert.equal(
        await prisma.memoryJob.count({ where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" } }),
        1,
        "同一决定时间不能重复排任务",
      );

      // 不清掉 retry 任务：交给 Worker 执行，验证带 retry 标记的键也能解析日期 + 目标。
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } }, id: { not: retryJob!.id } },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handbookWireEntry(scaffold.messageId, true)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-skip-retry-worker", now: new Date() });
        assert.equal(workerResult.status, "SUCCEEDED", "带 retry 标记的任务应能补齐手账");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: retryJob!.id }, select: { status: true } }))?.status, "SUCCEEDED");
      row = await prisma.characterJournal.findUnique({
        where: { id: journal.id },
        select: { status: true, handbookState: true },
      });
      assert.equal(row?.handbookState, "GENERATED");
      await prisma.memoryJob.deleteMany({ where: { memoryScopeId: scaffold.scopeId } });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      assert.equal(
        await prisma.memoryJob.count({ where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" } }),
        0,
        "两份都成功后不再排任务",
      );
    }

    // 4. HANDBOOK 已存在、DIARY 返回 SKIP：对称行为。
    {
      const scaffold = await buildScaffold("skip-diary");
      await prisma.characterJournal.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          dayKey,
          status: "ACTIVE",
          handbookState: "GENERATED",
          handbookDecidedAt: new Date(dayStart.getTime() + 12 * HOUR),
          revisions: {
            create: {
              kind: "HANDBOOK",
              version: 1,
              revisionType: "AI_GENERATED",
              content: "## 今日片段\n- 已经写过手账了",
              tags: [],
            },
          },
        },
      });
      const skipped = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "manual", target: "DIARY" },
        prisma,
        { generateDiary: async () => diarySkip() },
      );
      assert.equal(skipped.status, "skipped");
      const row = await prisma.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: scaffold.scopeId, dayKey } },
        select: { status: true, diaryState: true, handbookState: true },
      });
      assert.equal(row?.status, "ACTIVE");
      assert.equal(row?.diaryState, "SKIPPED");
      assert.equal(row?.handbookState, "GENERATED");
    }

    // 4.1 DIARY 返回 SKIP、HANDBOOK 正常生成：只保存手账，日记按份记 SKIPPED。
    {
      const scaffold = await buildScaffold("diary-skip");
      const outcome = await generateJournalForDay(
        { characterId: scaffold.characterId, dayKey, mode: "manual", target: "BOTH" },
        prisma,
        {
          generateDiary: async () => result({ action: "SKIP", reason: "今天不想写日记。" }),
          generateHandbook: async () => result({
            action: "CREATE",
            content: "## 今日片段\n- 今天只有一段手账。",
            tags: [],
            sourceMessageIds: [scaffold.messageId],
            sourceEventIds: [],
          }),
        },
      );
      assert.equal(outcome.status, "created");
      assert.equal(outcome.created?.DIARY, undefined);
      assert.equal(outcome.created?.HANDBOOK?.kind, "HANDBOOK");
      const row = await prisma.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: scaffold.scopeId, dayKey } },
        select: { status: true, diaryState: true, handbookState: true },
      });
      assert.equal(row?.status, "ACTIVE");
      assert.equal(row?.diaryState, "SKIPPED");
      assert.equal(row?.handbookState, "GENERATED");
    }

    // 5. Scheduler → Worker → Service → DB：显式参数 + 假模型返回两份正文。
    {
      const scaffold = await buildScaffold("worker-full");
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      const scheduled = await prisma.memoryJob.findFirst({
        where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL" },
        select: { id: true, journalDayKey: true, journalTarget: true, idempotencyKey: true },
      });
      assert.ok(scheduled, "两份都缺时应排手账任务");
      assert.equal(scheduled?.journalDayKey, dayKey);
      assert.equal(scheduled?.journalTarget, "BOTH");
      assert.equal(scheduled?.idempotencyKey, `journal:${scaffold.scopeId}:${dayKey}`);

      // 只留这条任务，避免测试里的其他脚手架被 Worker 先捡走。
      await prisma.memoryJob.deleteMany({
        where: {
          memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } },
          id: { not: scheduled!.id },
        },
      });

      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        const entry = calls === 1
          ? diaryCreate(scaffold.messageId).entry
          : handbookWireEntry(scaffold.messageId, true);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(entry) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };

      try {
        const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-flow-worker", now: new Date() });
        assert.equal(workerResult.status, "SUCCEEDED");
        assert.equal(calls, 2, "日记 + 手账各调用一次模型");
      } finally {
        globalThis.fetch = originalFetch;
      }

      const job = await prisma.memoryJob.findUnique({ where: { id: scheduled!.id }, select: { status: true } });
      assert.equal(job?.status, "SUCCEEDED");
      const revisions = await prisma.journalRevision.findMany({
        where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } } },
        orderBy: [{ kind: "asc" }, { version: "desc" }],
        select: { kind: true, version: true, sourceDiaryRevisionId: true },
      });
      assert.deepEqual(revisions.map((item) => item.kind).sort(), ["DIARY", "HANDBOOK"]);
      assert.ok(revisions.find((item) => item.kind === "HANDBOOK")?.sourceDiaryRevisionId, "手账的引句要指向这一版日记");
      const row = await prisma.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: scaffold.scopeId, dayKey } },
        select: { diaryState: true, handbookState: true },
      });
      assert.equal(row?.diaryState, "GENERATED");
      assert.equal(row?.handbookState, "GENERATED");
      await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId: flowOwnerId });
      assert.equal(
        await prisma.memoryJob.count({ where: { memoryScopeId: scaffold.scopeId, type: "GENERATE_JOURNAL", status: "QUEUED" } }),
        0,
        "两份都成功后不再排程",
      );
    }

    // 6. 历史遗留任务：没有显式参数字段，Worker 仍能从幂等键解析日期 + 目标。
    {
      const scaffold = await buildScaffold("legacy-key");
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      const job = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "GENERATE_JOURNAL",
          idempotencyKey: `journal:${scaffold.scopeId}:${dayKey}:HANDBOOK`,
          periodStart: dayStart,
          periodEnd: dayEnd,
          status: "QUEUED",
          maxAttempts: 2,
        },
        select: { id: true },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handbookWireEntry(scaffold.messageId, false)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-legacy-worker", now: new Date() });
        assert.equal(workerResult.status, "SUCCEEDED");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        0,
        "旧任务只补 HANDBOOK，不能顺手生成 DIARY",
      );
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        1,
      );
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: job.id }, select: { status: true } }))?.status, "SUCCEEDED");
    }

    // 7. 失败恢复：日记先成功、手账失败；任务进入 RETRY_WAIT，重试只补手账。
    {
      const scaffold = await buildScaffold("failure-recovery");
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      const job = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "GENERATE_JOURNAL",
          idempotencyKey: `journal:${scaffold.scopeId}:${dayKey}`,
          journalDayKey: dayKey,
          journalTarget: "BOTH",
          periodStart: dayStart,
          periodEnd: dayEnd,
          status: "QUEUED",
          maxAttempts: 3,
        },
        select: { id: true },
      });
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 2) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: "this is not json" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const entry = calls === 1
          ? diaryCreate(scaffold.messageId).entry
          : handbookWireEntry(scaffold.messageId, true);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(entry) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        const failed = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-failure-worker", now: new Date() });
        assert.equal(failed.status, "RETRY_WAIT", "手账失败时任务应重试，不能整单失败");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        1,
        "日记已经成功写入，不能被失败回滚",
      );
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        0,
      );

      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handbookWireEntry(scaffold.messageId, true)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
      try {
        const retried = await processNextMemoryJob(prisma, {
          ownerId: flowOwnerId,
          workerId: "journal-failure-worker-2",
          now: new Date(Date.now() + 31_000),
        });
        assert.equal(retried.status, "SUCCEEDED", "重试只补缺失的手账并成功");
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: job.id }, select: { status: true } }))?.status, "SUCCEEDED");
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "DIARY" } }),
        1,
        "重试不能重复写日记",
      );
      assert.equal(
        await prisma.journalRevision.count({ where: { journal: { is: { memoryScopeId: scaffold.scopeId, dayKey } }, kind: "HANDBOOK" } }),
        1,
      );
    }

    // 8. 非法任务键：安全失败，不能写到别的日期。
    {
      const scaffold = await buildScaffold("invalid-key");
      await prisma.memoryJob.deleteMany({
        where: { memoryScope: { is: { character: { is: { ownerId: flowOwnerId } } } } },
      });
      const job = await prisma.memoryJob.create({
        data: {
          memoryScopeId: scaffold.scopeId,
          type: "GENERATE_JOURNAL",
          idempotencyKey: `journal:${scaffold.scopeId}:${dayKey}:UNKNOWN`,
          periodStart: dayStart,
          periodEnd: dayEnd,
          status: "QUEUED",
          maxAttempts: 1,
        },
        select: { id: true },
      });
      const workerResult = await processNextMemoryJob(prisma, { ownerId: flowOwnerId, workerId: "journal-invalid-worker", now: new Date() });
      assert.equal(workerResult.status, "FAILED");
      assert.equal((await prisma.memoryJob.findUnique({ where: { id: job.id }, select: { status: true } }))?.status, "FAILED");
      assert.equal(
        await prisma.characterJournal.count({ where: { memoryScopeId: scaffold.scopeId } }),
        0,
        "非法任务键不能生成任何日期的内容",
      );
    }

    console.log("✅ test-journal-flow-db 全部通过");
    console.log("   并发只生成一份：复用方 existing，本地状态同步");
    console.log("   一份 SKIP：按份记录，新聊天后才重评");
    console.log("   Scheduler → Worker：显式日期/目标 + 旧 key 兼容 + 非法 key 安全失败");
  } finally {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: flowOwnerId },
          ...(characterIds.length ? [{ characterId: { in: characterIds } }] : []),
        ],
      },
    });
    if (scopeIds.length) {
      await prisma.memoryJob.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
      await prisma.characterJournal.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
      await prisma.conversation.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
      await prisma.memoryScope.deleteMany({ where: { id: { in: scopeIds } } });
    }
    if (characterIds.length) await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.user.deleteMany({ where: { id: flowOwnerId } });
    await prisma.$disconnect();
    if (oldApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = oldApiKey;
    if (oldBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = oldBaseUrl;
  }
}

main().catch(async (error) => {
  console.error("❌ test-journal-flow-db 失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
