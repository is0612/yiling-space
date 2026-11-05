import { createError, getRouterParam } from "h3";
import { resolveChatModelSettings, validateChatApiBaseUrl } from "../../../../utils/chat-model-config";
import { resolveCharacterContextAssistantApiKey } from "../../../../utils/credential-encryption";
import { testMemoryAssistantConnection } from "../../../../utils/memory-assistant";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId }, select: { modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const config = character.modelConfig !== null && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
    ? character.modelConfig as Record<string, unknown> : {};
  const model = typeof config.contextAssistantModel === "string" ? config.contextAssistantModel.trim() : "";
  if (!model) return { ok: false, message: "请先填写语境助手模型名称。" };
  let apiKey: string;
  try {
    apiKey = await resolveCharacterContextAssistantApiKey(config);
  } catch {
    return { ok: false, message: "无法解密语境助手已保存的 API Key，请重新输入并保存。" };
  }
  if (!apiKey) return { ok: false, message: "请先填写并保存语境助手独立 API Key。" };
  let apiBaseUrl: string;
  try {
    apiBaseUrl = validateChatApiBaseUrl(
      typeof config.contextAssistantApiBaseUrl === "string" && config.contextAssistantApiBaseUrl.trim()
        ? config.contextAssistantApiBaseUrl : resolveChatModelSettings(config).apiBaseUrl,
    );
  } catch {
    return { ok: false, message: "语境助手 API 地址无效，请检查后重新保存。" };
  }
  // 仅复用无状态连通探针，明确提供语境助手自己的凭据，不读取记忆助手或聊天 Key。
  const result = await testMemoryAssistantConnection({
    model, apiKey, apiBaseUrl, temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048,
  });
  return { ...result, message: result.message.replaceAll("记忆助手", "语境助手") };
});
