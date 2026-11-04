/**
 * 角色导出包（「角色卡」）的格式定义、构建与校验。
 *
 * 为什么不是整库 dump：换电脑时真正想带走的是「她是谁 + 她记得什么」，不是账号、
 * 渠道 Token、任务队列和工作日志。整库 dump 里那些东西既带不走（换台机器连不上原来的
 * QQ 网关），也不该带到别人电脑上（别人的私聊和凭据）。
 *
 * 因此包里只有七类内容，且每类都做过取舍：
 *   - 人设：name / basePrompt / styleExamples / userAddress + 少量模型参数
 *   - 记忆：CHARACTER_GLOBAL 与**导出者自己的** USER_PRIVATE 长期记忆
 *   - 忆泡：发生过什么（事实层）
 *   - 忆泡日历：哪些天整理过、整理到哪一刻（`memory_event_days`）。不带它，日历页
 *     导入后只剩「今天」一格，忆泡明明在、日子却不在
 *   - 日记 / 手账：她的主观视角（`character_journals` + 全部 `journal_revisions`）
 *   - 阶段总结：只带 CURRENT 版本，来源消息不随包走
 *   - 她的朋友（可选）：认识谁、聊过几次、她私底下怎么叫他（备注）、分别记得他什么
 *
 * 朋友这一段的取舍最需要说清楚：**导出者可以关掉它**。换台电脑继续养需要它（否则她
 * 一夜之间忘了整个群），但把卡发给别人时，它同时交出去的是别人的 QQ 号和「她怎么看他们」。
 * 所以这是唯一一个由导出者当场决定的内容段，默认带走、但不静默带走。
 * 只带走关系的元信息与记忆，**不带**账号绑定（`status` / `linkedUserId`）——
 * 那是站内用户与外部身份的验证结果，换人导入不该跟过去。
 *
 * 明确不带：
 *   - API Key（`chatApiKeyEncrypted` / `voiceApiKeyEncrypted` / `memoryAssistantApiKeyEncrypted`）—— 换机器本来就得重填，
 *     而且带出去等于把凭据交给任何拿到这个 json 的人
 *   - 表情包图片：图在 `.data/stickers/<id>/`，换机器后从 QQ 收藏夹重新同步即可
 *   - 会话原文、渠道绑定、任务队列、用量与审计：与具体机器/账号绑定
 *
 * 导入端把包当成**不可信输入**：字段逐个校验、超限直接拒绝，模型参数走白名单，
 * 任何密钥字段都不读。导入永远新建角色与新记忆范围，不会往已有角色里塞东西。
 */

import { createError } from "h3";
import { dropAliasesMatchingName, normalizeFriendAliases } from "./friend-aliases";

// 格式标识沿用改名前的 `yiling-hub.character`：它是角色卡的对外契约，
// 跟着品牌改成 yiling-space 会让已经导出的卡片导不进来。要换必须同时接受旧值。
export const CHARACTER_BUNDLE_FORMAT = "yiling-hub.character";
/**
 * 2 = 加入忆泡日历天与日记/手账。这两段是「内容」而不是美化：
 * 老程序读到 v2 卡会明确拒绝，总好过静默把她的日记丢掉。
 *
 * 3 = 朋友的备注（`MemoryScope.aliases`）。同样是内容：她怎么叫一个人，
 * 是她对这段关系的一部分理解，不是可选的展示字段。v3 卡给老程序读会被上面那条
 * 版本检查拦下 —— 让老程序明说「导不进来」，好过它默默把备注丢掉、导完还像成功。
 * v4 增加长期记忆、忆泡、阶段总结的跨设备 originId；v1–v3 仍兼容，缺少身份时由导入端补发。
 */
export const CHARACTER_BUNDLE_VERSION = 4;
/** 导入包最大字节数：够 4000 条记忆 + 600 篇总结 + 1500 篇手账，再大基本是塞了别的东西。 */
export const CHARACTER_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 归档周期的边界（2026-11-03 从 1–365 收到 1–8，默认 8 → 3）。
 * 与服务端 `api/characters/[id]/memory-settings/index.patch.ts` 的校验、
 * 前端 `pages/characters/[id]/settings/memory.vue` 的 `INTERVAL_*_DAYS` 必须一致。
 */
export const MEMORY_INTERVAL_MIN_DAYS = 1;
export const MEMORY_INTERVAL_MAX_DAYS = 8;
export const MEMORY_INTERVAL_DEFAULT_DAYS = 3;
/** 老角色包里可能带着过去允许的宽范围：读得进来，但不照搬，见下方 clamp。 */
const MEMORY_INTERVAL_IMPORT_MAX_DAYS = 365;

export const CHARACTER_BUNDLE_LIMITS = {
  memories: 4000,
  events: 4000,
  /** 忆泡日历的天数：一年 365 天 × 多个记忆范围，留两倍余量。 */
  eventDays: 2000,
  snapshots: 600,
  /** 日记 / 手账的天数：一天一条，三年也够。 */
  journals: 1500,
  /** 同一天同一种文本最多带走多少版；再多是反复「重写」刷出来的噪音。 */
  journalRevisions: 40,
  /** 全部日记/手账版本合计上限，防止包被历史版本撑爆。 */
  journalRevisionsTotal: 8000,
  catchphrases: 400,
  /** 一个角色最多带走多少位朋友：超过这个数的多半是群里刷出来的残留，不是真的认识。 */
  friends: 500,
  /** 单个朋友名下最多多少条记忆 / 总结。 */
  friendMemories: 300,
  friendSnapshots: 60,
  /** 全部朋友名下的记忆合计上限，防止 500 × 300 把包撑爆。 */
  friendMemoriesTotal: 4000,
  name: 100,
  alias: 100,
  description: 2000,
  basePrompt: 12000,
  styleExamples: 8000,
  userAddress: 40,
  memoryContent: 12000,
  eventTitle: 200,
  eventDetail: 12000,
  eventPlace: 200,
  snapshotSummary: 20000,
  journalContent: 20000,
  journalTitle: 120,
  journalThought: 4000,
  journalQuote: 2000,
  journalSkipReason: 300,
  catchphrase: 200,
  catchphraseUsage: 2000,
  tagLength: 40,
  tagsPerItem: 20,
} as const;

export type BundleScopeKind = "character" | "private";
export type BundleMemoryCategory =
  | "FACT"
  | "PREFERENCE"
  | "RELATIONSHIP"
  | "COMMITMENT"
  | "GOAL"
  | "EVENT"
  | "SUMMARY"
  | "OTHER";
export type BundleEventState = "DRAFT" | "FINAL";
export type BundleEventPrecision = "exact" | "part_of_day" | "day";
export type BundleSnapshotKind = "AUTOMATIC" | "MANUAL";
export type BundleJournalStatus = "ACTIVE" | "SKIPPED";
export type BundleJournalTextState = "PENDING" | "GENERATED" | "SKIPPED";
export type BundleJournalTextKind = "DIARY" | "HANDBOOK";
export type BundleJournalRevisionType = "AI_GENERATED" | "AI_REWRITE" | "USER_EDITED" | "RESTORED";

