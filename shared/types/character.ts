/**
 * 角色域的前后端共享契约。
 *
 * `Character` 就是 `server/utils/character-dto.ts` 的 `toCharacterDto()` 返回值：
 * 所有接口（列表 / 详情 / 创建 / 改 / 导入）都走同一个 `characterInclude` + 同一个
 * 整形函数，所以**形状只有一份**。前端 `app/utils/mock-data.ts` 里那份「全可选」的
 * `Character` 是历史遗留 —— 它把「列表和详情不一样」当成了事实，其实那早就统一了。
 *
 * 字段很多的根因是 `character.modelConfig` 是一个大 JSON：这里把它摊平成显式字段，
 * 好处是页面上打错一个配置名会直接报错，坏处是这个类型很长。别为了短而去用
 * `Record<string, unknown>` —— 那等于把类型检查关掉。
 */

/** 主动找话设置：她先开口的唯一路径，默认关闭。 */
export type ProactiveSettings = {
  enabled: boolean;
  /** 每天最多主动几条。 */
  dailyMax: number;
  /** 两条之间的最小间隔（分钟）。 */
  minGapMinutes: number;
  /** 安静时段起点（含）。 */
  quietStart: string;
  /** 安静时段终点（不含）。允许跨午夜。 */
  quietEnd: string;
  /** 主人最近这么多分钟内说过话，就当作「还在聊」，不打扰。 */
  userActiveMinutes: number;
  /** 挑目的的最低置信度。 */
  minConfidence: number;
};

/** 群内「冷场了自己找话题」；默认关闭。 */
export type GroupInitiativeSettings = {
  enabled: boolean;
  /** 群里安静了多少分钟才算「冷场」。 */
  idleMinutes: number;
  /** 每个群每天最多主动开几次话题。 */
  dailyMax: number;
  /** 同一个群两次尝试之间至少隔多久（分钟）。 */
  minGapMinutes: number;
  /** 安静时段起点（含），对她主动开口同样有效 —— 凌晨的群不需要被叫醒。 */
  quietStart: string;
  /** 安静时段终点（不含）。允许跨午夜。 */
  quietEnd: string;
};

export const CHARACTER_STATUSES = ["运行中", "已暂停", "未连接"] as const;
export type CharacterStatus = typeof CHARACTER_STATUSES[number];

export const AVATAR_TONES = ["purple", "peach", "mint", "blue"] as const;
export type AvatarTone = typeof AVATAR_TONES[number];

export const KNOWLEDGE_COLLECT_SCOPES = ["ALL", "SELECTED"] as const;
export type KnowledgeCollectScope = typeof KNOWLEDGE_COLLECT_SCOPES[number];

