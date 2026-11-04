import { buildChatCompletionsEndpoint, isChatModelConfigured } from "./chat-model-config";
import { parseJsonLoose } from "./loose-json";
import { readModelUsage, type ModelUsageTokens } from "./model-usage";
import { createHash } from "node:crypto";

export const MEMORY_CATEGORIES = [
  "FACT",
  "PREFERENCE",
  "RELATIONSHIP",
  "COMMITMENT",
  "GOAL",
  "EVENT",
  "SUMMARY",
  "OTHER",
] as const;

export type MemoryCategoryValue = (typeof MEMORY_CATEGORIES)[number];
export type MemoryChangeAction = "ADD" | "UPDATE" | "INVALIDATE";

export type MemoryAiMessage = {
  id: string;
  role: string;
  eventType: string;
  occurredAt: string;
  content: string;
  /** 这条消息来自哪种对话（`QQ群 12345678` / `私聊` / `本地对话`）。老数据没有这个字段。 */
  origin?: string;
  /** 这条是主人发的。主人私聊必真；群聊里主人发言也标出来，让提炼时认得主人。 */
  isOwner?: boolean;
  /** 这条消息 @ 了谁：`self` 是她，`other` 是别人（群里另一个 bot / 别的成员）。 */
  mentionTargets?: string[];
  /**
   * 这条是谁说的（渠道显示名）。
   *
   * 群聊里一条 USER 可能是主人、群友甲、群友乙。不给这个字段，模型只能从正文猜
   * 发言人，猜不出就在 participants 里写「群友」—— 忆泡当场丢掉那个人，事后
   * 按人检索匹配不到，回答只能含糊。手账链路（`journal-ai.ts`）早有这个字段，
   * 忆泡这条一直漏着。
   */
  speaker?: string;
  /** 群内稳定代号（`member_2`）：昵称会改，代号不会。 */
  member?: string;
};

export type MemoryAiExistingItem = {
  id: string;
  category: MemoryCategoryValue;
  content: string;
  confidence: number | null;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
};

export type MemoryChange = {
  action: MemoryChangeAction;
  category: MemoryCategoryValue;
  content: string;
  confidence: number;
  /**
   * 这条记忆对她有多重要（0–1）。
   *
   * 排序公式里的「重要度」一直是个常数 0.5 —— 因为从来没人写过这个字段，
   * 于是 `0.55 + 0.45 × importance` 对所有条目一视同仁，排序实际只剩相关度和衰减。
   * 由提炼时给分；模型没给就按类别兜底（`DEFAULT_MEMORY_IMPORTANCE`），不是两套判据打架。
   */
  importance?: number;
  evidenceMessageIds: string[];
  relatedMemoryId?: string;
  changeReason?: string;
  /**
   * 这条记忆该写进哪个范围。缺省 / "current" = 当前对话范围；
   * "character" = 角色全局范围（任何群、私聊都能读到）。
   *
   * 只对「关于她本人」的稳定事实有意义（生日、名字、外观、能力、稳定喜好）：
   * 这些在主人私聊里学到，但群聊也该知道。关于对话对象、对方隐私、只在这个私聊里
   * 成立的事，一律不加这个字段 —— 由调用方只对主人私聊开放全局写入。
   */
  scope?: "current" | "character";
};