export type CharacterBundleCharacter = {
  name: string;
  alias: string;
  description: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  basePrompt: string;
  styleExamples: string;
  userAddress: string;
};

/**
 * 血缘：这张卡最初来自哪一份角色数据。
 *
 * 它不是账号，也不是「本机的角色 id」—— 导入永远新建一行，新行有自己的 id。
 * 这里记的是第一份数据的 id，导出时优先取角色行上的 `originCharacterId`，
 * 所以 A → B → C 反复导出导入之后仍然指向同一个 origin。
 *
 * 用途只有一个：**认出本机已有的同一个角色**，从而允许合并而不是并排养出两个。
 * 空字符串 = 这份卡没有血缘信息（老卡，或导出时角色行上也没有），只能新建。
 */
export type CharacterBundleOrigin = {
  characterId: string;
};

export type CharacterBundleModelConfig = {
  chatModel?: string;
  chatTemperature?: number;
  chatMaxTokens?: number;
  chatThinking?: boolean;
  chatApiBaseUrl?: string;
  memoryTokenBudget?: number;
  snapshotTokenBudget?: number;
  memoryItemLimit?: number;
  recentMessageLimit?: number;
};

export type CharacterBundleMemory = {
  scope: BundleScopeKind;
  /** 跨设备稳定身份；老格式卡片没有该字段。 */
  originId: string | null;
  category: BundleMemoryCategory;
  content: string;
  confidence: number | null;
  importance: number;
  validFrom: string | null;
  validTo: string | null;
  dedupeKey: string | null;
};

export type CharacterBundleEvent = {
  scope: BundleScopeKind;
  /** 跨设备稳定身份；老格式卡片没有该字段。 */
  originId: string | null;
  dayKey: string;
  state: BundleEventState;
  occurredAt: string;
  timeOfDay: string | null;
  precision: BundleEventPrecision;
  place: string | null;
  title: string;
  detail: string;
  keywords: string[];
  participants: string[];
  confidence: number | null;
};

export type CharacterBundleSnapshot = {
  scope: BundleScopeKind;
  /** 跨设备稳定身份；老格式卡片没有该字段。 */
  originId: string | null;
  kind: BundleSnapshotKind;
  periodStart: string;
  periodEnd: string;
  summary: string;
  structuredContent: unknown;
  generatedAt: string | null;
  createdAt: string;
};

export type CharacterBundleCatchphrase = {
  phrase: string;
  usage: string;
  enabled: boolean;
  source: string;
};

/**
 * 忆泡日历的一天。
 *
 * 它和忆泡不是一回事：忆泡是「那天发生了什么」，这一行是「那天整理过没有、整理到哪一刻」。
 * 日历页读的是这张表，所以忆泡带走了、这行没带走，导入后日历就是空的。
 *
 * `eventCount` 保留原值而不是按导入的忆泡重算 —— 原文没随包走，条数是历史事实，
 * 重算只会让「那天整理出 25 条」变成「3 条」，看起来像丢数据。
 */
export type CharacterBundleEventDay = {
  scope: BundleScopeKind;
  dayKey: string;
  state: BundleEventState;
  eventCount: number;
  extractedAt: string | null;
};

/**
 * 日记 / 手账的一版。
 *
 * `sourceMessageIds` / `sourceEventIds` 不带：它们指向旧机器上的消息和忆泡 id，
 * 换台机器就是一堆死指针，页面上会显示「引用了 12 条原文」却点不开任何一条。
 * 「今日一句」的来源改用 `sourceDiaryVersion`（版本号）表达，导入时重映射到新 id。
 */
export type CharacterBundleJournalRevision = {
  kind: BundleJournalTextKind;
  version: number;
  title: string;
  content: string;
  thought: string;
  quote: string;
  tags: string[];
  revisionType: BundleJournalRevisionType;
  promptVersion: string | null;
  model: string | null;
  /** 手账的「今日一句」摘自第几版日记；日记版本里为空。 */
  sourceDiaryVersion: number | null;
  createdAt: string | null;
};

export type CharacterBundleJournal = {
  dayKey: string;
  status: BundleJournalStatus;
  skipReason: string | null;
  diaryState: BundleJournalTextState;
  handbookState: BundleJournalTextState;
  diaryDecidedAt: string | null;
  handbookDecidedAt: string | null;
  createdAt: string | null;
  revisions: CharacterBundleJournalRevision[];
};

/** 朋友名下的记忆与总结没有 `scope`：它属于谁由所在的 `friends[i]` 决定。 */
export type CharacterBundleMemoryBody = Omit<CharacterBundleMemory, "scope">;
export type CharacterBundleSnapshotBody = Omit<CharacterBundleSnapshot, "scope">;

/**
 * 「她的朋友」= 一条关系，不是一个账号。
 *
 * 只带「谁」和「她记得他什么」，**不带**账号绑定（`status` / `linkedUserId`）：
 * 那是站内用户与外部身份的验证结果，换台电脑、换个人导入都不该跟着走。
 */
export type CharacterBundleFriend = {
  platform: string;
  /** QQ 号 / B站 uid。群里认人靠它，所以必须带；这也是分享时最该慎重的字段。 */
  platformUid: string;
  displayName: string;
  /**
   * 她私底下对这个人的叫法 —— 页面上「＋ 加备注」录的那几个词。
   *
   * 和 `displayName` 不是一回事：那是平台名片，对方改一次群名片就变一次；
   * 这是她自己的叫法，按角色隔离。缺省/空数组 = 没设过备注（v2 老卡就是这样）。
   */
  aliases: string[];
  /** 在哪儿认识的：PRIVATE（私聊）/ GROUP（群里）。空 = 没记过。 */
  firstSource: string | null;
  interactionCount: number;
  lastInteractedAt: string | null;
  /** 关系建立时间，也就是第一次遇到这个人的时间。 */
  knownSince: string | null;
  memories: CharacterBundleMemoryBody[];
  snapshots: CharacterBundleSnapshotBody[];
};

export type CharacterBundleCounts = {
  memories: number;
  privateMemories: number;
  events: number;
  /** 忆泡日历里有记录的天数。 */
  eventDays: number;
  snapshots: number;
  /** 日记 / 手账的天数（一天一条，日记与手账各算一份文本）。 */
  journals: number;
  /** 日记/手账的历史版本合计。 */
  journalRevisions: number;
  catchphrases: number;
  /** 带走了几位朋友。为 0 时包里没有朋友数据（分享给别人时通常会关掉）。 */
  friends: number;
  /** 朋友名下的记忆条数（已计入 memories 之外的单独统计，避免和角色记忆混着数）。 */
  friendMemories: number;
  /** 朋友们名下的备注（她私底下的叫法）总条数。为 0 时导入预览可以放心说「没有备注」。 */
  friendAliases: number;
};

