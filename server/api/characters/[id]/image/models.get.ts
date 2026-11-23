import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterImageApiKey } from "../../../../utils/credential-encryption";
import { DEFAULT_IMAGE_MODEL, resolveImageGenerationSettings } from "../../../../utils/image-generation";
import { isImageGenerationModel } from "../../../../../shared/utils/vision-models";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/** 上游一次可能返回上百个模型，够挑就行 */
const MAX_MODELS = 200;
/** 过滤不到画图模型时，全量清单也只给这么多（下拉里塞 200 个也挑不动） */
const MAX_FALLBACK_MODELS = 50;

/**
 * MiniMax 没有 `GET /models`（和语音那条链路同一个结论），内置清单兜底。
 * 高速版参数完全一样，只差一个后缀 —— 放在这里省一次手打。
 */
const MINIMAX_IMAGE_MODELS = [DEFAULT_IMAGE_MODEL, `${DEFAULT_IMAGE_MODEL}-Highspeed`];

type ModelsResult = {
  ok: boolean;
  models: string[];
  message: string;
  /** 服务商压根没有列表接口（或这里是内置清单），前端据此提示「内置清单」 */
  unsupported?: boolean;
  provider?: string;
};

/**
 * 拉取**画图那一家**的可用模型列表。
 *
 * 和「图片模型」（看图）那条的区别，不只是换了配置来源：
 *   1. 走 `resolveImageGenerationSettings` —— 画图**不回落**到聊天 Key
 *      （DeepSeek 没有生图接口，把聊天 Key 打过去只会 401）；
 *   2. 清单里只留像生图模型的名字。`GET /models` 是不分用途的全量清单，
 *      让用户从里面挑，挑到 chat 模型的概率远比挑对高；
 *   3. 过滤后为空时给全量，不报「没有画图模型」—— 名字判据只认已知厂商，
 *      新的生图模型名一个都不认识，藏起来比让人撞一次 404 更糟。
 *
 * 和别处一样，只认**已保存**的配置：Key 在服务端加密存放，浏览器拿不到明文。
 */
export default defineEventHandler(async (event): Promise<ModelsResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const imageApiKey = await resolveCharacterImageApiKey(character.modelConfig).catch(() => "");
  if (!imageApiKey && !process.env.IMAGE_API_KEY?.trim()) {
    return { ok: false, models: [], message: "尚未填写画图 API Key。先填写并保存，再获取模型列表。" };
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const settings = resolveImageGenerationSettings({
    modelConfig: character.modelConfig,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    imageApiKey,
  });
  if (!settings) {
    // Key 在上面已经确认过，能走到这里只剩「地址写坏了」
    return { ok: false, models: [], message: "画图 API 地址无效，请填写完整地址，例如 https://api.minimaxi.com/v1。" };
  }

  if (settings.provider === "minimax") {
    return {
      ok: true,
      models: MINIMAX_IMAGE_MODELS,
      message: "MiniMax 没有模型列表接口，这里给出内置清单。",
      unsupported: true,
      provider: "minimax",
    };
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
      // 只认 404/405/501 是「这家没有列表接口」；401/403 是 Key 的问题。
      const unsupported = response.status === 404 || response.status === 405 || response.status === 501;
      const message = response.status === 401 || response.status === 403
        ? "画图 Key 无效或没有查看模型的权限（注意：它和对话、看图的 Key 是分开存的）。"
        : unsupported
          ? "该服务商没有提供模型列表接口（HTTP " + response.status + "），请直接手填模型名。"
          : "服务商返回 HTTP " + response.status + "，无法获取模型列表。请检查 API 地址与 Key。";
      return { ok: false, models: [], message, unsupported, provider: endpoint.hostname };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, models: [], message: "服务商返回了非 JSON 响应，请确认 API 地址是 OpenAI 兼容接口。", provider: endpoint.hostname };
    }

    // OpenAI 兼容是 { data: [{ id }] }；少数平台直接给数组，或者字段叫 name
    const root = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const rawList = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];
    const all: string[] = [];
    for (const item of rawList) {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      const id = record && typeof record.id === "string"
        ? record.id
        : record && typeof record.name === "string"
          ? record.name
          : typeof item === "string"
            ? item
            : "";
      const model = id.trim();
      if (model && !all.includes(model)) all.push(model);
      if (all.length >= MAX_MODELS) break;
    }

    if (!all.length) {
      return { ok: false, models: [], message: "接口返回成功，但列表里没有模型。请手动填写画图模型名称。", provider: endpoint.hostname };
    }

    const imageModels = all.filter(isImageGenerationModel);
    if (imageModels.length) {
      return {
        ok: true,
        models: imageModels,
        message: `获取到 ${imageModels.length} 个画图模型。`,
        provider: endpoint.hostname,
      };
    }

    // 名字判据不认识这家的新模型：宁可全给，也不要把真能用的藏起来
    return {
      ok: true,
      models: all.slice(0, MAX_FALLBACK_MODELS),
      message: `清单里没认出画图模型的名字（共 ${all.length} 个），先给全量，挑名字里带 image / flux 的那几个。`,
      unsupported: true,
      provider: endpoint.hostname,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      models: [],
      message: timedOut ? "获取模型列表超时（15 秒），请检查网络或供应商状态。" : "无法连接画图服务，请检查 API 地址与网络。",
      provider: endpoint.hostname,
    };
  }
});
