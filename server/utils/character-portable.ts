/**
 * 角色导出包（「角色卡」）的格式定义、构建与校验。
 *
 * 为什么不是整库 dump：换电脑时真正想带走的是「她是谁 + 她记得什么」，不是账号、
 * 渠道 Token、任务队列和工作日志。整库 dump 里那些东西既带不走（换台机器连不上原来的
 * QQ 网关），也不该带到别人电脑上（别人的私聊和凭据）。
 *
 * 内容按领域做取舍：
 *   - v5 成长：知识、社交评估与证据、反思结论、成长事件与投递历史（执行状态归档）
 *   - v7 表达习惯 / 目标 / 偏好：她说话的方式、在追的事、口味
 *   - 人设：name / basePrompt / styleExamples / userAddress + 全部非密钥设置（v7 起）
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
 *   - API Key（`chatApiKey` / `voiceApiKey` / `memoryAssistantApiKey` …）—— 2026-11-12 起
 *     modelConfig 里存的是明文，但导出仍然全部剥离：换机器本来就得重填，
 *     而且带出去等于把凭据交给任何拿到这个 json 的人
 *   - 表情包图片：图在 `.data/stickers/<id>/`，换机器后从 QQ 收藏夹重新同步即可
 *   - 会话原文、渠道绑定、任务队列、用量与审计：与具体机器/账号绑定
 *
 * 导入端把包当成**不可信输入**：字段逐个校验、超限直接拒绝，模型参数走白名单，
 * 任何密钥字段都不读。导入默认新建本地角色与新记忆范围；若用户明确指定同一同步根下的目标角色，
 * 则按合并规则补充内容，不覆盖目标角色的人设与设置。
 */

import { createError } from "h3";
import { emptyCharacterGrowthBundle, parseCharacterGrowthBundle, growthCounts, type CharacterGrowthBundle } from "./character-growth-portable";
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
 * v5 增加成长领域及稳定迁移身份，旧卡按空成长内容读取；新卡必须声明成长段。
 * v6 增加互动经验与渠道行为策略（2026-11-16）。这两段是「她怎么跟人打交道」的一部分，
 * 之前漏在包外，换台机器养等于一夜之间忘掉所有被教过的东西。v6 起必须声明这两段，
 * 老卡按空内容读取 —— 让老程序读 v6 卡会被上面那条版本检查拦下，好过它静默丢掉这些准则。
 * v7（2026-11-17）补三处「换机器就换个人」的缺口：
 *   - `modelConfig` 白名单从 9 个键扩到全部非密钥设置：语音（开关/概率/冷却/TTS 音色与语气）、
 *     表情额度、看图、自动收表情、自动捡梗、私聊主动、群内冷场主动、四个助手模型、日额度
 *   - 新增表达习惯 / 目标 / 偏好三段（她学到的说话方式、在追的事、口味）
 *   - `memorySetting` 带上原文保留天数与自动清理开关
 * 音色、语气指令这类东西属于「她是谁」，不再是可选的展示字段；凭据（`*ApiKey`）仍然一律不带，
 * 新机器上缺 Key 时的表现和别的模型一样是「未配置」。
 * v8（2026-11-24）补两处：
 *   - 形象档案（`visualProfile`）：形象描述、负面提示、装扮、发布版本快照、参考图清单。
 *     之前整张 `character_visual_profiles` 都漏在包外，换台机器她的长相设定全归零。
 *     **参考图文件本身不随包走**：那是磁盘上的图，包是纯 JSON；只带「有几张、叫什么、哪一类」，
 *     导入后照着清单重新上传即可。
 *   - 表情包清单（`stickers`）：名字、什么时候用、开关、来源。图片同样不随包走，
 *     导入端会先把它们建成「缺图」条目并停用 —— 缺图的条目让她发出去只会是发送失败。
 * 知识主题（自动整理出的主题、成员、修订）走成长包，见 `character-growth-portable.ts` 的 v2。
 */
export const CHARACTER_BUNDLE_VERSION = 8;
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
  /**
   * 互动经验条数上限。它是人一条条教出来的，不是生成的：
   * 每一条都对应一句主人亲自说过的话，200 条已经远超正常使用量。
   */
  interactionGuidance: 200,
  /** 渠道行为策略：每种渠道最多一条，留 20 个位置足够覆盖所有渠道。 */
  channelPolicies: 20,
  /**
   * 表达习惯 / 目标 / 偏好（v7）。
   *
   * 三个上限都比「正常使用量」放宽一档：这些是人一条条教出来的，条数天然有限，
   * 撞上限多半意味着包被别的东西污染了（或者她把三年前的目标都留着）。超了就拒绝，
   * 不静默截断 —— 悄悄少带走一半目标，比导不进来更难发现。
   */
  expressionHabits: 300,
  goals: 120,
  preferences: 300,
  /** 单个目标/偏好/习惯的正文、场景、原因长度，对齐数据库列。 */
  habitContent: 300,
  habitContext: 200,
  goalTitle: 100,
  goalDescription: 1000,
  preferenceTopic: 100,
  /**
   * 形象档案（v8）。
   *
   * 装扮按角色算，正常只有几套；版本是「发布过一次一条」，两百条已经远超正常使用量。
   * 参考图清单同理：它的用途是告诉新机器「你得补几张图」，不是备份图库。
   */
  visualOutfits: 60,
  visualVersions: 200,
  visualAssets: 60,
  /** 表情包清单：库里有 200 多张不稀奇，这里留到 800。 */
  stickers: 800,
  visualAppearance: 8000,
  visualPrompt: 8000,
  negativePrompt: 8000,
  /** LoRA 文件名与触发词，对齐数据库列宽。 */
  loraName: 200,
  loraTrigger: 200,
  outfitName: 100,
  outfitPrompt: 2000,
  versionNote: 300,
  assetLabel: 120,
  stickerName: 60,
  stickerUsage: 2000,
  /** 版本快照是模型/页面产出的 JSON，只当历史文本带走，不触发任何行为。 */
  visualSnapshotBytes: 16384,
  reason: 1000,
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
 * 稳定同步根：同一角色在不同设备上的本地实例通过它识别并合并。
 *
 * 它不是本机数据库主键：每台设备导入时都会生成自己的 `Character.id`，
 * 但带 origin 的卡会继承同一个同步根，因而 A → B → A 可以继续合并。
 * 本机新建角色以自己的实例 id 作为同步根；无 origin 的老卡导入时也以新实例 id 建根。
 *
 * 空字符串仅用于兼容历史卡片；新版本正常导出应始终携带有效 UUID。
 */
export type CharacterBundleOrigin = {
  characterId: string;
};