export type CharacterBundle = {
  format: typeof CHARACTER_BUNDLE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  exportedBy: "yiling-space";
  origin: CharacterBundleOrigin;
  character: CharacterBundleCharacter;
  modelConfig: CharacterBundleModelConfig;
  memorySetting: {
    snapshotIntervalDays: number;
    timezone: string;
    autoSnapshotEnabled: boolean;
  };
  memories: CharacterBundleMemory[];
  events: CharacterBundleEvent[];
  eventDays: CharacterBundleEventDay[];
  snapshots: CharacterBundleSnapshot[];
  journals: CharacterBundleJournal[];
  catchphrases: CharacterBundleCatchphrase[];
  friends: CharacterBundleFriend[];
  counts: CharacterBundleCounts;
};

/**
 * 模型参数白名单：导出只带这些键，导入也只认这些键。
 * 行为开关（表情、语音、主动搭话、群内接话）不随包走 —— 它们依赖新机器上的服务商和网关，
 * 照搬只会让角色在新环境里做出没人预期的动作。
 */
export const PORTABLE_MODEL_CONFIG_KEYS = [
  "chatModel",
  "chatTemperature",
  "chatMaxTokens",
  "chatThinking",
  "chatApiBaseUrl",
  "memoryTokenBudget",
  "snapshotTokenBudget",
  "memoryItemLimit",
  "recentMessageLimit",
] as const;

/** 任何以 `v1.` 开头的密文字段都不许进包；这里再按名字兜一层。 */
const SECRET_NAME_PATTERN = /(apikey|api_key|token|secret|password|credential)/i;
const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 血缘 id 只认 UUID，不像 id 的一律当「没有」。
 *
 * 和别处「不认识就拒绝」不同：它只是合并时的认人线索，不是内容。手改坏一个字符
 * 就整张卡导不进来，代价远大于丢掉合并能力（丢了还能走新建副本）。
 */
export function normalizeBundleOriginId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ORIGIN_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}
const AVATAR_TONES = ["purple", "peach", "mint", "blue"] as const;
const MEMORY_CATEGORIES: readonly BundleMemoryCategory[] = [
  "FACT",
  "PREFERENCE",
  "RELATIONSHIP",
  "COMMITMENT",
  "GOAL",
  "EVENT",
  "SUMMARY",
  "OTHER",
];
const EVENT_STATES: readonly BundleEventState[] = ["DRAFT", "FINAL"];
const EVENT_PRECISIONS: readonly BundleEventPrecision[] = ["exact", "part_of_day", "day"];
const SNAPSHOT_KINDS: readonly BundleSnapshotKind[] = ["AUTOMATIC", "MANUAL"];
const JOURNAL_STATUSES: readonly BundleJournalStatus[] = ["ACTIVE", "SKIPPED"];
const JOURNAL_TEXT_STATES: readonly BundleJournalTextState[] = ["PENDING", "GENERATED", "SKIPPED"];
const JOURNAL_TEXT_KINDS: readonly BundleJournalTextKind[] = ["DIARY", "HANDBOOK"];
const JOURNAL_REVISION_TYPES: readonly BundleJournalRevisionType[] = [
  "AI_GENERATED",
  "AI_REWRITE",
  "USER_EDITED",
  "RESTORED",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}

/**
 * 去掉模型配置里的全部凭据，并且**只保留白名单键**。
 * 导出用一次，导入再用一次：导出保证不泄密，导入保证不把别人的奇怪字段写进库。
 */
export function stripPortableModelConfig(config: unknown): CharacterBundleModelConfig {
  const source = asRecord(config);
  const result: Record<string, unknown> = {};
  for (const key of PORTABLE_MODEL_CONFIG_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (SECRET_NAME_PATTERN.test(key) || value.startsWith("v1.")) continue;
      result[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
      continue;
    }
    // 深度思考是布尔：不认这一支的话，这个键进了白名单也照样被丢掉。
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result as CharacterBundleModelConfig;
}

function readText(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) bad(`${label}不能为空。`);
    return "";
  }
  if (typeof value !== "string") bad(`${label}必须是文本。`);
  const trimmed = value.trim();
  if (required && !trimmed) bad(`${label}不能为空。`);
  if (trimmed.length > max) bad(`${label}不能超过 ${max} 个字符。`);
  return trimmed;
}

function readOptionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) bad(`${label}不是有效的时间。`);
  return new Date(value);
}

function readNumber(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) bad(`${label}必须是数字。`);
  if (value < min || value > max) bad(`${label}必须在 ${min} 到 ${max} 之间。`);
  return value;
}

function readOptionalNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) bad(`${label}必须是数字。`);
  if (value < min || value > max) bad(`${label}必须在 ${min} 到 ${max} 之间。`);
  return value;
}

function readStringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${label}必须是数组。`);
  if (value.length > CHARACTER_BUNDLE_LIMITS.tagsPerItem) {
    bad(`${label}最多 ${CHARACTER_BUNDLE_LIMITS.tagsPerItem} 项。`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") bad(`${label}第 ${index + 1} 项必须是文本。`);
    const trimmed = item.trim();
    if (trimmed.length > CHARACTER_BUNDLE_LIMITS.tagLength) {
      bad(`${label}第 ${index + 1} 项不能超过 ${CHARACTER_BUNDLE_LIMITS.tagLength} 个字符。`);
    }
    return trimmed;
  }).filter(Boolean);
}

function readArray(value: unknown, label: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${label}必须是数组。`);
  if (value.length > max) bad(`${label}最多 ${max} 条，请先拆成多个角色卡。`);
  return value;
}

function readScope(value: unknown): BundleScopeKind {
  return value === "private" ? "private" : "character";
}

/** 记忆条数决定导入后「她记得多少」，不带得太多；这是唯一的排序依据。 */
function buildCounts(bundle: Omit<CharacterBundle, "counts">): CharacterBundleCounts {
  return {
    memories: bundle.memories.length,
    privateMemories: bundle.memories.filter((item) => item.scope === "private").length,
    events: bundle.events.length,
    eventDays: bundle.eventDays.length,
    snapshots: bundle.snapshots.length,
    journals: bundle.journals.length,
    journalRevisions: bundle.journals.reduce((total, journal) => total + journal.revisions.length, 0),
    catchphrases: bundle.catchphrases.length,
    friends: bundle.friends.length,
    friendMemories: bundle.friends.reduce((total, friend) => total + friend.memories.length, 0),
    friendAliases: bundle.friends.reduce((total, friend) => total + friend.aliases.length, 0),
  };
}

/**
 * 名称在导出者那边唯一，在导入者这边不一定。撞名不报错，加后缀而不是覆盖 ——
 * 两份同名的角色卡同时存在是合理的（比如「我的一只鱼」和「朋友的一只鱼」）。
 */
export function computeImportedCharacterName(name: string, existingNames: readonly string[]): string {
  const base = name.trim().slice(0, CHARACTER_BUNDLE_LIMITS.name) || "导入的角色";
  const taken = new Set(existingNames.map((item) => item.trim()));
  if (!taken.has(base)) return base;
  const suffixed = `${base} 副本`;
  if (!taken.has(suffixed)) return suffixed;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} 副本 ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

type MemorySource = {
  originId?: string;
  category: string;
  content: string;
  confidence: number | null;
  importance: number;
  validFrom: Date | null;
  validTo: Date | null;
  dedupeKey: string | null;
};

