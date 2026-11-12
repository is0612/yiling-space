import { createError, getRouterParam } from "h3";
import { validateChatApiBaseUrl } from "../../../../utils/chat-model-config";
import { ASSISTANT_FIELDS, resolveAssistantConnection } from "../../../../utils/assistant-inheritance";
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
  const connection = await resolveAssistantConnection(character.modelConfig, ASSISTANT_FIELDS.context);
  const model = connection.model;
  if (!model) return { ok: false, message: "请先填写语境助手模型名称，或先配置对话模型。" };
  if (!connection.apiKey) {
    return {
      ok: false,
      message: connection.baseUrlSource === "assistant"
        ? "语境助手用了单独的 API 地址，需要单独填写它的 API Key。"
        : "尚未配置可用的 API Key。请在对话模型里填写 Key，或单独为语境助手填一把。",
    };
  }
  let apiBaseUrl: string;
  try {
    apiBaseUrl = validateChatApiBaseUrl(connection.apiBaseUrl);
  } catch {
    return { ok: false, message: "语境助手 API 地址无效，请检查后重新保存。" };
  }
  // 仅复用无状态连通探针，凭据取解析后的结果（可能继承自对话模型）。
  const result = await testMemoryAssistantConnection({
    model, apiKey: connection.apiKey, apiBaseUrl, temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048,
  });
  return { ...result, message: result.message.replaceAll("记忆助手", "语境助手") };
});
