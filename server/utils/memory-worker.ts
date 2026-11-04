import { resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { recordModelUsage, toUsageTokens } from "./model-usage";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";
import {
  analyzeMemoryPeriod,
  isMemoryModelConfigured,
  type MemoryAiMessage,
  type MemoryChange,
} from "./memory-ai";
import { applyMemoryChange, applyMemoryEvents, normalizeMemoryText } from "./memory-change-apply";
import {
  PER_CONVERSATION_SOURCE_WINDOW,
  selectPeriodSourceMessages,
} from "./memory-source-selection";
import { localDayKey } from "./memory-event-time";
import {
  conversationOriginLabel,
  readMessageAuthor,
  readMessageMentionTargets,
  readMessageSpeaker,
  readSourceMessageIsOwner,
} from "./conversation-message";
import { generateJournalForDay, readJournalJobParams } from "./journal-service";
import { normalizeFriendAliases } from "./friend-aliases";
import { MEMORY_JOB_LEASE_MS } from "./memory-job-lease";

/** 会被租约回收的任务类型（`UPDATE_LONG_TERM_MEMORY` 已不再产生）。 */
const LEASE_RECOVERABLE_JOB_TYPES = ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES", "EXTRACT_EVENTS", "GENERATE_JOURNAL"] as const;
/** 一个周期最多看几个会话：会话再多，也只给最近活跃的这几个分配来源配额。 */
const MAX_SCOPE_CONVERSATIONS = 12;
const MAX_SOURCE_MEMORIES = 250;
const MAX_AI_MESSAGES = 120;
/**
 * 纯上下文行（`storedReason = "silent"`）的保留天数。
 *
 * 这类消息她看过但没开口，作用只是「理解当时在聊什么」，一周后回顾价值很低；
 * 证据类（回了话 / 被点名）按角色设置的保留天数走。取 `min(7, 角色设置)`，
 * 用户的数字更小时以用户为准。
 */
const CONTEXT_RETENTION_DAYS = 7;
/**
 * 忆泡按天抽取的分块：每块多少条消息、一次任务最多跑几块。
 *
 * 不沿用 `MAX_AI_MESSAGES`（那是给「一次调用看一个周期」的快照用的）：按天抽取
 * 一晚上就有几百条，只喂 120 条会把中间整段丢掉。8 块 ≈ 960 条/次，超出时按
 * 时间均匀分块（而不是只留最近的），保证整天的内容都有一份代表。
 */
const EVENT_AI_CHUNK_SIZE = 120;
const MAX_EVENT_CHUNKS = 8;
const MAX_AI_MEMORIES = 80;
const MIN_MEMORY_CONFIDENCE = 0.65;

export type MemoryWorkerResult =
  | { processed: false; message: string }
  | { processed: true; jobId: string; status: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED" | "CANCELLED"; snapshotId?: string; message: string };

type WorkerOptions = {
  ownerId?: string;
  workerId?: string;
  now?: Date;
};

function ownerFilter(ownerId?: string) {
  return ownerId ? { memoryScope: { is: { character: { is: { ownerId } } } } } : {};
}

type PeriodSourceMessage = {
  id: string;
  role: string;
  eventType: string;
  content: string;
  occurredAt: Date;
  conversationId: string;
  /** 这条消息来自哪种对话：群聊带群号，私聊/本地对话各有一个固定标签。 */
  origin: string;
  /** 这条是主人发的。群聊里主人和群友混在一起，要靠它让提炼时认得出主人。 */
  isOwner: boolean;
  /** 这条消息 @ 了谁（self / other / all）。用来判断「这句话是不是冲她说的」。 */
  mentionTargets?: string[];
  /** 发言人账号与平台：忆泡的参与者引用靠它推导，不靠模型写名字。 */
  authorOpenId?: string;
  platform?: string;
  /** 发言人显示名：忆泡的 `participants` 靠它写对，否则模型只能写「群友」。 */
  speaker?: string;
  /** 群内稳定代号（`member_2`）：昵称会改，代号不会。 */
  member?: string;
};

/** 会话来源标签（实现在 `conversation-message.ts`，手账链路共用同一套判据）。 */

/**
 * 按会话取本周期来源消息。
 *
 * 每个会话单独查最近的一批，再交给 selectPeriodSourceMessages 做配额分配 ——
 * 一条 SQL 取不出「每个会话各 N 条」，而按全局时间取正是私聊被水群挤掉的原因。
 */
async function loadPeriodSourceMessages(
  prisma: PrismaClient,
  conversations: Array<{ id: string; externalConversationId: string | null }>,
  periodStart: Date,
  periodEnd: Date,
  options: { perConversation?: number; budget?: number } = {},
): Promise<PeriodSourceMessage[]> {
  const perConversationWindow = Math.max(1, Math.trunc(options.perConversation ?? PER_CONVERSATION_SOURCE_WINDOW));
  const batches = await Promise.all(conversations.map(async (conversation) => {
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id, occurredAt: { gte: periodStart, lt: periodEnd } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: perConversationWindow,
      select: { id: true, role: true, eventType: true, content: true, occurredAt: true, metadata: true },
    });
    const origin = conversationOriginLabel(conversation);
    return rows.map((row) => ({
      ...row,
      conversationId: conversation.id,
      origin,
      // 桌面端本地对话的 USER 消息就是主人说的：没有渠道账号可查，但会话本身就是主人的。
      // 漏掉这一步，桌面私聊的忆泡只有 `self` 引用，没有「对方」。
      isOwner: readSourceMessageIsOwner(row.metadata, { origin, role: row.role }),
      mentionTargets: readMessageMentionTargets(row.metadata),
      // 发言人账号与平台：忆泡的参与者引用靠它推导。
      ...readMessageAuthor(row.metadata),
      // 发言人显示名：忆泡的 participants 靠它写对名字。手账链路一直是这么取的，
      // 忆泡这条漏了，结果群聊事件被记成「群友」。
      ...readMessageSpeaker(row.metadata),
    }));
  }));
  return selectPeriodSourceMessages(batches.flat(), {
    ...(options.perConversation ? { perConversation: options.perConversation } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
  });
}

function selectAiMessages(messages: PeriodSourceMessage[]): MemoryAiMessage[] {
  let selected = messages;
  if (messages.length > MAX_AI_MESSAGES) {
    const edge = Math.floor(MAX_AI_MESSAGES / 2);
    selected = [...messages.slice(0, edge), ...messages.slice(-edge)];
  }
  return selected.map(toAiMessage);
}

/** 单条消息转成模型输入。分块抽取也用它，保证两条路径的字段完全一致。 */
function toAiMessage(message: PeriodSourceMessage): MemoryAiMessage {
  return {
    id: message.id,
    role: message.role,
    eventType: message.eventType,
    occurredAt: message.occurredAt.toISOString(),
    content: message.content.slice(0, 1200),
    origin: message.origin,
    isOwner: message.isOwner,
    ...(message.mentionTargets?.length ? { mentionTargets: message.mentionTargets } : {}),
    // 谁说的：不传的话模型只能从正文猜，猜不出就写「群友」，那个人当场丢掉。
    ...(message.speaker ? { speaker: message.speaker } : {}),
    ...(message.member ? { member: message.member } : {}),
  };
}

function validConfidence(change: MemoryChange): boolean {
  return change.confidence >= MIN_MEMORY_CONFIDENCE;
}

/**
 * 把一天的消息按时间顺序切成若干块。
 *
 * 块数取 `ceil(总数 / size)`，但封顶 `maxChunks`：条数远超上限时按「均匀分段」而不是
 * 「只留最近的」，否则一天的早段永远抽不到。顺序必须保持，模型靠它理解前因后果。
 */
function splitForEventExtraction<T>(messages: T[], size: number, maxChunks: number): T[][] {
  if (messages.length <= size) return [messages];
  const groups = Math.min(Math.ceil(messages.length / size), maxChunks);
  const perGroup = Math.ceil(messages.length / groups);
  const chunks: T[][] = [];
  for (let index = 0; index < messages.length; index += perGroup) {
    chunks.push(messages.slice(index, index + perGroup));
  }
  return chunks;
}

/**
 * 按天整理忆泡。
 *
 * 和快照任务的区别：不写快照、不碰长期记忆，只把「昨天」这一天里能落到具体时间的事
 * 写进 `MemoryEvent`。同一条事件由 `dedupeKey`（范围 + 日期 + 标题）保证只写一次，
 * 补跑或重试都不会重复。
 */
async function runDailyEventJob(
  prisma: PrismaClient,
  job: { id: string; memoryScopeId: string; periodStart: Date; periodEnd: Date; idempotencyKey: string },
  now: Date,
): Promise<MemoryWorkerResult> {
  const finish = async (
    status: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED",
    message: string,
    extra: { runAt?: Date } = {},
  ): Promise<MemoryWorkerResult> => {
    await prisma.memoryJob.update({
      where: { id: job.id },
      data: {
        status,
        completedAt: status === "RETRY_WAIT" ? null : now,
        lockedAt: null,
        lockedBy: null,
        lastError: status === "SUCCEEDED" || status === "SKIPPED" ? null : message,
        ...(extra.runAt ? { runAt: extra.runAt } : {}),
      },
    });
    return { processed: true, jobId: job.id, status, message };
  };

  const scope = await prisma.memoryScope.findUnique({
    where: { id: job.memoryScopeId },
    select: {
      characterId: true,
      scopeType: true,
      character: {
        select: {
          name: true,
          modelConfig: true,
          memorySetting: { select: { timezone: true } },
        },
      },
    },
  });
  if (!scope) return finish("FAILED", "找不到忆泡任务关联的记忆范围。");

  const chatSettings = resolveChatModelSettings(scope.character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(scope.character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    // 解密失败按「还没配好」处理：留回队列，别让一天的事件就此丢掉。
    return finish("RETRY_WAIT", "角色 API Key 无法解密，忆泡任务稍后重试。", { runAt: new Date(now.getTime() + 10 * 60_000) });
  }
  if (!apiKey || !chatSettings.model) {
    return finish("RETRY_WAIT", "模型未配置，忆泡任务留在队列。", { runAt: new Date(now.getTime() + 10 * 60_000) });
  }

  // 「今天还在长」的核心：一天一行进度，只处理上次抽取之后的新消息。
  const timeZone = scope.character.memorySetting?.timezone ?? "Asia/Shanghai";
  const dayKey = localDayKey(job.periodStart, timeZone);
  const finalize = job.idempotencyKey.startsWith("events-final:");
  const day = await prisma.memoryEventDay.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: job.memoryScopeId, dayKey } },
    select: { state: true, extractedAt: true },
  });
  if (day?.state === "FINAL" && !finalize) {
    return finish("SKIPPED", `${dayKey} 的忆泡已经收口。`);
  }
  // 增量起点：上次抽到哪就从哪继续；收口任务补最后一段。
  const deltaStart = day?.extractedAt && day.extractedAt.getTime() > job.periodStart.getTime()
    ? day.extractedAt
    : job.periodStart;

  const conversations = await prisma.conversation.findMany({
    where: {
      memoryScopeId: job.memoryScopeId,
      // 外部身份范围里可能还挂着历史群会话：私聊忆泡只读 `c:`，别把群聊内容写进某个人的私人时间线。
      ...(scope.scopeType === "EXTERNAL_IDENTITY"
        ? { externalConversationId: { startsWith: "c:" } }
        : {}),
      messages: { some: { occurredAt: { gte: deltaStart, lt: job.periodEnd } } },
    },
    select: { id: true, externalConversationId: true },
  });
  /**
   * 忆泡按天抽取要的是**覆盖**，不是「每会话公平取样」：
   * 快照那套配额（每会话 80 / 全天 250）在一天几百条时会直接把中间整段丢掉
   * （2026-10-31 实测：一晚上 368 条，只喂进 80 条）。这里放宽到「块数 × 每块条数」，
   * 再由下面的分块把它拆成多次模型调用。
   */
  const messages = await loadPeriodSourceMessages(prisma, conversations, deltaStart, job.periodEnd, {
    perConversation: EVENT_AI_CHUNK_SIZE * MAX_EVENT_CHUNKS,
    budget: EVENT_AI_CHUNK_SIZE * MAX_EVENT_CHUNKS,
  });
  if (messages.length === 0) {
    // 没有新消息也要把这一天标成已扫过：收口任务照样要落 FINAL。
    if (finalize) {
      await prisma.memoryEventDay.upsert({
        where: { memoryScopeId_dayKey: { memoryScopeId: job.memoryScopeId, dayKey } },
        create: { memoryScopeId: job.memoryScopeId, dayKey, state: "FINAL", extractedAt: now },
        update: { state: "FINAL", extractedAt: now },
      });
    }
    return finish("SKIPPED", "这一段没有新的对话。");
  }

  // 这一天已经记过的事件：进提示词让模型自己避开，重跑不会把同一件事换个说法再写一遍。
  const existingEvents = await prisma.memoryEvent.findMany({
    where: { memoryScopeId: job.memoryScopeId, dayKey, status: "ACTIVE" },
    orderBy: { occurredAt: "asc" },
    take: 40,
    select: { occurredAt: true, title: true },
  });
  /**
   * 分块抽取。
   *
   * 以前这里只喂 `selectAiMessages` 的 120 条（最早 60 + 最新 60），一整晚 368 条时
   * 中间两百多条**根本没进模型**（2026-10-31 实测：一个晚上只出 5 条忆泡）。
   * 现在按时间顺序切块，每块各调一次模型，事件合并后统一落库：
   * 调用次数变多（几分钱），换来的是不再丢中间那一大段。
   */
  const chunks = splitForEventExtraction(messages, EVENT_AI_CHUNK_SIZE, MAX_EVENT_CHUNKS);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const knownEvents = existingEvents.map((event) => ({
    occurredAt: event.occurredAt.toISOString(),
    title: event.title,
  }));
  let appliedCount = 0;
  let skippedCount = 0;
  try {
    for (const [index, chunk] of chunks.entries()) {
      const aiResult = await analyzeMemoryPeriod({
        apiKey,
        apiBaseUrl: chatSettings.apiBaseUrl,
        model: chatSettings.model,
        periodStart: job.periodStart.toISOString(),
        periodEnd: job.periodEnd.toISOString(),
        timezone: scope.character.memorySetting?.timezone ?? "Asia/Shanghai",
        scopeType: scope.scopeType,
        characterName: scope.character.name,
        messages: chunk.map(toAiMessage),
        totalMessageCount: messages.length,
        omittedMessageCount: Math.max(0, messages.length - chunk.length),
        // 这一趟只要事件：不用长期记忆做 UPDATE 对照，省一半输入。
        activeMemories: [],
        previousSnapshotSummary: null,
        // 已经记过的 + 本次前面几块刚提到的事件，一起让它避开。
        ...(knownEvents.length ? { existingEvents: knownEvents } : {}),
      });
      await recordModelUsage({
        // 单独记成 events：忆泡整理和 8 天快照是两条开销，混在 snapshot 里就分不清
        // 「这天花了多少是整理忆泡花的」。
        kind: "events",
        model: chatSettings.model,
        usage: toUsageTokens(aiResult.usage),
        characterId: scope.characterId,
      });
      /**
       * 每块立刻落库，而不是攒到最后一起写。
       *
       * 六块顺序调用，任何一块超时都会让整个任务进重试 —— 如果事件只在最后统一写入，
       * 前面已经抽出来的那几块全白费（2026-11-01 实测：4 块出 12 条，第 5 块超时 → 0 条落库）。
       * 现在按块提交，重试时靠 dedupeKey / 近义守卫跳过已写入的部分。
       */
      const result = await prisma.$transaction((tx) => applyMemoryEvents(
        tx,
        {
          memoryScopeId: job.memoryScopeId,
          characterId: scope.characterId,
          snapshotId: null,
          timeZone,
          state: finalize ? "FINAL" : "DRAFT",
          // 她自己的名字要从参与者里剔掉：「和谁」不该把「她自己」算进去。
          characterName: scope.character.name,
        },
        aiResult.analysis.events,
        messagesById,
      ));
      appliedCount += result.applied.length;
      skippedCount += result.skipped;
      knownEvents.push(...aiResult.analysis.events.map((draft) => ({
        occurredAt: draft.occurredAt,
        title: draft.title,
      })));
      /**
       * 每块跑完就把水位推到「这一块的最后一条」。
       *
       * 这样后面某块失败进入重试时，下一次从断点继续，而不是把整天重跑一遍
       * （2026-11-01 实测：6 块里第 5 块 JSON 解析失败，重跑要从第 1 块重新烧 token）。
       */
      const chunkEnd = chunk[chunk.length - 1]!.occurredAt;
      await prisma.memoryEventDay.upsert({
        where: { memoryScopeId_dayKey: { memoryScopeId: job.memoryScopeId, dayKey } },
        create: {
          memoryScopeId: job.memoryScopeId,
          dayKey,
          state: finalize ? "FINAL" : "DRAFT",
          eventCount: result.applied.length,
          extractedAt: chunkEnd,
        },
        update: {
          eventCount: { increment: result.applied.length },
          extractedAt: chunkEnd,
        },
      });
      // 一行可观测性日志：跑完能看出「这一块喂了多少、模型给了几条、落了几条」，
      // 少了事件时不用猜是没进模型还是模型没写。
      console.log(
        `[events] ${dayKey} 第 ${index + 1}/${chunks.length} 块：`
        + `输入 ${chunk.length} 条（全天 ${messages.length} 条），`
        + `模型给 ${aiResult.analysis.events.length} 条，落库 ${result.applied.length} 条`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.memoryJob.update({
      where: { id: job.id },
      data: {
        status: "RETRY_WAIT",
        completedAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: detail.slice(0, 700),
        runAt: new Date(now.getTime() + 5 * 60_000),
      },
    });
    return { processed: true, jobId: job.id, status: "RETRY_WAIT", message: detail.slice(0, 300) };
  }

  /**
   * 收口任务把整天的状态落成 FINAL，并把条数对齐成数据库里的真实值。
   *
   * 分块增量会累积 `eventCount`，但重跑/去重跳过之后它和「实际有多少条」会漂移
   * （2026-11-01 实测：实际 29 条，进度行还写着 17）。这里以 count 为准，别让页面上
   * 的「那天几条」长期错着。
   */
  const totalEvents = await prisma.memoryEvent.count({ where: { memoryScopeId: job.memoryScopeId, dayKey } });
  await prisma.memoryEventDay.updateMany({
    where: { memoryScopeId: job.memoryScopeId, dayKey },
    data: { state: finalize ? "FINAL" : "DRAFT", eventCount: totalEvents },
  });

  return finish(
    "SUCCEEDED",
    appliedCount > 0
      ? `整理了 ${appliedCount} 条忆泡（${chunks.length} 块），跳过 ${skippedCount} 条重复或不合格的。`
      : "这一段没有可以落成忆泡的事件。",
  );
}

/**
 * 每天写一篇手账。
 *
 * 和忆泡任务的区别：忆泡是「那天发生了什么」（事实），手账是「她怎么过、怎么想」
 * （主观叙述）。两者读同一批原始消息，但输出不共用 —— 别把忆泡的结果直接抄进手账。
 */
async function runJournalJob(
  prisma: PrismaClient,
  job: {
    id: string;
    memoryScopeId: string;
    idempotencyKey: string;
    journalDayKey?: string | null;
    journalTarget?: string | null;
  },
  now: Date,
): Promise<MemoryWorkerResult> {
  const finish = async (
    status: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED",
    message: string,
    extra: { runAt?: Date } = {},
  ): Promise<MemoryWorkerResult> => {
    await prisma.memoryJob.update({
      where: { id: job.id },
      data: {
        status,
        completedAt: status === "RETRY_WAIT" ? null : now,
        lockedAt: null,
        lockedBy: null,
        lastError: status === "SUCCEEDED" || status === "SKIPPED" ? null : message,
        ...(extra.runAt ? { runAt: extra.runAt } : {}),
      },
    });
    return { processed: true, jobId: job.id, status, message };
  };

  const scope = await prisma.memoryScope.findUnique({
    where: { id: job.memoryScopeId },
    select: { characterId: true, scopeType: true },
  });
  if (!scope) return finish("FAILED", "找不到手账任务关联的记忆范围。");
  const params = readJournalJobParams({
    idempotencyKey: job.idempotencyKey,
    journalDayKey: job.journalDayKey,
    journalTarget: job.journalTarget,
  });
  if (!params.ok) return finish("FAILED", params.error);
  const { dayKey, target } = params;

  try {
    const outcome = await generateJournalForDay({
      characterId: scope.characterId,
      dayKey,
      target,
      mode: "auto",
    }, prisma);
    switch (outcome.status) {
      case "created": {
        const parts = [
          ...(outcome.created?.DIARY ? [`日记第 ${outcome.created.DIARY.version} 版`] : []),
          ...(outcome.created?.HANDBOOK ? [`手账第 ${outcome.created.HANDBOOK.version} 版`] : []),
        ];
        return finish("SUCCEEDED", `写了 ${dayKey} 的${parts.join("、") || "日记/手账"}。`);
      }
      case "skipped":
        return finish("SKIPPED", outcome.reason ?? "这一天没有可写的内容。");
      case "existing":
        return finish("SKIPPED", "这一天的日记/手账已经写过了。");
      case "inactive":
        return finish("SKIPPED", "角色已停用，不写日记/手账。");
      case "not_configured":
        return finish("RETRY_WAIT", outcome.message ?? "模型未配置。", { runAt: new Date(now.getTime() + 30 * 60_000) });
      case "quota_exceeded":
        return finish("RETRY_WAIT", outcome.message ?? "额度已用完。", { runAt: new Date(now.getTime() + 60 * 60_000) });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const latest = await prisma.memoryJob.findUnique({
      where: { id: job.id },
      select: { attemptCount: true, maxAttempts: true },
    });
    const exhausted = Boolean(latest && latest.attemptCount >= latest.maxAttempts);
    const retryDelayMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.max(0, (latest?.attemptCount ?? 1) - 1)));
    await prisma.memoryJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: exhausted ? "FAILED" : "RETRY_WAIT",
        completedAt: exhausted ? now : null,
        lockedAt: null,
        lockedBy: null,
        lastError: detail.slice(0, 700),
        runAt: exhausted ? now : new Date(now.getTime() + retryDelayMs),
      },
    });
    return {
      processed: true,
      jobId: job.id,
      status: exhausted ? "FAILED" : "RETRY_WAIT",
      message: detail.slice(0, 300),
    };
  }
}

