import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint, resolveChatModelSettings } from "../../../../../utils/chat-model-config";
import { resolveCharacterKnowledgeAssistantApiKey } from "../../../../../utils/credential-encryption";
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
  const config = character.modelConfig !== null && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
    ? character.modelConfig as Record<string, unknown> : {};
  const chat = resolveChatModelSettings(character.modelConfig);
  const base = typeof config.knowledgeAssistantApiBaseUrl === "string" && config.knowledgeAssistantApiBaseUrl.trim()
    ? config.knowledgeAssistantApiBaseUrl.trim() : chat.apiBaseUrl;
  const key = await resolveCharacterKnowledgeAssistantApiKey(character.modelConfig).catch(() => "");
  if (!key) return { ok: false, models: [], message: "请先填写并保存知识处理助手独立 API Key。" };
  let endpoint: URL;
  try { endpoint = buildModelsEndpoint(base); }
  catch (error) { return { ok: false, models: [], message: error instanceof Error ? error.message : "API 地址无效。" }; }
  try {
    const response = await fetch(endpoint, {
      redirect: "error",
      headers: { authorization: "Bearer " + key, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unsupported = [404, 405, 501].includes(response.status);
      return {
        ok: false, models: [],
        message: unsupported
          ? "该服务商不支持模型列表接口，请直接手填模型名称。"
          : "知识处理助手服务商返回 HTTP " + response.status + "，请检查地址与独立 Key。",
        unsupported, provider: endpoint.hostname,
      };
    }
    const payload: unknown = await response.json();
    const root = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown> : {};
    const raw = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];
    const models: string[] = [];
    for (const item of raw) {
      const row = item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const value = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : typeof item === "string" ? item : "";
      const name = value.trim();
      if (name && !models.includes(name)) models.push(name);
      if (models.length >= 200) break;
    }
    return models.length
      ? { ok: true, models, message: "已获取 " + models.length + " 个模型。", provider: endpoint.hostname }
      : { ok: false, models: [], message: "接口返回成功，但模型列表为空，请手动填写模型名称。", provider: endpoint.hostname };
  } catch {
    return { ok: false, models: [], message: "无法连接知识处理助手 API，请检查网络和 API 地址。", provider: endpoint.hostname };
  }
});