/** 「上午 / 下午」这类模糊时段。只认这几个词，别的当没写。 */
export const EVENT_TIME_OF_DAY = ["凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "深夜"] as const;
export type EventTimeOfDay = (typeof EVENT_TIME_OF_DAY)[number];

/**
 * 一条待写入的忆泡。`occurredAt` 是**事件发生时间**，不是提炼时间 ——
 * 「前天我做了什么」靠它才答得出来。
 */
export type MemoryEventDraft = {
  occurredAt: string;
  timeOfDay?: EventTimeOfDay;
  precision: "exact" | "part_of_day" | "day";
  place?: string;
  title: string;
  detail: string;
  keywords: string[];
  participants: string[];
  confidence: number;
  evidenceMessageIds: string[];
};

export type MemoryAiAnalysis = {
  summary: string;
  importantEvents: Array<{ title: string; detail: string; evidenceMessageIds: string[] }>;
  factAndPreferenceChanges: Array<{ description: string; changeType: string; evidenceMessageIds: string[] }>;
  relationshipChanges: Array<{ description: string; evidenceMessageIds: string[] }>;
  goalsAndCommitments: Array<{ description: string; status: string; evidenceMessageIds: string[] }>;
  unresolvedTopics: Array<{ description: string; evidenceMessageIds: string[] }>;
  differencesFromPrevious: string[];
  memoryChanges: MemoryChange[];
  /** 可定位到日期的具体事件。与 memoryChanges 分开：事件是事实，记忆是结论。 */
  events: MemoryEventDraft[];
  /**
   * 她私下想怎么叫这个人（仅 EXTERNAL_IDENTITY 范围产出）。
   *
   * 这个范围唯一对应「她 × 某个人」，提炼时顺带让她想想「我平时都怎么叫对方」。
   * 候选进待审队列，用户点头才生效 —— 见 `FriendAliasSuggestion`。
   */
  friendAliases: Array<{ alias: string; reason: string }>;
};

export type MemoryAiInput = {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  scopeType: string;
  characterName: string;
  messages: MemoryAiMessage[];
  totalMessageCount: number;
  omittedMessageCount: number;
  activeMemories: MemoryAiExistingItem[];
  /**
   * 角色全局范围的现有记忆。只有主人私聊（USER_PRIVATE）才会传。
   *
   * 传了它，模型才能看到「以前记着不会发语音」这类全局条目，并在证据推翻时
   * INVALIDATE；也才会知道哪些事该用 `scope: "character"` 写进全局。
   * 普通群友的私聊不传 —— 不能让一个人的说法覆盖角色全局记忆。
   */
  globalMemories?: MemoryAiExistingItem[];
  /**
   * 允许把「关于她本人」的 ADD 写进角色全局范围。主人私聊且存在全局范围时为 true。
   *
   * 和 `globalMemories` 分开：第一次提炼时全局范围可能一条记忆都没有，
   * 但「生日写全局」这条规则仍然要生效，不能因为列表为空就退化成只写私聊。
   */
  allowGlobalMemory?: boolean;
  previousSnapshotSummary: string | null;
  /**
   * 这一天已经记录过的忆泡（按天任务专用）。
   * 不传时模型没有「哪些事已经记过」的概念，重跑同一天就会换句话再写一遍。
   */
  existingEvents?: Array<{ occurredAt: string; title: string }>;
  /** 周期内已经整理好的忆泡：快照拿它当「发生过什么」的权威时间线。 */
  periodEvents?: Array<{ id: string; occurredAt: string; title: string; detail: string; participants: string[] }>;
  /** 这一趟要不要产出 events。按天任务 true，周期快照 false（忆泡只由按天任务写）。 */
  emitEvents?: boolean;
  /**
   * 这一趟要不要顺带产出「她想给这个人起的备注」（friendAliases）。
   * 只对 EXTERNAL_IDENTITY 范围开 —— 这个范围恰好就是「她 × 某个人」。
   */
  emitFriendAliases?: boolean;
};

const MAX_RESPONSE_BYTES = 1_000_000;
/** v5：忆泡抽取补上 `speaker` / `member`，并要求 participants 不写自己、不写泛称。 */
/** v6：主人私聊可见全局记忆，支持 `scope: "character"` 写入与跨范围 INVALIDATE。 */
const TEMPLATE_VERSION = "memory-extraction-v6";

function asText(value: unknown, maxLength = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceIds(value: unknown, validIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string =>
    typeof id === "string" && validIds.has(id),
  ))].slice(0, 10);
}

function evidenceList<T extends { evidenceMessageIds: string[] }>(
  value: unknown,
  validIds: Set<string>,
  mapper: (entry: Record<string, unknown>, ids: string[]) => T | null,
  max = 30,
): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const raw of value.slice(0, max)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const ids = evidenceIds(entry.evidenceMessageIds, validIds);
    if (ids.length === 0) continue;
    const mapped = mapper(entry, ids);
    if (mapped) result.push(mapped);
  }
  return result;
}

function readStringList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value.slice(0, max)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, maxLength);
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

/**
 * 读忆泡草稿。
 *
 * 比记忆条目更严：没有可解析的发生时间、没有标题/详情、没有来源消息的，一律丢弃。
 * 宁可少记一条，也不要造出一条「不知道哪天发生」的假事件 —— 那种东西既不能按时间查，
 * 又会被模型当成事实说出来。
 */