const FAILED_JOB_DEPENDENCY_GRACE_MS = 24 * 60 * 60 * 1000;
const RAW_MESSAGE_DEPENDENT_JOB_TYPES = [
  "GENERATE_SNAPSHOT",
  "REGENERATE_SNAPSHOT",
  "EXTRACT_EVENTS",
  "GENERATE_JOURNAL",
] as const;

/**
 * 原始消息清理前，检查是否还有消费这段历史的未完成任务。
 *
 * QUEUED / RUNNING / RETRY_WAIT 一律等待；FAILED 只在一个宽限期内等待，
 * 避免模型没配置之类的永久失败把原始消息永远钉住。超过宽限期仍未重试的
 * 任务视为已放弃，清理继续（任务监控里仍可看到失败记录）。
 */
async function findBlockingRawMessageJob(
  db: Pick<PrismaClient, "memoryJob">,
  memoryScopeId: string,
  cutoff: Date,
  now: Date,
) {
  const failedGraceCutoff = new Date(now.getTime() - FAILED_JOB_DEPENDENCY_GRACE_MS);
  return db.memoryJob.findFirst({
    where: {
      memoryScopeId,
      type: { in: [...RAW_MESSAGE_DEPENDENT_JOB_TYPES] },
      periodStart: { lt: cutoff },
      OR: [
        { status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] } },
        { status: "FAILED", updatedAt: { gte: failedGraceCutoff } },
      ],
    },
    select: { id: true, type: true, status: true },
  });
}

