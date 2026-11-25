import { MODEL_PURPOSE_DEFAULTS } from "../../shared/utils/model-purpose-defaults";
import { resolveSocialAssessmentOutputBudget } from "./social-assessment-budget";
import { resolveChatModelSettings } from "./chat-model-config";
import { resolveEmojiFrequency } from "./emoji-frequency";
import { MEMORY_TOKEN_BUDGET_DEFAULT, SNAPSHOT_TOKEN_BUDGET_DEFAULT, resolveMemoryItemLimit, resolveRecentMessageLimit } from "./memory-retrieval";
import { resolveEventRecentDays } from "./memory-event-retrieval";
import { resolveProactiveSettings } from "./proactive-settings";
import type { GroupInitiativeSettings, ProactiveSettings } from "../../shared/types/character";
import { resolveGroupInitiativeSettings } from "./group-initiative-settings";
import { API_KEY_FIELDS, isAsrApiKeySaved, isContextAssistantApiKeySaved, isImageApiKeySaved, isKnowledgeAssistantApiKeySaved, isMemoryAssistantApiKeySaved, isSocialRelationshipAssessmentAssistantApiKeySaved, isVisionApiKeySaved, isVoiceApiKeySaved, readApiKeyFieldPlain } from "./credential-encryption";
import { ASSISTANT_FIELDS, summarizeAssistantConnection } from "./assistant-inheritance";
import { readKnowledgeCollectScope } from "./knowledge-collect-policy";
import { resolveVoiceChance, resolveVoiceCooldownMinutes } from "./voice";
import { resolveImageChance, resolveImageCooldownMinutes, resolveImageDailyLimit, resolveImageSizePreset } from "./image-generation";
import { resolveLocalImageQuality, readImageProfiles } from "../../shared/utils/local-image-engine";

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**

 * 角色的 API 形状 = 共享契约（`shared/types/character.ts` 的 `Character`）。
 *
 * 保留 `CharacterDto` 这个名字：服务端一圈调用方都这么写，改成 `Character` 只是噪音。
 * 字段定义只在 shared 里维护一份 —— 以前它躺在这里，前端又抄了一份「全可选」的版本，
 * 于是「列表和详情字段不一样」这种说法被当成事实传了下去。
 */
