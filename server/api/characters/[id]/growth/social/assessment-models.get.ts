import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint } from "../../../../../utils/chat-model-config";
import { ASSISTANT_FIELDS, resolveAssistantConnection } from "../../../../../utils/assistant-inheritance";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

type ModelsResult = { ok: boolean; models: string[]; message: string; unsupported?: boolean; provider?: string };

export default defineEventHandler(async (event): Promise<ModelsResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const connection = await resolveAssistantConnection(character.modelConfig, ASSISTANT_FIELDS.socialAssessment);
  const baseUrl = connection.apiBaseUrl;
  const apiKey = connection.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      message: connection.baseUrlSource === "assistant"
        ? "关系评估助手用了单独的 API 地址，需要单独填写它的 API Key 才能获取模型列表。"
        : "尚未配置可用的 API Key。请在对话模型里填写 Key，或单独为关系评估助手填一把。",
    };
  }

  let endpoint: URL;
  try {
    endpoint = buildModelsEndpoint(baseUrl);
  } catch (error) {
    return { ok: false, models: [], message: error instanceof Error ? error.message : "API 地址无效。" };
  }

  try {
    const response = await fetch(endpoint, {
      redirect: "error",
      headers: { authorization: "Bearer " + apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unsupported = [404, 405, 501].includes(response.status);
      return {
        ok: false,
        models: [],
        message: unsupported
          ? "该服务商不支持模型列表接口，请直接手填模型名称。"
          : "关系评估助手服务商返回 HTTP " + response.status + "，请检查地址与独立 Key。",
        unsupported,
        provider: endpoint.hostname,
      };
    }
    const payload: unknown = await response.json();
    const root = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const raw = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];
    const models: string[] = [];
    for (const item of raw) {
      const row = item !== null && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};
      const value = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : typeof item === "string" ? item : "";
      const name = value.trim();
      if (name && name.length <= 160 && !models.includes(name)) models.push(name);
      if (models.length >= 200) break;
    }
    models.sort((a, b) => a.localeCompare(b));
    return { ok: true, models, message: models.length ? `已获取 ${models.length} 个模型。` : "服务商没有返回可识别的模型名称。", provider: endpoint.hostname };
  } catch {
    return { ok: false, models: [], message: "连接关系评估助手服务商失败，请检查网络、地址和 Key。" };
  }
});