function readEventDrafts(value: unknown, validIds: Set<string>): MemoryEventDraft[] {
  if (!Array.isArray(value)) return [];
  const drafts: MemoryEventDraft[] = [];
  for (const raw of value.slice(0, 40)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const title = asText(entry.title, 200);
    const detail = asText(entry.detail, 2000);
    const occurredAtRaw = asText(entry.occurredAt, 60);
    const ids = evidenceIds(entry.evidenceMessageIds, validIds);
    if (!title || !detail || !occurredAtRaw || ids.length === 0) continue;
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) continue;

    const timeOfDayRaw = asText(entry.timeOfDay, 20);
    const timeOfDay = (EVENT_TIME_OF_DAY as readonly string[]).includes(timeOfDayRaw)
      ? (timeOfDayRaw as EventTimeOfDay)
      : undefined;
    const confidenceRaw = entry.confidence;
    const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.6;
    // 只有日期没有时刻（当天 00:00）时，精度标成 day，别假装知道几点。
    const precision: MemoryEventDraft["precision"] = timeOfDay
      ? "part_of_day"
      : occurredAtRaw.endsWith("T00:00:00.000Z") || occurredAtRaw.endsWith("T00:00:00Z")
        ? "day"
        : "exact";

    drafts.push({
      occurredAt: occurredAt.toISOString(),
      ...(timeOfDay ? { timeOfDay } : {}),
      precision,
      ...(asText(entry.place, 200) ? { place: asText(entry.place, 200) } : {}),
      title,
      detail,
      keywords: readStringList(entry.keywords, 8, 30),
      participants: readStringList(entry.participants, 8, 40),
      confidence,
      evidenceMessageIds: ids,
    });
  }
  return drafts;
}

/**
 * 「同一件事换了个说法」的判定：先看标题重合，再看参与人。
 *
 * - 连续 6 字以上重合 → 直接判重（「发布群公告」这种关键片段不会巧合）；
 * - 只有 3–5 字重合 → 多半只是人名/称呼撞上了，**必须参与人也有交集**才判重；
 * - 参与人里的「主人 / 群友」是角色词，不算交集 —— 否则「主人问她会不会X」和
 *   「主人问她要不要Y」这种同主语的不同事件会被吞掉。
 */
export function isNearDuplicateEvent(
  left: { title: string; participants: readonly string[] },
  right: { title: string; participants: readonly string[] },
): boolean {
  const shared = longestCommonSubstringLength(left.title, right.title);
  if (shared >= 6) return true;
  if (shared < 3) return false;
  const generic = new Set(["主人", "群友", "大家", "对方", "自己", "我", "你", "她", "他"]);
  return left.participants.some(
    (person) => !generic.has(person) && right.participants.includes(person),
  );
}

/** 忆泡幂等键：同一范围、同一天、同一件事只写一条。 */
export function makeEventDedupeKey(occurredAt: Date, title: string): string {
  const day = occurredAt.toISOString().slice(0, 10);
  const normalized = title.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return "ev:" + createHash("sha256").update(day + ":" + normalized).digest("hex").slice(0, 40);
}

/**
 * 两个标题的最长公共子串长度（去掉标点与空白后）。
 *
 * 用来兜住「同一件事换了个说法」：精确 `dedupeKey` 只认完全相同的标题，
 * 重跑同一天时模型很容易把「发布群公告」写成「为新群起草并发布公告」。
 * 用公共子串而不是编辑距离：中文标题的关键信息往往是连续片段（人名、事件词）。
 */
export function longestCommonSubstringLength(left: string, right: string): number {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}

/**
 * 两条长期记忆是不是在说同一件事。
 *
 * 精确 `dedupeKey` 只认整句相同；这里补的是「同一件事又写了一遍，只是多了半句 / 少了半句」——
 * 快照重跑时最常见的重复形态。判据刻意保守：类别必须相同，再要求字面高度重合
 * （一方包含另一方且较短的那条够长，或二元组 Jaccard ≥ 0.62）。
 *
 * **它挡不住真正的改写**（「她只会发文字」对「她原本没有语音功能」这种换个说法的）——
 * 那要语义向量。这里只做确定性判重，宁可漏一条，也不把两件不同的事合成一条。
 */
