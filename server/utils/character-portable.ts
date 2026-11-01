/**
 * 角色导出包（「角色卡」）的格式定义、构建与校验。
 *
 * 为什么不是整库 dump：换电脑时真正想带走的是「她是谁 + 她记得什么」，不是账号、
 * 渠道 Token、任务队列和工作日志。整库 dump 里那些东西既带不走（换台机器连不上原来的
 * QQ 网关），也不该带到别人电脑上（别人的私聊和凭据）。
 *
 * 因此包里只有五类内容，且每类都做过取舍：
 *   - 人设：name / basePrompt / styleExamples / userAddress + 少量模型参数
 *   - 记忆：CHARACTER_GLOBAL 与**导出者自己的** USER_PRIVATE 长期记忆
 *   - 忆泡：发生过什么（事实层）
 *   - 阶段总结：只带 CURRENT 版本，来源消息不随包走
 *   - 她的朋友（可选）：认识谁、聊过几次、分别记得他什么
 *
 * 朋友这一段的取舍最需要说清楚：**导出者可以关掉它**。换台电脑继续养需要它（否则她
 * 一夜之间忘了整个群），但把卡发给别人时，它同时交出去的是别人的 QQ 号和「她怎么看他们」。
 * 所以这是唯一一个由导出者当场决定的内容段，默认带走、但不静默带走。
 * 只带走关系的元信息与记忆，**不带**账号绑定（`status` / `linkedUserId`）——
 * 那是站内用户与外部身份的验证结果，换人导入不该跟过去。
 *
 * 明确不带：
 *   - API Key（`chatApiKeyEncrypted` / `voiceApiKeyEncrypted`）—— 换机器本来就得重填，
 *     而且带出去等于把凭据交给任何拿到这个 json 的人
 *   - 表情包图片：图在 `.data/stickers/<id>/`，换机器后从 QQ 收藏夹重新同步即可
 *   - 会话原文、渠道绑定、任务队列、用量与审计：与具体机器/账号绑定
 *
 * 导入端把包当成**不可信输入**：字段逐个校验、超限直接拒绝，模型参数走白名单，
 * 任何密钥字段都不读。导入永远新建角色与新记忆范围，不会往已有角色里塞东西。
 */

import { createError } from "h3";

export const CHARACTER_BUNDLE_FORMAT = "yiling-hub.character";
export const CHARACTER_BUNDLE_VERSION = 1;
/** 导入包最大字节数：够 4000 条记忆 + 600 篇总结，再大基本是塞了别的东西。 */
export const CHARACTER_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;

export const CHARACTER_BUNDLE_LIMITS = {
  memories: 4000,
  events: 4000,
  snapshots: 600,
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

export type CharacterBundleCharacter = {
  name: string;
  alias: string;
  description: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  basePrompt: string;
  styleExamples: string;
  userAddress: string;
};

export type CharacterBundleModelConfig = {
  chatModel?: string;
  chatTemperature?: number;
  chatMaxTokens?: number;
  chatApiBaseUrl?: string;
  memoryTokenBudget?: number;
  snapshotTokenBudget?: number;
  recentMessageLimit?: number;
};

export type CharacterBundleMemory = {
  scope: BundleScopeKind;
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
  snapshots: number;
  catchphrases: number;
  /** 带走了几位朋友。为 0 时包里没有朋友数据（分享给别人时通常会关掉）。 */
  friends: number;
  /** 朋友名下的记忆条数（已计入 memories 之外的单独统计，避免和角色记忆混着数）。 */
  friendMemories: number;
};

export type CharacterBundle = {
  format: typeof CHARACTER_BUNDLE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  exportedBy: "yiling-hub";
  character: CharacterBundleCharacter;
  modelConfig: CharacterBundleModelConfig;
  memorySetting: {
    snapshotIntervalDays: number;
    timezone: string;
    autoSnapshotEnabled: boolean;
  };
  memories: CharacterBundleMemory[];
  events: CharacterBundleEvent[];
  snapshots: CharacterBundleSnapshot[];
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
  "chatApiBaseUrl",
  "memoryTokenBudget",
  "snapshotTokenBudget",
  "recentMessageLimit",
] as const;

/** 任何以 `v1.` 开头的密文字段都不许进包；这里再按名字兜一层。 */
const SECRET_NAME_PATTERN = /(apikey|api_key|token|secret|password|credential)/i;
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
    snapshots: bundle.snapshots.length,
    catchphrases: bundle.catchphrases.length,
    friends: bundle.friends.length,
    friendMemories: bundle.friends.reduce((total, friend) => total + friend.memories.length, 0),
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
  category: string;
  content: string;
  confidence: number | null;
  importance: number;
  validFrom: Date | null;
  validTo: Date | null;
  dedupeKey: string | null;
};