export type Character = {
  id: string;
  /** 稳定同步根 ID：同一角色在不同设备上的本地实例通过它识别；本机新建角色以自己的 id 为根。 */
  originId: string;
  name: string;
  alias: string;
  description: string;
  avatar: string;
  avatarTone: AvatarTone;
  status: CharacterStatus;
  channels: string[];
  /** 正在生效的归档周期。 */
  intervalDays: number;
  /** 已排期但还没到生效边界的归档周期；null = 没有待生效的改动。 */
  pendingIntervalDays: number | null;
  nextSnapshot: string;
  memoryCount: number;
  latestSnapshot: string;
  personality: string;
  /** 对话示例：只用于对齐语气，聊天 / QQ 被动回复会注入。 */
  examples: string;
  /** 角色在对话里怎么称呼用户；空字符串表示不特意称呼。 */
  userAddress: string;
  /** ISO 时间：弹窗页脚左侧显示「上次保存」。 */
  updatedAt: string;

  // ── 对话模型 ──────────────────────────────────────────────
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  /** 深度思考开关；默认开（跟随 DeepSeek 平台默认）。只在 DeepSeek 系模型上真正生效。 */
  chatThinking: boolean;
  chatApiBaseUrl: string;
  /** 明文 Key（2026-11-12 起不再加密存储），页面用密码框回显；空 = 没配。 */
  chatApiKey: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";

  // ── 记忆助手 ──────────────────────────────────────────────
  /** 留空 = 跟随对话模型。 */
  memoryAssistantEnabled: boolean;
  memoryAssistantModel: string;
  memoryAssistantTemperature: number;
  memoryAssistantMaxInputTokens: number;
  memoryAssistantMaxOutputTokens: number;
  memoryAssistantApiBaseUrl: string;
  memoryAssistantApiKey: string;
  memoryAssistantApiKeyConfigured: boolean;
  /** 解析后的连接是否真的能跑（含继承对话模型 / Key 的情况）。 */
  memoryAssistantConfigured: boolean;

  // ── 上下文助手 ────────────────────────────────────────────
  contextAssistantEnabled: boolean;
  contextAssistantModel: string;
  contextAssistantTemperature: number;
  contextAssistantMaxInputTokens: number;
  contextAssistantMaxOutputTokens: number;
  contextAssistantApiBaseUrl: string;
  contextAssistantApiKey: string;
  contextAssistantApiKeyConfigured: boolean;
  contextAssistantConfigured: boolean;

  // ── 知识处理助手 ─────────────────────────────────────────
  knowledgeAutoCollectEnabled: boolean;
  /** 聊天知识候选收谁的：ALL 全体 / SELECTED 仅被标记的好友与主人。 */
  knowledgeCollectScope: KnowledgeCollectScope;
  knowledgeAssistantEnabled: boolean;
  knowledgeAssistantModel: string;
  knowledgeAssistantTemperature: number;
  knowledgeAssistantMaxInputTokens: number;
  knowledgeAssistantMaxOutputTokens: number;
  knowledgeAssistantApiBaseUrl: string;
  knowledgeAssistantApiKey: string;
  knowledgeAssistantApiKeyConfigured: boolean;
  knowledgeAssistantConfigured: boolean;

  // ── 关系评估助手 ─────────────────────────────────────────
  socialRelationshipAssessmentAssistantEnabled: boolean;
  socialRelationshipAssessmentAssistantModel: string;
  socialRelationshipAssessmentAssistantTemperature: number;
  socialRelationshipAssessmentAssistantMaxInputTokens: number;
  socialRelationshipAssessmentAssistantMaxOutputTokens: number;
  socialRelationshipAssessmentAssistantApiBaseUrl: string;
  socialRelationshipAssessmentAssistantApiKey: string;
  socialRelationshipAssessmentAssistantApiKeyConfigured: boolean;
  socialRelationshipAssessmentAssistantConfigured: boolean;

  // ── 预算与注入量 ──────────────────────────────────────────
  /** 每日 token 额度，0 = 不限。 */
  dailyTokenLimit: number;
  memoryTokenBudget: number;
  snapshotTokenBudget: number;
  /** 每次注入多少条长期记忆；默认 20。 */
  memoryItemLimit: number;
  /** 每次回复回看多少条已落库消息；桌面端约等于「轮数 × 2」。 */
  recentMessageLimit: number;
  /** 最近几天的忆泡无条件当背景带上；0 = 不带。 */
  eventRecentDays: number;

  // ── 表情与贴图 ────────────────────────────────────────────
  /** QQ 渠道回复是否允许附一张表情；默认关。 */
  emojiEnabled: boolean;
  /** 表情额度：多少分钟内最多贴几次（贴图与内置表情共用一个额度，按会话分别算）。 */
  emojiWindowMinutes: number;
  emojiPerWindow: number;
  /** 群里发来的图是否交给视觉模型读；默认关。 */
  imageUnderstanding: boolean;
  /** 群里的图是否自动收进她的表情库（「偷表情包」）；默认关。 */
  stickerAutoCollect: boolean;
  /** 群聊之后是否自动扫一遍群里的梗（捡到的先进待确认）；默认关。 */
  catchphraseAutoMine: boolean;

  // ── 语音 ──────────────────────────────────────────────────
  /** 她的回复能不能发成语音条；默认关。 */
  voiceEnabled: boolean;
  /** 她听不听得懂别人发的语音（自动转写）；默认关。 */
  voiceTranscribe: boolean;
  /** 发语音的概率（0-100），默认 25。 */
  voiceChance: number;
  /** 两条语音之间至少隔多少分钟（0 = 不冷却），默认 20。 */
  voiceCooldownMinutes: number;
  /** 语音服务地址；空 = 用环境变量或角色聊天地址。 */
  voiceApiBaseUrl: string;
  /** 明文语音 Key；空 = 没配。 */
  voiceApiKey: string;
  voiceApiKeyConfigured: boolean;
  /** 语音合成模型 / 音色 / 识别模型；空 = 用环境变量。 */
  ttsModel: string;
  ttsVoice: string;
  asrModel: string;
  /** 识别服务商：空 = 自动判断。patch 可写、DTO 必须回，否则页面回显会退回「自动」。 */
  asrProvider: string;
  /** 语音服务商：openai（含兼容接口）/ minimax / breeze。空 = 按地址自动判断。 */
  ttsProvider: string;
  /** MiniMax 的 GroupId（查询参数）。 */
  ttsGroupId: string;
  /** Breeze 的演技指令；空 = 用环境变量。 */
  ttsInstructions: string;
  /** 语速 0.5–2.0；0 = 用环境变量或默认 1。 */
  ttsSpeed: number;
  /** 识别专用地址；空 = 用环境变量或语音地址。 */
  asrApiBaseUrl: string;
  /** 明文识别 Key（合成与识别不是同一家时用）。 */
  asrApiKey: string;
  asrApiKeyConfigured: boolean;

  // ── 看图 ──────────────────────────────────────────────────
  /** 看图模型：空 = 回落到环境变量 / 对话模型，所以「没配」是正常状态。 */
  visionModel: string;
  /** 看图服务地址；空 = 用环境变量或角色聊天地址。 */
  visionApiBaseUrl: string;
  /** 明文看图 Key；空 = 没配（会回落到对话模型）。 */
  visionApiKey: string;
  visionApiKeyConfigured: boolean;

  // ── 主动行为 ──────────────────────────────────────────────
  /** 主动找话设置；未配置过时是默认值（enabled=false）。 */
  proactive: ProactiveSettings;
  /** 群内「冷场了自己找话题」；未配置过时是默认值（enabled=false）。 */
  groupInitiative: GroupInitiativeSettings;
};