export function isNearDuplicateMemory(
  left: { category: string; content: string },
  right: { category: string; content: string },
): boolean {
  if (left.category !== right.category) return false;
  const a = normalizeMemoryContent(left.content);
  const b = normalizeMemoryContent(right.content);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 12;
  return bigramJaccard(a, b) >= 0.62;
}

function normalizeMemoryContent(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "");
}

function bigramJaccard(left: string, right: string): number {
  const grams = (value: string) => {
    const chars = Array.from(value);
    const out = new Set<string>();
    for (let index = 0; index < chars.length - 1; index += 1) out.add(chars[index]! + chars[index + 1]!);
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function validateMemoryAiOutput(
  raw: unknown,
  validSourceMessageIds: Iterable<string>,
  existingMemoryIds: Iterable<string>,
  globalMemoryIds: Iterable<string> = [],
): MemoryAiAnalysis {
  const root = asRecord(raw);
  if (!root) throw new Error("LLM_INVALID_JSON: 模型输出必须是 JSON 对象。");

  const validIds = new Set(validSourceMessageIds);
  const existingIds = new Set([...existingMemoryIds, ...globalMemoryIds]);
  const summary = asText(root.summary, 8000);
  if (!summary) throw new Error("LLM_INVALID_RESPONSE: 模型没有返回有效的阶段总结。");

  const importantEvents = evidenceList(root.importantEvents, validIds, (entry, ids) => {
    const title = asText(entry.title, 300);
    const detail = asText(entry.detail, 2000);
    return title && detail ? { title, detail, evidenceMessageIds: ids } : null;
  });

  const factAndPreferenceChanges = evidenceList(root.factAndPreferenceChanges, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    const changeType = asText(entry.changeType, 80) || "观察";
    return description ? { description, changeType, evidenceMessageIds: ids } : null;
  });

  const relationshipChanges = evidenceList(root.relationshipChanges, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    return description ? { description, evidenceMessageIds: ids } : null;
  });

  const goalsAndCommitments = evidenceList(root.goalsAndCommitments, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    const status = asText(entry.status, 80) || "未明确";
    return description ? { description, status, evidenceMessageIds: ids } : null;
  });

  const unresolvedTopics = evidenceList(root.unresolvedTopics, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    return description ? { description, evidenceMessageIds: ids } : null;
  });

  const differencesFromPrevious = Array.isArray(root.differencesFromPrevious)
    ? root.differencesFromPrevious
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 1000))
        .filter(Boolean)
        .slice(0, 30)
    : [];

  const events = readEventDrafts(root.events, validIds);

  // 候选备注：只在朋友范围开启时才解析；其它范围即便模型多写了也当没写。
  const friendAliases = Array.isArray(root.friendAliases)
    ? root.friendAliases
        .slice(0, 8)
        .map((raw) => asRecord(raw))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          alias: asText(entry.alias, 40),
          reason: asText(entry.reason, 200),
        }))
        .filter((item) => item.alias)
    : [];

  const memoryChanges: MemoryChange[] = [];
  if (Array.isArray(root.memoryChanges)) {
    for (const rawChange of root.memoryChanges.slice(0, 80)) {
      const entry = asRecord(rawChange);
      if (!entry) continue;
      const action = entry.action;
      const category = entry.category;
      const content = asText(entry.content, 2000);
      const confidence = entry.confidence;
      const ids = evidenceIds(entry.evidenceMessageIds, validIds);
      if (
        (action !== "ADD" && action !== "UPDATE" && action !== "INVALIDATE") ||
        typeof category !== "string" ||
        !(MEMORY_CATEGORIES as readonly string[]).includes(category) ||
        !content ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        ids.length === 0
      ) continue;

      const relatedMemoryId = asText(entry.relatedMemoryId, 100);
      if ((action === "UPDATE" || action === "INVALIDATE") && !existingIds.has(relatedMemoryId)) continue;
      // 0–1，两位小数。越界的截断而不是丢弃 —— 分数只是排序参考，不值得为它废掉整条记忆。
      const rawImportance = entry.importance;
      const importance = typeof rawImportance === "number" && Number.isFinite(rawImportance)
        ? Math.min(1, Math.max(0, Math.round(rawImportance * 100) / 100))
        : undefined;
      // 只认 "character"：别的值一律按当前范围处理，不因为模型多写一个字就跨范围写入。
      const scope = entry.scope === "character" ? "character" as const : undefined;
      memoryChanges.push({
        action,
        category: category as MemoryCategoryValue,
        content,
        confidence,
        ...(importance === undefined ? {} : { importance }),
        evidenceMessageIds: ids,
        ...(action !== "ADD" ? { relatedMemoryId } : {}),
        ...(scope ? { scope } : {}),
        ...(asText(entry.changeReason, 500) ? { changeReason: asText(entry.changeReason, 500) } : {}),
      });
    }
  }

  return {
    summary,
    importantEvents,
    factAndPreferenceChanges,
    relationshipChanges,
    goalsAndCommitments,
    unresolvedTopics,
    differencesFromPrevious,
    memoryChanges,
    events,
    friendAliases,
  };
}

