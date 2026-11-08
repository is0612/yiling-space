import { createError, readBody } from "h3";
import type { Prisma } from "../../../src/generated/prisma/client";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readCharacterBody, readCharacterProfilePatch } from "../../utils/character-profile-input";
import { readChatModelSettingsPatch, validateChatApiBaseUrl } from "../../utils/chat-model-config";
import { encryptApiKey, resolveCharacterVoiceApiKey } from "../../utils/credential-encryption";
import { readContextAssistantSettingsPatch, validateContextAssistantEnabledConfig } from "../../utils/context-assistant-config";
import { readKnowledgeAssistantSettingsPatch, validateKnowledgeAssistantEnabledConfig } from "../../utils/knowledge-assistant-config";
import { readSocialRelationshipAssessmentAssistantSettingsPatch, validateSocialRelationshipAssessmentAssistantEnabledConfig } from "../../utils/social-relationship-assessment-config";
import { requireActorUserId } from "../../utils/auth";
import { readTrimmedString, requireUuid } from "../../utils/local-api";
import { MEMORY_ITEM_LIMIT_MAX, MEMORY_ITEM_LIMIT_MIN, RECENT_MESSAGE_LIMIT_MAX, RECENT_MESSAGE_LIMIT_MIN } from "../../utils/memory-retrieval";
import { getPrisma } from "../../utils/prisma";
import { readProactivePatch, resolveProactiveSettings } from "../../utils/proactive-settings";
import { readGroupInitiativePatch, resolveGroupInitiativeSettings } from "../../utils/group-initiative-settings";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const body = readCharacterBody(await readBody<unknown>(event));
  const prisma = getPrisma();
  const existing = await prisma.character.findFirst({ where: { id, ownerId } });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const config = existing.modelConfig && typeof existing.modelConfig === "object" && !Array.isArray(existing.modelConfig)
    ? existing.modelConfig as Record<string, unknown>
    : {};
  const profile = readCharacterProfilePatch(body);
  const data: Prisma.CharacterUpdateInput = { ...profile.data };

  if (body.status !== undefined) {
    const statusMap: Record<string, "ACTIVE" | "PAUSED" | "ARCHIVED"> = {
      "运行中": "ACTIVE", "已暂停": "PAUSED", "未连接": "ARCHIVED",
    };
    if (typeof body.status !== "string" || !statusMap[body.status]) {
      throw createError({ statusCode: 400, statusMessage: "无效的角色状态。" });
    }
    data.status = statusMap[body.status];
  }

  let contextAssistantPatch;
  try {
    contextAssistantPatch = readContextAssistantSettingsPatch(body);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "语境助手配置无效。" });
  }
  let knowledgeAssistantPatch;
  try {
    knowledgeAssistantPatch = readKnowledgeAssistantSettingsPatch(body);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "知识处理助手配置无效。" });
  }
  let socialRelationshipAssessmentAssistantPatch;
  try {
    socialRelationshipAssessmentAssistantPatch = readSocialRelationshipAssessmentAssistantSettingsPatch(body);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "关系评估助手配置无效。" });
  }
  const modelConfigPatch: Record<string, unknown> = {
    ...profile.modelConfig,
    ...contextAssistantPatch.config,
    ...knowledgeAssistantPatch.config,
    ...socialRelationshipAssessmentAssistantPatch.config,
  };
  /** 语音 Key 的明文只在这里短暂停留，落库前一定加密；不写日志、不回显。 */
  let voiceApiKeyPlain = "";
  let clearVoiceApiKey = false;
  /** 识别专用 Key：合成与识别不是同一家时用，留空则回落到共用的语音 Key。 */
  let asrApiKeyPlain = "";
  let clearAsrApiKey = false;
  /** 页面点过「同语音合成」：服务端把合成那把 Key 复制到识别（Key 不经过浏览器）。 */
  let syncAsrFromVoice = false;
  /** 图片（看图）模型的 Key：与语音同理，几乎必然是另一家服务商，单独一把。 */
  let visionApiKeyPlain = "";
  let clearVisionApiKey = false;
  /** 记忆助手的 Key 与主聊天模型独立保存，不能互相回落。 */
  let memoryAssistantApiKeyPlain = "";
  let clearMemoryAssistantApiKey = false;
  /** 关系评估助手专用 Key：只在服务端短暂接收明文，落库前加密。 */
  const socialRelationshipAssessmentAssistantApiKeyPlain = socialRelationshipAssessmentAssistantPatch.apiKey;
  const clearSocialRelationshipAssessmentAssistantApiKey = socialRelationshipAssessmentAssistantPatch.clearApiKey;

  if (body.memoryAssistantModel !== undefined) {
    modelConfigPatch.memoryAssistantModel = readTrimmedString(body.memoryAssistantModel, "记忆助手模型名称", 120);
  }
  if (body.memoryAssistantApiBaseUrl !== undefined) {
    if (typeof body.memoryAssistantApiBaseUrl !== "string") {
      throw createError({ statusCode: 400, statusMessage: "记忆助手 API 地址必须是文本。" });
    }
    try {
      const value = body.memoryAssistantApiBaseUrl.trim();
      modelConfigPatch.memoryAssistantApiBaseUrl = value ? validateChatApiBaseUrl(value) : "";
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error ? error.message : "记忆助手 API 地址无效。",
      });
    }
  }
  if (body.memoryAssistantApiKey !== undefined) {
    if (typeof body.memoryAssistantApiKey !== "string") {
      throw createError({ statusCode: 400, statusMessage: "记忆助手 API Key 必须是文本。" });
    }
    const key = body.memoryAssistantApiKey.trim();
    if (key.length > 8192) throw createError({ statusCode: 400, statusMessage: "记忆助手 API Key 不能超过 8192 个字符。" });
    if (key) memoryAssistantApiKeyPlain = key;
  }
  if (body.clearMemoryAssistantApiKey !== undefined) {
    if (typeof body.clearMemoryAssistantApiKey !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "清除记忆助手 API Key 的参数无效。" });
    }
    clearMemoryAssistantApiKey = body.clearMemoryAssistantApiKey;
  }
  if (body.memoryAssistantEnabled !== undefined) {
    if (typeof body.memoryAssistantEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "记忆助手开关必须是布尔值。" });
    }
    modelConfigPatch.memoryAssistantEnabled = body.memoryAssistantEnabled;
  }
  const memoryAssistantNumericSettings: Array<[string, string, number, number, boolean]> = [
    ["memoryAssistantTemperature", "记忆助手温度", 0, 2, false],
    ["memoryAssistantMaxInputTokens", "记忆助手最大输入 Token", 4_096, 32_768, true],
    ["memoryAssistantMaxOutputTokens", "记忆助手最大输出 Token", 512, 8_192, true],
  ];
  for (const [key, label, min, max, integerOnly] of memoryAssistantNumericSettings) {
    if (body[key] === undefined) continue;
    const value = typeof body[key] === "number" ? body[key] as number : Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integerOnly && !Number.isInteger(value))) {
      throw createError({ statusCode: 400, statusMessage: `${label}必须是 ${min} 到 ${max} 之间${integerOnly ? "的整数" : "的数字"}。` });
    }
    modelConfigPatch[key] = value;
  }

  // 额度与预算都是 0 = 不限（预算则回落到默认值），所以允许 0。
  const numericLimits: Array<[string, string, number]> = [
    ["dailyTokenLimit", "每日 token 额度", 100_000_000],
    ["memoryTokenBudget", "记忆 token 预算", 20_000],
    ["snapshotTokenBudget", "快照 token 预算", 20_000],
    // 近期忆泡：0 = 不带（默认），上限和 resolveEventRecentDays 的夹取保持一致。
    ["eventRecentDays", "近期忆泡天数", 14],
  ];
  for (const [key, label, max] of numericLimits) {
    const raw = body[key];
    if (raw === undefined) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw createError({ statusCode: 400, statusMessage: `${label}必须是 0 到 ${max} 之间的数字。` });
    }
    modelConfigPatch[key] = Math.round(value);
  }

  // 最近对话条数：0 不代表「不限」，所以不能塞进上面那个 0 起的循环。
  if (body.recentMessageLimit !== undefined) {
    const value = typeof body.recentMessageLimit === "number" ? body.recentMessageLimit : Number(body.recentMessageLimit);
    if (!Number.isInteger(value) || value < RECENT_MESSAGE_LIMIT_MIN || value > RECENT_MESSAGE_LIMIT_MAX) {
      throw createError({
        statusCode: 400,
        statusMessage: `最近对话条数必须是 ${RECENT_MESSAGE_LIMIT_MIN} 到 ${RECENT_MESSAGE_LIMIT_MAX} 之间的整数。`,
      });
    }
    modelConfigPatch.recentMessageLimit = value;
  }

  // 记忆条数上限：跟回看条数一样，0 不代表「不限」，所以不能塞进上面那个 0 起的循环。
  // 这一项以前只有读、没有写入口 —— 页面上调预算却不见多记，就是因为 12 条先卡住了。
  if (body.memoryItemLimit !== undefined) {
    const value = typeof body.memoryItemLimit === "number" ? body.memoryItemLimit : Number(body.memoryItemLimit);
    if (!Number.isInteger(value) || value < MEMORY_ITEM_LIMIT_MIN || value > MEMORY_ITEM_LIMIT_MAX) {
      throw createError({
        statusCode: 400,
        statusMessage: `记忆条数上限必须是 ${MEMORY_ITEM_LIMIT_MIN} 到 ${MEMORY_ITEM_LIMIT_MAX} 之间的整数。`,
      });
    }
    modelConfigPatch.memoryItemLimit = value;
  }

  if (body.emojiEnabled !== undefined) {
    if (typeof body.emojiEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "表情开关必须是布尔值。" });
    }
    modelConfigPatch.emojiEnabled = body.emojiEnabled;
  }

  // 表情额度：「每 N 分钟最多 N 张」。贴图与内置表情共用，按会话分别算。
  // 不设 0 —— 「一张都不许发」应该去关开关，而不是把额度设成 0（那样页面上还开着，只是永远发不出来）。
  const emojiLimits: Array<[string, string, number]> = [
    ["emojiWindowMinutes", "表情额度的分钟数", 1440],
    ["emojiPerWindow", "表情额度里的张数", 20],
  ];
  for (const [key, label, max] of emojiLimits) {
    const raw = body[key];
    if (raw === undefined) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > max) {
      throw createError({ statusCode: 400, statusMessage: `${label}必须是 1 到 ${max} 之间的数字。` });
    }
    modelConfigPatch[key] = Math.round(value);
  }

  // 看图开关：和表情开关一样是角色级，只影响 QQ 渠道的被动回复。
  if (body.imageUnderstanding !== undefined) {
    if (typeof body.imageUnderstanding !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "看图开关必须是布尔值。" });
    }
    modelConfigPatch.imageUnderstanding = body.imageUnderstanding;
  }

  // 偷表情包开关：群里发来的图自动收进她的表情库。角色级，默认关。
  if (body.stickerAutoCollect !== undefined) {
    if (typeof body.stickerAutoCollect !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "偷表情包开关必须是布尔值。" });
    }
    modelConfigPatch.stickerAutoCollect = body.stickerAutoCollect;
  }

  // 自动捡梗：群聊回复之后顺手扫一次，捡到的先进待确认。默认关 ——
  // 它会在用户不知情时花一次模型调用，得让人自己打开。
  if (body.catchphraseAutoMine !== undefined) {
    if (typeof body.catchphraseAutoMine !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "自动捡梗开关必须是布尔值。" });
    }
    modelConfigPatch.catchphraseAutoMine = body.catchphraseAutoMine;
  }

  // 语音是两个独立开关：她「能不能说」和「听不听得懂」是两件事，
  // 合成按字符计费、转写按秒计费，合在一起关不掉其中一半。
  if (body.voiceEnabled !== undefined) {
    if (typeof body.voiceEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "语音回复开关必须是布尔值。" });
    }
    modelConfigPatch.voiceEnabled = body.voiceEnabled;
  }

  if (body.voiceTranscribe !== undefined) {
    if (typeof body.voiceTranscribe !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "听懂语音开关必须是布尔值。" });
    }
    modelConfigPatch.voiceTranscribe = body.voiceTranscribe;
  }

  // 发语音的概率：0 = 从不在文字外发语音，100 = 只要是短回复就发。
  if (body.voiceChance !== undefined) {
    const value = typeof body.voiceChance === "number" ? body.voiceChance : Number(body.voiceChance);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw createError({ statusCode: 400, statusMessage: "语音概率必须是 0 到 100 之间的数字。" });
    }
    modelConfigPatch.voiceChance = Math.round(value);
  }

  // 两条语音之间至少隔多少分钟：0 = 不冷却。上限一天，再长等于永久关掉。
  if (body.voiceCooldownMinutes !== undefined) {
    const value = typeof body.voiceCooldownMinutes === "number"
      ? body.voiceCooldownMinutes
      : Number(body.voiceCooldownMinutes);
    if (!Number.isFinite(value) || value < 0 || value > 1440) {
      throw createError({ statusCode: 400, statusMessage: "语音冷却必须是 0 到 1440 分钟之间的数字。" });
    }
    modelConfigPatch.voiceCooldownMinutes = Math.round(value);
  }

  // 语音服务商：地址与模型名都可以在页面上填，不必去改 .env。
  // 空字符串是有效值（= 回落到环境变量 / 角色的聊天地址），所以这里不做「非空」校验。
  for (const [key, label, max] of [
    ["ttsModel", "语音合成模型", 120],
    ["ttsVoice", "语音音色", 100],
    ["asrModel", "语音识别模型", 120],
    // MiniMax 的 GroupId：查询参数，不是密钥但也不是能随便公开的东西。
    ["ttsGroupId", "语音服务 GroupId", 100],
    // Breeze 的演技指令（"声音软软的、带一点气声"），一句话的长度足够。
    ["ttsInstructions", "语音语气指令", 400],
  ] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") {
      throw createError({ statusCode: 400, statusMessage: `${label}必须是文本。` });
    }
    const value = (body[key] as string).trim();
    if (value.length > max) {
      throw createError({ statusCode: 400, statusMessage: `${label}不能超过 ${max} 个字符。` });
    }
    modelConfigPatch[key] = value;
  }

  /**
   * 语音服务商。空字符串 = 自动判断（看地址里有没有 minimax），
   * 显式写了就必须是认得的那两个 —— 写错了会静默走另一家的协议，报错信息会非常难懂。
   */
  /**
   * 语速。0.5–2.0，缺省 1。
   *
   * 必须能在页面上调：MiniMax 的默认音色本身偏慢，想快一点过去只能改 .env 再重启适配器，
   * 而「重启」这一步在页面上完全没有提示。
   */
  if (body.ttsSpeed !== undefined) {
    const value = typeof body.ttsSpeed === "number" ? body.ttsSpeed : Number(body.ttsSpeed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw createError({ statusCode: 400, statusMessage: "语音语速必须是 0.5 到 2 之间的数字。" });
    }
    modelConfigPatch.ttsSpeed = Math.round(value * 100) / 100;
  }

  /**
   * 语速。0.5–2.0，缺省 1。
   *
   * 必须能在页面上调：MiniMax 的默认音色本身偏慢，想快一点过去只能改 .env 再重启适配器，
   * 而「重启」这一步在页面上完全没有提示。
   */
  if (body.ttsSpeed !== undefined) {
    const value = typeof body.ttsSpeed === "number" ? body.ttsSpeed : Number(body.ttsSpeed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw createError({ statusCode: 400, statusMessage: "语音语速必须是 0.5 到 2 之间的数字。" });
    }
    modelConfigPatch.ttsSpeed = Math.round(value * 100) / 100;
  }

  if (body.ttsProvider !== undefined) {
    if (typeof body.ttsProvider !== "string") {
      throw createError({ statusCode: 400, statusMessage: "语音服务商必须是文本。" });
    }
    const value = body.ttsProvider.trim();
    if (value && value !== "openai" && value !== "minimax" && value !== "breeze") {
      throw createError({
        statusCode: 400,
        statusMessage: "语音服务商只支持 openai（含兼容接口）、minimax 或 breeze。",
      });
    }
    modelConfigPatch.ttsProvider = value;
  }

  if (body.voiceApiBaseUrl !== undefined) {
    if (typeof body.voiceApiBaseUrl !== "string") {
      throw createError({ statusCode: 400, statusMessage: "语音服务地址必须是文本。" });
    }
    try {
      modelConfigPatch.voiceApiBaseUrl = body.voiceApiBaseUrl.trim()
        ? validateChatApiBaseUrl(body.voiceApiBaseUrl)
        : "";
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error ? error.message : "语音服务地址无效。",
      });
    }
  }

  if (body.voiceApiKey !== undefined) {
    if (typeof body.voiceApiKey !== "string") {
      throw createError({ statusCode: 400, statusMessage: "语音服务的 API Key 必须是文本。" });
    }
    const key = body.voiceApiKey.trim();
    if (key.length > 8192) throw createError({ statusCode: 400, statusMessage: "API Key 不能超过 8192 个字符。" });
    if (key) voiceApiKeyPlain = key;
  }

  if (body.clearVoiceApiKey !== undefined) {
    if (typeof body.clearVoiceApiKey !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "清除语音 API Key 的参数无效。" });
    }
    clearVoiceApiKey = body.clearVoiceApiKey;
  }

  if (body.asrProvider !== undefined) {
    if (typeof body.asrProvider !== "string") {
      throw createError({ statusCode: 400, statusMessage: "识别服务商必须是文本。" });
    }
    const value = body.asrProvider.trim();
    // Breeze 只做合成，没有识别端点，所以这里不收它。
    if (value && value !== "openai" && value !== "minimax") {
      throw createError({
        statusCode: 400,
        statusMessage: "识别服务商只支持 openai（含兼容接口）或 minimax。",
      });
    }
    modelConfigPatch.asrProvider = value;
  }

  /**
   * 识别（ASR）单独一份。合成与识别不是同一家时必须能分开填：
   * Breeze 只做合成，把这把 Key 喂给识别服务商只会 401，而报错只写「鉴权失败」。
   * 留空 = 回落到共用的语音 Key（一家全包时的老行为）。
   */
  if (body.asrApiBaseUrl !== undefined) {
    if (typeof body.asrApiBaseUrl !== "string") {
      throw createError({ statusCode: 400, statusMessage: "识别服务地址必须是文本。" });
    }
    try {
      modelConfigPatch.asrApiBaseUrl = body.asrApiBaseUrl.trim()
        ? validateChatApiBaseUrl(body.asrApiBaseUrl)
        : "";
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error ? error.message : "识别服务地址无效。",
      });
    }
  }

  if (body.asrApiKey !== undefined) {
    if (typeof body.asrApiKey !== "string") {
      throw createError({ statusCode: 400, statusMessage: "识别服务的 API Key 必须是文本。" });
    }
    const key = body.asrApiKey.trim();
    if (key.length > 8192) throw createError({ statusCode: 400, statusMessage: "API Key 不能超过 8192 个字符。" });
    if (key) asrApiKeyPlain = key;
  }

  if (body.clearAsrApiKey !== undefined) {
    if (typeof body.clearAsrApiKey !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "清除识别 API Key 的参数无效。" });
    }
    clearAsrApiKey = body.clearAsrApiKey;
  }

  /**
   * 页面上的「同语音合成」：把合成的 Key 在服务端复制一份给识别。
   *
   * Key 明文不回传浏览器，所以复制只能在这里做 —— 前端只送一个开关，
   * 拿不到也传不了 Key。复制过去之后识别就是独立一把，用户改合成那把不会连带影响识别。
   */
  if (body.syncAsrFromVoice !== undefined) {
    if (typeof body.syncAsrFromVoice !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "同步识别 Key 的参数无效。" });
    }
    syncAsrFromVoice = body.syncAsrFromVoice;
  }

  /**
   * 图片模型：看图（以及以后的生图）用的服务商。
   *
   * 为什么必须能单独填 Key：视觉模型几乎必然不是聊天那一家
   * （DeepSeek 没有视觉接口，gpt-4o-mini 那种“能看但会烧光思考预算”只是兜底），
   * 拿聊天 Key 去打别家地址只会 401，而且错误信息完全指不到这里。
   */
  if (body.visionModel !== undefined) {
    if (typeof body.visionModel !== "string") {
      throw createError({ statusCode: 400, statusMessage: "看图模型的名称必须是文本。" });
    }
    const value = body.visionModel.trim();
    if (value.length > 120) throw createError({ statusCode: 400, statusMessage: "看图模型名称不能超过 120 个字符。" });
    // 空字符串是有效值：表示回落到环境变量 / 对话模型，所以不做「非空」校验。
    modelConfigPatch.visionModel = value;
  }

  if (body.visionApiBaseUrl !== undefined) {
    if (typeof body.visionApiBaseUrl !== "string") {
      throw createError({ statusCode: 400, statusMessage: "看图服务地址必须是文本。" });
    }
    try {
      modelConfigPatch.visionApiBaseUrl = body.visionApiBaseUrl.trim()
        ? validateChatApiBaseUrl(body.visionApiBaseUrl)
        : "";
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error ? error.message : "看图服务地址无效。",
      });
    }
  }

  if (body.visionApiKey !== undefined) {
    if (typeof body.visionApiKey !== "string") {
      throw createError({ statusCode: 400, statusMessage: "看图服务的 API Key 必须是文本。" });
    }
    const key = body.visionApiKey.trim();
    if (key.length > 8192) throw createError({ statusCode: 400, statusMessage: "看图 API Key 不能超过 8192 个字符。" });
    if (key) visionApiKeyPlain = key;
  }

  if (body.clearVisionApiKey !== undefined) {
    if (typeof body.clearVisionApiKey !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "清除看图 API Key 的参数无效。" });
    }
    clearVisionApiKey = body.clearVisionApiKey;
  }

  // 主动找话的设置也挂在 modelConfig 上，但走独立的校验：写入侧宁可报错也不夹取。
  if (body.proactive !== undefined) {
    const current = config.proactive && typeof config.proactive === "object" && !Array.isArray(config.proactive)
      ? config.proactive as Record<string, unknown>
      : {};
    try {
      const patch = readProactivePatch(body.proactive);
      // 存归一化后的完整对象：读的时候就有确定值可对照，不必再猜「这个字段到底存没存过」。
      modelConfigPatch.proactive = resolveProactiveSettings({ proactive: { ...current, ...patch } });
    } catch (error) {
      throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "主动找话设置无效。" });
    }
  }

  // 群内「冷场了自己找话题」：和主动找话同一套写法，独立的字段与校验。
  if (body.groupInitiative !== undefined) {
    const current = config.groupInitiative && typeof config.groupInitiative === "object" && !Array.isArray(config.groupInitiative)
      ? config.groupInitiative as Record<string, unknown>
      : {};
    try {
      const patch = readGroupInitiativePatch(body.groupInitiative);
      modelConfigPatch.groupInitiative = resolveGroupInitiativeSettings({ groupInitiative: { ...current, ...patch } });
    } catch (error) {
      throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "群内找话题设置无效。" });
    }
  }

  let settingsPatch;
  try {
    settingsPatch = readChatModelSettingsPatch(body);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "角色模型参数无效。" });
  }
  const { chatApiKey, clearApiKey, ...safeSettingsPatch } = settingsPatch;
  Object.assign(modelConfigPatch, safeSettingsPatch);

  if (Object.keys(modelConfigPatch).length > 0 || chatApiKey || clearApiKey || voiceApiKeyPlain || clearVoiceApiKey || asrApiKeyPlain || clearAsrApiKey || visionApiKeyPlain || clearVisionApiKey || memoryAssistantApiKeyPlain || clearMemoryAssistantApiKey || contextAssistantPatch.apiKey || contextAssistantPatch.clearApiKey || knowledgeAssistantPatch.apiKey || knowledgeAssistantPatch.clearApiKey || socialRelationshipAssessmentAssistantApiKeyPlain || clearSocialRelationshipAssessmentAssistantApiKey) {
    const nextConfig: Record<string, unknown> = { ...config, ...modelConfigPatch };
    if (clearApiKey) delete nextConfig.chatApiKeyEncrypted;
    if (chatApiKey) nextConfig.chatApiKeyEncrypted = await encryptApiKey(chatApiKey);
    // 语音 Key 与聊天 Key 分开两把：语音常常是另一家服务商，
    // 混用一个字段会导致「换语音服务商时把聊天也换掉」。
    if (clearVoiceApiKey) delete nextConfig.voiceApiKeyEncrypted;
    if (voiceApiKeyPlain) nextConfig.voiceApiKeyEncrypted = await encryptApiKey(voiceApiKeyPlain);
    // 识别是独立一把：合成换成只做合成的服务商之后，共用那把 Key 打识别服务商只会 401。
    if (clearAsrApiKey) delete nextConfig.asrApiKeyEncrypted;
    if (asrApiKeyPlain) nextConfig.asrApiKeyEncrypted = await encryptApiKey(asrApiKeyPlain);
    // 「同语音合成」：在服务端把合成那把复制过来。用户自己填了识别 Key 时以用户为准。
    if (syncAsrFromVoice && !asrApiKeyPlain && !clearAsrApiKey) {
      const source = await resolveCharacterVoiceApiKey(nextConfig).catch(() => "");
      if (source) nextConfig.asrApiKeyEncrypted = await encryptApiKey(source);
      else console.warn("[voice] 点了「同语音合成」但合成那边没有 Key，识别 Key 保持不变");
    }
    // 图片模型的 Key 同理再分开一把，三家可以各是各的。
    if (clearVisionApiKey) delete nextConfig.visionApiKeyEncrypted;
    if (visionApiKeyPlain) nextConfig.visionApiKeyEncrypted = await encryptApiKey(visionApiKeyPlain);
    if (clearMemoryAssistantApiKey) delete nextConfig.memoryAssistantApiKeyEncrypted;
    if (memoryAssistantApiKeyPlain) {
      nextConfig.memoryAssistantApiKeyEncrypted = await encryptApiKey(memoryAssistantApiKeyPlain);
    }

    // 开启前必须具备独立模型和独立 Key。地址可以留空，默认沿用这个角色的聊天 API 地址。
    // 即使只是修改其他字段，只要当前助手仍处于开启状态，也会再次验证配置完整性。
    if (nextConfig.memoryAssistantEnabled === true) {
      const assistantModel = typeof nextConfig.memoryAssistantModel === "string"
        ? nextConfig.memoryAssistantModel.trim()
        : "";
      const assistantKey = nextConfig.memoryAssistantApiKeyEncrypted;
      if (!assistantModel) {
        throw createError({ statusCode: 400, statusMessage: "启用记忆助手前，请先在模型设置中填写记忆助手模型名称。" });
      }
      if (typeof assistantKey !== "string" || !assistantKey.startsWith("v1.")) {
        throw createError({ statusCode: 400, statusMessage: "启用记忆助手前，请先保存记忆助手专用 API Key。" });
      }
      const assistantBaseUrl = typeof nextConfig.memoryAssistantApiBaseUrl === "string"
        && nextConfig.memoryAssistantApiBaseUrl.trim()
        ? nextConfig.memoryAssistantApiBaseUrl
        : typeof nextConfig.chatApiBaseUrl === "string" && nextConfig.chatApiBaseUrl.trim()
          ? nextConfig.chatApiBaseUrl
          : process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
      try {
        validateChatApiBaseUrl(assistantBaseUrl);
      } catch (error) {
        throw createError({
          statusCode: 400,
          statusMessage: error instanceof Error ? error.message : "记忆助手 API 地址无效。",
        });
      }
    }
    if (contextAssistantPatch.clearApiKey) delete nextConfig.contextAssistantApiKeyEncrypted;
    if (contextAssistantPatch.apiKey) nextConfig.contextAssistantApiKeyEncrypted = await encryptApiKey(contextAssistantPatch.apiKey);
    if (knowledgeAssistantPatch.clearApiKey) delete nextConfig.knowledgeAssistantApiKeyEncrypted;
    if (knowledgeAssistantPatch.apiKey) nextConfig.knowledgeAssistantApiKeyEncrypted = await encryptApiKey(knowledgeAssistantPatch.apiKey);
    if (clearSocialRelationshipAssessmentAssistantApiKey) delete nextConfig.socialRelationshipAssessmentAssistantApiKeyEncrypted;
    if (socialRelationshipAssessmentAssistantApiKeyPlain) {
      nextConfig.socialRelationshipAssessmentAssistantApiKeyEncrypted = await encryptApiKey(socialRelationshipAssessmentAssistantApiKeyPlain);
    }
    try {
      validateContextAssistantEnabledConfig(nextConfig);
      validateKnowledgeAssistantEnabledConfig(nextConfig);
      validateSocialRelationshipAssessmentAssistantEnabledConfig(nextConfig);
    } catch (error) {
      throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "助手配置无效。" });
    }
    data.modelConfig = nextConfig as Prisma.InputJsonObject;
  }

  const updated = await prisma.character.update({
    where: { id },
    data,
    include: characterInclude,
  });
  return toCharacterDto(updated);
});
