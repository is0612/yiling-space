import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey, resolveCharacterVoiceApiKey } from "../../../../utils/credential-encryption";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveVoiceTtsSettings } from "../../../../utils/voice";

/** MiniMax 没有模型列表接口，内置清单兜底（见下面 MINIMAX_VOICE_MODELS） */
const MINIMAX_VOICE_MODELS = [
  "speech-2.5-turbo-preview",
  "speech-2.5-hd-preview",
  "speech-02-turbo",
  "speech-02-hd",
];

/** OpenAI 兼容接口里的语音模型 id 关键词：拉全量后按这个过滤，别把 chat/embedding 模型混进来 */
const VOICE_MODEL_RE = /(tts|speech|cosyvoice|sensevoice|whisper|voice|audio|asr|moss)/i;

type ModelsResult = {
  ok: boolean;
  models: string[];
  message: string;
  unsupported?: boolean;
  provider?: string;
};

export default defineEventHandler(async (event): Promise<ModelsResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let chatApiKey = "";
  let voiceApiKey = "";
  try {
    chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
    voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig);
  } catch {
    return { ok: false, models: [], message: "无法解密当前角色保存的 API Key。请重新输入并保存该 Key。" };
  }

  const settings = resolveVoiceTtsSettings({
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKey,
    voiceApiKey,
  });
  if (!settings) {
    return { ok: false, models: [], message: "语音配置不完整，请先填服务商、Key、合成模型。" };
  }

  // MiniMax 不提供 GET /models：直接给内置清单，标 unsupported 让前端提示「内置清单」。
  if (settings.provider === "minimax") {
    return {
      ok: true,
      models: MINIMAX_VOICE_MODELS,
      message: "MiniMax 没有模型列表接口，这里给出内置清单。",
      unsupported: true,
      provider: "minimax",
    };
  }

  if (!settings.apiKey) {
    return { ok: false, models: [], message: "尚未填写语音 Key，无法拉取模型列表。" };
  }

  let endpoint: URL;
  try {
    endpoint = buildModelsEndpoint(settings.apiBaseUrl);
  } catch (error) {
    return { ok: false, models: [], message: error instanceof Error ? error.message : "API Base URL 无效。" };
  }

  try {
    const response = await fetch(endpoint, {
      headers: { authorization: "Bearer " + settings.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unsupported = response.status === 404 || response.status === 405 || response.status === 501;
      const message = response.status === 401 || response.status === 403
        ? "语音 Key 无效或没有查看模型的权限。"
        : unsupported
          ? "该服务商没有模型列表接口，请直接手填模型名。"
          : "服务商返回 HTTP " + response.status + "，无法获取模型列表。";
      return { ok: false, models: [], message, unsupported, provider: endpoint.hostname };
    }
    const payload = (await response.json()) as unknown;
    const root = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const data = Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : [];
    const models: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
      if (!id) continue;
      // 语音模型才有资格进这个下拉；chat/embedding/图片模型混进来会让人挑错
      if (VOICE_MODEL_RE.test(id) && !models.includes(id)) models.push(id);
    }
    if (!models.length) {
      return { ok: false, models: [], message: "该服务商的模型清单里没找到语音模型，请直接手填模型名。", provider: endpoint.hostname };
    }
    return { ok: true, models: models.slice(0, 50), message: "已获取语音模型列表。", provider: endpoint.hostname };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, models: [], message: timedOut ? "获取模型超时（15 秒）。" : "无法连接 API，请检查语音地址与 Key。", provider: endpoint.hostname };
  }
});