function systemPrompt(options: {
  emitEvents: boolean;
  withPeriodEvents: boolean;
  emitFriendAliases: boolean;
  withGlobalMemories: boolean;
}): string {
  const lines = [
    "你是严格的长期记忆提炼器，不是角色扮演者。",
    "仅根据输入的原始消息和现有记忆提炼事实。绝不补造未出现的细节；区分用户明确陈述、助手建议和不确定推断。",
    "只把对后续互动有长期价值的个人事实、稳定偏好、关系、目标、承诺写入 memoryChanges；一次性闲聊不要写成长记忆。",
    "同一周期可能同时包含私聊与群聊，每条消息的 origin 标明来源（例如「QQ群 12345678」「私聊」）。群聊里只有与她本人相关的内容才写成长期记忆：她说过的话、答应过的事、有人点名找她、她参与过的群内话题、群里的人怎么称呼她、她跟谁熟。",
    "群友之间与她无关的闲聊只概括进 summary，不要写成她的记忆；群友的隐私（病情、住址、感情、财务、工作内幕）一律不写入 memoryChanges。需要区分场合时在记忆内容里带上群号，不要凭昵称推断同一个人在不同群或私聊里的身份。",
    "标了 isOwner 的消息是主人说的。主人与她相关的发言要优先记住，并在关系记忆里体现「主人」这个身份；群聊里也要把主人的话和群友的话分开，不要把主人的话记成「某个群友说的」。",
    "当你判断某个对话对象值得她长期记住时，写一条 category=RELATIONSHIP 的记忆，内容包含对方称呼、来源（哪个群或私聊）和这段关系的要点；不要为记不住的泛泛之交写关系记忆。",
    "偏好或事实发生变化时，优先 UPDATE 已提供的相关 active memory；明确不再成立时使用 INVALIDATE；确实新增时使用 ADD。",
    "UPDATE/INVALIDATE 的 relatedMemoryId 必须来自输入的 activeMemories。每条 memoryChanges 必须至少引用一个输入中的 evidenceMessageIds，且来源必须真正支持该结论。",
    "每条记忆都要给 importance（0–1，两位小数）：0.85 以上是长期成立、会影响她判断的事（身份、底线、稳定关系、明确承诺）；0.5–0.7 是日常事实与偏好；0.3 以下是一次性的临时状态。不要所有条目都给同一个数 —— 排序就是靠它区分轻重，全给 0.5 等于没给。",
    "写 ADD 之前先扫一遍 activeMemories：如果这一期的证据说明某条已经不成立（改了主意、取消了、被更正、事情已经做完、对方更正了说法），必须单独发一条 INVALIDATE 指回它，而不是只 ADD 一条新的、把旧的留在那里。旧条目不退场，她就会同时相信两件互相矛盾的事。这条和「不要乱删」不冲突：INVALIDATE 只针对有证据推翻的那种，拿不准就不动。",
  ];
  if (options.withGlobalMemories) {
    lines.push(
      "globalMemories 是角色全局记忆（每个群、每个私聊都能读到）；activeMemories 是当前私聊范围。两边的 id 都可以作为 UPDATE/INVALIDATE 的 relatedMemoryId。",
      "**关于她本人**的稳定事实（生日、名字、外观、能力、稳定喜好、她自己答应过的事）要写进全局：memoryChanges 里加 scope: \"character\"。**关于对话对象**的事实、对方的隐私、只在这个私聊里成立的事，不要加 scope（默认写当前范围）。拿不准时写当前范围，不要为了省事把所有事都标成 character。",
      "如果这一期的证据说明 globalMemories 里某条已经不成立（例如以前记着「她不会发语音」，现在主人给她开通了；以前没有某个功能，现在有了），必须单独发一条 INVALIDATE 指回那条全局记忆。只 ADD 新的、不废旧的，她在群里就会继续说旧状态 —— 这是实际发生过的错误，不是理论风险。",
    );
  }
  if (options.withPeriodEvents) {
    lines.push(
      "periodEvents 是这个周期里**已经整理好的忆泡**（按天任务产出）：它就是「发生过什么」的权威时间线，summary 和 importantEvents 以它为准；messages 只用来提炼偏好、关系、情绪与结论，不要拿零散消息去推翻已有忆泡。",
    );
  }
  if (options.emitEvents) {
    lines.push(
      "另外把这一周期里**能落到某一天**的事写进 events：occurredAt 用消息里的时间（ISO 8601，换算成 UTC 带 Z；只知道哪一天就写当天 00:00:00Z），title 一句话，detail 写清经过，participants 写涉及的人（用消息里的 `speaker` 称呼），place 知道才写，keywords 写 3-5 个同义或相关词。寒暄、没有日期的泛泛而谈、群友之间与她无关的闲聊都不要写。每条 events 同样必须引用真实的 evidenceMessageIds。",
      "**title 和 detail 里提到具体的人时也写名字**（用 `speaker`），不要写「群友」「群主」「对方」—— 事件正文和 participants 对不上时，她以后只能照着正文说「有个群友」，participants 里的名字白记了。只有确实指代一群人（例如「群里好几个人一起起哄」）时才用泛称。",
      "**participants 的三条硬规矩**：① 不要把你自己的名字写进去 —— 你是记事的人，不是「相关人物」；② 群聊里必须写 `speaker` 里那个具体的名字，绝对不要写「群友」「群成员」「对方」「有人」这类泛称 —— 泛称等于没记，过后谁都查不出是谁，提问时也匹配不到；③ 某句话分不清是谁说的，就不要写进 participants，写空数组也比写错人好。",
      "existingEvents 是这一天**已经记录过**的事件：不要重复记录，同一件事换个说法也算重复（例如「发布群公告」和「起草并发布公告」是同一件）。只写确实不同的事。但**不要因为它非空就整体返回空数组** —— 它只用来避免重复，这一段里只要还有没记过的事，就必须照常写出来。",
      "群聊里可能同时有好几个 bot 在活动，别人 (@数字) 或直接说的话**不一定是冲她说的**。写 event 前必须先确认对象：只有 role=assistant 的消息（她自己说的）、明确叫她名字的话、@ 指向她的消息，才算「关于她」。如果一条评价/抱怨 @ 的是另一个号码、或者上下文显示在说别人的 bot，就不能写成「群友说她/嫌她/夸她」这类事——那件事的主体不是她。判断不出来时宁可不写，也别记成她的事。这条只适用于 origin 以「QQ群 」开头的消息：私聊和本地对话是两个人面对面说话，对方说的每一句都是对她说的，不要因为「没 @ 她、没叫名字」就跳过私聊事件。",
    );
  } else {
    lines.push(
      "这一趟**不要输出 events**：忆泡由按天的任务负责，周期总结再写一遍会和它打架。events 返回空数组即可。",
    );
  }
  if (options.emitFriendAliases) {
    lines.push(
      "这个范围记录的是她和一个具体的人之间的往来。请你顺带回想：她私下会怎么称呼这个人、给对方起了什么亲昵或调侃的外号？把想得起来的、她真的会叫的叫法写进 friendAliases 数组：alias 是那个叫法（简短，12 字以内，不是对方的本名或平台昵称），reason 用一句话写「为什么这么叫、什么情境下叫」。",
      "只想写她从对话里真的透露出会用的叫法，不要编一个漂亮但没人这么叫的外号；没有就返回空数组。不要带侮辱性、贬损性的称呼；不要写对方的隐私。",
    );
  }
  lines.push(
    "只输出 JSON，不要 Markdown 代码围栏。所有列表字段必须存在，即使为空。",
    "JSON 格式：",
    JSON.stringify({
      summary: "周期摘要",
      importantEvents: [{ title: "事件标题", detail: "客观事件", evidenceMessageIds: ["原始消息ID"] }],
      factAndPreferenceChanges: [{ description: "事实/偏好变化", changeType: "新增|更新|失效|确认", evidenceMessageIds: ["原始消息ID"] }],
      relationshipChanges: [{ description: "关系变化", evidenceMessageIds: ["原始消息ID"] }],
      goalsAndCommitments: [{ description: "目标或承诺", status: "进行中|已完成|取消|未明确", evidenceMessageIds: ["原始消息ID"] }],
      unresolvedTopics: [{ description: "未解决话题", evidenceMessageIds: ["原始消息ID"] }],
      differencesFromPrevious: ["相较上一份总结的变化"],
      friendAliases: [{ alias: "私下叫法", reason: "为什么这么叫" }],
      memoryChanges: [{
        action: "ADD|UPDATE|INVALIDATE",
        category: "FACT|PREFERENCE|RELATIONSHIP|COMMITMENT|GOAL|EVENT|SUMMARY|OTHER",
        content: "简明、可独立理解的记忆",
        confidence: 0.0,
        importance: 0.7,
        evidenceMessageIds: ["原始消息ID"],
        relatedMemoryId: "UPDATE/INVALIDATE 必填，ADD 省略",
        scope: "character（仅关于她本人的稳定事实；否则省略）",
        changeReason: "变化依据"
      }],
      events: [{
        occurredAt: "2026-10-25T06:00:00.000Z",
        timeOfDay: "下午",
        precision: "part_of_day",
        place: "北海",
        title: "和小明在海边游泳",
        detail: "小明下午约她去银滩游泳，一直玩到傍晚。",
        keywords: ["游泳", "海边", "银滩"],
        participants: ["小明"],
        confidence: 0.9,
        evidenceMessageIds: ["原始消息ID"]
      }]
    }, null, 2),
    "注意：JSON 示例中的原始消息ID只是占位符。只能返回输入中真实出现的 ID。",
  );
  return lines.join("\n");
}

