import { createError, readBody } from "h3";
import type { Prisma } from "../../../src/generated/prisma/client";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readChatModelSettingsPatch, validateChatApiBaseUrl } from "../../utils/chat-model-config";
import { encryptApiKey } from "../../utils/credential-encryption";import { requireActorUserId } from "../../utils/auth";
import { readTrimmedString, requireUuid } from "../../utils/local-api";
import { RECENT_MESSAGE_LIMIT_MAX, RECENT_MESSAGE_LIMIT_MIN } from "../../utils/memory-retrieval";
import { getPrisma } from "../../utils/prisma";
import { readProactivePatch, resolveProactiveSettings } from "../../utils/proactive-settings";
import { readGroupInitiativePatch, resolveGroupInitiativeSettings } from "../../utils/group-initiative-settings";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const existing = await prisma.character.findFirst({ where: { id, ownerId } });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const config = existing.modelConfig && typeof existing.modelConfig === "object" && !Array.isArray(existing.modelConfig)
    ? existing.modelConfig as Record<string, unknown>
    : {};
  const data: Prisma.CharacterUpdateInput = {};

  if (body.name !== undefined) data.name = readTrimmedString(body.name, "角色名称", 100, { required: true });
  if (body.personality !== undefined) data.basePrompt = readTrimmedString(body.personality, "基础人设", 12000);
  if (body.examples !== undefined) data.styleExamples = readTrimmedString(body.examples, "对话示例", 8000);
  // 空字符串是合法值：表示这个角色不特意称呼用户，不要回填默认的「主人」。
  if (body.userAddress !== undefined) data.userAddress = readTrimmedString(body.userAddress, "她对你的称呼", 40);

  if (body.status !== undefined) {
    const statusMap: Record<string, "ACTIVE" | "PAUSED" | "ARCHIVED"> = {
      "运行中": "ACTIVE", "已暂停": "PAUSED", "未连接": "ARCHIVED",
    };
    if (typeof body.status !== "string" || !statusMap[body.status]) {
      throw createError({ statusCode: 400, statusMessage: "无效的角色状态。" });
    }
    data.status = statusMap[body.status];
  }

  const modelConfigPatch: Record<string, unknown> = {};
  /** 语音 Key 的明文只在这里短暂停留，落库前一定加密；不写日志、不回显。 */
  let voiceApiKeyPlain = "";
  let clearVoiceApiKey = false;
  if (body.alias !== undefined) modelConfigPatch.alias = readTrimmedString(body.alias, "角色标签", 100);
  if (body.description !== undefined) modelConfigPatch.description = readTrimmedString(body.description, "角色简介", 2000);

  // 额度与预算都是 0 = 不限（预算则回落到默认值），所以允许 0。
  const numericLimits: Array<[string, string, number]> = [
    ["dailyTokenLimit", "每日 token 额度", 100_000_000],
    ["memoryTokenBudget", "记忆 token 预算", 20_000],
    ["snapshotTokenBudget", "快照 token 预算", 20_000],
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
  if (body.ttsProvider !== undefined) {
    if (typeof body.ttsProvider !== "string") {
      throw createError({ statusCode: 400, statusMessage: "语音服务商必须是文本。" });
    }
    const value = body.ttsProvider.trim();
    if (value && value !== "openai" && value !== "minimax") {
      throw createError({ statusCode: 400, statusMessage: "语音服务商只支持 openai（含兼容接口）或 minimax。" });
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

  if (Object.keys(modelConfigPatch).length > 0 || chatApiKey || clearApiKey || voiceApiKeyPlain || clearVoiceApiKey) {
    const nextConfig: Record<string, unknown> = { ...config, ...modelConfigPatch };
    if (clearApiKey) delete nextConfig.chatApiKeyEncrypted;
    if (chatApiKey) nextConfig.chatApiKeyEncrypted = await encryptApiKey(chatApiKey);
    // 语音 Key 与聊天 Key 分开两把：语音常常是另一家服务商，
    // 混用一个字段会导致「换语音服务商时把聊天也换掉」。
    if (clearVoiceApiKey) delete nextConfig.voiceApiKeyEncrypted;
    if (voiceApiKeyPlain) nextConfig.voiceApiKeyEncrypted = await encryptApiKey(voiceApiKeyPlain);
    data.modelConfig = nextConfig as Prisma.InputJsonObject;
  }

  const updated = await prisma.character.update({
    where: { id },
    data,
    include: characterInclude,
  });
  return toCharacterDto(updated);
});
