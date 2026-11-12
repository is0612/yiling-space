import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint } from "../../../../../utils/chat-model-config";
import { ASSISTANT_FIELDS, resolveAssistantConnection } from "../../../../../utils/assistant-inheritance";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

const MAX_MODELS = 200;

type ModelsResult = {
  ok: boolean;
  models: string[];
  message: string;
  unsupported?: boolean;
  provider?: string;
};

/**
 * 拉取语境助手服务商的模型清单。
 *
 * 地址和 Key 都可以留空沿用对话模型（见 `assistant-inheritance`）：
 * 只有地址也换了别家时，才必须单独填 Key —— 拿 A 家的 Key 打 B 家只会 401。
 */
export default defineEventHandler(async (event): Promise<ModelsResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const connection = await resolveAssistantConnection(character.modelConfig, ASSISTANT_FIELDS.context);
  const apiBaseUrl = connection.apiBaseUrl;
  const apiKey = connection.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      message: connection.baseUrlSource === "assistant"
        ? "语境助手用了单独的 API 地址，需要单独填写它的 API Key 才能获取模型列表。"
        : "尚未配置可用的 API Key。请在对话模型里填写 Key，或单独为语境助手填一把。",
    };
  }

  let endpoint: URL;
  try {
    endpoint = buildModelsEndpoint(apiBaseUrl);
  } catch (error) {
    return {
      ok: false,
      models: [],
      message: error instanceof Error ? error.message : "语境助手 API 地址无效。",
    };
  }

  try {
    const response = await fetch(endpoint, {
      redirect: "error",
      headers: { authorization: "Bearer " + apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const unsupported = response.status === 404 || response.status === 405 || response.status === 501;
      const message = response.status === 401 || response.status === 403
        ? "语境助手 API Key 无效或没有查看模型的权限。"
        : unsupported
          ? "该服务商没有提供模型列表接口（HTTP " + response.status + "），请从内置清单里选，或直接手填模型名。"
          : "语境助手服务商返回 HTTP " + response.status + "，无法获取模型列表。请检查 API 地址与独立 Key。";
      return { ok: false, models: [], message, unsupported, provider: endpoint.hostname };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        models: [],
        message: "语境助手服务商返回了非 JSON 响应，请确认 API 地址兼容 OpenAI 模型列表接口。",
        provider: endpoint.hostname,
      };
    }

    const root = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const rawList = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];
    const models: string[] = [];
    for (const item of rawList) {
      const record = item !== null && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
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
      return {
        ok: false,
        models: [],
        message: "接口返回成功，但模型列表为空。请手动填写模型名称。",
        provider: endpoint.hostname,
      };
    }
    return {
      ok: true,
      models,
      message: "语境助手获取到 " + models.length + " 个模型。",
      provider: endpoint.hostname,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      models: [],
      message: timedOut
        ? "获取语境助手模型列表超时（15 秒），请检查网络或供应商状态。"
        : "无法连接语境助手 API，请检查独立 API 地址与网络。",
      provider: endpoint.hostname,
    };
  }
});
