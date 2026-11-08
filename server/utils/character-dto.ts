import { resolveChatModelSettings } from "./chat-model-config";
import { resolveEmojiFrequency } from "./emoji-frequency";
import { MEMORY_TOKEN_BUDGET_DEFAULT, SNAPSHOT_TOKEN_BUDGET_DEFAULT, resolveMemoryItemLimit, resolveRecentMessageLimit } from "./memory-retrieval";
import { resolveEventRecentDays } from "./memory-event-retrieval";
import { resolveProactiveSettings, type ProactiveSettings } from "./proactive-settings";
import { resolveGroupInitiativeSettings, type GroupInitiativeSettings } from "./group-initiative-settings";
import { isAsrApiKeySaved, isContextAssistantApiKeySaved, isKnowledgeAssistantApiKeySaved, isMemoryAssistantApiKeySaved, isSocialRelationshipAssessmentAssistantApiKeySaved, isVisionApiKeySaved, isVoiceApiKeySaved } from "./credential-encryption";
import { resolveVoiceChance, resolveVoiceCooldownMinutes } from "./voice";

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export type CharacterDto = {
  id: string;
  /** 稳定同步根 ID：同一角色在不同设备上的本地实例通过它识别；本机新建角色以自己的 id 为根。 */
  originId: string;
  name: string;
  alias: string;
  description: string;
  avatar: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  status: "运行中" | "已暂停" | "未连接";
  channels: string[];
  /** 正在生效的归档周期。 */
  intervalDays: number;
  /** 已排期但还没到生效边界的归档周期；null = 没有待生效的改动。 */
  pendingIntervalDays: number | null;
  nextSnapshot: string;
  memoryCount: number;
  latestSnapshot: string;
  personality: string;
  /** 对话示例：只用于对齐语气，聊天 / QQ / B站 被动回复会注入，B站 值班判断不注入。 */
  examples: string;
  /** 角色在对话里怎么称呼用户；空字符串表示不特意称呼。 */
  userAddress: string;
  /** ISO 时间：弹窗页脚左侧显示「上次保存」。 */
  updatedAt: string;
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  /** 深度思考开关；默认开（跟随 DeepSeek 平台默认）。只在 DeepSeek 系模型上真正生效。 */
  chatThinking: boolean;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";
  /** 记忆助手专用模型配置；Key 仅回传是否已保存。 */
  memoryAssistantEnabled: boolean;
  memoryAssistantModel: string;
  memoryAssistantTemperature: number;
  memoryAssistantMaxInputTokens: number;
  memoryAssistantMaxOutputTokens: number;
  memoryAssistantApiBaseUrl: string;
  memoryAssistantApiKeyConfigured: boolean;
  memoryAssistantConfigured: boolean;
  contextAssistantEnabled: boolean;
  contextAssistantModel: string;
  contextAssistantTemperature: number;
  contextAssistantMaxInputTokens: number;
  contextAssistantMaxOutputTokens: number;
  contextAssistantApiBaseUrl: string;
  contextAssistantApiKeyConfigured: boolean;
  contextAssistantConfigured: boolean;
  /** 知识处理助手配置；API Key 只回显是否已保存。 */
  knowledgeAutoCollectEnabled: boolean;
  knowledgeAssistantEnabled: boolean;
  knowledgeAssistantModel: string;
  knowledgeAssistantTemperature: number;
  knowledgeAssistantMaxInputTokens: number;
  knowledgeAssistantMaxOutputTokens: number;
  knowledgeAssistantApiBaseUrl: string;
  knowledgeAssistantApiKeyConfigured: boolean;
  knowledgeAssistantConfigured: boolean;
  /** 关系评估助手独立模型配置；API Key 只回显是否已保存。 */
  socialRelationshipAssessmentAssistantEnabled: boolean;
  socialRelationshipAssessmentAssistantModel: string;
  socialRelationshipAssessmentAssistantTemperature: number;
  socialRelationshipAssessmentAssistantMaxInputTokens: number;
  socialRelationshipAssessmentAssistantMaxOutputTokens: number;
  socialRelationshipAssessmentAssistantApiBaseUrl: string;
  socialRelationshipAssessmentAssistantApiKeyConfigured: boolean;
  socialRelationshipAssessmentAssistantConfigured: boolean;
  /** 每日 token 额度，0 = 不限。 */
  dailyTokenLimit: number;
  /** 每次对话注入的记忆 / 快照 token 预算。 */
  memoryTokenBudget: number;
  snapshotTokenBudget: number;
  /** 每次注入多少条长期记忆；默认 20（以前写死 12，比预算更早卡住）。 */
  memoryItemLimit: number;
  /** 每次回复回看多少条已落库消息；桌面端约等于「轮数 × 2」。 */
  recentMessageLimit: number;
  /** 最近几天的忆泡无条件当背景带上；0 = 不带。 */
  eventRecentDays: number;
  /** QQ 渠道回复是否允许附一张表情；默认关。 */
  emojiEnabled: boolean;
  /** 表情额度：多少分钟内最多贴几次（贴图与内置表情共用一个额度，按会话分别算）。 */
  emojiWindowMinutes: number;
  emojiPerWindow: number;
  /** QQ 群里发来的图是否交给视觉模型读；默认关。 */
  imageUnderstanding: boolean;
  /** 群里发来的图是否自动收进她的表情库（「偷表情包」）；默认关。 */
  stickerAutoCollect: boolean;
  /** 群聊之后是否自动扫一遍群里的梗（捡到的先进待确认）；默认关。 */
  catchphraseAutoMine: boolean;
  /** 她的回复能不能发成语音条；默认关。 */
  voiceEnabled: boolean;
  /** 她听不听得懂别人发的语音（自动转写）；默认关。 */
  voiceTranscribe: boolean;
  /** 发语音的概率（0-100），默认 25。 */
  voiceChance: number;
  /** 两条语音之间至少隔多少分钟（0 = 不冷却），默认 20。 */
  voiceCooldownMinutes: number;
  /** 语音服务地址（页面上填的）；空 = 用环境变量或角色聊天地址。 */
  voiceApiBaseUrl: string;
  /** 语音 Key 是否已保存（只回显布尔，绝不回显 Key 本身）。 */
  voiceApiKeyConfigured: boolean;
  /** 语音合成模型 / 音色 / 识别模型；空 = 用环境变量。 */
  ttsModel: string;
  ttsVoice: string;
  asrModel: string;
  /** 语音服务商：openai（含兼容接口）/ minimax / breeze。空 = 按地址自动判断。 */
  ttsProvider: string;
  /** MiniMax 的 GroupId（查询参数）。 */
  ttsGroupId: string;
  /** Breeze 的演技指令；空 = 用环境变量。 */
  ttsInstructions: string;
  /** 语速 0.5–2.0；0 = 用环境变量或默认 1。 */
  ttsSpeed: number;
  /** 识别专用地址；空 = 用环境变量 `VOICE_ASR_BASE_URL` 或语音地址。 */
  asrApiBaseUrl: string;
  /** 识别专用 Key 是否已保存（合成与识别不是同一家时用）。 */
  asrApiKeyConfigured: boolean;
  /** 看图（图片）模型：空 = 回落到环境变量 / 对话模型，所以"没配"是正常状态。 */
  visionModel: string;
  /** 看图服务地址；空 = 用环境变量或角色聊天地址。 */
  visionApiBaseUrl: string;
  /** 看图 Key 是否已保存（只回显布尔，绝不回显 Key 本身）。 */
  visionApiKeyConfigured: boolean;
  /** 主动找话设置；未配置过时是默认值（enabled=false）。 */
  proactive: ProactiveSettings;
  /** 群内「冷场了自己找话题」；未配置过时是默认值（enabled=false）。 */
  groupInitiative: GroupInitiativeSettings;
};