/**
 * 模型参数与行为开关。
 *
 * v7 之前只带 9 个「不会让角色做出意外动作」的键，理由是行为开关依赖新机器上的服务商与网关。
 * 代价太大：换台机器之后她不再发表情、不再主动找话，声音也从「软软的带点气声」变成默认音色 ——
 * 那已经不是一个参数，是换了一个人。所以 v7 起凡是**非密钥**的设置都带走，
 * 密钥继续靠 `SECRET_NAME_PATTERN` 与值形态（`v1.` 密文）剥掉。
 *
 * 新机器上缺 Key / 缺服务商时，表现和别的模型一样：设置页显示未配置，聊天时那条链路降级，
 * 而不是静默地按默认值乱说话。
 */
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
  /** 表情额度：多少分钟内最多贴几张（贴图与内置表情共用）。 */
  emojiEnabled?: boolean;
  emojiWindowMinutes?: number;
  emojiPerWindow?: number;
  /** 语音：要不要发语音、要不要转写别人的语音，以及节奏。 */
  voiceEnabled?: boolean;
  voiceTranscribe?: boolean;
  voiceChance?: number;
  voiceCooldownMinutes?: number;
  voiceApiBaseUrl?: string;
  /** 她的声音。这几项丢了，换机器后声音就不是她了。 */
  ttsProvider?: string;
  ttsVoice?: string;
  ttsModel?: string;
  ttsSpeed?: number;
  ttsGroupId?: string;
  ttsInstructions?: string;
  asrProvider?: string;
  asrModel?: string;
  asrApiBaseUrl?: string;
  /** 看图。 */
  imageUnderstanding?: boolean;
  visionModel?: string;
  visionApiBaseUrl?: string;
  /** 画图（文生图）：开关、额度、模型与地址；Key 不随包走。 */
  imageEnabled?: boolean;
  imageChance?: number;
  imageCooldownMinutes?: number;
  imageDailyLimit?: number;
  imageModel?: string;
  imageApiBaseUrl?: string;
  imageProvider?: string;
  imageSize?: string;
  /** 像素预算（百万像素）：本地按它算宽高，9:16 + 2 MP = 1088 × 1920。 */
  imageMegapixels?: number;
  imageQuality?: string;
  /** 收集类开关：表情、梗。 */
  stickerAutoCollect?: boolean;
  catchphraseAutoMine?: boolean;
  knowledgeCollectScope?: string;
  /** 记忆与额度。 */
  eventRecentDays?: number;
  dailyTokenLimit?: number;
  /** 四个后台助手的模型选择（enabled 开关不随包走，见 `PORTABLE_MODEL_CONFIG_KEYS` 上方）。 */
  contextAssistantModel?: string;
  contextAssistantTemperature?: number;
  contextAssistantApiBaseUrl?: string;
  contextAssistantMaxInputTokens?: number;
  contextAssistantMaxOutputTokens?: number;
  memoryAssistantModel?: string;
  memoryAssistantTemperature?: number;
  memoryAssistantApiBaseUrl?: string;
  memoryAssistantMaxInputTokens?: number;
  memoryAssistantMaxOutputTokens?: number;
  knowledgeAssistantModel?: string;
  knowledgeAssistantTemperature?: number;
  knowledgeAssistantApiBaseUrl?: string;
  knowledgeAssistantMaxInputTokens?: number;
  knowledgeAssistantMaxOutputTokens?: number;
  socialRelationshipAssessmentAssistantModel?: string;
  socialRelationshipAssessmentAssistantTemperature?: number;
  socialRelationshipAssessmentAssistantApiBaseUrl?: string;
  socialRelationshipAssessmentAssistantMaxInputTokens?: number;
  socialRelationshipAssessmentAssistantMaxOutputTokens?: number;
  /** 私聊主动找话 / 群里冷场接话：整块是对象，字段在下面各自白名单。 */
  proactive?: CharacterBundleProactiveSettings;
  groupInitiative?: CharacterBundleGroupInitiativeSettings;
};

/** 私聊主动：字段与 `resolveProactiveSettings` 同口径。 */
export type CharacterBundleProactiveSettings = {
  enabled: boolean;
  dailyMax: number;
  minGapMinutes: number;
  quietStart: string;
  quietEnd: string;
  userActiveMinutes: number;
  minConfidence: number;
};

/** 群内冷场主动：字段与 `resolveGroupInitiativeSettings` 同口径。 */
export type CharacterBundleGroupInitiativeSettings = {
  enabled: boolean;
  idleMinutes: number;
  dailyMax: number;
  minGapMinutes: number;
  quietStart: string;
  quietEnd: string;
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
  /** QQ 号。群里认人靠它，所以必须带；这也是分享时最该慎重的字段。 */
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
  /** 带走了几条已采纳的互动经验。 */
  interactionGuidance: number;
  /** 带走了几条已采纳的渠道行为策略。 */
  channelPolicies: number;
  /** 表达习惯（语义上同「语言系统」）。 */
  expressionHabits: number;
  /** 目标与愿望（含已完成/已放弃的）。 */
  goals: number;
  /** 口味偏好。 */
  preferences: number;
  /** 形象档案：带了装扮几套 / 版本几版 / 参考图清单几张。全为 0 也可能是带了文字，见 `hasVisualProfile`。 */
  visualOutfits: number;
  visualVersions: number;
  visualAssets: number;
  /** 包里是否带了一段形象档案（文字也算）。false 时预览不该说「带着她的长相设定」。 */
  hasVisualProfile: boolean;
  /** 表情包清单条数（都是缺图条目，图片不随包走）。 */
  stickers: number;
  growth?: ReturnType<typeof growthCounts>;
};

/**
 * 互动经验：她学到的「怎么跟人打交道」。
 *
 * 只带 ACTIVE 的条目 —— PENDING 是等主人确认的候选、REJECTED 是已经否决过的，
 * 这两个状态属于本机的决策现场，搬到新机器上只会变成一堆要重新处理的待办。
 * 也不带 sourceRefs：它指向本机的教育证据（哪句话、哪个群、谁授权的），
 * 换台机器那些 id 全是悬空的。导入端会给它们重新盖一个「来自角色卡」的来源。
 */
export type CharacterBundleInteractionGuidance = {
  kind: GuidanceKindName;
  content: string;
  context: string;
  chatScope: "ALL" | "GROUP" | "PRIVATE";
};

/** 渠道行为策略：同样是「她怎么跟人打交道」，只是作用在渠道层而不是对话内容上。 */
export type CharacterBundleChannelPolicy = {
  kind: "GROUP_AT_DISABLED";
  content: string;
  chatScope: "GROUP";
};

/**
 * 表达习惯：她说话的调子、用词、长短。
 *
 * 只带 ACTIVE 与 DISABLED：前者是她现在的说法，后者是她被明确关掉过的说法 ——
 * 关掉本身也是选择，带过去不该又变回开着。PENDING / REJECTED 是本机的决策现场，不跟卡走。
 */