export type CharacterDto = Character;

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
  /**
   * 助手的「可用性」不再看有没有独立配置，而是看解析后的连接够不够跑：
   * 模型名可以继承对话模型，Key 在地址一致时也可以继承（见 assistant-inheritance）。
   * DTO 只回「自己填了什么」+「最终能不能用」，UI 拿这两个就能显示「跟随对话模型」。
   */
  const memoryAssistant = summarizeAssistantConnection(config, ASSISTANT_FIELDS.memory, chatSettings);
  const contextAssistant = summarizeAssistantConnection(config, ASSISTANT_FIELDS.context, chatSettings);
  const knowledgeAssistant = summarizeAssistantConnection(config, ASSISTANT_FIELDS.knowledge, chatSettings);
  const socialAssistant = summarizeAssistantConnection(config, ASSISTANT_FIELDS.socialAssessment, chatSettings);

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
    chatApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.chat),
    chatApiKeyConfigured: chatSettings.apiKeyConfigured,
    chatApiKeySource: chatSettings.apiKeySource,
    // 默认开启：没存过就是开着的，只有显式关过才算关。
    memoryAssistantEnabled: config.memoryAssistantEnabled !== false,
    memoryAssistantModel,
    memoryAssistantTemperature: typeof config.memoryAssistantTemperature === "number" && Number.isFinite(config.memoryAssistantTemperature) ? Math.min(2, Math.max(0, config.memoryAssistantTemperature)) : MODEL_PURPOSE_DEFAULTS.memory.temperature,
    memoryAssistantMaxInputTokens: typeof config.memoryAssistantMaxInputTokens === "number" && Number.isFinite(config.memoryAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.memoryAssistantMaxInputTokens))) : MODEL_PURPOSE_DEFAULTS.memory.maxInputTokens,
    memoryAssistantMaxOutputTokens: typeof config.memoryAssistantMaxOutputTokens === "number" && Number.isFinite(config.memoryAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.memoryAssistantMaxOutputTokens))) : MODEL_PURPOSE_DEFAULTS.memory.maxOutputTokens,
    memoryAssistantApiBaseUrl: typeof config.memoryAssistantApiBaseUrl === "string"
      ? config.memoryAssistantApiBaseUrl
      : "",
    memoryAssistantApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.memoryAssistant),
    memoryAssistantApiKeyConfigured,
    memoryAssistantConfigured: Boolean(memoryAssistant.model && memoryAssistant.hasApiKey),
    contextAssistantEnabled: config.contextAssistantEnabled !== false,
    contextAssistantModel,
    contextAssistantTemperature: typeof config.contextAssistantTemperature === "number" && Number.isFinite(config.contextAssistantTemperature) ? Math.min(2, Math.max(0, config.contextAssistantTemperature)) : MODEL_PURPOSE_DEFAULTS.context.temperature,
    contextAssistantMaxInputTokens: typeof config.contextAssistantMaxInputTokens === "number" && Number.isFinite(config.contextAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.contextAssistantMaxInputTokens))) : MODEL_PURPOSE_DEFAULTS.context.maxInputTokens,
    contextAssistantMaxOutputTokens: typeof config.contextAssistantMaxOutputTokens === "number" && Number.isFinite(config.contextAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.contextAssistantMaxOutputTokens))) : MODEL_PURPOSE_DEFAULTS.context.maxOutputTokens,
    contextAssistantApiBaseUrl: typeof config.contextAssistantApiBaseUrl === "string"
      ? config.contextAssistantApiBaseUrl
      : "",
    contextAssistantApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.contextAssistant),
    contextAssistantApiKeyConfigured,
    contextAssistantConfigured: Boolean(contextAssistant.model && contextAssistant.hasApiKey),
    knowledgeAutoCollectEnabled: config.knowledgeAutoCollectEnabled === true,
    knowledgeCollectScope: readKnowledgeCollectScope(config),
    knowledgeAssistantEnabled: config.knowledgeAssistantEnabled !== false,
    knowledgeAssistantModel,
    knowledgeAssistantTemperature: typeof config.knowledgeAssistantTemperature === "number" && Number.isFinite(config.knowledgeAssistantTemperature) ? Math.min(2, Math.max(0, config.knowledgeAssistantTemperature)) : MODEL_PURPOSE_DEFAULTS.knowledge.temperature,
    knowledgeAssistantMaxInputTokens: typeof config.knowledgeAssistantMaxInputTokens === "number" && Number.isFinite(config.knowledgeAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.knowledgeAssistantMaxInputTokens))) : MODEL_PURPOSE_DEFAULTS.knowledge.maxInputTokens,
    knowledgeAssistantMaxOutputTokens: typeof config.knowledgeAssistantMaxOutputTokens === "number" && Number.isFinite(config.knowledgeAssistantMaxOutputTokens) ? Math.round(Math.min(8_192, Math.max(512, config.knowledgeAssistantMaxOutputTokens))) : MODEL_PURPOSE_DEFAULTS.knowledge.maxOutputTokens,
    knowledgeAssistantApiBaseUrl: typeof config.knowledgeAssistantApiBaseUrl === "string" ? config.knowledgeAssistantApiBaseUrl : "",
    knowledgeAssistantApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.knowledgeAssistant),
    knowledgeAssistantApiKeyConfigured,
    knowledgeAssistantConfigured: Boolean(knowledgeAssistant.model && knowledgeAssistant.hasApiKey),
    socialRelationshipAssessmentAssistantEnabled: config.socialRelationshipAssessmentAssistantEnabled !== false,
    socialRelationshipAssessmentAssistantModel,
    socialRelationshipAssessmentAssistantTemperature: typeof config.socialRelationshipAssessmentAssistantTemperature === "number" && Number.isFinite(config.socialRelationshipAssessmentAssistantTemperature) ? Math.min(2, Math.max(0, config.socialRelationshipAssessmentAssistantTemperature)) : MODEL_PURPOSE_DEFAULTS.social.temperature,
    socialRelationshipAssessmentAssistantMaxInputTokens: typeof config.socialRelationshipAssessmentAssistantMaxInputTokens === "number" && Number.isFinite(config.socialRelationshipAssessmentAssistantMaxInputTokens) ? Math.round(Math.min(32_768, Math.max(4_096, config.socialRelationshipAssessmentAssistantMaxInputTokens))) : MODEL_PURPOSE_DEFAULTS.social.maxInputTokens,
    socialRelationshipAssessmentAssistantMaxOutputTokens: resolveSocialAssessmentOutputBudget(config.socialRelationshipAssessmentAssistantMaxOutputTokens),
    socialRelationshipAssessmentAssistantApiBaseUrl,
    socialRelationshipAssessmentAssistantApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.socialRelationshipAssessmentAssistant),
    socialRelationshipAssessmentAssistantApiKeyConfigured,
    socialRelationshipAssessmentAssistantConfigured: Boolean(socialAssistant.model && socialAssistant.hasApiKey),
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
    voiceApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.voice),
    voiceApiKeyConfigured: isVoiceApiKeySaved(config),
    ttsModel: typeof config.ttsModel === "string" ? config.ttsModel : "",
    ttsVoice: typeof config.ttsVoice === "string" ? config.ttsVoice : "",
    asrModel: typeof config.asrModel === "string" ? config.asrModel : "",
    // 识别服务商：`[id].patch.ts` 一直能写进 modelConfig，但这里以前没回，
    // 于是页面回显永远退回「自动」—— 用户改过也看不出来。补上这一行才算闭环。
    asrProvider: typeof config.asrProvider === "string" ? config.asrProvider : "",
    ttsProvider: typeof config.ttsProvider === "string" ? config.ttsProvider : "",
    ttsGroupId: typeof config.ttsGroupId === "string" ? config.ttsGroupId : "",
    ttsInstructions: typeof config.ttsInstructions === "string" ? config.ttsInstructions : "",
    ttsSpeed: typeof config.ttsSpeed === "number" ? config.ttsSpeed : 0,
    asrApiBaseUrl: typeof config.asrApiBaseUrl === "string" ? config.asrApiBaseUrl : "",
    asrApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.asr),
    asrApiKeyConfigured: isAsrApiKeySaved(config),
    visionModel: typeof config.visionModel === "string" ? config.visionModel : "",
    visionApiBaseUrl: typeof config.visionApiBaseUrl === "string" ? config.visionApiBaseUrl : "",
    visionApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.vision),
    visionApiKeyConfigured: isVisionApiKeySaved(config),
    imageEnabled: config.imageEnabled === true,
    imageChance: resolveImageChance(config),
    imageCooldownMinutes: resolveImageCooldownMinutes(config),
    imageDailyLimit: resolveImageDailyLimit(config),
    imageModel: typeof config.imageModel === "string" ? config.imageModel : "",
    imageApiBaseUrl: typeof config.imageApiBaseUrl === "string" ? config.imageApiBaseUrl : "",
    imageApiKey: readApiKeyFieldPlain(config, API_KEY_FIELDS.image),
    imageApiKeyConfigured: isImageApiKeySaved(config),
    imageProvider: typeof config.imageProvider === "string" ? config.imageProvider : "",
    imageSize: resolveImageSizePreset(config),
    imageQuality: resolveLocalImageQuality(config.imageQuality),
    imagePreset: config.imagePreset === "moss" || config.imagePreset === "anima" ? config.imagePreset : "auto",
    imageProfiles: (() => { try { return readImageProfiles(config.imageProfiles ?? []); } catch { return []; } })(),
    imageActiveProfileId: typeof config.imageActiveProfileId === "string" ? config.imageActiveProfileId : "",
    proactive: resolveProactiveSettings(config),
    groupInitiative: resolveGroupInitiativeSettings(config),
  };
}
