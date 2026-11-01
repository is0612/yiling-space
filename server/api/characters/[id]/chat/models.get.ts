import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../utils/credential-encryption";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/** 上游一次可能返回上百个模型，够挑就行，别整个塞给前端 */
const MAX_MODELS = 200;

type ModelsResult = {
  ok: boolean;
  models: string[];
  message: string;
  /** 服务商压根没有 `GET /models`（404/405/501），前端据此改用内置清单兜底 */
  unsupported?: boolean;
  /** 部分服务商的模型清单只有 id，没有更细的信息 */
  provider?: string;
};

/**
 * 拉取该角色所配服务商的可用模型列表。
 *
 * 只能用**已保存**的配置：Key 在服务端加密存放，浏览器拿不到明文，
 * 所以前端必须先保存再调用（和「保存并测试」同一套顺序）。
 */
export default defineEventHandler(async (event): Promise<ModelsResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const settings = resolveChatModelSettings(character.modelConfig);
  let apiKey: string;
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
  } catch {
    return { ok: false, models: [], message: "无法解密当前角色保存的 API Key。请重新输入并保存该 Key。" };
  }
  if (!apiKey) {
    return { ok: false, models: [], message: "尚未填写 API Key。请先填写并保存，再获取模型列表。" };
  }

  let endpoint: URL;
  try {
    endpoint = buildModelsEndpoint(settings.apiBaseUrl);
  } catch (error) {
    return { ok: false, models: [], message: error instanceof Error ? error.message : "API Base URL 无效。" };
  }

  try {
    const response = await fetch(endpoint, {
      headers: { authorization: "Bearer " + apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // 只认 404/405/501 是「这家没有列表接口」。401/403 是 Key 的问题，
      // 400/406 是地址对但请求被拒 —— 照实报出来，别都推给「不支持」。
      const unsupported = response.status === 404 || response.status === 405 || response.status === 501;
      const message = response.status === 401 || response.status === 403
        ? "API Key 无效或没有查看模型的权限。"
        : unsupported
          ? "该服务商没有提供模型列表接口（HTTP " + response.status + "），请从内置清单里选，或直接手填模型名。"
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
    const models: string[] = [];
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
      if (model && !models.includes(model)) models.push(model);
      if (models.length >= MAX_MODELS) break;
    }

    if (!models.length) {
      return { ok: false, models: [], message: "接口返回成功，但列表里没有模型。请手动填写模型名称。", provider: endpoint.hostname };
    }
    return { ok: true, models, message: "获取到 " + models.length + " 个模型。", provider: endpoint.hostname };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      models: [],
      message: timedOut ? "获取模型列表超时（15 秒），请检查网络或供应商状态。" : "无法连接模型服务，请检查 API 地址与网络。",
      provider: endpoint.hostname,
    };
  }
});