/**
 * 把租约过期的 RUNNING 任务放回队列；尝试次数用完的直接判失败。
 *
 * 这只是「谁领任务谁先擦一遍桌子」，不是一个独立进程 —— 所以**必须有东西在领任务**：
 * 整机没有 Worker 在跑时，卡住的任务不会自己回来（页面上就是永远「运行中」）。
 * 那种情况下由任务监控的手动重新入队兜底（`server/api/tasks/[id]/retry.post.ts`）。
 *
 * 归还时必须带上 `lockedAt < staleBefore` 这个条件：不然会把刚刚被别的 Worker 领走、
 * 已经换了新租约的任务也一起打回队列，两个 Worker 就会同时跑同一条。
 */
export async function reclaimExpiredMemoryJobs(
  prisma: PrismaClient,
  options: { now?: Date; ownerId?: string } = {},
): Promise<{ recovered: number; failed: number }> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - MEMORY_JOB_LEASE_MS);
  const staleJobs = await prisma.memoryJob.findMany({
    where: {
      type: { in: [...LEASE_RECOVERABLE_JOB_TYPES] },
      status: "RUNNING",
      lockedAt: { lt: staleBefore },
      ...ownerFilter(options.ownerId),
    },
    select: { id: true, attemptCount: true, maxAttempts: true },
    take: 100,
  });
  let recovered = 0;
  let failed = 0;
  for (const stale of staleJobs) {
    const exhausted = stale.attemptCount >= stale.maxAttempts;
    const result = await prisma.memoryJob.updateMany({
      where: { id: stale.id, status: "RUNNING", lockedAt: { lt: staleBefore } },
      data: {
        status: exhausted ? "FAILED" : "RETRY_WAIT",
        runAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: "任务执行租约已过期，系统已恢复该任务的队列状态。",
        completedAt: exhausted ? now : null,
      },
    });
    if (result.count !== 1) continue;
    if (exhausted) failed += 1;
    else recovered += 1;
  }
  return { recovered, failed };
}