export type CharacterBundleExpressionHabit = {
  kind: "TONE" | "WORDING" | "LENGTH";
  content: string;
  context: string;
  chatScope: "ALL" | "GROUP" | "PRIVATE";
  status: "ACTIVE" | "DISABLED";
  /** 形成原因：她自己为什么这么说话，属于内容而不是设置。 */
  reason: string;
};

/**
 * 目标与愿望：她在追什么、追完过什么。
 *
 * PENDING（等人确认）与 REJECTED（否决过）不带；PAUSED / COMPLETED / ABANDONED 要带 ——
 * 「她放弃过一个目标」和「她实现过一个目标」都是她经历过的事，不是待办。
 * 进展（progress）不带：那是本地一天天记下来的事实，换台机器后从零开始才诚实。
 */
export type CharacterBundleGoal = {
  kind: "GOAL" | "WISH";
  title: string;
  description: string;
  reason: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
};

/** 口味：喜欢 / 不喜欢 / 感兴趣。口径同表达习惯。 */
export type CharacterBundlePreference = {
  kind: "LIKE" | "DISLIKE" | "INTEREST";
  topic: string;
  reason: string;
  status: "ACTIVE" | "DISABLED";
};

export const VISUAL_ASSET_KINDS = [
  "STANDARD",
  "FRONT_VIEW",
  "SIDE_VIEW",
  "BACK_VIEW",
  "EXPRESSION",
  "OUTFIT",
  "ACCESSORY",
  "SUPPLEMENT",
] as const;
export type BundleVisualAssetKind = typeof VISUAL_ASSET_KINDS[number];

export const VISUAL_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type BundleVisualVersionStatus = typeof VISUAL_VERSION_STATUSES[number];

/**
 * 参考图清单（v8）：只有「有哪几张」，没有图片本体。
 *
 * 不带 `relativePath` / `id`：前者是旧机器磁盘上的路径，后者是本机主键，
 * 搬过去都是死指针；带上只会让新机器以为「图在」，实际打不开。
 * 导入端因此**不写素材行**，而是提示导出者照这张清单重新上传 ——
 * 一张标着「正面图」却读不出来的行，比一行提示更糟。
 */
export type CharacterBundleVisualAsset = {
  kind: BundleVisualAssetKind;
  label: string;
  /** 原图尺寸，只用于清单展示（新机器补图时知道要找多大的图）。 */
  width: number | null;
  height: number | null;
  sortOrder: number;
};

/** 装扮：默认那套会进提示词，其余的等她挑。 */
export type CharacterBundleVisualOutfit = {
  name: string;
  prompt: string;
  isDefault: boolean;
  sortOrder: number;
};

/**
 * 已发布/草稿的一版形象。
 *
 * `snapshot` 是发布那一刻的形象快照（含当时的装扮与素材引用），**导出前逐层剥掉
 * 素材 id 与磁盘路径**，只留 kind / label / sortOrder —— 同理，旧机器的 id 搬过来无意义。
 */
export type CharacterBundleVisualVersion = {
  revision: number;
  status: BundleVisualVersionStatus;
  note: string;
  snapshot: Record<string, unknown>;
  createdAt: string | null;
  publishedAt: string | null;
};

/**
 * 形象档案（v8）：她长什么样。
 *
 * 这是「她是谁」里最容易被忽略的一块 —— 人设文字带走了，形象设定没带走，
 * 换台机器她就画不出自己。所以 v8 起整段随卡走，只有图片本体留在原地。
 */
export type CharacterBundleVisualProfile = {
  coreAppearance: string;
  corePrompt: string;
  negativePrompt: string;
  /**
   * 本机引擎的角色 LoRA（可选段）。
   *
   * 跟着形象档案走是必须的：她长相的一半在这个 LoRA 里，只带文字的话新机器画出来是另一个人。
   * 但**文件本身不随包走** —— `.safetensors` 动辄几十兆，包是纯 JSON。
   * 缺这个文件时表现成「装了但引擎里没有」：导入端保留配置并提示，出图会明确报错，不会静默换人。
   */
  loraName?: string;
  loraStrength?: number;
  loraTrigger?: string;
  /** 当前正式版本号；0 = 还没发布过任何一版。 */
  currentPublishedRevision: number;
  outfits: CharacterBundleVisualOutfit[];
  versions: CharacterBundleVisualVersion[];
  assets: CharacterBundleVisualAsset[];
};

/**
 * 表情包清单（v8）：名字与用途，不带图片。
 *
 * 为什么不带图：一台机器上两百多张、三十多兆，塞进纯 JSON 的包里要 base64 膨胀三分之一，
 * 直接把 32MB 上限撑爆，而且换来的只是「导进来就能发」这一件事。
 * 名字和场景才是人重新补图时需要的东西，所以只带这两样。
 */
export type CharacterBundleSticker = {
  name: string;
  usage: string;
  /** 导出时是开着还是关着。导入端会先按「缺图」停用，补图后再自己打开。 */
  enabled: boolean;
  /** manual / collected / qq。 */
  source: string;
};

export type GuidanceKindName = "UNDERSTANDING" | "REFERENCE" | "SITUATION" | "STRATEGY";
const GUIDANCE_KIND_NAMES: readonly GuidanceKindName[] = ["UNDERSTANDING", "REFERENCE", "SITUATION", "STRATEGY"];
const GUIDANCE_CHAT_SCOPES = ["ALL", "GROUP", "PRIVATE"] as const;

const HABIT_KINDS = ["TONE", "WORDING", "LENGTH"] as const;
const HABIT_STATUSES = ["ACTIVE", "DISABLED"] as const;
const GOAL_KINDS = ["GOAL", "WISH"] as const;
const GOAL_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"] as const;
const PREFERENCE_KINDS = ["LIKE", "DISLIKE", "INTEREST"] as const;
const PREFERENCE_STATUSES = ["ACTIVE", "DISABLED"] as const;

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
    /** 原文保留天数：null = 不自动清理。v7 之前不带，导入端按默认值兜。 */
    rawMessageRetentionDays?: number | null;
    rawMessageCleanupEnabled?: boolean;
  };
  memories: CharacterBundleMemory[];
  events: CharacterBundleEvent[];
  eventDays: CharacterBundleEventDay[];
  snapshots: CharacterBundleSnapshot[];
  journals: CharacterBundleJournal[];
  catchphrases: CharacterBundleCatchphrase[];
  friends: CharacterBundleFriend[];
  /** 互动经验：只含 ACTIVE。旧卡没有这一段，读成空数组。 */
  interactionGuidance: CharacterBundleInteractionGuidance[];
  /** 渠道行为策略：只含 ACTIVE。 */
  channelPolicies: CharacterBundleChannelPolicy[];
  /** 表达习惯：ACTIVE + DISABLED（v7）。 */
  expressionHabits: CharacterBundleExpressionHabit[];
  /** 目标与愿望：ACTIVE / PAUSED / COMPLETED / ABANDONED（v7）。 */
  goals: CharacterBundleGoal[];
  /** 口味偏好：ACTIVE + DISABLED（v7）。 */
  preferences: CharacterBundlePreference[];
  /**
   * 形象档案（v8）：null = 这个角色没建过形象档案（不是「建了但是空的」）。
   * 两种情况导入后端表现一样（不建行），但包里区分开，预览才能说清「她把长相设定留在了原地」。
   */
  visualProfile: CharacterBundleVisualProfile | null;
  /** 表情包清单（v8）：只有名字与用途，图片不随包走。 */
  stickers: CharacterBundleSticker[];
  growth: CharacterGrowthBundle;
  counts: CharacterBundleCounts;
};