type SnapshotSource = {
  originId?: string;
  kind: string;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  structuredContent: unknown;
  generatedAt: Date | null;
  createdAt: Date;
};

function toBundleMemory(item: MemorySource): CharacterBundleMemoryBody {
  return {
    originId: item.originId ?? null,
    category: (MEMORY_CATEGORIES as readonly string[]).includes(item.category)
      ? item.category as BundleMemoryCategory
      : "OTHER",
    content: item.content,
    confidence: item.confidence,
    importance: item.importance,
    validFrom: item.validFrom ? item.validFrom.toISOString() : null,
    validTo: item.validTo ? item.validTo.toISOString() : null,
    dedupeKey: item.dedupeKey,
  };
}

function toBundleSnapshot(snapshot: SnapshotSource): CharacterBundleSnapshotBody {
  return {
    originId: snapshot.originId ?? null,
    kind: (SNAPSHOT_KINDS as readonly string[]).includes(snapshot.kind)
      ? snapshot.kind as BundleSnapshotKind
      : "AUTOMATIC",
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    summary: snapshot.summary,
    structuredContent: snapshot.structuredContent ?? {},
    generatedAt: snapshot.generatedAt ? snapshot.generatedAt.toISOString() : null,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

/**
 * 从库里读出来、还没序列化的日记/手账（`Date` 尚未转成 ISO）。
 * 导出侧按这个形状交给 `buildCharacterBundle`，转换在那一层统一做。
 */
export type BundleJournalSource = {
  dayKey: string;
  status: string;
  skipReason: string | null;
  diaryState: string;
  handbookState: string;
  diaryDecidedAt: Date | null;
  handbookDecidedAt: Date | null;
  createdAt: Date;
  revisions: Array<{
    kind: string;
    version: number;
    title: string | null;
    content: string;
    thought: string | null;
    quote: string | null;
    tags: string[];
    revisionType: string;
    promptVersion: string | null;
    model: string | null;
    sourceDiaryVersion: number | null;
    createdAt: Date;
  }>;
};

export type BundleBuildInput = {
  character: {
    name: string;
    basePrompt: string;
    styleExamples?: string | null;
    userAddress?: string | null;
    modelConfig?: unknown;
    /** 角色行上的血缘 id；导出时优先用它，没有才在调用方回落到角色自己的 id。 */
    originCharacterId?: string | null;
  };
  memorySetting?: {
    snapshotIntervalDays: number;
    timezone: string;
    autoSnapshotEnabled: boolean;
  } | null;
  scopes: Array<{
    scopeType: string;
    userId?: string | null;
    memoryItems?: MemorySource[];
    events?: Array<{
      originId?: string;
      dayKey: string;
      state: string;
      occurredAt: Date;
      timeOfDay: string | null;
      precision: string;
      place: string | null;
      title: string;
      detail: string;
      keywords: string[];
      participants: string[];
      confidence: number | null;
    }>;
    snapshots?: SnapshotSource[];
    /**
     * 忆泡日历的进度行。少了它，导入后日历页只剩「今天」一格。
     */
    eventDays?: Array<{
      dayKey: string;
      state: string;
      eventCount: number;
      extractedAt: Date | null;
    }>;
  }>;
  /**
   * 日记 / 手账。只取角色全局范围的（生成代码只写这一份），一天一条。
   * 版本按 `kind` 分组、`version` 升序由调用方截断后传入。
   */
  journals?: BundleJournalSource[];
  /**
   * 「她的朋友」。只在导出者明确要带走时才传（分享型导出传空数组），
   * 传入的一定是 `interactionCount > 0` 的关系 —— 0 次的是群里没搭理的残留。
   */
  friends?: Array<{
    platform: string;
    platformUid: string;
    displayName: string | null;
    /** 她私底下的叫法。库里是数组，导入端与页面共用 `normalizeFriendAliases` 的口径。 */
    aliases?: string[] | null;
    firstSource: string | null;
    interactionCount: number;
    lastInteractedAt: Date | null;
    knownSince: Date | null;
    memoryItems?: MemorySource[];
    snapshots?: SnapshotSource[];
  }>;
  catchphrases?: Array<{ phrase: string; usage: string; enabled: boolean; source: string }>;
  now?: Date;
};

/**
 * 把库里的角色读成导出包。`scopes` 只应包含角色全局范围与导出者自己的私人范围，
 * 调用方必须在查询阶段就按 `userId` 过滤，不能靠这里兜底。
 */
export function buildCharacterBundle(input: BundleBuildInput): CharacterBundle {
  const config = asRecord(input.character.modelConfig);
  const memories: CharacterBundleMemory[] = [];
  const events: CharacterBundleEvent[] = [];
  const eventDays: CharacterBundleEventDay[] = [];
  const snapshots: CharacterBundleSnapshot[] = [];

  for (const scope of input.scopes) {
    const kind: BundleScopeKind = scope.scopeType === "CHARACTER_GLOBAL" ? "character" : "private";
    for (const item of scope.memoryItems ?? []) {
      memories.push({ scope: kind, ...toBundleMemory(item) });
    }
    for (const event of scope.events ?? []) {
      events.push({
        scope: kind,
        originId: event.originId ?? null,
        dayKey: event.dayKey,
        state: (EVENT_STATES as readonly string[]).includes(event.state) ? event.state as BundleEventState : "FINAL",
        occurredAt: event.occurredAt.toISOString(),
        timeOfDay: event.timeOfDay,
        precision: (EVENT_PRECISIONS as readonly string[]).includes(event.precision)
          ? event.precision as BundleEventPrecision
          : "day",
        place: event.place,
        title: event.title,
        detail: event.detail,
        keywords: event.keywords,
        participants: event.participants,
        confidence: event.confidence,
      });
    }
    for (const day of scope.eventDays ?? []) {
      eventDays.push({
        scope: kind,
        dayKey: day.dayKey,
        state: (EVENT_STATES as readonly string[]).includes(day.state) ? day.state as BundleEventState : "FINAL",
        eventCount: Math.max(0, Math.trunc(day.eventCount)),
        extractedAt: day.extractedAt ? day.extractedAt.toISOString() : null,
      });
    }
    for (const snapshot of scope.snapshots ?? []) {
      snapshots.push({ scope: kind, ...toBundleSnapshot(snapshot) });
    }
  }

  const journals: CharacterBundleJournal[] = (input.journals ?? []).map((journal) => ({
    dayKey: journal.dayKey,
    status: (JOURNAL_STATUSES as readonly string[]).includes(journal.status)
      ? journal.status as BundleJournalStatus
      : "ACTIVE",
    skipReason: journal.skipReason,
    diaryState: (JOURNAL_TEXT_STATES as readonly string[]).includes(journal.diaryState)
      ? journal.diaryState as BundleJournalTextState
      : "PENDING",
    handbookState: (JOURNAL_TEXT_STATES as readonly string[]).includes(journal.handbookState)
      ? journal.handbookState as BundleJournalTextState
      : "PENDING",
    diaryDecidedAt: journal.diaryDecidedAt ? journal.diaryDecidedAt.toISOString() : null,
    handbookDecidedAt: journal.handbookDecidedAt ? journal.handbookDecidedAt.toISOString() : null,
    createdAt: journal.createdAt.toISOString(),
    revisions: journal.revisions.map((revision) => ({
      kind: (JOURNAL_TEXT_KINDS as readonly string[]).includes(revision.kind)
        ? revision.kind as BundleJournalTextKind
        : "DIARY",
      version: Math.max(1, Math.trunc(revision.version)),
      title: (revision.title ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.journalTitle),
      content: revision.content,
      thought: revision.thought ?? "",
      quote: revision.quote ?? "",
      tags: revision.tags.filter(Boolean).slice(0, CHARACTER_BUNDLE_LIMITS.tagsPerItem),
      revisionType: (JOURNAL_REVISION_TYPES as readonly string[]).includes(revision.revisionType)
        ? revision.revisionType as BundleJournalRevisionType
        : "AI_GENERATED",
      promptVersion: revision.promptVersion,
      model: revision.model,
      sourceDiaryVersion: revision.sourceDiaryVersion,
      createdAt: revision.createdAt ? revision.createdAt.toISOString() : null,
    })),
  }));

  const friends: CharacterBundleFriend[] = (input.friends ?? []).map((friend) => {
    const displayName = (friend.displayName ?? "").slice(0, 255);
    return {
      platform: friend.platform.slice(0, 50),
      platformUid: friend.platformUid.slice(0, 255),
      displayName,
      // 备注和页面保存走同一份口径（切分 / 截断 / 去重 / 去掉与本名相同的叫法），
      // 导出的包里不带脏数据，导入端就不用猜这些词是不是干净的。
      aliases: dropAliasesMatchingName(normalizeFriendAliases(friend.aliases ?? []).aliases, displayName),
      firstSource: friend.firstSource === "PRIVATE" || friend.firstSource === "GROUP" ? friend.firstSource : null,
      interactionCount: Math.max(0, Math.trunc(friend.interactionCount)),
      lastInteractedAt: friend.lastInteractedAt ? friend.lastInteractedAt.toISOString() : null,
      knownSince: friend.knownSince ? friend.knownSince.toISOString() : null,
      memories: (friend.memoryItems ?? []).map(toBundleMemory),
      snapshots: (friend.snapshots ?? []).map(toBundleSnapshot),
    };
  });

  const payload: Omit<CharacterBundle, "counts"> = {
    format: CHARACTER_BUNDLE_FORMAT,
    formatVersion: CHARACTER_BUNDLE_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    exportedBy: "yiling-space",
    origin: {
      // 没有就走空：导入端会把它当成「不能合并，只能新建副本」。
      characterId: normalizeBundleOriginId(input.character.originCharacterId) ?? "",
    },
    character: {
      name: input.character.name,
      alias: typeof config.alias === "string" ? config.alias.slice(0, CHARACTER_BUNDLE_LIMITS.alias) : "",
      description: typeof config.description === "string"
        ? config.description.slice(0, CHARACTER_BUNDLE_LIMITS.description)
        : "",
      avatarTone: (AVATAR_TONES as readonly string[]).includes(String(config.avatarTone))
        ? config.avatarTone as CharacterBundleCharacter["avatarTone"]
        : "mint",
      basePrompt: input.character.basePrompt,
      styleExamples: input.character.styleExamples ?? "",
      userAddress: input.character.userAddress ?? "",
    },
    modelConfig: stripPortableModelConfig(input.character.modelConfig),
    memorySetting: {
      snapshotIntervalDays: input.memorySetting?.snapshotIntervalDays ?? 3,
      timezone: input.memorySetting?.timezone ?? "Asia/Shanghai",
      autoSnapshotEnabled: input.memorySetting?.autoSnapshotEnabled ?? false,
    },
    memories,
    events,
    eventDays,
    snapshots,
    journals,
    catchphrases: (input.catchphrases ?? []).map((item) => ({
      phrase: item.phrase,
      usage: item.usage,
      enabled: item.enabled,
      source: item.source || "manual",
    })),
    friends,
  };

  return { ...payload, counts: buildCounts(payload) };
}

export type ParsedCharacterBundle = {
  formatVersion: number;
  /**
   * 血缘 id；null = 这张卡没带来源角色信息，只能新建（不能合并）。
   */
  originId: string | null;
  character: CharacterBundleCharacter;
  modelConfig: CharacterBundleModelConfig;
  memorySetting: CharacterBundle["memorySetting"];
  memories: CharacterBundleMemory[];
  events: CharacterBundleEvent[];
  eventDays: CharacterBundleEventDay[];
  snapshots: CharacterBundleSnapshot[];
  journals: CharacterBundleJournal[];
  catchphrases: CharacterBundleCatchphrase[];
  friends: CharacterBundleFriend[];
  counts: CharacterBundleCounts;
  exportedAt: string | null;
};

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function readDayKey(value: unknown, label: string): string {
  const text = readText(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) bad(`${label}必须是 YYYY-MM-DD 格式。`);
  return text;
}

/**
 * 校验并规范化导入包。任何不认识的东西都拒绝，而不是「尽量理解」——
 * 角色卡会被贴到群里、传到网盘，解析器宽容一次，后面就要为它兜一辈子。
 */
export function parseCharacterBundle(raw: unknown): ParsedCharacterBundle {
  const body = asRecord(raw);
  if (body.format !== CHARACTER_BUNDLE_FORMAT) {
    bad("这不是忆灵空间的角色卡文件（缺少 format 标记）。");
  }
  const version = body.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    bad("角色卡的格式版本无效。");
  }
  if (version > CHARACTER_BUNDLE_VERSION) {
    bad(`角色卡格式版本 ${version} 高于当前程序支持的 ${CHARACTER_BUNDLE_VERSION}，请先升级程序。`);
  }

  // 血缘：v1 老卡与手工整理的卡都可能没有这一段，缺省就是「认不出，只能新建」。
  const originId = normalizeBundleOriginId(asRecord(body.origin).characterId);

  const character = asRecord(body.character);
  const name = readText(character.name, "角色名称", CHARACTER_BUNDLE_LIMITS.name, true);
  const basePrompt = readText(character.basePrompt, "人设", CHARACTER_BUNDLE_LIMITS.basePrompt);
  const styleExamples = readText(character.styleExamples, "对话示例", CHARACTER_BUNDLE_LIMITS.styleExamples);
  const userAddress = readText(character.userAddress, "她对你的称呼", CHARACTER_BUNDLE_LIMITS.userAddress);
  const alias = readText(character.alias, "角色标签", CHARACTER_BUNDLE_LIMITS.alias);
  const description = readText(character.description, "角色简介", CHARACTER_BUNDLE_LIMITS.description);
  const avatarTone = (AVATAR_TONES as readonly string[]).includes(String(character.avatarTone))
    ? character.avatarTone as CharacterBundleCharacter["avatarTone"]
    : "mint";

  const modelConfig = stripPortableModelConfig(body.modelConfig);
  const setting = asRecord(body.memorySetting);
  const timezoneInput = readText(setting.timezone, "时区", 100);
  /**
   * 归档周期收口：老卡里的 1–365 照旧读得进来，但落到 1–8 之间。
   *
   * 这里刻意**不拒绝**超范围的老卡：拒绝等于「你导不进来」，而卡本身没有任何问题，
   * 只是当年允许填 30 天。收口则是把周期压到 8，导入后在设置页直接看得见，
   * 也不会留下「库里 30、界面 8、一保存就 400」的那种死角。
   */
  const memorySetting = {
    snapshotIntervalDays: Math.min(
      MEMORY_INTERVAL_MAX_DAYS,
      Math.round(
        readNumber(
          setting.snapshotIntervalDays,
          "归档周期",
          MEMORY_INTERVAL_MIN_DAYS,
          MEMORY_INTERVAL_IMPORT_MAX_DAYS,
          MEMORY_INTERVAL_DEFAULT_DAYS,
        ),
      ),
    ),
    timezone: timezoneInput && isValidTimezone(timezoneInput) ? timezoneInput : "Asia/Shanghai",
    autoSnapshotEnabled: setting.autoSnapshotEnabled === true,
  };

  const memories: CharacterBundleMemory[] = readArray(
    body.memories,
    "记忆",
    CHARACTER_BUNDLE_LIMITS.memories,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条记忆`;
    const categoryInput = typeof item.category === "string" ? item.category : "";
    return {
      scope: readScope(item.scope),
      originId: normalizeBundleOriginId(item.originId),
      category: (MEMORY_CATEGORIES as readonly string[]).includes(categoryInput)
        ? categoryInput as BundleMemoryCategory
        : "OTHER",
      content: readText(item.content, label, CHARACTER_BUNDLE_LIMITS.memoryContent, true),
      confidence: readOptionalNumber(item.confidence, `${label}的可信度`, 0, 1),
      importance: readNumber(item.importance, `${label}的重要度`, 0, 1, 0.5),
      validFrom: readOptionalDate(item.validFrom, `${label}的生效时间`)?.toISOString() ?? null,
      validTo: readOptionalDate(item.validTo, `${label}的失效时间`)?.toISOString() ?? null,
      dedupeKey: typeof item.dedupeKey === "string" && item.dedupeKey.trim()
        ? item.dedupeKey.trim().slice(0, 255)
        : null,
    };
  });

  const events: CharacterBundleEvent[] = readArray(
    body.events,
    "忆泡",
    CHARACTER_BUNDLE_LIMITS.events,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条忆泡`;
    const occurredAt = readOptionalDate(item.occurredAt, `${label}的发生时间`);
    if (!occurredAt) bad(`${label}缺少发生时间。`);
    const stateInput = typeof item.state === "string" ? item.state : "";
    const precisionInput = typeof item.precision === "string" ? item.precision : "";
    const timeOfDay = readText(item.timeOfDay, `${label}的时段`, 20);
    const place = readText(item.place, `${label}的地点`, CHARACTER_BUNDLE_LIMITS.eventPlace);
    return {
      scope: readScope(item.scope),
      originId: normalizeBundleOriginId(item.originId),
      dayKey: readDayKey(item.dayKey, `${label}的日期`),
      state: (EVENT_STATES as readonly string[]).includes(stateInput) ? stateInput as BundleEventState : "FINAL",
      occurredAt: occurredAt.toISOString(),
      timeOfDay: timeOfDay || null,
      precision: (EVENT_PRECISIONS as readonly string[]).includes(precisionInput)
        ? precisionInput as BundleEventPrecision
        : "day",
      place: place || null,
      title: readText(item.title, `${label}的标题`, CHARACTER_BUNDLE_LIMITS.eventTitle, true),
      detail: readText(item.detail, `${label}的详情`, CHARACTER_BUNDLE_LIMITS.eventDetail),
      keywords: readStringList(item.keywords, `${label}的关键词`),
      participants: readStringList(item.participants, `${label}的参与者`),
      confidence: readOptionalNumber(item.confidence, `${label}的可信度`, 0, 1),
    };
  });

  const snapshots: CharacterBundleSnapshot[] = readArray(
    body.snapshots,
    "阶段总结",
    CHARACTER_BUNDLE_LIMITS.snapshots,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 篇阶段总结`;
    const periodStart = readOptionalDate(item.periodStart, `${label}的周期开始时间`);
    const periodEnd = readOptionalDate(item.periodEnd, `${label}的周期结束时间`);
    if (!periodStart || !periodEnd) bad(`${label}缺少周期时间。`);
    if (periodEnd < periodStart) bad(`${label}的周期结束时间早于开始时间。`);
    const kindInput = typeof item.kind === "string" ? item.kind : "";
    const generatedAt = readOptionalDate(item.generatedAt, `${label}的生成时间`);
    const createdAt = readOptionalDate(item.createdAt, `${label}的创建时间`) ?? periodEnd;
    const structured = item.structuredContent;
    return {
      scope: readScope(item.scope),
      originId: normalizeBundleOriginId(item.originId),
      kind: (SNAPSHOT_KINDS as readonly string[]).includes(kindInput) ? kindInput as BundleSnapshotKind : "AUTOMATIC",
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      summary: readText(item.summary, `${label}的正文`, CHARACTER_BUNDLE_LIMITS.snapshotSummary, true),
      // 结构化内容是模型产出的 JSON，原样带走；导入时只当历史文本，不再触发任何写记忆行为。
      structuredContent: structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {},
      generatedAt: generatedAt ? generatedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    };
  });

  /**
   * 忆泡日历的天。允许缺省（老卡没有这一段），也允许有重复 dayKey：
   * 同一范围同一天只能有一行，重复会撞唯一键，这里按 dayKey 合并 ——
   * 条数取大、整理时间取晚、任一为 DRAFT 就算 DRAFT，和日历页的合并口径一致。
   */
  const eventDayMap = new Map<string, CharacterBundleEventDay>();
  readArray(body.eventDays, "忆泡日历", CHARACTER_BUNDLE_LIMITS.eventDays).forEach((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 个忆泡日历日`;
    const scope = readScope(item.scope);
    const dayKey = readDayKey(item.dayKey, `${label}的日期`);
    const stateInput = typeof item.state === "string" ? item.state : "";
    const state: BundleEventState = (EVENT_STATES as readonly string[]).includes(stateInput)
      ? stateInput as BundleEventState
      : "FINAL";
    const eventCount = Math.round(readNumber(item.eventCount, `${label}的忆泡条数`, 0, 100_000, 0));
    const extractedAt = readOptionalDate(item.extractedAt, `${label}的整理时间`);
    const key = `${scope}:${dayKey}`;
    const previous = eventDayMap.get(key);
    if (!previous) {
      eventDayMap.set(key, {
        scope,
        dayKey,
        state,
        eventCount,
        extractedAt: extractedAt ? extractedAt.toISOString() : null,
      });
      return;
    }
    previous.eventCount = Math.max(previous.eventCount, eventCount);
    if (state === "DRAFT") previous.state = "DRAFT";
    const candidateTime = extractedAt ? extractedAt.getTime() : 0;
    const previousTime = previous.extractedAt ? Date.parse(previous.extractedAt) : 0;
    if (candidateTime > previousTime) previous.extractedAt = new Date(candidateTime).toISOString();
  });
  const eventDays = [...eventDayMap.values()];

  const journals: CharacterBundleJournal[] = [];
  let journalRevisionsTotal = 0;
  readArray(body.journals, "日记手账", CHARACTER_BUNDLE_LIMITS.journals).forEach((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 天的手账`;
    const dayKey = readDayKey(item.dayKey, `${label}的日期`);
    const statusInput = typeof item.status === "string" ? item.status : "";
    const diaryStateInput = typeof item.diaryState === "string" ? item.diaryState : "";
    const handbookStateInput = typeof item.handbookState === "string" ? item.handbookState : "";
    const skipReason = readText(item.skipReason, `${label}的跳过原因`, CHARACTER_BUNDLE_LIMITS.journalSkipReason);
    const createdAt = readOptionalDate(item.createdAt, `${label}的创建时间`);

    // 同一种文本的 (kind, version) 必须唯一，否则导入会撞 `(journalId, kind, version)`。
    const revisions: CharacterBundleJournalRevision[] = [];
    const seenVersions = new Set<string>();
    const revisionCounts = new Map<BundleJournalTextKind, number>();
    readArray(item.revisions, `${label}的版本`, CHARACTER_BUNDLE_LIMITS.journalRevisions * JOURNAL_TEXT_KINDS.length)
      .forEach((entry, revisionIndex) => {
        const revision = asRecord(entry);
        const revisionLabel = `${label}第 ${revisionIndex + 1} 版`;
        const kindInput = typeof revision.kind === "string" ? revision.kind : "";
        const kind: BundleJournalTextKind = (JOURNAL_TEXT_KINDS as readonly string[]).includes(kindInput)
          ? kindInput as BundleJournalTextKind
          : "DIARY";
        const kindCount = (revisionCounts.get(kind) ?? 0) + 1;
        if (kindCount > CHARACTER_BUNDLE_LIMITS.journalRevisions) {
          bad(`${label}的 ${kind} 版本超过 ${CHARACTER_BUNDLE_LIMITS.journalRevisions} 条。`);
        }
        revisionCounts.set(kind, kindCount);
        const version = Math.round(readNumber(revision.version, `${revisionLabel}的版本号`, 1, 100_000, 0));
        if (!version) bad(`${revisionLabel}缺少版本号。`);
        const versionKey = `${kind}:${version}`;
        if (seenVersions.has(versionKey)) return;
        seenVersions.add(versionKey);
        const revisionTypeInput = typeof revision.revisionType === "string" ? revision.revisionType : "";
        const revisionCreatedAt = readOptionalDate(revision.createdAt, `${revisionLabel}的创建时间`);
        const sourceDiaryVersion = revision.sourceDiaryVersion === null || revision.sourceDiaryVersion === undefined
          ? null
          : Math.round(readNumber(revision.sourceDiaryVersion, `${revisionLabel}引用的日记版本`, 1, 100_000, 0)) || null;
        const promptVersion = readText(revision.promptVersion, `${revisionLabel}的提示词版本`, 80);
        const model = readText(revision.model, `${revisionLabel}的模型`, 120);
        revisions.push({
          kind,
          version,
          title: readText(revision.title, `${revisionLabel}的标题`, CHARACTER_BUNDLE_LIMITS.journalTitle),
          // 有版本却没有正文，等于把这一天清空后还记得「那天写过」——直接拒绝。
          content: readText(revision.content, `${revisionLabel}的正文`, CHARACTER_BUNDLE_LIMITS.journalContent, true),
          thought: readText(revision.thought, `${revisionLabel}的今日想法`, CHARACTER_BUNDLE_LIMITS.journalThought),
          quote: readText(revision.quote, `${revisionLabel}的今日一句`, CHARACTER_BUNDLE_LIMITS.journalQuote),
          tags: readStringList(revision.tags, `${revisionLabel}的标签`),
          revisionType: (JOURNAL_REVISION_TYPES as readonly string[]).includes(revisionTypeInput)
            ? revisionTypeInput as BundleJournalRevisionType
            : "AI_GENERATED",
          promptVersion: promptVersion || null,
          model: model || null,
          sourceDiaryVersion,
          createdAt: revisionCreatedAt ? revisionCreatedAt.toISOString() : null,
        });
      });
    journalRevisionsTotal += revisions.length;
    if (journalRevisionsTotal > CHARACTER_BUNDLE_LIMITS.journalRevisionsTotal) {
      bad(`日记/手账的版本合计超过 ${CHARACTER_BUNDLE_LIMITS.journalRevisionsTotal} 条，请先精简这张卡。`);
    }

    // 有正文就必须是 GENERATED：状态停在 PENDING 会让人以为这天还没写，自动任务也会再写一遍。
    const hasDiary = revisions.some((revision) => revision.kind === "DIARY");
    const hasHandbook = revisions.some((revision) => revision.kind === "HANDBOOK");
    journals.push({
      dayKey,
      status: (JOURNAL_STATUSES as readonly string[]).includes(statusInput)
        ? statusInput as BundleJournalStatus
        : "ACTIVE",
      skipReason: skipReason || null,
      diaryState: hasDiary
        ? "GENERATED"
        : (JOURNAL_TEXT_STATES as readonly string[]).includes(diaryStateInput)
          ? diaryStateInput as BundleJournalTextState
          : "PENDING",
      handbookState: hasHandbook
        ? "GENERATED"
        : (JOURNAL_TEXT_STATES as readonly string[]).includes(handbookStateInput)
          ? handbookStateInput as BundleJournalTextState
          : "PENDING",
      diaryDecidedAt: readOptionalDate(item.diaryDecidedAt, `${label}的日记决策时间`)?.toISOString() ?? null,
      handbookDecidedAt: readOptionalDate(item.handbookDecidedAt, `${label}的手账决策时间`)?.toISOString() ?? null,
      createdAt: createdAt ? createdAt.toISOString() : null,
      revisions,
    });
  });

  // 同一天只能有一条手账主体：重复时后面的丢弃，不让唯一键在事务里炸掉整张卡。
  const seenJournalDays = new Set<string>();
  const uniqueJournals = journals.filter((journal) => {
    if (seenJournalDays.has(journal.dayKey)) return false;
    seenJournalDays.add(journal.dayKey);
    return true;
  });
  journals.length = 0;
  journals.push(...uniqueJournals);

  const catchphrases: CharacterBundleCatchphrase[] = readArray(
    body.catchphrases,
    "梗",
    CHARACTER_BUNDLE_LIMITS.catchphrases,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条梗`;
    return {
      phrase: readText(item.phrase, `${label}的台词`, CHARACTER_BUNDLE_LIMITS.catchphrase, true),
      usage: readText(item.usage, `${label}的用法`, CHARACTER_BUNDLE_LIMITS.catchphraseUsage),
      enabled: item.enabled !== false,
      source: typeof item.source === "string" && item.source.trim() ? item.source.trim().slice(0, 20) : "manual",
    };
  });

  // 朋友是可选段：老角色卡没有这一段，分享型导出也会把它清空，所以缺省就是空数组。
  let friendMemoriesTotal = 0;
  const friends: CharacterBundleFriend[] = readArray(
    body.friends,
    "朋友",
    CHARACTER_BUNDLE_LIMITS.friends,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 位朋友`;
    const platform = readText(item.platform, `${label}的平台`, 50, true);
    const platformUid = readText(item.platformUid, `${label}的平台账号`, 255, true);
    const friendMemories = readArray(
      item.memories,
      `${label}的记忆`,
      CHARACTER_BUNDLE_LIMITS.friendMemories,
    ).map((entry, memoryIndex) => {
      const memory = asRecord(entry);
      const memoryLabel = `${label}的第 ${memoryIndex + 1} 条记忆`;
      const categoryInput = typeof memory.category === "string" ? memory.category : "";
      return {
        originId: normalizeBundleOriginId(memory.originId),
        category: (MEMORY_CATEGORIES as readonly string[]).includes(categoryInput)
          ? categoryInput as BundleMemoryCategory
          : "OTHER",
        content: readText(memory.content, memoryLabel, CHARACTER_BUNDLE_LIMITS.memoryContent, true),
        confidence: readOptionalNumber(memory.confidence, `${memoryLabel}的可信度`, 0, 1),
        importance: readNumber(memory.importance, `${memoryLabel}的重要度`, 0, 1, 0.5),
        validFrom: readOptionalDate(memory.validFrom, `${memoryLabel}的生效时间`)?.toISOString() ?? null,
        validTo: readOptionalDate(memory.validTo, `${memoryLabel}的失效时间`)?.toISOString() ?? null,
        dedupeKey: typeof memory.dedupeKey === "string" && memory.dedupeKey.trim()
          ? memory.dedupeKey.trim().slice(0, 255)
          : null,
      } satisfies CharacterBundleMemoryBody;
    });
    friendMemoriesTotal += friendMemories.length;
    if (friendMemoriesTotal > CHARACTER_BUNDLE_LIMITS.friendMemoriesTotal) {
      bad(`朋友名下的记忆合计超过 ${CHARACTER_BUNDLE_LIMITS.friendMemoriesTotal} 条，请先精简这张卡。`);
    }

    const friendSnapshots = readArray(
      item.snapshots,
      `${label}的阶段总结`,
      CHARACTER_BUNDLE_LIMITS.friendSnapshots,
    ).map((entry, snapshotIndex) => {
      const snapshot = asRecord(entry);
      const snapshotLabel = `${label}的第 ${snapshotIndex + 1} 篇总结`;
      const periodStart = readOptionalDate(snapshot.periodStart, `${snapshotLabel}的周期开始时间`);
      const periodEnd = readOptionalDate(snapshot.periodEnd, `${snapshotLabel}的周期结束时间`);
      if (!periodStart || !periodEnd) bad(`${snapshotLabel}缺少周期时间。`);
      if (periodEnd < periodStart) bad(`${snapshotLabel}的周期结束时间早于开始时间。`);
      const kindInput = typeof snapshot.kind === "string" ? snapshot.kind : "";
      const generatedAt = readOptionalDate(snapshot.generatedAt, `${snapshotLabel}的生成时间`);
      const createdAt = readOptionalDate(snapshot.createdAt, `${snapshotLabel}的创建时间`) ?? periodEnd;
      const structured = snapshot.structuredContent;
      return {
        originId: normalizeBundleOriginId(snapshot.originId),
        kind: (SNAPSHOT_KINDS as readonly string[]).includes(kindInput)
          ? kindInput as BundleSnapshotKind
          : "AUTOMATIC",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        summary: readText(snapshot.summary, `${snapshotLabel}的正文`, CHARACTER_BUNDLE_LIMITS.snapshotSummary, true),
        structuredContent: structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {},
        generatedAt: generatedAt ? generatedAt.toISOString() : null,
        createdAt: createdAt.toISOString(),
      } satisfies CharacterBundleSnapshotBody;
    });

    const firstSource = item.firstSource === "PRIVATE" || item.firstSource === "GROUP" ? item.firstSource : null;
    const displayName = readText(item.displayName, `${label}的昵称`, 255);
    /**
     * 备注走「截断」而不是「拒绝」，和页面保存的既有策略一致：一个 13 字的外号
     * 不该让整张卡导不进来，截成 12 字照样能用。非字符串、空白、与本名相同的都被丢掉。
     * 缺省（v2 老卡）就是空数组 —— 那时包里根本没有备注，不是「她没给这个人起过名」。
     */
    const aliases = dropAliasesMatchingName(normalizeFriendAliases(item.aliases).aliases, displayName);
    return {
      platform,
      platformUid,
      displayName,
      aliases,
      firstSource,
      interactionCount: Math.round(readNumber(item.interactionCount, `${label}的互动次数`, 0, 1_000_000, 0)),
      lastInteractedAt: readOptionalDate(item.lastInteractedAt, `${label}的最后互动时间`)?.toISOString() ?? null,
      knownSince: readOptionalDate(item.knownSince, `${label}的认识时间`)?.toISOString() ?? null,
      memories: friendMemories,
      snapshots: friendSnapshots,
    };
  });

  // 同一个 (platform, platformUid) 只能有一位：scopeKey 是确定性的，重复会直接撞唯一键。
  const seenFriendKeys = new Set<string>();
  for (const friend of friends) {
    const key = `${friend.platform}:${friend.platformUid}`;
    if (seenFriendKeys.has(key)) {
      bad(`朋友列表里有重复的 ${friend.platform} 账号 ${friend.platformUid}，请检查这份角色卡。`);
    }
    seenFriendKeys.add(key);
  }

  const payload: Omit<CharacterBundle, "counts"> = {
    format: CHARACTER_BUNDLE_FORMAT,
    formatVersion: version,
    exportedAt: typeof body.exportedAt === "string" ? body.exportedAt : "",
    exportedBy: "yiling-space",
    origin: { characterId: originId ?? "" },
    character: { name, alias, description, avatarTone, basePrompt, styleExamples, userAddress },
    modelConfig,
    memorySetting,
    memories,
    events,
    eventDays,
    snapshots,
    journals,
    catchphrases,
    friends,
  };

  return {
    formatVersion: version,
    originId,
    character: payload.character,
    modelConfig,
    memorySetting,
    memories,
    events,
    eventDays,
    snapshots,
    journals,
    catchphrases,
    friends,
    counts: buildCounts(payload),
    exportedAt: payload.exportedAt || null,
  };
}

/** 导出文件名：保留中文，过滤掉路径分隔符与控制字符。 */
export function characterBundleFileName(name: string, at: Date): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 60) || "character";
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "").slice(0, 12);
  return `yiling-character-${safe}-${stamp}.json`;
}