export function isMemoryModelConfigured(configValue?: unknown): boolean {
  return isChatModelConfigured(configValue);
}

export async function analyzeMemoryPeriod(input: MemoryAiInput): Promise<{
  analysis: MemoryAiAnalysis;
  model: string;
  provider: string;
  promptTemplateVersion: string;
  usage?: ModelUsageTokens;
}> {
  // Credentials must be resolved by the caller for the selected provider. Never silently
  // substitute the global environment key for a request targeting another provider.
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  const baseUrl = input.apiBaseUrl.trim();
  if (!apiKey || !model || !baseUrl) {
    throw new Error("LLM_NOT_CONFIGURED: 当前模型请求缺少已解析的 API Key、API Base URL 或模型名称；请检查角色模型配置和服务端默认配置。");
  }
  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(baseUrl);
  } catch (error) {
    throw new Error("LLM_INVALID_BASE_URL: " + (error instanceof Error ? error.message : String(error)));
  }

  // 记忆提炼的输入比单轮对话大得多（一个周期上百条消息 + 现有记忆），思考型模型
  // 在 60 秒默认值下会超时；分块抽取后每块一百多条、又要顺序跑好几次，120 秒也踩过线
  // （2026-11-01 第 5 块超时，前 4 块白跑）。后台任务优先正确性，默认给满 180 秒。
  const timeoutRaw = Number(process.env.LLM_TIMEOUT_MS ?? 180_000);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 5_000 && timeoutRaw <= 180_000
    ? timeoutRaw
    : 180_000;
  // Keep connection settings out of the user prompt. Project fields explicitly so
  // extra runtime properties on nested objects cannot accidentally be serialized.
  const promptInput = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timezone: input.timezone,
    scopeType: input.scopeType,
    characterName: input.characterName,
    messages: input.messages.map(({
      id, role, eventType, occurredAt, content, origin, isOwner, mentionTargets, speaker, member,
    }) => ({
      id,
      role,
      eventType,
      occurredAt,
      content,
      ...(origin ? { origin } : {}),
      ...(isOwner ? { isOwner } : {}),
      // 群聊里 @ 的是谁：`other` 表示这句话是冲别人说的，不能记成她的事。
      ...(mentionTargets?.length ? { mentionTargets } : {}),
      // 发言人：忆泡的 participants 靠它写对名字，而不是靠模型从正文猜。
      ...(speaker ? { speaker } : {}),
      ...(member ? { member } : {}),
    })),
    totalMessageCount: input.totalMessageCount,
    omittedMessageCount: input.omittedMessageCount,
    activeMemories: input.activeMemories.map(({
      id, category, content, confidence, validFrom, validTo, createdAt,
    }) => ({ id, category, content, confidence, validFrom, validTo, createdAt })),
    ...(input.globalMemories?.length || input.allowGlobalMemory === true
      ? {
          globalMemories: (input.globalMemories ?? []).slice(0, 60).map(({
            id, category, content, confidence, validFrom, validTo, createdAt,
          }) => ({ id, category, content, confidence, validFrom, validTo, createdAt })),
        }
      : {}),
    previousSnapshotSummary: input.previousSnapshotSummary,
    // 周期内已经整理好的忆泡：快照以它为时间线权威，不再从零散消息重造事件。
    ...(input.periodEvents?.length
      ? {
          periodEvents: input.periodEvents.slice(0, 80).map((event) => ({
            id: event.id,
            occurredAt: event.occurredAt,
            title: event.title,
            detail: event.detail,
            participants: event.participants,
          })),
        }
      : {}),
    // 这一天已经记过的事件：让模型自己避开，别把同一件事换句话再写一遍。
    // 只在按天任务里传（周期快照没有「当天已记录」这个概念）。
    ...(input.existingEvents?.length
      ? {
          existingEvents: input.existingEvents.slice(0, 40).map((event) => ({
            occurredAt: event.occurredAt,
            title: event.title,
          })),
        }
      : {}),
  };

  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      // 思考型模型会先花掉一部分预算在 reasoning 上：6000 在「一天 120 条消息 + 事件 + 变化」
      // 这种输入下会把正文截断，表现是 JSON 解析失败（2026-10-31 实测重跑两次都挂在这）。
      // 宁可多给预算，也别让一份内容正确的输出因为截断被整轮丢掉。
      max_tokens: 16_000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt({ emitEvents: input.emitEvents !== false, withPeriodEvents: Boolean(input.periodEvents?.length), emitFriendAliases: input.emitFriendAliases === true, withGlobalMemories: Boolean(input.globalMemories?.length) || input.allowGlobalMemory === true }) },
        { role: "user", content: JSON.stringify(promptInput) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("LLM_RESPONSE_TOO_LARGE: 模型响应超过大小限制。");
  }
  if (!response.ok) {
    // Provider error bodies may echo request fragments. Keep raw response text out of task logs.
    throw new Error("LLM_HTTP_ERROR: 模型服务返回 HTTP " + response.status + "。请检查服务端模型配置和供应商控制台。");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_INVALID_ENVELOPE: 模型服务没有返回有效 JSON。");
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  let parsed: unknown;
  try {
    if (typeof content !== "string") throw new Error("content is not a string");
    // `response_format: json_object` 只是请求，不是保证：实测最常见的坏输出是套一层
    // json 围栏，或前面先写一句「好的，这是结果：」。内容和群聊那条一样走宽松解析，
    // 裸 JSON.parse 会把这类**内容其实全对**的输出判成失败（2026-10-31 群聊整理就是这样挂的）。
    parsed = parseJsonLoose(content, { expect: "object" });
    if (!parsed) throw new Error("not an object");
  } catch {
    throw new Error("LLM_INVALID_JSON: 模型输出不是有效 JSON。");
  }

  const sourceIds = input.messages.map((message) => message.id);
  const existingIds = input.activeMemories.map((memory) => memory.id);
  const globalIds = (input.globalMemories ?? []).map((memory) => memory.id);
  const analysis = validateMemoryAiOutput(parsed, sourceIds, existingIds, globalIds);
  // 用量统一走 model-usage 的解析，才能带上缓存命中明细（命中价只有未命中价的几十分之一）。
  const usage = readModelUsage(payload);

  return {
    analysis,
    model,
    provider: endpoint.origin,
    promptTemplateVersion: TEMPLATE_VERSION,
    ...(usage ? { usage } : {}),
  };
}

export function makeMemoryDedupeKey(category: MemoryCategoryValue, content: string): string {
  const normalized = content.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  return "ai:" + createHash("sha256").update(category + ":" + normalized).digest("hex").slice(0, 48);
}