/**
 * 模型参数与行为开关白名单：导出只带这些键，导入也只认这些键。
 *
 * v7 之前这里只有 9 个「模型参数」，注释写着「行为开关不随包走，它们依赖新机器上的服务商和网关」。
 * 那句话对**凭据**成立，对**设置**不成立：带着卡换台机器，她不该一夜之间不发表情、不主动开口、
 * 声音从定制的音色退回默认音色。所以 v7 起所有非密钥设置都进白名单；
 * 密钥照样靠 `SECRET_NAME_PATTERN` 和 `v1.` 密文形态剥掉（`*ApiKey` 一个都不进）。
 *
 * `proactive` / `groupInitiative` 是对象，走 `PORTABLE_MODEL_CONFIG_OBJECT_KEYS` 单独收口。
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
  // 表情额度
  "emojiEnabled",
  "emojiWindowMinutes",
  "emojiPerWindow",
  // 语音 / 转写
  "voiceEnabled",
  "voiceTranscribe",
  "voiceChance",
  "voiceCooldownMinutes",
  "voiceApiBaseUrl",
  // 她的声音
  "ttsProvider",
  "ttsVoice",
  "ttsModel",
  "ttsSpeed",
  "ttsGroupId",
  "ttsInstructions",
  "asrProvider",
  "asrModel",
  "asrApiBaseUrl",
  // 看图
  "imageUnderstanding",
  "visionModel",
  "visionApiBaseUrl",
  // 画图（文生图）：设置随包走，Key 不随包走
  "imageEnabled",
  "imageChance",
  "imageCooldownMinutes",
  "imageDailyLimit",
  "imageModel",
  "imageApiBaseUrl",
  "imageProvider",
  "imageSize",
  "imageMegapixels",
  "imageQuality",
  "imagePreset",
  // imageProfiles deliberately excluded: nested connection credentials are not portable.
  // 收集类开关：收表情、捡梗（都要人看得见的结果，不额外花钱）
  "stickerAutoCollect",
  "catchphraseAutoMine",
  "knowledgeCollectScope",
  // 记忆与额度
  "eventRecentDays",
  "dailyTokenLimit",
  // 四个后台助手：**只带模型选择，不带 enabled 开关**
  "contextAssistantModel",
  "contextAssistantTemperature",
  "contextAssistantApiBaseUrl",
  "contextAssistantMaxInputTokens",
  "contextAssistantMaxOutputTokens",
  "memoryAssistantModel",
  "memoryAssistantTemperature",
  "memoryAssistantApiBaseUrl",
  "memoryAssistantMaxInputTokens",
  "memoryAssistantMaxOutputTokens",
  "knowledgeAssistantModel",
  "knowledgeAssistantTemperature",
  "knowledgeAssistantApiBaseUrl",
  "knowledgeAssistantMaxInputTokens",
  "knowledgeAssistantMaxOutputTokens",
  "socialRelationshipAssessmentAssistantModel",
  "socialRelationshipAssessmentAssistantTemperature",
  "socialRelationshipAssessmentAssistantApiBaseUrl",
  "socialRelationshipAssessmentAssistantMaxInputTokens",
  "socialRelationshipAssessmentAssistantMaxOutputTokens",
] as const;

/**
 * 故意**不随包走**的开关：四个后台助手的 `*Enabled`、`knowledgeAutoCollectEnabled`、
 * `interactionExperienceAutoEnabled`。
 *
 * 它们不改变「她是谁」，只决定新机器上要不要**自己开始花钱**（后台定时调模型整理记忆/知识/
 * 社交评估）。这和「模型输出只能驱动白名单动作、副作用要有人点头」是同一条原则：
 * 一张别人发来的卡不该让我的机器悄悄跑起四条流水线。模型选择照带，人在设置页打开开关就能用。
 *
 * 下面是对象型设置的白名单，与上面这份扁平清单互不重叠。
 */
export const PORTABLE_MODEL_CONFIG_OBJECT_KEYS = ["proactive", "groupInitiative"] as const;

/** 单个字符串设置的上限：够放一段语气描述，又不会让一个键把包撑大。 */
const PORTABLE_CONFIG_STRING_MAX = 1000;
const PORTABLE_CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 读对象型设置。
 *
 * 与「内容段」不同，这里对坏字段是**收口**而不是整卡拒绝：一条脏的 `proactive.minGapMinutes`
 * 不该让整张卡导不进来（和归档周期的 clamp 同一个道理）。但字段级白名单是硬的 ——
 * 认不出来的键不会带进来，避免把未来的字段名带进一个不懂它的旧程序。
 *
 * 取值范围与 `proactive-settings.ts` / `group-initiative-settings.ts` 的 clamp 保持一致，
 * 故意不 import 那两个模块：它们牵扯用量与数据库，portable 这个模块要保持纯函数。
 */
function readPortableObjectSettings(key: string, value: unknown): Record<string, unknown> | null {
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return null;
  const bool = (field: string) => (typeof raw[field] === "boolean" ? { [field]: raw[field] } : {});
  const int = (field: string, min: number, max: number) => (
    typeof raw[field] === "number" && Number.isFinite(raw[field])
      ? { [field]: Math.max(min, Math.min(max, Math.round(raw[field] as number))) }
      : {}
  );
  const clock = (field: string): string | undefined => (
    typeof raw[field] === "string" && PORTABLE_CLOCK_PATTERN.test(raw[field].trim())
      ? raw[field].trim()
      : undefined
  );
  // 起止一样等于「没有安静时段」，和运行时一样当没配：两个都不带，别留下半条矛盾设置。
  const quietOf = () => {
    const start = clock("quietStart");
    const end = clock("quietEnd");
    return start && end && start !== end ? { quietStart: start, quietEnd: end } : {};
  };

  const merged: Record<string, unknown> = key === "proactive"
    ? {
        ...bool("enabled"),
        ...int("dailyMax", 0, 24),
        ...int("minGapMinutes", 15, 1440),
        ...quietOf(),
        ...int("userActiveMinutes", 0, 720),
        ...(typeof raw.minConfidence === "number" && Number.isFinite(raw.minConfidence)
          ? { minConfidence: Math.round(Math.max(0, Math.min(1, raw.minConfidence)) * 100) / 100 }
          : {}),
      }
    : {
        ...bool("enabled"),
        ...int("idleMinutes", 15, 1440),
        ...int("dailyMax", 0, 24),
        ...int("minGapMinutes", 30, 1440),
        ...quietOf(),
      };
  return Object.keys(merged).length ? merged : null;
}

