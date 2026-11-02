import type { Prisma } from "../../src/generated/prisma/client";
import {
  isNearDuplicateEvent, isNearDuplicateMemory, makeEventDedupeKey, makeMemoryDedupeKey,
  type MemoryCategoryValue, type MemoryChange, type MemoryEventDraft,
} from "./memory-ai";
import { localDayKey } from "./memory-event-time";

/**
 * 单条长期记忆变更的落库逻辑。
 *
 * 抽出来的原因：同一条模型建议有两条执行路径 —— Worker 自动生成时直接应用，
 * 人工在阶段总结详情里「采纳」时按需应用。两套实现迟早会漂移，
 * 所以落库、去重、审计都在这里，两边只负责决定「要不要调」。
 */

export type MemoryApplyTx = Prisma.TransactionClient;

export type MemoryEvidenceMessage = {
  id: string;
  occurredAt: Date;
  /** 这条消息属于哪个会话。忆泡只归属一个会话，参与者引用不能跨会话混。 */
  conversationId?: string;
  /** 这条消息是谁发的（渠道账号）。用来推导忆泡的参与者引用，而不是靠模型写名字。 */
  role?: string;
  authorOpenId?: string;
  /** 平台标识（qq-onebot / bili …）。没有就当未知，不参与身份合并。 */
  platform?: string;
  isOwner?: boolean;
};

/**
 * 忆泡参与者的**结构化引用**。
 *
 * 和 `participants`（模型抄来的显示名）分开：昵称会改、同名会混、群代号 `member_3`
 * 换个群就不一样。引用只记「是谁」，展示仍用名字。
 */
export type ParticipantRef =
  | { kind: "self" }
  | { kind: "owner" }
  | { kind: "external"; platform: string; externalId: string; displayName?: string };

/**
 * 从证据消息推导参与者引用（确定性，不经过模型）。
 *
 * - `ASSISTANT` 消息 → 她自己（`self`）；
 * - `isOwner` 标记 → 主人（`owner`）；
 * - 其余带 `authorOpenId` 的消息 → 外部身份（platform + externalId）。
 *
 * 同一个人在多条证据里出现只记一次；拿不到账号的消息跳过 —— 宁可少一个引用，
 * 也不要编一个。显示名仍由 `participants` 负责，这里只记「是谁」。
 */
export function deriveParticipantRefs(evidence: MemoryEvidenceMessage[]): ParticipantRef[] {
  const refs: ParticipantRef[] = [];
  const seen = new Set<string>();
  const push = (key: string, ref: ParticipantRef) => {
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const message of evidence) {
    if (message.role === "ASSISTANT") {
      push("self", { kind: "self" });
      continue;
    }
    if (message.isOwner) {
      push("owner", { kind: "owner" });
      continue;
    }
    const externalId = message.authorOpenId?.trim();
    if (!externalId) continue;
    const platform = message.platform?.trim() || "unknown";
    push(`external:${platform}:${externalId}`, {
      kind: "external",
      platform,
      externalId,
    });
  }
  return refs;
}

export type MemoryApplyContext = {
  memoryScopeId: string;
  characterId: string;
  snapshotId: string;
  actorType: "WORKER" | "USER";
  /** 审计动作前缀：自动生成 `memory.ai_`，人工采纳 `memory.review_`。 */
  auditActionPrefix: "memory.ai_" | "memory.review_";
  actorId?: string | null;
  /**
   * 目标记忆的「当前状态」。Worker 用周期时点的快照，人工采纳用数据库里最新的值 ——
   * 中间可能有别的归档改过这条记忆，对照的基准不该是旧的。
   */
  resolvePrevious: (memoryId: string) => Promise<{ category: MemoryCategoryValue; content: string } | null>;
  /** 是否允许把变更指向这条记忆（Worker 限制在模型看过的集合内；人工采纳不限制）。 */
  canTarget: (memoryId: string) => boolean;
  handledMemoryIds: Set<string>;
  existingItemSignatures: Set<string>;
  existingDedupeKeys: Set<string>;
  /**
   * 同范围里**仍在生效**的条目（id + 类别 + 内容），用来挡「换句话又是一条」。
   *
   * 和 `existingItemSignatures` 分工：那个是精确签名（整句相同），这个是近似判重
   * （同类别 + 字面高度重合）。不传就只做精确判重，行为与以前一致。
   */
  existingItems?: Array<{ id: string; category: MemoryCategoryValue; content: string }>;
};