type CharacterRecord = {
  id: string;
  originCharacterId?: string | null;
  name: string;
  avatar: string | null;
  basePrompt: string;
  styleExamples: string;
  userAddress: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  modelConfig: unknown;
  updatedAt: Date;
  memorySetting: {
    snapshotIntervalDays: number;
    /** 已排期但还没到生效边界的周期；旧数据里可能为空。 */
    pendingSnapshotIntervalDays: number | null;
    timezone: string;
    nextSnapshotAt: Date | null;
    autoSnapshotEnabled: boolean;
  } | null;
  channelBindings: Array<{ connection: { displayName: string } }>;
  memoryScopes: Array<{
    _count: { memoryItems: number };
    snapshots: Array<{ createdAt: Date }>;
  }>;
};

export const characterInclude = {
  memorySetting: true,
  channelBindings: { select: { connection: { select: { displayName: true } } } },
  memoryScopes: {
    select: {
      _count: { select: { memoryItems: { where: { status: "ACTIVE" as const } } } },
      snapshots: {
        where: { status: "CURRENT" as const },
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { createdAt: true },
      },
    },
  },
} as const;

function asConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatDate(value: Date, timeZone = "Asia/Shanghai"): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
    }).format(value).replace("/", " 月 ").replace("/", " 日");
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(value);
  }
}

