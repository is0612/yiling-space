import { createError } from "h3";
import { buildChatCompletionsEndpoint } from "./chat-model-config";
import { readModelUsage, recordModelUsage, type ModelUsageTokens } from "./model-usage";
import { contextCost, type RoleplayApiMessage, type RoleplaySettings } from "./roleplay-context";

export async function callRoleplayModel(settings: RoleplaySettings, apiKey: string, messages: RoleplayApiMessage[], accounting: { ownerId: string; sessionId: string; characterId?: string | null; summary?: boolean }): Promise<string> {
  if (!apiKey) throw createError({ statusCode: 503, statusMessage: "请先配置角色扮演模型 API Key。" });
  if (contextCost(messages) > settings.contextBudgetTokens) throw createError({ statusCode: 413, statusMessage: "角色扮演上下文超过预算，请缩短人设或消息、压缩历史或提高预算。" });
  const endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  const record = (status: string, usage?: ModelUsageTokens | null) => recordModelUsage({ kind: accounting.summary ? "roleplay-summary" : "roleplay-chat", model: settings.model, userId: accounting.ownerId, characterId: accounting.characterId, usage, metadata: { roleplaySessionId: accounting.sessionId, status } });
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: settings.model, messages, temperature: settings.temperature, max_tokens: settings.maxTokens, ...(accounting.summary ? { response_format: { type: "json_object" } } : {}), ...(endpoint.hostname === "api.deepseek.com" ? { thinking: { type: settings.thinking ? "enabled" : "disabled" } } : {}) }), signal: AbortSignal.timeout(90000) });
  } catch {
    await record("network_error");
    throw createError({ statusCode: 502, statusMessage: "角色扮演模型连接失败或超时，消息已保留，可使用相同请求编号重试。" });
  }
  if (!response.ok) {
    await record(`http_${response.status}`);
    throw createError({ statusCode: 502, statusMessage: `角色扮演模型返回 HTTP ${response.status}，消息已保留。` });
  }
  let payload: { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  try { payload = await response.json(); } catch {
    await record("invalid_json");
    throw createError({ statusCode: 502, statusMessage: "角色扮演模型返回无效响应，消息已保留。" });
  }
  if (!payload || typeof payload !== "object") {
    await record("invalid_response");
    throw createError({ statusCode: 502, statusMessage: "角色扮演模型响应格式无效。" });
  }
  const choice = payload.choices?.[0];
  const valid = typeof choice?.message?.content === "string" && Boolean(choice.message.content.trim()) && choice.finish_reason !== "length";
  await record(valid ? "success" : "empty_or_truncated", readModelUsage(payload));
  if (!valid) throw createError({ statusCode: 502, statusMessage: "模型正文为空或被输出上限截断，消息已保留；请调整输出上限后重试。" });
  return choice!.message!.content!.trim();
}