export function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();}

/**
 * 模型没给 importance 时的按类别兜底。
 *
 * 不是为了「猜得准」，是为了别让所有条目又回到同一个数 —— 那样排序里的重要度项
 * 又变成固定乘数（改前 16 条全是 0.5，等于没排序）。承诺与关系天然比一次性的状态更该留。
 */
export const DEFAULT_MEMORY_IMPORTANCE: Record<MemoryCategoryValue, number> = {
  COMMITMENT: 0.8,
  RELATIONSHIP: 0.75,
  GOAL: 0.7,
  PREFERENCE: 0.65,
  FACT: 0.6,
  EVENT: 0.5,
  SUMMARY: 0.4,
  OTHER: 0.4,
};

function resolveImportance(change: MemoryChange): number {
  if (typeof change.importance === "number" && Number.isFinite(change.importance)) {
    return Math.min(1, Math.max(0, change.importance));
  }
  return DEFAULT_MEMORY_IMPORTANCE[change.category] ?? 0.5;
}

type ApplyResult = Record<string, unknown>;

/**
 * 应用一条变更。返回 null 表示这条被跳过（目标记忆不可用、已被同一轮处理过、
 * 或者内容与现状相同），调用方不应把它算作已应用。
 */
export async function applyMemoryChange(
  tx: MemoryApplyTx,
  ctx: MemoryApplyContext,
  change: MemoryChange,
  evidence: MemoryEvidenceMessage[],
): Promise<ApplyResult | null> {
  if (evidence.length === 0) return null;
  const primaryEvidence = [...evidence].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0]!;
  const validFrom = primaryEvidence.occurredAt;
  const relatedId = change.relatedMemoryId;
  const auditActor = ctx.actorType === "USER" && ctx.actorId
    ? { actorType: "USER" as const, actorId: ctx.actorId }
    : { actorType: ctx.actorType };

  if (change.action === "ADD") {
    const signature = change.category + ":" + normalizeMemoryText(change.content);
    if (ctx.existingItemSignatures.has(signature)) {
      return {
        action: "ADD",
        result: "DUPLICATE_IGNORED",
        category: change.category,
        content: change.content,
        evidenceMessageIds: change.evidenceMessageIds,
      };
    }

    // 近似判重：整句不同、说的是同一件事。只对「同类别 + 字面高度重合」生效，
    // 判据保守（见 isNearDuplicateMemory），宁可漏一条也不合成两件不同的事。
    const nearDuplicate = ctx.existingItems?.find((item) => isNearDuplicateMemory(item, change));
    if (nearDuplicate) {
      return {
        action: "ADD",
        result: "DUPLICATE_IGNORED",
        category: change.category,
        content: change.content,
        duplicateOfMemoryId: nearDuplicate.id,
        evidenceMessageIds: change.evidenceMessageIds,
      };
    }

    const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
    const keyUsed = ctx.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: ctx.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    ctx.existingDedupeKeys.add(dedupeKey);
    const importance = resolveImportance(change);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: ctx.memoryScopeId,
        category: change.category as MemoryCategoryValue,
        content: change.content,
        confidence: change.confidence,
        importance,
        status: "ACTIVE",
        validFrom,
        sourceMessageId: primaryEvidence.id,
        sourceSnapshotId: ctx.snapshotId,
        dedupeKey: keyUsed ? null : dedupeKey,
      },
      select: { id: true },
    });
    ctx.existingItemSignatures.add(signature);
    ctx.existingItems?.push({ id: created.id, category: change.category, content: change.content });
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "added",
        entityType: "MemoryItem",
        entityId: created.id,
        details: {
          category: change.category,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "ADD",
      result: "CREATED",
      memoryItemId: created.id,
      category: change.category,
      content: change.content,
      confidence: change.confidence,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  if (!relatedId || ctx.handledMemoryIds.has(relatedId) || !ctx.canTarget(relatedId)) return null;
  const previous = await ctx.resolvePrevious(relatedId);
  if (!previous) return null;

  if (change.action === "INVALIDATE") {
    const invalidated = await tx.memoryItem.updateMany({
      where: { id: relatedId, memoryScopeId: ctx.memoryScopeId, status: "ACTIVE" },
      data: { status: "INVALIDATED", validTo: primaryEvidence.occurredAt },
    });
    if (invalidated.count !== 1) return null;
    ctx.handledMemoryIds.add(relatedId);
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "invalidated",
        entityType: "MemoryItem",
        entityId: relatedId,
        details: {
          reason: change.changeReason ?? change.content,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "INVALIDATE",
      result: "INVALIDATED",
      memoryItemId: relatedId,
      content: change.content,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  if (
    change.action === "UPDATE" &&
    (previous.category !== change.category || normalizeMemoryText(previous.content) !== normalizeMemoryText(change.content))
  ) {
    const superseded = await tx.memoryItem.updateMany({
      where: { id: relatedId, memoryScopeId: ctx.memoryScopeId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", validTo: primaryEvidence.occurredAt },
    });
    if (superseded.count !== 1) return null;
    ctx.handledMemoryIds.add(relatedId);
    const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
    const keyUsed = ctx.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: ctx.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    ctx.existingDedupeKeys.add(dedupeKey);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: ctx.memoryScopeId,
        category: change.category as MemoryCategoryValue,
        content: change.content,
        confidence: change.confidence,
        importance: resolveImportance(change),
        status: "ACTIVE",
        validFrom,
        sourceMessageId: primaryEvidence.id,
        sourceSnapshotId: ctx.snapshotId,
        dedupeKey: keyUsed ? null : dedupeKey,
      },
      select: { id: true },
    });
    ctx.existingItemSignatures.add(change.category + ":" + normalizeMemoryText(change.content));
    ctx.existingItems?.push({ id: created.id, category: change.category, content: change.content });
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "updated",
        entityType: "MemoryItem",
        entityId: created.id,
        details: {
          supersededMemoryId: relatedId,
          previousContent: previous.content.slice(0, 1000),
          newContent: change.content,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "UPDATE",
      result: "REPLACED",
      memoryItemId: created.id,
      supersededMemoryId: relatedId,
      category: change.category,
      content: change.content,
      confidence: change.confidence,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  return null;
}

/**
 * 写入忆泡。
 *
 * 和长期记忆的两点不同：
 * 1. **只追加**：同一件事已经在（同范围 + 同一天 + 同标题）写过就跳过，不更新旧记录 ——
 *    事件一旦发生就不会变，后来的变化应该是一条新事件。
 * 2. **不做人工复核**：忆泡是原始事实，不像长期记忆那样会「代表她现在的看法」，
 *    所以自动写入 + 审计即可；重新提炼（历史重放）不重写忆泡。
 */
export async function applyMemoryEvents(
  tx: MemoryApplyTx,
  ctx: {
    memoryScopeId: string;
    characterId: string;
    snapshotId: string | null;
    /** 角色时区：dayKey 按它换算，跨零点的消息才不会归错天。 */
    timeZone: string;
    /** DRAFT = 今天还在长；FINAL = 昨天已收口。 */
    state: "DRAFT" | "FINAL";
  },
  drafts: MemoryEventDraft[],
  messagesById: Map<string, MemoryEvidenceMessage>,
): Promise<{ applied: Array<{ id: string; title: string; occurredAt: string }>; skipped: number }> {
  const applied: Array<{ id: string; title: string; occurredAt: string }> = [];
  let skipped = 0;
  // 按天缓存已有事件：一次任务里同一天会有多条草稿，别每条都回表查一遍。
  const existingEventsByDay = new Map<string, Array<{ title: string; participants: string[] }>>();

  for (const draft of drafts) {
    const evidence = draft.evidenceMessageIds
      .map((id) => messagesById.get(id))
      .filter((message): message is MemoryEvidenceMessage => Boolean(message))
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
    const occurredAt = new Date(draft.occurredAt);
    if (evidence.length === 0 || Number.isNaN(occurredAt.getTime())) {
      skipped += 1;
      continue;
    }

    /**
     * 一条忆泡只归属一个会话。
     *
     * 按天抽取会把同一天里的几个会话（桌面、私聊、群聊）放进同一次模型调用 —— 这是
     * 为了覆盖，不是为了合并。模型偶尔会把两段不相干的对话写成一条事件，证据也跨会话；
     * 参与者引用若照单全收，「私聊里发生的事」就会带上群成员，检索时会被读成
     * 「那天群里也参与了」。
     *
     * 以**最早一条证据所在的会话**为准收口：引用与来源都只取这段。没有 `conversationId`
     * 的旧调用方式（手工构造证据）保持原样，不因为这条守卫丢消息。
     */
    const primaryConversationId = evidence[0]!.conversationId;
    const scopedEvidence = primaryConversationId
      ? evidence.filter((message) => message.conversationId === primaryConversationId)
      : evidence;

    const dedupeKey = makeEventDedupeKey(occurredAt, draft.title);
    const existing = await tx.memoryEvent.findFirst({
      where: { memoryScopeId: ctx.memoryScopeId, dedupeKey },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    // 近义重复：同一天里已有标题与它高度重合（连续 6 个字以上相同），当作同一件事。
    // 精确 dedupeKey 只认完全相同的标题，而模型重跑时很爱换个说法。
    const dayKey = localDayKey(occurredAt, ctx.timeZone);
    let dayEvents = existingEventsByDay.get(dayKey);
    if (!dayEvents) {
      const rows = await tx.memoryEvent.findMany({
        where: { memoryScopeId: ctx.memoryScopeId, dayKey },
        select: { title: true, participants: true },
      });
      dayEvents = rows.map((row) => ({ title: row.title, participants: row.participants }));
      existingEventsByDay.set(dayKey, dayEvents);
    }
    const duplicated = dayEvents.some((existing) => isNearDuplicateEvent(existing, draft));
    if (duplicated) {
      skipped += 1;
      continue;
    }

    try {
      const created = await tx.memoryEvent.create({
        data: {
          memoryScopeId: ctx.memoryScopeId,
          dayKey: localDayKey(occurredAt, ctx.timeZone),
          state: ctx.state,
          occurredAt,
          timeOfDay: draft.timeOfDay ?? null,
          precision: draft.precision,
          place: draft.place ?? null,
          title: draft.title,
          detail: draft.detail,
          keywords: draft.keywords,
          participants: draft.participants,
          // 结构化引用：从证据消息的作者推导，不靠模型写名字。
          participantRefs: deriveParticipantRefs(scopedEvidence) as unknown as Prisma.InputJsonValue,
          confidence: draft.confidence,
          sourceMessageId: scopedEvidence[0]!.id,
          // 全部证据消息：只存第一条会让「这条忆泡是从哪几句话来的」查不全。
          sourceMessageIds: scopedEvidence.map((message) => message.id),
          sourceSnapshotId: ctx.snapshotId,
          dedupeKey,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      applied.push({ id: created.id, title: draft.title, occurredAt: occurredAt.toISOString() });
      // 同一批里后面几条也要跟新写的这条比，否则同批内的近义重复挡不住。
      dayEvents.push({ title: draft.title, participants: draft.participants });
      await tx.auditLog.create({
        data: {
          actorType: "WORKER",
          characterId: ctx.characterId,
          action: "memory.event_added",
          entityType: "MemoryEvent",
          entityId: created.id,
          details: {
            occurredAt: occurredAt.toISOString(),
            title: draft.title,
            participants: draft.participants,
            confidence: draft.confidence,
            evidenceMessageIds: draft.evidenceMessageIds,
            snapshotId: ctx.snapshotId,
          },
        },
      });
    } catch {
      // 唯一约束竞争：另一个任务刚写了同一件事。跳过即可，不算失败。
      skipped += 1;
    }
  }

  return { applied, skipped };
}