export async function processNextMemoryJob(
  prisma: PrismaClient,
  options: WorkerOptions = {},
): Promise<MemoryWorkerResult> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const ownership = ownerFilter(options.ownerId);

  // Retention jobs are safe to replay: deleting an already deleted message is a no-op.
  // Foreign keys preserve snapshot/source records while nulling links to expired raw messages.
  const cleanupCandidates = await prisma.memoryJob.findMany({
    where: {
      type: "CLEAN_EXPIRED_MESSAGES",
      status: { in: ["QUEUED", "RETRY_WAIT"] },
      runAt: { lte: now },
      ...ownership,
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 20,
    select: { id: true, status: true, memoryScopeId: true, periodEnd: true, attemptCount: true, maxAttempts: true },
  });
  let deferredCleanupResult: MemoryWorkerResult | null = null;
  for (const candidate of cleanupCandidates) {
    if (!candidate.periodEnd) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: { status: "FAILED", completedAt: now, lastError: "原始消息清理任务缺少截止时间。" },
      });
      continue;
    }
    if (candidate.attemptCount >= candidate.maxAttempts) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: "FAILED",
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: "任务已达到最大尝试次数。",
        },
      });
      continue;
    }
    const claim = await prisma.memoryJob.updateMany({
      where: { id: candidate.id, status: candidate.status, runAt: { lte: now } },
      data: { status: "RUNNING", attemptCount: { increment: 1 }, lockedAt: now, lockedBy: workerId, startedAt: now, lastError: null },
    });
    if (claim.count !== 1) continue;

    const scope = await prisma.memoryScope.findUnique({
      where: { id: candidate.memoryScopeId },
      select: {
        characterId: true,
        character: {
          select: {
            memorySetting: {
              select: {
                rawMessageCleanupEnabled: true,
                rawMessageRetentionDays: true,
              },
            },
          },
        },
      },
    });
    if (!scope) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: { status: "FAILED", completedAt: now, lockedAt: null, lockedBy: null, lastError: "找不到清理任务关联的记忆范围。" },
      });
      return { processed: true, jobId: candidate.id, status: "FAILED", message: "找不到清理任务关联的记忆范围。" };
    }

    const currentRetentionDays = scope.character.memorySetting?.rawMessageRetentionDays;
    const currentCutoff = scope.character.memorySetting?.rawMessageCleanupEnabled &&
      currentRetentionDays && currentRetentionDays > 0
      ? new Date(now.getTime() - currentRetentionDays * 24 * 60 * 60 * 1000)
      : null;
    if (!currentCutoff || candidate.periodEnd.getTime() > currentCutoff.getTime()) {
      const reason = !currentCutoff
        ? "当前角色尚未明确授权原始消息自动清理，或已选择永久保留；该旧任务已取消，未删除原始消息。"
        : "原始消息保留期限已放宽，当前任务的截止范围比最新策略更激进；该旧任务已取消，未删除原始消息。";
      const cancelled = await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "CANCELLED",
          attemptCount: { decrement: 1 },
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: reason,
        },
      });
      if (cancelled.count === 1) {
        return { processed: true, jobId: candidate.id, status: "CANCELLED", message: reason };
      }
      continue;
    }

    const pendingDependency = await findBlockingRawMessageJob(
      prisma,
      candidate.memoryScopeId,
      candidate.periodEnd,
      now,
    );
    if (pendingDependency) {
      const deferred = await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "RETRY_WAIT",
          // This is a dependency wait, not a failed cleanup attempt.
          attemptCount: { decrement: 1 },
          runAt: new Date(now.getTime() + 60_000),
          lockedAt: null,
          lockedBy: null,
          completedAt: null,
          lastError: "仍有更早的归档/忆泡/手账任务待处理，清理已延后。",
        },
      });
      if (deferred.count === 1) {
        deferredCleanupResult ??= { processed: true, jobId: candidate.id, status: "RETRY_WAIT", message: "仍有过期区间的归档/忆泡/手账任务待处理，已延后清理。" };
      }
      continue;
    }

    try {
      // Keep the deletion, job completion, and audit record in one transaction.
      // Lock/verify ownership first so a stale or displaced worker cannot delete content.
      const deletedCount = await prisma.$transaction(async (tx) => {
        const claim = await tx.memoryJob.updateMany({
          where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
          data: { lastError: null },
        });
        if (claim.count !== 1) {
          throw new Error("清理任务租约已失效；拒绝删除原始消息。");
        }
        // Lock the current policy row so a concurrent settings change cannot
        // revoke authorization between this check and the irreversible delete.
        const policyRows = await tx.$queryRaw<Array<{
          rawMessageCleanupEnabled: boolean;
          rawMessageRetentionDays: number | null;
        }>>`
          SELECT "rawMessageCleanupEnabled", "rawMessageRetentionDays"
          FROM "character_memory_settings"
          WHERE "characterId" = ${scope.characterId}::uuid
          FOR UPDATE
        `;
        const latestPolicy = policyRows[0] ?? null;
        const latestRetentionDays = latestPolicy?.rawMessageRetentionDays;
        const latestCutoff = latestPolicy?.rawMessageCleanupEnabled &&
          latestRetentionDays && latestRetentionDays > 0
          ? new Date(now.getTime() - latestRetentionDays * 24 * 60 * 60 * 1000)
          : null;
        if (!latestCutoff || candidate.periodEnd!.getTime() > latestCutoff.getTime()) {
          throw new Error("CLEANUP_POLICY_CHANGED");
        }
        // 检查与删除之间仍可能有任务被重新入队；不可逆删除前再确认一次。
        // 先锁住任务表：插入/更新任务的事务会等到清理提交，避免「刚检查完又插进来」。
        await tx.$executeRawUnsafe('LOCK TABLE "memory_jobs" IN EXCLUSIVE MODE');
        const dependency = await findBlockingRawMessageJob(tx, candidate.memoryScopeId, candidate.periodEnd!, now);
        if (dependency) {
          throw new Error("CLEANUP_DEPENDENCY_APPEARED");
        }

        /**
         * 私聊不进清理。
         *
         * 私聊量小，而且是「她这一天的记忆」的一部分：忆泡按天从私聊记录里取事件，
         * 清理掉原文就等于把还没整理的那几天直接抹了。群聊仍按角色保留策略走；
         * 桌面本地对话不属于 `c:` 会话，保持原行为。
         */
        const privateConversations = await tx.conversation.findMany({
          where: {
            memoryScopeId: candidate.memoryScopeId,
            externalConversationId: { startsWith: "c:" },
          },
          select: { id: true },
        });
        const privateConversationIds = privateConversations.map((conversation) => conversation.id);
        const preservePrivate = privateConversationIds.length
          ? { conversationId: { notIn: privateConversationIds } }
          : {};

        /**
         * 分层清理：纯上下文行只保留 7 天，证据类（她回了话 / 被点名）按角色设置的保留天数走。
         *
         * 上下文行有两档，都要算进来：
         * - `silent`：她看过但没开口的那一轮；
         * - `context`：主人在群里说的话（这一轮没接她，但私聊里要能接上，见
         *   `cross-channel-context.ts`）。它只服务「刚才」那两小时，留一个月没有意义，
         *   而且会跟着群消息量一路涨。
         *
         * 真正需要留证的是她参与过的那部分。两个窗口都受同一个清理开关约束。
         *
         * Prisma 的 JSON 过滤器没有 `in`，两档只能写成 OR —— 别改成对 metadata 取字符串比较，
         * 那会把整列当作一个字符串去匹配，一条都删不掉（静默失效，只在库里越积越多）。
         */
        const contextRetentionDays = Math.min(CONTEXT_RETENTION_DAYS, latestRetentionDays ?? CONTEXT_RETENTION_DAYS);
        const contextCutoff = new Date(now.getTime() - contextRetentionDays * 24 * 60 * 60 * 1000);
        const removedContext = await tx.message.deleteMany({
          where: {
            conversation: { is: { memoryScopeId: candidate.memoryScopeId } },
            ...preservePrivate,
            occurredAt: { lt: contextCutoff },
            OR: [
              { metadata: { path: ["storedReason"], equals: "silent" } },
              { metadata: { path: ["storedReason"], equals: "context" } },
            ],
          },
        });

        const deleted = await tx.message.deleteMany({
          where: {
            conversation: { is: { memoryScopeId: candidate.memoryScopeId } },
            ...preservePrivate,
            occurredAt: { lt: candidate.periodEnd! },
          },
        });
        await tx.memoryJob.update({
          where: { id: candidate.id },
          data: { status: "SUCCEEDED", completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
        });
        await tx.auditLog.create({
          data: {
            actorType: "WORKER",
            characterId: scope.characterId,
            action: "message.retention_cleanup",
            entityType: "MemoryScope",
            entityId: candidate.memoryScopeId,
            details: { cutoff: candidate.periodEnd!.toISOString(), deletedMessages: deleted.count, contextMessages: removedContext.count, contextCutoff: contextCutoff.toISOString(), jobId: candidate.id },
          },
        });
        return deleted.count;
      });
      return { processed: true, jobId: candidate.id, status: "SUCCEEDED", message: `原始消息清理完成，删除 ${deletedCount} 条过期消息；阶段总结与来源记录已保留。` };
    } catch (error) {
      if (error instanceof Error && error.message === "CLEANUP_POLICY_CHANGED") {
        const message = "清理策略已变更或尚未授权；该任务已取消，未删除原始消息。";
        const cancelled = await prisma.memoryJob.updateMany({
          where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
          data: {
            status: "CANCELLED",
            attemptCount: { decrement: 1 },
            runAt: now,
            lockedAt: null,
            lockedBy: null,
            lastError: message,
            completedAt: now,
          },
        });
        if (cancelled.count === 1) {
          return { processed: true, jobId: candidate.id, status: "CANCELLED", message };
        }
        return { processed: false, message: "清理任务状态已变化，未删除原始消息。" };
      }
      if (error instanceof Error && error.message === "CLEANUP_DEPENDENCY_APPEARED") {
        const message = "清理前出现新的归档/忆泡/手账任务，已延后，未删除原始消息。";
        const deferred = await prisma.memoryJob.updateMany({
          where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
          data: {
            status: "RETRY_WAIT",
            attemptCount: { decrement: 1 },
            runAt: new Date(now.getTime() + 60_000),
            lockedAt: null,
            lockedBy: null,
            completedAt: null,
            lastError: message,
          },
        });
        if (deferred.count === 1) {
          return { processed: true, jobId: candidate.id, status: "RETRY_WAIT", message };
        }
        return { processed: false, message: "清理任务状态已变化，未删除原始消息。" };
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      const attemptCount = candidate.attemptCount + 1;
      const exhausted = attemptCount >= candidate.maxAttempts;
      const status: "FAILED" | "RETRY_WAIT" = exhausted ? "FAILED" : "RETRY_WAIT";
      const retryDelayMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attemptCount - 1)));
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status,
          runAt: exhausted ? now : new Date(now.getTime() + retryDelayMs),
          lockedAt: null,
          lockedBy: null,
          lastError: exhausted ? `原始消息清理失败，已达到最大尝试次数：${message}` : message,
          completedAt: exhausted ? now : null,
        },
      });
      return {
        processed: true,
        jobId: candidate.id,
        status,
        message: exhausted
          ? `原始消息清理失败，已达到最大尝试次数：${message}`
          : `原始消息清理失败，将稍后重试：${message}`,
      };
    }
  }

  if (deferredCleanupResult) return deferredCleanupResult;

  // 领取之前先回收：过期租约 = 领走它的进程已经不在了，任务必须回到队列，否则它会一直显示「运行中」。
  await reclaimExpiredMemoryJobs(prisma, { now, ...(options.ownerId ? { ownerId: options.ownerId } : {}) });

  const candidates = await prisma.memoryJob.findMany({
    where: {
      type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "EXTRACT_EVENTS", "GENERATE_JOURNAL"] },
      status: { in: ["QUEUED", "RETRY_WAIT"] },
      runAt: { lte: now },
      ...ownership,
    },
    orderBy: [{ runAt: "asc" }, { periodEnd: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      type: true,
      status: true,
      attemptCount: true,
      maxAttempts: true,
      memoryScope: { select: { character: { select: { modelConfig: true } } } },
    },
  });

  const configuredCandidates = candidates.filter((candidate) => isMemoryModelConfigured(candidate.memoryScope.character.modelConfig));
  if (configuredCandidates.length === 0 && candidates.length > 0) {
    return {
      processed: false,
      message: "待处理阶段总结关联的角色尚未配置模型 API。请打开该角色的 AI 对话 → 模型参数填写 API 地址、Key 和模型名称；任务会保留在队列中。",
    };
  }

  let claimedJobId = "";
  for (const candidate of configuredCandidates) {
    if (candidate.attemptCount >= candidate.maxAttempts) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: "FAILED",
          completedAt: now,
          lastError: "任务已达到最大尝试次数。",
          lockedAt: null,
          lockedBy: null,
        },
      });
      continue;
    }

    const claim = await prisma.memoryJob.updateMany({
      where: { id: candidate.id, status: candidate.status, runAt: { lte: now } },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
        lockedAt: now,
        lockedBy: workerId,
        startedAt: now,
        lastError: null,
      },
    });
    if (claim.count === 1) {
      claimedJobId = candidate.id;
      break;
    }
  }

  if (!claimedJobId) return { processed: false, message: "当前没有可领取的周期归档任务。" };

  try {
    const job = await prisma.memoryJob.findUnique({
      where: { id: claimedJobId },
      select: {
        id: true,
        type: true,
        snapshotId: true,
        memoryScopeId: true,
        idempotencyKey: true,
        journalDayKey: true,
        journalTarget: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        lockedBy: true,
        attemptCount: true,
      },
    });
    if (!job || job.status !== "RUNNING" || job.lockedBy !== workerId) {
      throw new Error("任务已不属于当前 Worker，拒绝继续执行。");
    }
    if (!job.periodStart || !job.periodEnd || job.periodStart >= job.periodEnd) {
      throw new Error("周期任务缺少有效的起止时间。");
    }

    // 忆泡按天整理：和 8 天快照无关，走单独分支，不碰快照与长期记忆。
    if (job.type === "EXTRACT_EVENTS") {
      return await runDailyEventJob(prisma, {
        id: job.id,
        memoryScopeId: job.memoryScopeId,
        periodStart: job.periodStart,
        periodEnd: job.periodEnd,
        idempotencyKey: job.idempotencyKey,
      }, now);
    }

    // 手账也是按天的独立流水线：只写 character_journals，不碰忆泡/长期记忆。
    if (job.type === "GENERATE_JOURNAL") {
      return await runJournalJob(prisma, {
        id: job.id,
        memoryScopeId: job.memoryScopeId,
        idempotencyKey: job.idempotencyKey,
        journalDayKey: job.journalDayKey,
        journalTarget: job.journalTarget,
      }, now);
    }

    const isRegeneration = job.type === "REGENERATE_SNAPSHOT";
    let logicalSnapshotKey = job.idempotencyKey;

    if (isRegeneration) {
      if (!job.snapshotId) throw new Error("AI 重新提炼任务缺少原始总结 ID。");
      const regenerationTarget = await prisma.memorySnapshot.findFirst({
        where: { id: job.snapshotId, memoryScopeId: job.memoryScopeId },
        select: { id: true, snapshotKey: true, kind: true, periodStart: true, periodEnd: true },
      });
      if (!regenerationTarget || regenerationTarget.kind !== "AUTOMATIC") {
        throw new Error("AI 重新提炼只能针对仍保留在数据库中的自动归档。");
      }
      if (
        regenerationTarget.periodStart.getTime() !== job.periodStart.getTime() ||
        regenerationTarget.periodEnd.getTime() !== job.periodEnd.getTime()
      ) {
        throw new Error("重新提炼任务的周期范围与原始总结不一致。");
      }
      logicalSnapshotKey = regenerationTarget.snapshotKey;
    } else {
      const priorSnapshot = await prisma.memorySnapshot.findFirst({
        where: { snapshotKey: job.idempotencyKey, memoryScopeId: job.memoryScopeId },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (priorSnapshot) {
        await prisma.memoryJob.updateMany({
          where: { id: job.id, status: "RUNNING", lockedBy: workerId },
          data: { status: "SUCCEEDED", snapshotId: priorSnapshot.id, completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
        });
        return { processed: true, jobId: job.id, status: "SUCCEEDED", snapshotId: priorSnapshot.id, message: "检测到相同周期已有总结，已复用历史结果。" };
      }
    }
    const messageWhere = {
      conversation: { is: { memoryScopeId: job.memoryScopeId } },
      occurredAt: { gte: job.periodStart, lt: job.periodEnd },
    };
    const memoryActivityWhere = {
      memoryScopeId: job.memoryScopeId,
      status: { not: "TRASHED" as const },
      OR: [
        { createdAt: { gte: job.periodStart, lt: job.periodEnd } },
        { updatedAt: { gte: job.periodStart, lt: job.periodEnd } },
      ],
    };

    // 先列本周期内有消息的会话，来源再按会话配额取 —— 不能再用「整个范围按时间取前后各 125 条」：
    // 一个热闹的群就能把私聊整个挤出窗口，总结只剩群里与她无关的闲话。
    // 会话也一样：一对一（私聊/本地）永远排在群聊前面，不能靠 lastMessageAt 硬排 —— 群多了
    // 之后私聊会话会被挤到第 12 名开外，直接从会话级消失。所以非群聊会话先全量取，
    // 剩下的名额再按最近活跃度给群会话。
    const periodBaseWhere = {
      memoryScopeId: job.memoryScopeId,
      messages: { some: { occurredAt: { gte: job.periodStart, lt: job.periodEnd } } },
    };
    const [directConversations, groupConversations] = await Promise.all([
      prisma.conversation.findMany({
        where: { ...periodBaseWhere, OR: [
          { externalConversationId: null },
          { externalConversationId: { startsWith: "c:" } },
        ] },
        orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
        select: { id: true, externalConversationId: true },
      }),
      prisma.conversation.findMany({
        where: { ...periodBaseWhere, externalConversationId: { startsWith: "g:" } },
        orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
        take: MAX_SCOPE_CONVERSATIONS,
        select: { id: true, externalConversationId: true },
      }),
    ]);
    const periodConversations = [...directConversations, ...groupConversations];

    const [messageCount, eventCount, memoryActivityCount, activeItems, scope, previousSnapshot] = await Promise.all([
      prisma.message.count({ where: messageWhere }),
      prisma.message.count({ where: { ...messageWhere, eventType: { not: "message" } } }),
      prisma.memoryItem.count({ where: memoryActivityWhere }),
      prisma.memoryItem.findMany({
        where: {
          memoryScopeId: job.memoryScopeId,
          status: "ACTIVE",
          // AI-created memories use the evidence timestamp as validFrom. Do not
          // filter by createdAt/updatedAt: backfilled jobs may write those later.
          OR: [
            { validFrom: { lte: job.periodEnd } },
            { validFrom: null, createdAt: { lte: job.periodEnd } },
          ],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: MAX_SOURCE_MEMORIES,
        select: {
          id: true, category: true, content: true, confidence: true,
          validFrom: true, validTo: true, createdAt: true,
        },
      }),
      prisma.memoryScope.findUnique({
        where: { id: job.memoryScopeId },
        select: {
          id: true,
          scopeType: true,
          characterId: true,
          character: { select: { name: true, modelConfig: true, memorySetting: { select: { timezone: true } } } },
        },
      }),
      prisma.memorySnapshot.findFirst({
        where: {
          memoryScopeId: job.memoryScopeId,
          periodEnd: { lte: job.periodStart },
          status: "CURRENT",
        },
        orderBy: [{ periodEnd: "desc" }, { version: "desc" }],
        select: { summary: true, periodEnd: true },
      }),
    ]);

    if (!scope) throw new Error("找不到任务关联的记忆范围。");

    /**
     * 主人私聊：顺带读角色全局记忆。
     *
     * 两个用途：① 模型能看到「以前记着不会发语音」这类旧全局事实，在证据推翻时
     * INVALIDATE 它；② 模型知道哪些事该用 `scope: "character"` 写进全局（生日、
     * 名字、能力、稳定喜好），群聊才读得到。
     *
     * **只对 USER_PRIVATE 开放**：普通群友的私聊（EXTERNAL_IDENTITY）不传，
     * 不能让一个人的说法覆盖角色全局记忆。
     */
    type SnapshotMemoryRow = (typeof activeItems)[number];
    let globalScope: { id: string } | null = null;
    let globalItems: SnapshotMemoryRow[] = [];
    if (scope.scopeType === "USER_PRIVATE") {
      globalScope = await prisma.memoryScope.findFirst({
        where: { characterId: scope.characterId, scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
      });
      if (globalScope) {
        globalItems = await prisma.memoryItem.findMany({
          where: {
            memoryScopeId: globalScope.id,
            status: "ACTIVE",
            OR: [
              { validFrom: { lte: job.periodEnd } },
              { validFrom: null, createdAt: { lte: job.periodEnd } },
            ],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: MAX_AI_MEMORIES,
          select: {
            id: true, category: true, content: true, confidence: true,
            validFrom: true, validTo: true, createdAt: true,
          },
        });
      }
    }

    if (messageCount === 0 && memoryActivityCount === 0) {
      await prisma.memoryJob.updateMany({
        where: { id: job.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "SKIPPED",
          completedAt: now,
          lastError: "该周期内没有已保存的对话消息、平台事件或长期记忆变更。",
          lockedAt: null,
          lockedBy: null,
        },
      });
      return { processed: true, jobId: job.id, status: "SKIPPED", message: "周期内无已保存活动，已跳过总结生成。" };
    }

    // 按会话配额取来源：每个会话先保住自己最新的一条，再在总预算内按时间填满。
    const sourceMessages = await loadPeriodSourceMessages(
      prisma, periodConversations, job.periodStart, job.periodEnd,
    );
    const aiMessages = selectAiMessages(sourceMessages);
    // activeItems is newest-first, so the model sees the latest memory state.
    const aiMemoryContext = activeItems.slice(0, MAX_AI_MEMORIES).map((item) => ({
      id: item.id,
      category: item.category,
      content: item.content.slice(0, 800),
      confidence: item.confidence,
      validFrom: item.validFrom?.toISOString() ?? null,
      validTo: item.validTo?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    }));
    const globalAiMemoryContext = globalItems.slice(0, MAX_AI_MEMORIES).map((item) => ({
      id: item.id,
      category: item.category,
      content: item.content.slice(0, 800),
      confidence: item.confidence,
      validFrom: item.validFrom?.toISOString() ?? null,
      validTo: item.validTo?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    }));

    // 周期内已经整理好的忆泡：快照拿它当「发生过什么」的权威时间线，
    // 不再从零散消息重造事件（两套规则各写一遍，同一天会被判两次）。
    const periodEvents = await prisma.memoryEvent.findMany({
      where: {
        memoryScopeId: job.memoryScopeId,
        status: "ACTIVE",
        occurredAt: { gte: job.periodStart, lt: job.periodEnd },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 80,
      select: { id: true, occurredAt: true, title: true, detail: true, participants: true },
    });

    // The model call deliberately happens outside a database transaction.
    const chatSettings = resolveChatModelSettings(scope.character.modelConfig);
    const apiKey = await resolveCharacterApiKey(scope.character.modelConfig, chatSettings.apiBaseUrl);
    if (!apiKey || !chatSettings.model) {
      throw new Error("角色尚未配置模型 API。请先在角色的 AI 对话 → 模型参数中填写 API Key 与模型名称。");
    }
    const aiResult = await analyzeMemoryPeriod({
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      model: chatSettings.model,
      periodStart: job.periodStart.toISOString(),
      periodEnd: job.periodEnd.toISOString(),
      timezone: scope.character.memorySetting?.timezone ?? "UTC",
      scopeType: scope.scopeType,
      characterName: scope.character.name,
      messages: aiMessages,
      totalMessageCount: messageCount,
      omittedMessageCount: Math.max(0, messageCount - aiMessages.length),
      activeMemories: aiMemoryContext,
      ...(globalAiMemoryContext.length ? { globalMemories: globalAiMemoryContext } : {}),
      allowGlobalMemory: Boolean(globalScope),
      previousSnapshotSummary: previousSnapshot?.summary ?? null,
      // 忆泡由按天任务负责：快照只读 periodEvents 做总结，不再产出 events。
      emitEvents: false,
      // 朋友范围顺带产候选备注：这个范围就是「她 × 某个人」，趁提炼顺手让她想「我平时怎么叫对方」。
      emitFriendAliases: scope.scopeType === "EXTERNAL_IDENTITY",
      ...(periodEvents.length
        ? {
            periodEvents: periodEvents.map((event) => ({
              id: event.id,
              occurredAt: event.occurredAt.toISOString(),
              title: event.title,
              detail: event.detail,
              participants: event.participants,
            })),
          }
        : {}),
    });

    // 记账放在事务之前：模型已经调用过，后面事务失败也不能漏掉这笔花费。
    await recordModelUsage({
      kind: "snapshot",
      model: chatSettings.model,
      usage: toUsageTokens(aiResult.usage),
      characterId: scope.characterId,
    });

    const outcome = await prisma.$transaction(async (tx) => {
      const latestJob = await tx.memoryJob.findUnique({
        where: { id: job.id },
        select: { status: true, lockedBy: true },
      });
      if (latestJob?.status !== "RUNNING" || latestJob.lockedBy !== workerId) {
        throw new Error("任务租约已失效；拒绝提交模型结果。");
      }

      if (!isRegeneration) {
        const racedSnapshot = await tx.memorySnapshot.findFirst({
          where: { snapshotKey: job.idempotencyKey, memoryScopeId: job.memoryScopeId },
          orderBy: [{ version: "desc" }, { createdAt: "desc" }],
          select: { id: true },
        });
        if (racedSnapshot) {
          await tx.memoryJob.update({
            where: { id: job.id },
            data: { status: "SUCCEEDED", snapshotId: racedSnapshot.id, completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
          });
          return { status: "SUCCEEDED" as const, snapshotId: racedSnapshot.id, message: "同一周期已由其他执行完成，复用已有总结。" };
        }
      }

      const latestSnapshot = await tx.memorySnapshot.findFirst({
        where: { snapshotKey: logicalSnapshotKey, memoryScopeId: job.memoryScopeId },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { version: true },
      });
      const nextSnapshotVersion = isRegeneration ? (latestSnapshot?.version ?? 0) + 1 : 1;

      if (isRegeneration) {
        await tx.memorySnapshot.updateMany({
          where: { snapshotKey: logicalSnapshotKey, memoryScopeId: job.memoryScopeId, status: "CURRENT" },
          data: { status: "SUPERSEDED" },
        });
      }
      const structuredContent = {
        generatedBy: "llm",
        generationMode: isRegeneration ? "REGENERATE" : "GENERATE",
        capturedAt: now.toISOString(),
        period: {
          start: job.periodStart!.toISOString(),
          end: job.periodEnd!.toISOString(),
          timezone: scope.character.memorySetting?.timezone ?? "UTC",
          interval: "[start, end)",
        },
        counts: {
          messageCount,
          eventCount,
          storedSourceMessageCount: sourceMessages.length,
          aiAnalyzedMessageCount: aiMessages.length,
          omittedMessageCount: Math.max(0, messageCount - aiMessages.length),
          memoryActivityCount,
        },
        model: {
          name: aiResult.model,
          provider: aiResult.provider,
          promptTemplateVersion: aiResult.promptTemplateVersion,
          ...(aiResult.usage ? { usage: aiResult.usage } : {}),
        },
        analysis: aiResult.analysis,
        activeMemoriesConsidered: aiMemoryContext.map((item) => item.id),
        memoryChangesApplied: [] as Array<Record<string, unknown>>,
        note: isRegeneration
          ? "AI 重新提炼版本；为避免历史重放改写当前长期记忆，本次提出的长期记忆变化仅供审核，不会自动应用。"
          : "AI 提炼结果；每条被采纳的新长期记忆都关联至少一条本周期原始消息。",
      };

      const snapshot = await tx.memorySnapshot.create({
        data: {
          snapshotKey: logicalSnapshotKey,
          memoryScopeId: job.memoryScopeId,
          kind: "AUTOMATIC",
          version: nextSnapshotVersion,
          periodStart: job.periodStart!,
          periodEnd: job.periodEnd!,
          summary: aiResult.analysis.summary,
          structuredContent: structuredContent as never,
          status: "CURRENT",
          modelMetadata: {
            provider: aiResult.provider,
            model: aiResult.model,
            promptTemplateVersion: aiResult.promptTemplateVersion,
            ...(aiResult.usage ? { usage: aiResult.usage } : {}),
          },
          generatedAt: now,
          sources: {
            create: [
              ...sourceMessages.map((message) => ({
                sourceType: message.eventType === "message" ? "MESSAGE" as const : "PLATFORM_EVENT" as const,
                sourceRef: message.id,
                messageId: message.id,
              })),
              ...activeItems.map((item) => ({
                sourceType: "MEMORY_ITEM" as const,
                sourceRef: item.id,
                memoryItemId: item.id,
              })),
            ],
          },
        },
        select: { id: true },
      });

      const currentItems = new Map(activeItems.map((item) => [item.id, item]));
      const eligibleModelMemoryIds = new Set(aiMemoryContext.map((item) => item.id));
      const handledMemoryIds = new Set<string>();
      // 全局范围的对账状态。只有主人私聊才可能有；没传就整段为空。
      const globalCurrentItems = new Map(globalItems.map((item) => [item.id, item]));
      const globalEligibleModelMemoryIds = new Set(globalAiMemoryContext.map((item) => item.id));
      const globalHandledMemoryIds = new Set<string>();
      const globalExistingDedupeKeys = new Set<string>();
      const globalExistingItemSignatures = new Set(
        globalItems.map((item) => item.category + ":" + normalizeMemoryText(item.content)),
      );
      const globalExistingItems = globalItems.map((item) => ({
        id: item.id,
        category: item.category,
        content: item.content,
      }));
      const appliedChanges: Array<Record<string, unknown>> = [];
      const messagesById = new Map(sourceMessages.map((message) => [message.id, message]));
      const existingDedupeKeys = new Set<string>();
      const existingItemSignatures = new Set(
        activeItems.map((item) => item.category + ":" + normalizeMemoryText(item.content)),
      );
      // 近似判重用的底表：同范围里还在生效的条目。判重逻辑在 applyMemoryChange 里。
      const existingItems = activeItems.map((item) => ({
        id: item.id,
        category: item.category,
        content: item.content,
      }));

      // 模型提出但没通过校验的条数。没有这个数字，人分不清「模型没提」和「提了但不合格」。
      let rejectedChangeCount = 0;

      // 候选备注：朋友范围里模型顺带提的「她想给这个人起的叫法」，落待审队列。
      // 归一化沿用 friend-aliases 的口径（截断/去重），aliasKey 交给唯一约束挡重复。
      // 用 createMany + skipDuplicates：同一条（含已否掉的 REJECTED）不再重复落库，
      // 否则用户否掉的外号下个周期又被提回来、弹窗永远清不空。
      // 失败静默 —— 快照本身已经成功，起外号是搭便车，不该因为它把整份快照判失败。
      const aliasRows = aiResult.analysis.friendAliases
        .map((suggestion) => {
          const normalized = normalizeFriendAliases(suggestion.alias);
          const alias = normalized.aliases[0];
          return alias
            ? { scopeId: job.memoryScopeId, alias, aliasKey: alias.toLowerCase(), reason: suggestion.reason.slice(0, 200), status: "PENDING" }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
      if (aliasRows.length) {
        await tx.friendAliasSuggestion.createMany({ data: aliasRows, skipDuplicates: true }).catch(() => undefined);
      }

      // 忆泡不再由快照写：它是按天任务的职责。两套规则各写一遍时，同一天会被判两次，
      // 而且周期快照看不到「今天还在长」的 DRAFT。这里固定为空，模型也不再被要求产出。
      const eventResult = { applied: [] as Array<{ id: string; title: string; occurredAt: string }>, skipped: 0 };

      for (const change of aiResult.analysis.memoryChanges) {
        // 置信度门槛必须排在重新提炼分支之前：审核清单是最需要人看的一份数据，
        // 不能变成唯一一条绕过 MIN_MEMORY_CONFIDENCE 的路径。
        if (!validConfidence(change)) {
          rejectedChangeCount += 1;
          continue;
        }
        const evidence = change.evidenceMessageIds
          .map((id) => messagesById.get(id))
          .filter((message): message is NonNullable<typeof message> => Boolean(message));
        if (evidence.length === 0) {
          rejectedChangeCount += 1;
          continue;
        }

        if (isRegeneration) {
          // relatedMemoryId 已由 memory-ai 校验过属于本轮输入记忆，直接取当期快照里的原文做对照。
          const relatedItem = change.relatedMemoryId
            ? currentItems.get(change.relatedMemoryId) ?? globalCurrentItems.get(change.relatedMemoryId) ?? null
            : null;
          appliedChanges.push({
            action: change.action,
            result: "NOT_APPLIED_REGENERATION",
            category: change.category,
            content: change.content,
            confidence: change.confidence,
            // 只留本周期真实存在、能回溯到原文的证据，UI 的「依据 #N」才对得上来源列表。
            evidenceMessageIds: evidence.map((message) => message.id),
            ...(change.relatedMemoryId ? { supersededMemoryId: change.relatedMemoryId } : {}),
            ...(relatedItem
              ? { supersededCategory: relatedItem.category, supersededContent: relatedItem.content }
              : {}),
          });
          continue;
        }

        const applied = await applyMemoryChange(
          tx,
          {
            memoryScopeId: job.memoryScopeId,
            characterId: scope.characterId,
            snapshotId: snapshot.id,
            actorType: "WORKER",
            auditActionPrefix: "memory.ai_",
            // 自动生成用周期时点的记忆快照做对照；人工采纳才用数据库里的最新值。
            resolvePrevious: async (memoryId) => currentItems.get(memoryId) ?? null,
            canTarget: (memoryId) => eligibleModelMemoryIds.has(memoryId),
            handledMemoryIds,
            existingItemSignatures,
            existingItems,
            existingDedupeKeys,
            ...(globalScope
              ? {
                  global: {
                    memoryScopeId: globalScope.id,
                    resolvePrevious: async (memoryId: string) => globalCurrentItems.get(memoryId) ?? null,
                    canTarget: (memoryId: string) => globalEligibleModelMemoryIds.has(memoryId),
                    handledMemoryIds: globalHandledMemoryIds,
                    existingItemSignatures: globalExistingItemSignatures,
                    existingItems: globalExistingItems,
                    existingDedupeKeys: globalExistingDedupeKeys,
                  },
                }
              : {}),
          },
          change,
          evidence,
        );
        if (applied) appliedChanges.push(applied);
      }

      // Keep applied mutation results with the immutable snapshot used to produce them.
      const finalStructuredContent = {
        ...structuredContent,
        memoryChangesApplied: appliedChanges,
        memoryChangesRejected: rejectedChangeCount,
        eventsApplied: eventResult.applied,
        eventsSkipped: eventResult.skipped,
      };
      await tx.memorySnapshot.update({
        where: { id: snapshot.id },
        data: { structuredContent: finalStructuredContent as never },
      });

      if (isRegeneration) {
        await tx.auditLog.create({
          data: { actorType: "WORKER", characterId: scope.characterId, action: "snapshot.ai_regenerated", entityType: "MemorySnapshot", entityId: snapshot.id, details: { previousSnapshotId: job.snapshotId, version: nextSnapshotVersion, periodStart: job.periodStart!.toISOString(), periodEnd: job.periodEnd!.toISOString(), memoryChangesApplied: false } },
        });
      }

      await tx.memoryJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          snapshotId: snapshot.id,
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      return {
        status: "SUCCEEDED" as const,
        snapshotId: snapshot.id,
        message: isRegeneration
          ? `AI 重新提炼完成，已创建版本 ${nextSnapshotVersion}；长期记忆变化仅供审核，未自动应用。`
          : `AI 阶段总结已生成；应用 ${appliedChanges.length} 项长期记忆变化。`
      };
    });

    return { processed: true, jobId: job.id, ...outcome };
  } catch (error) {
    const failedAt = new Date();
    const latest = await prisma.memoryJob.findUnique({
      where: { id: claimedJobId },
      select: { attemptCount: true, maxAttempts: true, lockedBy: true, status: true },
    });
    if (!latest || latest.status !== "RUNNING" || latest.lockedBy !== workerId) {
      return { processed: true, jobId: claimedJobId, status: "FAILED", message: "任务执行失败或租约已被其他 Worker 接管。" };
    }
    const exhausted = latest.attemptCount >= latest.maxAttempts;
    const retryDelayMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, latest.attemptCount - 1)));
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await prisma.memoryJob.updateMany({
      where: { id: claimedJobId, status: "RUNNING", lockedBy: workerId },
      data: {
        status: exhausted ? "FAILED" : "RETRY_WAIT",
        runAt: exhausted ? failedAt : new Date(failedAt.getTime() + retryDelayMs),
        completedAt: exhausted ? failedAt : null,
        lastError: message,
        lockedAt: null,
        lockedBy: null,
      },
    });
    return {
      processed: true,
      jobId: claimedJobId,
      status: exhausted ? "FAILED" : "RETRY_WAIT",
      message: exhausted ? `任务失败，已达到最大尝试次数：${message}` : `任务执行失败，将延迟重试：${message}`,
    };
  }
}