/** 任何以 `v1.` 开头的密文字段、以及任何名字像密钥的字段都不许进包；这里再按名字兜一层。 */
const SECRET_NAME_PATTERN = /(apikey|api_key|token|secret|password|credential)/i;
const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 同步根 ID 只认 UUID，不像 id 的一律当「没有」。
 *
 * 和别处「不认识就拒绝」不同：它只是跨设备合并时的身份线索，不是内容。手改坏一个字符
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
      // 空字符串没有信息量；超长的「设置」基本是塞了别的东西（一段人设、一坨 base64）
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > PORTABLE_CONFIG_STRING_MAX) continue;
      result[key] = trimmed;
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
  for (const key of PORTABLE_MODEL_CONFIG_OBJECT_KEYS) {
    const normalized = readPortableObjectSettings(key, source[key]);
    if (normalized) result[key] = normalized;
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

/** 原文保留天数只认页面上那几个选项；`null` = 永久保留，`undefined`（老卡）= 导入端默认 30 天。 */
const RAW_RETENTION_DAYS = [30, 90, 180] as const;
const RAW_RETENTION_DEFAULT_DAYS = 30;
function readRawRetentionDays(value: unknown): number | null {
  if (value === null) return null;
  if (value === undefined) return RAW_RETENTION_DEFAULT_DAYS;
  const days = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : Number.NaN;
  if (days === 0) return null;
  return (RAW_RETENTION_DAYS as readonly number[]).includes(days) ? days : RAW_RETENTION_DEFAULT_DAYS;
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
    interactionGuidance: bundle.interactionGuidance.length,
    channelPolicies: bundle.channelPolicies.length,
    expressionHabits: bundle.expressionHabits.length,
    goals: bundle.goals.length,
    preferences: bundle.preferences.length,
    visualOutfits: bundle.visualProfile?.outfits.length ?? 0,
    visualVersions: bundle.visualProfile?.versions.length ?? 0,
    visualAssets: bundle.visualProfile?.assets.length ?? 0,
    hasVisualProfile: bundle.visualProfile !== null,
    stickers: bundle.stickers.length,
    growth: growthCounts(bundle.growth),
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
    /** 角色行上的稳定同步根 ID；旧行为空时由导出调用方回落到角色自己的 id。 */
    originCharacterId?: string | null;
  };
  memorySetting?: {
    snapshotIntervalDays: number;
    timezone: string;
    autoSnapshotEnabled: boolean;
    rawMessageRetentionDays?: number | null;
    rawMessageCleanupEnabled?: boolean;
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
  growth?: CharacterGrowthBundle;
  catchphrases?: Array<{ phrase: string; usage: string; enabled: boolean; source: string }>;
  /** 互动经验：调用方只传 ACTIVE 的，这里不再筛。 */
  interactionGuidance?: CharacterBundleInteractionGuidance[];
  /** 渠道行为策略：同样只传 ACTIVE 的。 */
  channelPolicies?: CharacterBundleChannelPolicy[];
  /** 表达习惯、目标、偏好（v7）：调用方负责按状态筛，这里不再筛。 */
  expressionHabits?: CharacterBundleExpressionHabit[];
  goals?: CharacterBundleGoal[];
  preferences?: CharacterBundlePreference[];
  /** 形象档案（v8）：没建过就传 null 或不传。 */
  visualProfile?: BundleVisualProfileSource | null;
  /** 表情包清单（v8）：调用方只传未删除的，这里只收名字与用途。 */
  stickers?: Array<{ name: string; usage: string; enabled: boolean; source: string | null }>;
  now?: Date;
};

/** 库里读出来的形象档案，`Date` 尚未转成 ISO，转在 build 这一层统一做。 */
export type BundleVisualProfileSource = {
  coreAppearance: string;
  corePrompt: string;
  negativePrompt: string;
  /** 库里可能没有这三列（老版本迁移前的读取路径），所以是可选的。 */
  loraName?: string;
  loraStrength?: number;
  loraTrigger?: string;
  currentPublishedRevision: number;
  outfits: Array<{ name: string; prompt: string; isDefault: boolean; sortOrder: number }>;
  versions: Array<{
    revision: number;
    status: string;
    note: string;
    snapshot: unknown;
    createdAt: Date;
    publishedAt: Date | null;
  }>;
  assets: Array<{ kind: string; label: string; width: number | null; height: number | null; sortOrder: number }>;
};

function visualAssetKind(value: unknown): BundleVisualAssetKind {
  return (VISUAL_ASSET_KINDS as readonly string[]).includes(String(value))
    ? value as BundleVisualAssetKind
    : "STANDARD";
}

function visualVersionStatus(value: unknown): BundleVisualVersionStatus {
  return (VISUAL_VERSION_STATUSES as readonly string[]).includes(String(value))
    ? value as BundleVisualVersionStatus
    : "DRAFT";
}

/**
 * 版本快照的白名单化。
 *
 * 快照原本是「这一版引用了哪几张素材」的记录，素材行带 `id` 与 `relativePath` ——
 * 两样都是旧机器上的东西，搬过去只会让新机器以为图还在。所以这里只留
 * 描述文字与「第几张、什么用途、叫什么」，不认识/不该带的键一律丢掉（不 spread 库里的行）。
 *
 * 超出字节上限时退回「只留文字」：一个把包撑爆的快照，不如一段描述诚实。
 */
function toBundleVisualSnapshot(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  const text = (key: string, max: number) => typeof raw[key] === "string" ? (raw[key] as string).slice(0, max) : "";
  const outfits = Array.isArray(raw.outfits)
    ? raw.outfits.slice(0, CHARACTER_BUNDLE_LIMITS.visualOutfits).map((item) => {
      const row = asRecord(item);
      return {
        name: typeof row.name === "string" ? row.name.slice(0, CHARACTER_BUNDLE_LIMITS.outfitName) : "",
        prompt: typeof row.prompt === "string" ? row.prompt.slice(0, CHARACTER_BUNDLE_LIMITS.outfitPrompt) : "",
        isDefault: row.isDefault === true,
        sortOrder: Number.isSafeInteger(row.sortOrder) ? row.sortOrder as number : 0,
      };
    })
    : [];
  const assets = Array.isArray(raw.assets)
    ? raw.assets.slice(0, CHARACTER_BUNDLE_LIMITS.visualAssets).map((item) => {
      const row = asRecord(item);
      return {
        kind: visualAssetKind(row.kind),
        label: typeof row.label === "string" ? row.label.slice(0, CHARACTER_BUNDLE_LIMITS.assetLabel) : "",
        sortOrder: Number.isSafeInteger(row.sortOrder) ? row.sortOrder as number : 0,
      };
    })
    : [];
  const snapshot = {
    coreAppearance: text("coreAppearance", CHARACTER_BUNDLE_LIMITS.visualAppearance),
    corePrompt: text("corePrompt", CHARACTER_BUNDLE_LIMITS.visualPrompt),
    negativePrompt: text("negativePrompt", CHARACTER_BUNDLE_LIMITS.negativePrompt),
    // LoRA 是「这一版长什么样」的一部分，必须跟着快照走；只留文件名，路径一律不要。
    loraName: (text("loraName", CHARACTER_BUNDLE_LIMITS.loraName).split(/[/\\]/u).pop() ?? ""),
    loraStrength: typeof raw.loraStrength === "number" && Number.isFinite(raw.loraStrength)
      ? Math.min(2, Math.max(0, raw.loraStrength as number))
      : 1,
    loraTrigger: text("loraTrigger", CHARACTER_BUNDLE_LIMITS.loraTrigger),
    outfits,
    assets,
  };
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= CHARACTER_BUNDLE_LIMITS.visualSnapshotBytes
    ? snapshot
    : { ...snapshot, outfits: [], assets: [] };
}

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
      // 原文保留策略是用户设定，不是运行状态：带着它换机器，才不用重新想一遍「留几天」。
      rawMessageRetentionDays: input.memorySetting?.rawMessageRetentionDays ?? null,
      rawMessageCleanupEnabled: input.memorySetting?.rawMessageCleanupEnabled ?? false,
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
    interactionGuidance: input.interactionGuidance ?? [],
    channelPolicies: input.channelPolicies ?? [],
    expressionHabits: input.expressionHabits ?? [],
    goals: input.goals ?? [],
    preferences: input.preferences ?? [],
    visualProfile: input.visualProfile
      ? {
        coreAppearance: (input.visualProfile.coreAppearance ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.visualAppearance),
        corePrompt: (input.visualProfile.corePrompt ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.visualPrompt),
        negativePrompt: (input.visualProfile.negativePrompt ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.negativePrompt),
        // 只留文件名：引擎认的是 models/loras 下的名字，绝对路径换台机器就是无效配置。
        loraName: (input.visualProfile.loraName ?? "").split(/[/\\]/u).pop()?.slice(0, CHARACTER_BUNDLE_LIMITS.loraName) ?? "",
        loraStrength: Number.isFinite(input.visualProfile.loraStrength)
          ? Math.min(2, Math.max(0, input.visualProfile.loraStrength as number))
          : 1,
        loraTrigger: (input.visualProfile.loraTrigger ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.loraTrigger),
        currentPublishedRevision: Math.max(0, Math.trunc(input.visualProfile.currentPublishedRevision)),
        outfits: input.visualProfile.outfits
          .slice(0, CHARACTER_BUNDLE_LIMITS.visualOutfits)
          .map(outfit => ({
            name: (outfit.name ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.outfitName),
            prompt: (outfit.prompt ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.outfitPrompt),
            isDefault: outfit.isDefault === true,
            sortOrder: Number.isSafeInteger(outfit.sortOrder) ? outfit.sortOrder : 0,
          })),
        versions: input.visualProfile.versions
          .slice(0, CHARACTER_BUNDLE_LIMITS.visualVersions)
          .map(version => ({
            revision: Math.max(1, Math.trunc(version.revision)),
            status: visualVersionStatus(version.status),
            note: (version.note ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.versionNote),
            snapshot: toBundleVisualSnapshot(version.snapshot),
            createdAt: version.createdAt ? version.createdAt.toISOString() : null,
            publishedAt: version.publishedAt ? version.publishedAt.toISOString() : null,
          })),
        assets: input.visualProfile.assets
          .slice(0, CHARACTER_BUNDLE_LIMITS.visualAssets)
          .map(asset => ({
            kind: visualAssetKind(asset.kind),
            label: (asset.label ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.assetLabel),
            width: Number.isSafeInteger(asset.width) ? asset.width : null,
            height: Number.isSafeInteger(asset.height) ? asset.height : null,
            sortOrder: Number.isSafeInteger(asset.sortOrder) ? asset.sortOrder : 0,
          })),
      }
      : null,
    stickers: (input.stickers ?? [])
      .slice(0, CHARACTER_BUNDLE_LIMITS.stickers)
      .map(item => ({
        name: (item.name ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.stickerName),
        usage: (item.usage ?? "").slice(0, CHARACTER_BUNDLE_LIMITS.stickerUsage),
        enabled: item.enabled === true,
        source: item.source || "manual",
      })),
    growth: input.growth ?? emptyCharacterGrowthBundle(),
  };

  return { ...payload, counts: buildCounts(payload) };
}

