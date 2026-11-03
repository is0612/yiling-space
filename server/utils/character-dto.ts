import { resolveChatModelSettings } from "./chat-model-config";
import { resolveEmojiFrequency } from "./emoji-frequency";
import { MEMORY_TOKEN_BUDGET_DEFAULT, SNAPSHOT_TOKEN_BUDGET_DEFAULT, resolveMemoryItemLimit, resolveRecentMessageLimit } from "./memory-retrieval";
import { resolveEventRecentDays } from "./memory-event-retrieval";
import { resolveProactiveSettings, type ProactiveSettings } from "./proactive-settings";
import { resolveGroupInitiativeSettings, type GroupInitiativeSettings } from "./group-initiative-settings";
import { isVisionApiKeySaved, isVoiceApiKeySaved } from "./credential-encryption";
import { resolveVoiceChance, resolveVoiceCooldownMinutes } from "./voice";

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export type CharacterDto = {
  id: string;
  /**
   * 血缘 id：这个角色最初来自哪一份角色数据。
   * 导入角色卡时用它认出「本机已有同一个她」，所以合并判断在前端就能做；
   * 空 = 本机原生角色（导出时才第一次确定）。
   */
  originId: string | null;
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
  /** 语音服务商：openai（含兼容接口）/ minimax。空 = 按地址自动判断。 */
  ttsProvider: string;
  /** MiniMax 的 GroupId（查询参数）。 */
  ttsGroupId: string;
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
    memoryItems: Array<{ id: string }>;
    snapshots: Array<{ createdAt: Date }>;
  }>;
};

export const characterInclude = {
  memorySetting: true,
  channelBindings: { include: { connection: { select: { displayName: true } } } },
  memoryScopes: {
    include: {
      memoryItems: { where: { status: "ACTIVE" as const }, select: { id: true } },
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
    originId: character.originCharacterId ?? null,
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
    memoryCount: character.memoryScopes.reduce((total, scope) => total + scope.memoryItems.length, 0),
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
    visionModel: typeof config.visionModel === "string" ? config.visionModel : "",
    visionApiBaseUrl: typeof config.visionApiBaseUrl === "string" ? config.visionApiBaseUrl : "",
    visionApiKeyConfigured: isVisionApiKeySaved(config),
    proactive: resolveProactiveSettings(config),
    groupInitiative: resolveGroupInitiativeSettings(config),
  };
}
