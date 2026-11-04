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
  /**
   * 发言人显示名（渠道昵称）。
   *
   * 两处用它：`deriveParticipantRefs` 给引用带上当时叫法；`resolveEventParticipants`
   * 把模型写的泛称「群友」换成具体的人。缺了它，忆泡只知道 QQ 号、不知道叫什么。
   */
  speaker?: string;
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
    // 顺手带上当时的叫法：昵称会改，以后要按「这个人当时叫什么」回溯时不用再回表。
    const displayName = message.speaker?.trim().slice(0, 40);
    push(`external:${platform}:${externalId}`, {
      kind: "external",
      platform,
      externalId,
      ...(displayName ? { displayName } : {}),
    });
  }
  return refs;
}

/**
 * 忆泡参与者里的「泛称」。
 *
 * 模型在群聊里认不出人时会写这些词 —— 等于没记名字：卡片上看不出是谁，
 * 按人检索匹配不到，回答只能说「有个群友」。
 *
 * 注意 `memory-ai.ts` 的 `isNearDuplicateEvent` 里有一份用途不同的近似清单
 * （那边是「不算交集」，这边是「需要被替换」），别合并成一处：改一边会静默影响另一边。
 */
export const GENERIC_EVENT_PARTICIPANTS: readonly string[] = [
  "群友", "群成员", "群员", "群内成员", "群里的人", "群里的", "群友甲", "群友乙",
  "对方", "有人", "某人", "某个群友", "网友", "成员", "大家",
];

/** 指代她的自指写法，不该出现在「相关人物」里。 */
const SELF_PARTICIPANT_WORDS = ["我", "自己", "本人"];

/**
 * 把忆泡的参与者从「模型抄来的字」校正成「能认出是谁的名字」。
 *
 * 三件事，全部确定性，不经过模型：
 *
 * 1. **剔除她自己** —— `participants` 的语义是「除了她还有谁」。把她自己列进去，
 *    问「和你一起答题的是谁」时她会把自己报出来，检索侧按人过滤也会被污染。
 * 2. **泛称换成真实昵称** —— 只在证据里**恰好剩一个**没被点名的人时才换。
 *    证据里 A、B 都说过话，但 B 可能只是路过说了句「哈哈」，这时把「群友」
 *    补成 B 就是错配。**宁可不写，也不要记错人** —— 和 `participantRefs`
 *    「拿不到账号就跳过」是同一条原则。
 * 3. **泛称能定位时就退场** —— 证据里的人都已点名，说明「群友」是模型把同一个人
 *    写了两遍，留着只会让判重误吞和检索误命中。定位不了（或多于一个候选）就保留：
 *    「当时有别人在」这个信息不能丢。
 */
export function resolveEventParticipants(
  participants: readonly string[],
  evidence: readonly MemoryEvidenceMessage[],
  characterName?: string,
): string[] {
  const selfNames = new Set<string>(SELF_PARTICIPANT_WORDS);
  const selfName = characterName?.trim();
  if (selfName) selfNames.add(selfName);

  // 证据里能点出名字的外部成员（她自己与主人另算，主人用「主人」这个称呼更稳）。
  const externals: string[] = [];
  for (const message of evidence) {
    if (message.role === "ASSISTANT" || message.isOwner) continue;
    const name = message.speaker?.trim();
    if (!name || selfNames.has(name)) continue;
    if (!externals.includes(name)) externals.push(name);
  }

  const generic = new Set(GENERIC_EVENT_PARTICIPANTS);

  // 先剔掉她自己：这一步不需要证据，纯字符串判断，永远成立。
  const kept: string[] = [];
  for (const person of participants) {
    const name = person.trim();
    if (!name || selfNames.has(name)) continue;
    if (!kept.includes(name)) kept.push(name);
  }

  /**
   * 证据里点不出任何名字时，泛称**保留**。
   *
   * 删掉它是把「有别人参与、只是不知道是谁」改成「没有别人参与」—— 后者是错的，
   * 而且旧忆泡（`sourceMessageIds` 为空的那批）只能走这条路，清空等于把仅有的
   * 一点点信息也抹了。泛称至少说明当时有人在。
   */
  if (!externals.length) return kept.slice(0, 8);

  const concrete = kept.filter((person) => !generic.has(person));
  const hasGeneric = kept.length !== concrete.length;

  /**
   * 只在「剩一个」时替换：证据里 A、B 两个人都说了话，但 B 可能只是路过说了句
   * 「哈哈」—— 这时把「群友」补成 B 就是错配。宁可不写，也不要记错人。
   *
   * 补名的两个入口：① 参与者里有泛称占位（模型写了「群友」）；
   * ② 剔掉她自己后一个人都不剩（模型漏写）。两条都要求证据里恰好只剩一个
   * 没被点名的人 —— 后者是「她给群友出了道题」这类单人互动最常见的样子。
   */
  const shouldFill = hasGeneric || concrete.length === 0;
  const unresolved = externals.filter((name) => !concrete.includes(name));
  if (shouldFill && unresolved.length === 1) return [...concrete, unresolved[0]!].slice(0, 8);

  // 证据里的人都已点名，泛称没有指向对象：多半是模型把同一个人写了名字又写了「群友」。
  if (hasGeneric && !unresolved.length) return concrete.slice(0, 8);

  // 候选不止一个：泛称留着比乱指一个好，让读者知道「当时还有别人」。
  return (hasGeneric ? kept : concrete).slice(0, 8);
}