const AVATAR_TONES = ["purple", "peach", "mint", "blue"] as const;

/** 头像配色：优先用角色配置，没有就按名字首字稳定派生，保证同一角色每次颜色一致。 */
export function resolveAvatarTone(name: string, config: Record<string, unknown>): CharacterDto["avatarTone"] {
  const configuredTone = config.avatarTone;
  return AVATAR_TONES.includes(configuredTone as (typeof AVATAR_TONES)[number])
    ? (configuredTone as CharacterDto["avatarTone"])
    : (AVATAR_TONES[name.codePointAt(0)! % AVATAR_TONES.length] ?? "purple");
}

export function toCharacterDto(input: unknown): CharacterDto {
  const character = input as CharacterRecord;
  const config = asConfig(character.modelConfig);
  const chatSettings = resolveChatModelSettings(config);
  const memoryAssistantModel = typeof config.memoryAssistantModel === "string"
    ? config.memoryAssistantModel.trim()
    : "";
  const memoryAssistantApiKeyConfigured = isMemoryAssistantApiKeySaved(config);
  const contextAssistantModel = typeof config.contextAssistantModel === "string"
    ? config.contextAssistantModel.trim()
    : "";
  const contextAssistantApiKeyConfigured = isContextAssistantApiKeySaved(config);
  const knowledgeAssistantModel = typeof config.knowledgeAssistantModel === "string" ? config.knowledgeAssistantModel.trim() : "";
  const knowledgeAssistantApiKeyConfigured = isKnowledgeAssistantApiKeySaved(config);
  const socialRelationshipAssessmentAssistantModel = typeof config.socialRelationshipAssessmentAssistantModel === "string"
    ? config.socialRelationshipAssessmentAssistantModel.trim()
    : "";
  const socialRelationshipAssessmentAssistantApiKeyConfigured = isSocialRelationshipAssessmentAssistantApiKeySaved(config);
  const socialRelationshipAssessmentAssistantApiBaseUrl = typeof config.socialRelationshipAssessmentAssistantApiBaseUrl === "string"
    ? config.socialRelationshipAssessmentAssistantApiBaseUrl
    : "";
  const avatarTone = resolveAvatarTone(character.name, config);
  const setting = character.memorySetting;
  const snapshots = character.memoryScopes.flatMap((scope) => scope.snapshots.map((snapshot) => snapshot.createdAt));
  const latestSnapshot = snapshots.sort((a, b) => b.getTime() - a.getTime())[0];

  let nextSnapshot = "尚未计划";
  if (setting && !setting.autoSnapshotEnabled) {
    nextSnapshot = "已暂停";
  } else if (setting?.nextSnapshotAt) {
    try {
      nextSnapshot = new Intl.DateTimeFormat("zh-CN", {
        timeZone: setting.timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(setting.nextSnapshotAt);
    } catch {
      nextSnapshot = setting.nextSnapshotAt.toISOString();
    }
  }

  const emojiFrequency = resolveEmojiFrequency(config);

  return {
    id: character.id,
    originId: character.originCharacterId ?? character.id,
    name: character.name,
    alias: typeof config.alias === "string" ? config.alias : "自定义角色",
    description: typeof config.description === "string" ? config.description : "",
    avatar: character.avatar || character.name.slice(0, 1),
    avatarTone,
    status: character.status === "ACTIVE" ? "运行中" : character.status === "PAUSED" ? "已暂停" : "未连接",
    channels: character.channelBindings.map((binding) => binding.connection.displayName),
    intervalDays: setting?.snapshotIntervalDays ?? 3,
    pendingIntervalDays: setting?.pendingSnapshotIntervalDays ?? null,
    nextSnapshot,
    memoryCount: character.memoryScopes.reduce((total, scope) => total + scope._count.memoryItems, 0),
    latestSnapshot: latestSnapshot ? formatDate(latestSnapshot, setting?.timezone) : "暂无总结",
    personality: character.basePrompt,
    examples: character.styleExamples ?? "",
    userAddress: character.userAddress ?? "",
    updatedAt: character.updatedAt.toISOString(),
    chatModel: chatSettings.model,
    chatTemperature: chatSettings.temperature,
    chatMaxTokens: chatSettings.maxTokens,
    // 默认开（跟随 DeepSeek 平台默认）；只有显式存过 false 才算关。
    chatThinking: config.chatThinking !== false,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKeyConfigured: chatSettings.apiKeyConfigured,
    chatApiKeySource: chatSettings.apiKeySource,
    memoryAssistantEnabled: config.memoryAssistantEnabled === true,
    memoryAssistantModel,
    memoryAssistantTemperature: typeof config.memoryAssistantTemperature === "number" && Number.isFinite(config.memoryAssistantTemperature) ? Math.min(2, Math.max(0, config.memoryAssistantTemperature)) : 0.1,
    memoryAssistantMaxInputTokens: typeof config.memoryAssistantMaxInputTokens === "number" && Number.isFinite(config.memoryAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.memoryAssistantMaxInputTokens))) : 12_288,
    memoryAssistantMaxOutputTokens: typeof config.memoryAssistantMaxOutputTokens === "number" && Number.isFinite(config.memoryAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.memoryAssistantMaxOutputTokens))) : 2_048,
    memoryAssistantApiBaseUrl: typeof config.memoryAssistantApiBaseUrl === "string"
      ? config.memoryAssistantApiBaseUrl
      : "",
    memoryAssistantApiKeyConfigured,
    memoryAssistantConfigured: Boolean(memoryAssistantModel && memoryAssistantApiKeyConfigured),
    contextAssistantEnabled: config.contextAssistantEnabled === true,
    contextAssistantModel,
    contextAssistantTemperature: typeof config.contextAssistantTemperature === "number" && Number.isFinite(config.contextAssistantTemperature) ? Math.min(2, Math.max(0, config.contextAssistantTemperature)) : 0.1,
    contextAssistantMaxInputTokens: typeof config.contextAssistantMaxInputTokens === "number" && Number.isFinite(config.contextAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.contextAssistantMaxInputTokens))) : 16_384,
    contextAssistantMaxOutputTokens: typeof config.contextAssistantMaxOutputTokens === "number" && Number.isFinite(config.contextAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.contextAssistantMaxOutputTokens))) : 2_048,
    contextAssistantApiBaseUrl: typeof config.contextAssistantApiBaseUrl === "string"
      ? config.contextAssistantApiBaseUrl
      : "",
    contextAssistantApiKeyConfigured,
    contextAssistantConfigured: Boolean(contextAssistantModel && contextAssistantApiKeyConfigured),
    knowledgeAutoCollectEnabled: config.knowledgeAutoCollectEnabled === true,
    knowledgeAssistantEnabled: config.knowledgeAssistantEnabled === true,
    knowledgeAssistantModel,
    knowledgeAssistantTemperature: typeof config.knowledgeAssistantTemperature === "number" && Number.isFinite(config.knowledgeAssistantTemperature) ? Math.min(2, Math.max(0, config.knowledgeAssistantTemperature)) : 0.1,
    knowledgeAssistantMaxInputTokens: typeof config.knowledgeAssistantMaxInputTokens === "number" && Number.isFinite(config.knowledgeAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.knowledgeAssistantMaxInputTokens))) : 12_288,
    knowledgeAssistantMaxOutputTokens: typeof config.knowledgeAssistantMaxOutputTokens === "number" && Number.isFinite(config.knowledgeAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.knowledgeAssistantMaxOutputTokens))) : 2_048,
    knowledgeAssistantApiBaseUrl: typeof config.knowledgeAssistantApiBaseUrl === "string" ? config.knowledgeAssistantApiBaseUrl : "",
    knowledgeAssistantApiKeyConfigured,
    knowledgeAssistantConfigured: Boolean(knowledgeAssistantModel && knowledgeAssistantApiKeyConfigured),
    socialRelationshipAssessmentAssistantEnabled: config.socialRelationshipAssessmentAssistantEnabled === true,
    socialRelationshipAssessmentAssistantModel,
    socialRelationshipAssessmentAssistantTemperature: typeof config.socialRelationshipAssessmentAssistantTemperature === "number" && Number.isFinite(config.socialRelationshipAssessmentAssistantTemperature) ? Math.min(2, Math.max(0, config.socialRelationshipAssessmentAssistantTemperature)) : 0.1,
    socialRelationshipAssessmentAssistantMaxInputTokens: typeof config.socialRelationshipAssessmentAssistantMaxInputTokens === "number" && Number.isFinite(config.socialRelationshipAssessmentAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.socialRelationshipAssessmentAssistantMaxInputTokens))) : 16_384,
    socialRelationshipAssessmentAssistantMaxOutputTokens: typeof config.socialRelationshipAssessmentAssistantMaxOutputTokens === "number" && Number.isFinite(config.socialRelationshipAssessmentAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.socialRelationshipAssessmentAssistantMaxOutputTokens))) : 2_048,
    socialRelationshipAssessmentAssistantApiBaseUrl,
    socialRelationshipAssessmentAssistantApiKeyConfigured,
    socialRelationshipAssessmentAssistantConfigured: Boolean(socialRelationshipAssessmentAssistantModel && socialRelationshipAssessmentAssistantApiBaseUrl && socialRelationshipAssessmentAssistantApiKeyConfigured),
    dailyTokenLimit: positiveNumber(config.dailyTokenLimit),
    memoryTokenBudget: positiveNumber(config.memoryTokenBudget) || MEMORY_TOKEN_BUDGET_DEFAULT,
    snapshotTokenBudget: positiveNumber(config.snapshotTokenBudget) || SNAPSHOT_TOKEN_BUDGET_DEFAULT,
    memoryItemLimit: resolveMemoryItemLimit(config),
    recentMessageLimit: resolveRecentMessageLimit(config),
    // 0 = 不带近期忆泡。读的时候也补默认值，页面不用猜「没填是多少」。
    eventRecentDays: resolveEventRecentDays(config),
    emojiEnabled: config.emojiEnabled === true,
    // 额度读的时候就把默认值补齐，页面不用再猜「没填是多少」。
    emojiWindowMinutes: emojiFrequency.windowMinutes,
    emojiPerWindow: emojiFrequency.perWindow,
    imageUnderstanding: config.imageUnderstanding === true,
    stickerAutoCollect: config.stickerAutoCollect === true,
    catchphraseAutoMine: config.catchphraseAutoMine === true,
    voiceEnabled: config.voiceEnabled === true,
    voiceTranscribe: config.voiceTranscribe === true,
    voiceChance: resolveVoiceChance(config),
    voiceCooldownMinutes: resolveVoiceCooldownMinutes(config),
    voiceApiBaseUrl: typeof config.voiceApiBaseUrl === "string" ? config.voiceApiBaseUrl : "",
    voiceApiKeyConfigured: isVoiceApiKeySaved(config),
    ttsModel: typeof config.ttsModel === "string" ? config.ttsModel : "",
    ttsVoice: typeof config.ttsVoice === "string" ? config.ttsVoice : "",
    asrModel: typeof config.asrModel === "string" ? config.asrModel : "",
    ttsProvider: typeof config.ttsProvider === "string" ? config.ttsProvider : "",
    ttsGroupId: typeof config.ttsGroupId === "string" ? config.ttsGroupId : "",
    ttsInstructions: typeof config.ttsInstructions === "string" ? config.ttsInstructions : "",
    ttsSpeed: typeof config.ttsSpeed === "number" ? config.ttsSpeed : 0,
    asrApiBaseUrl: typeof config.asrApiBaseUrl === "string" ? config.asrApiBaseUrl : "",
    asrApiKeyConfigured: isAsrApiKeySaved(config),
    visionModel: typeof config.visionModel === "string" ? config.visionModel : "",
    visionApiBaseUrl: typeof config.visionApiBaseUrl === "string" ? config.visionApiBaseUrl : "",
    visionApiKeyConfigured: isVisionApiKeySaved(config),
    proactive: resolveProactiveSettings(config),
    groupInitiative: resolveGroupInitiativeSettings(config),
  };
}