type SnapshotSource = {
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

export type BundleBuildInput = {
  character: {
    name: string;
    basePrompt: string;
    styleExamples?: string | null;
    userAddress?: string | null;
    modelConfig?: unknown;
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
  }>;
  /**
   * 「她的朋友」。只在导出者明确要带走时才传（分享型导出传空数组），
   * 传入的一定是 `interactionCount > 0` 的关系 —— 0 次的是群里没搭理的残留。
   */
  friends?: Array<{
    platform: string;
    platformUid: string;
    displayName: string | null;
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
  const snapshots: CharacterBundleSnapshot[] = [];

  for (const scope of input.scopes) {
    const kind: BundleScopeKind = scope.scopeType === "CHARACTER_GLOBAL" ? "character" : "private";
    for (const item of scope.memoryItems ?? []) {
      memories.push({ scope: kind, ...toBundleMemory(item) });
    }
    for (const event of scope.events ?? []) {
      events.push({
        scope: kind,
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
    for (const snapshot of scope.snapshots ?? []) {
      snapshots.push({ scope: kind, ...toBundleSnapshot(snapshot) });
    }
  }

  const friends: CharacterBundleFriend[] = (input.friends ?? []).map((friend) => ({
    platform: friend.platform.slice(0, 50),
    platformUid: friend.platformUid.slice(0, 255),
    displayName: (friend.displayName ?? "").slice(0, 255),
    firstSource: friend.firstSource === "PRIVATE" || friend.firstSource === "GROUP" ? friend.firstSource : null,
    interactionCount: Math.max(0, Math.trunc(friend.interactionCount)),
    lastInteractedAt: friend.lastInteractedAt ? friend.lastInteractedAt.toISOString() : null,
    knownSince: friend.knownSince ? friend.knownSince.toISOString() : null,
    memories: (friend.memoryItems ?? []).map(toBundleMemory),
    snapshots: (friend.snapshots ?? []).map(toBundleSnapshot),
  }));

  const payload: Omit<CharacterBundle, "counts"> = {
    format: CHARACTER_BUNDLE_FORMAT,
    formatVersion: CHARACTER_BUNDLE_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    exportedBy: "yiling-hub",
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
      snapshotIntervalDays: input.memorySetting?.snapshotIntervalDays ?? 8,
      timezone: input.memorySetting?.timezone ?? "Asia/Shanghai",
      autoSnapshotEnabled: input.memorySetting?.autoSnapshotEnabled ?? false,
    },
    memories,
    events,
    snapshots,
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
  character: CharacterBundleCharacter;
  modelConfig: CharacterBundleModelConfig;
  memorySetting: CharacterBundle["memorySetting"];
  memories: CharacterBundleMemory[];
  events: CharacterBundleEvent[];
  snapshots: CharacterBundleSnapshot[];
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
  const memorySetting = {
    snapshotIntervalDays: Math.round(
      readNumber(setting.snapshotIntervalDays, "归档周期", 1, 365, 8),
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
    return {
      platform,
      platformUid,
      displayName: readText(item.displayName, `${label}的昵称`, 255),
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
    exportedBy: "yiling-hub",
    character: { name, alias, description, avatarTone, basePrompt, styleExamples, userAddress },
    modelConfig,
    memorySetting,
    memories,
    events,
    snapshots,
    catchphrases,
    friends,
  };

  return {
    formatVersion: version,
    character: payload.character,
    modelConfig,
    memorySetting,
    memories,
    events,
    snapshots,
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