/**
 * 一条变更要落到哪个范围。
 *
 * 默认是当前范围；主人私聊里学到「关于她自己」的事实，会落到角色全局范围
 * （`scope: "character"`），这样群聊也读得到 —— 生日、能力、外观不该只存在私聊。
 * 全局范围由调用方显式传入，外部身份（普通群友）的私聊永远不传，避免污染全局记忆。
 */
export type MemoryApplyScope = {
  memoryScopeId: string;
  resolvePrevious: (memoryId: string) => Promise<{ category: MemoryCategoryValue; content: string } | null>;
  canTarget: (memoryId: string) => boolean;
  handledMemoryIds: Set<string>;
  existingItemSignatures: Set<string>;
  existingDedupeKeys: Set<string>;
  existingItems?: Array<{ id: string; category: MemoryCategoryValue; content: string }>;
};

export type MemoryApplyContext = MemoryApplyScope & {
  characterId: string;
  snapshotId: string;
  actorType: "WORKER" | "USER";
  /** 审计动作前缀：自动生成 `memory.ai_`，人工采纳 `memory.review_`。 */
  auditActionPrefix: "memory.ai_" | "memory.review_";
  actorId?: string | null;
  /**
   * 全局范围：只有主人私聊（USER_PRIVATE）才会传。
   *
   * 传了之后，`scope: "character"` 的 ADD 会写进全局；指向全局条目的
   * UPDATE/INVALIDATE 也会在全局范围执行。普通群友的私聊不传，防止把
   * 某个人的说法写成角色全局事实。
   */
  global?: MemoryApplyScope;
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

  /**
   * 这条变更落到哪个范围。
   *
   * - ADD 带 `scope: "character"`：写全局（只有主人私聊会带）。
   * - UPDATE / INVALIDATE 指向全局条目：在全局范围执行。
   * - 其余：当前范围，保持原行为。
   */
  const target: MemoryApplyScope = change.action === "ADD" && change.scope === "character" && ctx.global
    ? ctx.global
    : relatedId && ctx.global?.canTarget(relatedId)
      ? ctx.global
      : ctx;
  const targetScope = target === ctx.global ? "character" : "current";

  if (change.action === "ADD") {
    const signature = change.category + ":" + normalizeMemoryText(change.content);
    if (target.existingItemSignatures.has(signature)) {
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
    const nearDuplicate = target.existingItems?.find((item) => isNearDuplicateMemory(item, change));
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
    const keyUsed = target.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: target.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    target.existingDedupeKeys.add(dedupeKey);
    const importance = resolveImportance(change);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: target.memoryScopeId,
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
    target.existingItemSignatures.add(signature);
    target.existingItems?.push({ id: created.id, category: change.category, content: change.content });
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
          scope: targetScope,
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

  if (!relatedId || target.handledMemoryIds.has(relatedId) || !target.canTarget(relatedId)) return null;
  const previous = await target.resolvePrevious(relatedId);
  if (!previous) return null;

  if (change.action === "INVALIDATE") {
    const invalidated = await tx.memoryItem.updateMany({
      where: { id: relatedId, memoryScopeId: target.memoryScopeId, status: "ACTIVE" },
      data: { status: "INVALIDATED", validTo: primaryEvidence.occurredAt },
    });
    if (invalidated.count !== 1) return null;
    target.handledMemoryIds.add(relatedId);
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
          scope: targetScope,
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
      where: { id: relatedId, memoryScopeId: target.memoryScopeId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", validTo: primaryEvidence.occurredAt },
    });
    if (superseded.count !== 1) return null;
    target.handledMemoryIds.add(relatedId);
    const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
    const keyUsed = target.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: target.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    target.existingDedupeKeys.add(dedupeKey);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: target.memoryScopeId,
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
    target.existingItemSignatures.add(change.category + ":" + normalizeMemoryText(change.content));
    target.existingItems?.push({ id: created.id, category: change.category, content: change.content });
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
          scope: targetScope,
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
    /**
     * 角色自己的名字。用来把「她自己」从 `participants` 里剔掉 ——
     * 那不是「相关人物」，留着会让检索和回答把她也算成在场的人。
     */
    characterName?: string;
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

    /**
     * 参与者清洗必须排在判重之前：判重拿 `participants` 算「算不算同一件事」的交集，
     * 用未清洗的「群友」会让两条本来不同的事互相吞掉（泛称之间永远有交集），
     * 而清洗后是真名，只有真的同一个人重提才算撞。
     */
    const participants = resolveEventParticipants(draft.participants, scopedEvidence, ctx.characterName);

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
    const duplicated = dayEvents.some((existing) => isNearDuplicateEvent(existing, { title: draft.title, participants }));
    if (duplicated) {
      skipped += 1;
      continue;
    }

    try {
      const created = await tx.memoryEvent.create({
        data: {
          memoryScopeId: ctx.memoryScopeId,
          // 忆泡归属会话：群聊范围是全局的，不存这一列就没法按「这个群」过滤。
          // 收口规则见上面 primaryConversationId 的注释。
          conversationId: primaryConversationId ?? null,
          dayKey: localDayKey(occurredAt, ctx.timeZone),
          state: ctx.state,
          occurredAt,
          timeOfDay: draft.timeOfDay ?? null,
          precision: draft.precision,
          place: draft.place ?? null,
          title: draft.title,
          detail: draft.detail,
          keywords: draft.keywords,
          participants,
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
      dayEvents.push({ title: draft.title, participants });
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
            participants,
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