export type ParsedCharacterBundle = {
  formatVersion: number;
  /** 稳定同步根 ID；null = 历史卡片未携带 origin，只能新建并建立独立根。 */
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
  interactionGuidance: CharacterBundleInteractionGuidance[];
  channelPolicies: CharacterBundleChannelPolicy[];
  expressionHabits: CharacterBundleExpressionHabit[];
  goals: CharacterBundleGoal[];
  preferences: CharacterBundlePreference[];
  /** 形象档案（v8）：null = 没建过。 */
  visualProfile: CharacterBundleVisualProfile | null;
  /** 表情包清单（v8）：只有名字与用途。 */
  stickers: CharacterBundleSticker[];
  growth: CharacterGrowthBundle;
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

  // 兼容旧卡：没有有效 origin 时无法自动匹配；导入新建时会用新实例 id 建立独立同步根。
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
   *
   * 原文保留策略（v7）同一个态度：老卡没有这两格 → 沿用导入端原来的默认值（30 天）；
   * 显式写 `null` 才是「永久保留」。只认页面上那几个选项（30 / 90 / 180），
   * 别的一律收口。永久保留时不允许同时开着自动清理（页面接口也是这条规则）。
   */
  const rawRetentionDays = readRawRetentionDays(setting.rawMessageRetentionDays);
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
    rawMessageRetentionDays: rawRetentionDays,
    rawMessageCleanupEnabled: setting.rawMessageCleanupEnabled === true && rawRetentionDays !== null,
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

  /**
   * 互动经验 / 渠道策略（v6）。老卡没有这两段，读成空数组 ——
   * 与成长段不同，它们的缺失不会让人误以为「卡坏了」，只会是「没教过」。
   *
   * 内容长度对齐数据库列（400 / 200）；kind 与 chatScope 都走白名单，
   * 认不出来的直接拒绝，而不是悄悄改成默认值 —— 一条被改错的准则比没有更糟。
   */
  const interactionGuidance: CharacterBundleInteractionGuidance[] = readArray(
    body.interactionGuidance,
    "互动经验",
    CHARACTER_BUNDLE_LIMITS.interactionGuidance,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条互动经验`;
    const kindInput = typeof item.kind === "string" ? item.kind : "";
    if (!(GUIDANCE_KIND_NAMES as readonly string[]).includes(kindInput)) bad(`${label}的类型无法识别。`);
    const scopeInput = typeof item.chatScope === "string" ? item.chatScope : "ALL";
    if (!(GUIDANCE_CHAT_SCOPES as readonly string[]).includes(scopeInput)) bad(`${label}的聊天范围无法识别。`);
    return {
      kind: kindInput as GuidanceKindName,
      content: readText(item.content, `${label}的内容`, 400, true),
      context: readText(item.context, `${label}的场景`, 400, true),
      chatScope: scopeInput as CharacterBundleInteractionGuidance["chatScope"],
    };
  });

  const channelPolicies: CharacterBundleChannelPolicy[] = readArray(
    body.channelPolicies,
    "渠道行为策略",
    CHARACTER_BUNDLE_LIMITS.channelPolicies,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条渠道策略`;
    if (item.kind !== "GROUP_AT_DISABLED") bad(`${label}的类型无法识别。`);
    return {
      kind: "GROUP_AT_DISABLED" as const,
      content: readText(item.content, `${label}的内容`, 200, true),
      chatScope: "GROUP" as const,
    };
  });

  /**
   * 表达习惯 / 目标 / 偏好（v7）。老卡没有这三段，读成空数组 —— 与互动经验同一个态度：
   * 缺失只意味着「那时还没这类内容」，不是「卡坏了」。
   *
   * 认不出来的 kind / chatScope 一律拒绝：一条被悄悄改成默认值的「说话习惯」
   * 会直接改写她的语气，比没有更糟。状态只接受导出侧会带的那几个（PENDING 之类的
   * 决策现场不跨机器），多出来的当卡被改过，拒绝。
   */
  const expressionHabits: CharacterBundleExpressionHabit[] = readArray(
    body.expressionHabits,
    "表达习惯",
    CHARACTER_BUNDLE_LIMITS.expressionHabits,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条表达习惯`;
    const kindInput = typeof item.kind === "string" ? item.kind : "";
    if (!(HABIT_KINDS as readonly string[]).includes(kindInput)) bad(`${label}的类型无法识别。`);
    const statusInput = typeof item.status === "string" ? item.status : "";
    if (!(HABIT_STATUSES as readonly string[]).includes(statusInput)) bad(`${label}的状态无法识别。`);
    const scopeInput = typeof item.chatScope === "string" ? item.chatScope : "ALL";
    if (!(GUIDANCE_CHAT_SCOPES as readonly string[]).includes(scopeInput)) bad(`${label}的聊天范围无法识别。`);
    return {
      kind: kindInput as CharacterBundleExpressionHabit["kind"],
      content: readText(item.content, `${label}的内容`, CHARACTER_BUNDLE_LIMITS.habitContent, true),
      context: readText(item.context, `${label}的场景`, CHARACTER_BUNDLE_LIMITS.habitContext),
      chatScope: scopeInput as CharacterBundleExpressionHabit["chatScope"],
      status: statusInput as CharacterBundleExpressionHabit["status"],
      // 成因必填：库里那条 CHECK 要求 reason 非空，空着导进去只会在事务里炸掉整张卡
      reason: readText(item.reason, `${label}的成因`, CHARACTER_BUNDLE_LIMITS.reason, true),
    };
  });

  const goals: CharacterBundleGoal[] = readArray(
    body.goals,
    "目标",
    CHARACTER_BUNDLE_LIMITS.goals,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 个目标`;
    const kindInput = typeof item.kind === "string" ? item.kind : "";
    if (!(GOAL_KINDS as readonly string[]).includes(kindInput)) bad(`${label}的类型无法识别。`);
    const statusInput = typeof item.status === "string" ? item.status : "";
    if (!(GOAL_STATUSES as readonly string[]).includes(statusInput)) bad(`${label}的状态无法识别。`);
    return {
      kind: kindInput as CharacterBundleGoal["kind"],
      title: readText(item.title, `${label}的标题`, CHARACTER_BUNDLE_LIMITS.goalTitle, true),
      // 库里 CHECK 要求标题、描述、成因都非空：这里先挡住，别让人导到一半整包回滚
      description: readText(item.description, `${label}的描述`, CHARACTER_BUNDLE_LIMITS.goalDescription, true),
      reason: readText(item.reason, `${label}的成因`, CHARACTER_BUNDLE_LIMITS.reason, true),
      status: statusInput as CharacterBundleGoal["status"],
    };
  });

  const preferences: CharacterBundlePreference[] = readArray(
    body.preferences,
    "偏好",
    CHARACTER_BUNDLE_LIMITS.preferences,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    const label = `第 ${index + 1} 条偏好`;
    const kindInput = typeof item.kind === "string" ? item.kind : "";
    if (!(PREFERENCE_KINDS as readonly string[]).includes(kindInput)) bad(`${label}的类型无法识别。`);
    const statusInput = typeof item.status === "string" ? item.status : "";
    if (!(PREFERENCE_STATUSES as readonly string[]).includes(statusInput)) bad(`${label}的状态无法识别。`);
    return {
      kind: kindInput as CharacterBundlePreference["kind"],
      topic: readText(item.topic, `${label}的主题`, CHARACTER_BUNDLE_LIMITS.preferenceTopic, true),
      reason: readText(item.reason, `${label}的原因`, CHARACTER_BUNDLE_LIMITS.reason, true),
      status: statusInput as CharacterBundlePreference["status"],
    };
  });

  /**
   * 形象档案（v8）。允许 `null`（这个角色没建过），也允许整段缺省（v7 及更早的卡）。
   * 缺省与 null 在库里表现一样：不写 profile 行。区别只在语义上——
   * 「老卡没有这一段」和「导出时她没有形象档案」都是「新机器上没有」，不必分。
   */
  const visualRaw = body.visualProfile;
  const visualProfile: CharacterBundleVisualProfile | null = visualRaw === undefined || visualRaw === null
    ? null
    : (() => {
      const item = asRecord(visualRaw);
      const outfits = readArray(item.outfits, "形象装扮", CHARACTER_BUNDLE_LIMITS.visualOutfits).map((entry, index) => {
        const outfit = asRecord(entry);
        return {
          name: readText(outfit.name, `第 ${index + 1} 套装扮的名称`, CHARACTER_BUNDLE_LIMITS.outfitName, true),
          prompt: readText(outfit.prompt, `第 ${index + 1} 套装扮的描述`, CHARACTER_BUNDLE_LIMITS.outfitPrompt, true),
          isDefault: outfit.isDefault === true,
          sortOrder: Number.isSafeInteger(outfit.sortOrder) ? outfit.sortOrder as number : index,
        } satisfies CharacterBundleVisualOutfit;
      });
      // 同名装扮在库里是唯一键，包里出现两份就直接拒绝：让导出者知道这份卡有问题，
      // 而不是导入时悄悄只留一套、事后发现少了一套衣服。
      const outfitNames = new Set<string>();
      for (const outfit of outfits) {
        if (outfitNames.has(outfit.name)) bad(`形象装扮里有重名的「${outfit.name}」。`);
        outfitNames.add(outfit.name);
      }
      if (outfits.filter(outfit => outfit.isDefault).length > 1) bad("形象装扮里有不止一套默认装扮。");

      const versions = readArray(item.versions, "形象版本", CHARACTER_BUNDLE_LIMITS.visualVersions).map((entry, index) => {
        const version = asRecord(entry);
        const label = `第 ${index + 1} 个形象版本`;
        return {
          revision: Math.round(readNumber(version.revision, `${label}的版本号`, 1, 100_000, 1)),
          status: visualVersionStatus(version.status),
          note: readText(version.note, `${label}的备注`, CHARACTER_BUNDLE_LIMITS.versionNote),
          snapshot: toBundleVisualSnapshot(version.snapshot),
          createdAt: readOptionalDate(version.createdAt, `${label}的创建时间`)?.toISOString() ?? null,
          publishedAt: readOptionalDate(version.publishedAt, `${label}的发布时间`)?.toISOString() ?? null,
        } satisfies CharacterBundleVisualVersion;
      });
      const revisions = new Set<number>();
      for (const version of versions) {
        if (revisions.has(version.revision)) bad(`形象版本 ${version.revision} 出现了两次。`);
        revisions.add(version.revision);
      }

      const assets = readArray(item.assets, "形象参考图清单", CHARACTER_BUNDLE_LIMITS.visualAssets).map((entry, index) => {
        const asset = asRecord(entry);
        return {
          kind: visualAssetKind(asset.kind),
          label: readText(asset.label, `第 ${index + 1} 张参考图的名称`, CHARACTER_BUNDLE_LIMITS.assetLabel),
          width: readOptionalNumber(asset.width, `第 ${index + 1} 张参考图的宽度`, 1, 100_000),
          height: readOptionalNumber(asset.height, `第 ${index + 1} 张参考图的高度`, 1, 100_000),
          sortOrder: Number.isSafeInteger(asset.sortOrder) ? asset.sortOrder as number : index,
        } satisfies CharacterBundleVisualAsset;
      });

      return {
        coreAppearance: readText(item.coreAppearance, "形象描述", CHARACTER_BUNDLE_LIMITS.visualAppearance),
        corePrompt: readText(item.corePrompt, "形象提示词", CHARACTER_BUNDLE_LIMITS.visualPrompt),
        negativePrompt: readText(item.negativePrompt, "形象负面提示词", CHARACTER_BUNDLE_LIMITS.negativePrompt),
        // LoRA 段在 v8 里是可选的：老 v8 卡没有它，读成「不用 LoRA」。
        loraName: readText(item.loraName, "LoRA 文件名", CHARACTER_BUNDLE_LIMITS.loraName).split(/[/\\]/u).pop() ?? "",
        loraStrength: readOptionalNumber(item.loraStrength, "LoRA 强度", 0, 2) ?? 1,
        loraTrigger: readText(item.loraTrigger, "LoRA 触发词", CHARACTER_BUNDLE_LIMITS.loraTrigger),
        // 指向一个包里没有的版本号时收口成 0：导入后「当前正式版本」不该指着一版不存在的形象。
        currentPublishedRevision: revisions.has(Number(item.currentPublishedRevision))
          ? Number(item.currentPublishedRevision)
          : 0,
        outfits,
        versions,
        assets,
      } satisfies CharacterBundleVisualProfile;
    })();

  // 表情包清单（v8）：只有名字与用途，图片不随包走。
  const stickers: CharacterBundleSticker[] = readArray(
    body.stickers,
    "表情包",
    CHARACTER_BUNDLE_LIMITS.stickers,
  ).map((candidate, index) => {
    const item = asRecord(candidate);
    return {
      name: readText(item.name, `第 ${index + 1} 个表情包的名字`, CHARACTER_BUNDLE_LIMITS.stickerName, true),
      usage: readText(item.usage, `第 ${index + 1} 个表情包的用途`, CHARACTER_BUNDLE_LIMITS.stickerUsage),
      enabled: item.enabled === true,
      source: typeof item.source === "string" && item.source.trim() ? item.source.trim().slice(0, 20) : "manual",
    } satisfies CharacterBundleSticker;
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

  /**
   * 版本段的必填检查，从新到旧。
   *
   * 同时缺好几段时报最新的那个：它最能说明「这张卡是哪一版导出来的」，
   * 报一个老段反而会让人以为是更早的格式问题。
   */
  if (version >= 8 && (body.visualProfile === undefined || body.stickers === undefined)) {
    bad("v8角色卡缺少形象档案或表情包段。");
  }
  if (version < 8 && (body.visualProfile !== undefined || body.stickers !== undefined)) {
    bad("形象档案与表情包清单需要v8角色卡，不能以旧版本静默导入。");
  }
  if (version >= 7 && (
    body.expressionHabits === undefined
    || body.goals === undefined
    || body.preferences === undefined
  )) {
    bad("v7角色卡缺少表达习惯、目标或偏好段。");
  }
  if (version < 7 && (
    body.expressionHabits !== undefined
    || body.goals !== undefined
    || body.preferences !== undefined
  )) {
    bad("表达习惯、目标与偏好需要v7角色卡，不能以旧版本静默导入。");
  }
  if (version >= 6 && (body.interactionGuidance === undefined || body.channelPolicies === undefined)) {
    bad("v6角色卡缺少互动经验或渠道策略段。");
  }
  if (version < 6 && (body.interactionGuidance !== undefined || body.channelPolicies !== undefined)) {
    bad("互动经验与渠道策略需要v6角色卡，不能以旧版本静默导入。");
  }
  if (version >= 5 && body.growth === undefined) bad("v5角色卡缺少成长数据段。");
  if (version < 5 && body.growth !== undefined) bad("成长数据需要v5角色卡，不能以旧版本静默导入。");

  const growth = version >= 5 ? parseCharacterGrowthBundle(body.growth, {
    eventIds: new Set(events.filter(item => item.scope === "character").flatMap(item => item.originId ? [item.originId] : [])),
    snapshotIds: new Set(snapshots.filter(item => item.scope === "character").flatMap(item => item.originId ? [item.originId] : [])),
    friends: seenFriendKeys,
    includeFriends: friends.length > 0,
  }) : emptyCharacterGrowthBundle();

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
    interactionGuidance,
    channelPolicies,
    expressionHabits,
    goals,
    preferences,
    visualProfile,
    stickers,
    growth,
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
    interactionGuidance,
    channelPolicies,
    expressionHabits,
    goals,
    preferences,
    visualProfile,
    stickers,
    growth,
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
