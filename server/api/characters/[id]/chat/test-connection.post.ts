import { createError, getRouterParam } from "h3";
import { buildChatCompletionsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../utils/credential-encryption";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
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
    return { ok: false, message: "无法解密当前角色保存的 API Key。请重新输入并保存该 Key。" };
  }
  if (!apiKey) return { ok: false, message: "尚未填写 API Key。请在模型参数里输入并保存后再测试。" };
  if (!settings.model) return { ok: false, message: "请先填写模型名称。" };

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "API Base URL 无效。" };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: "system", content: "YILING_CONVERSATION_REPLY_V1 connectivity test. Reply briefly." },
          { role: "user", content: JSON.stringify({ currentMessage: "connection test", memories: [], snapshots: [] }) },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "API Key 无效或没有调用权限。"
        : response.status === 404
          ? "API 路径或模型不存在，请检查 Base URL 和模型名称。"
          : "模型供应商返回 HTTP " + response.status + "。请检查 API 地址、Key 与模型权限。";
      return { ok: false, message, provider: endpoint.hostname, elapsedMs: Date.now() - startedAt };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, message: "供应商返回了非 JSON 响应，请检查 Base URL 是否指向 OpenAI 兼容接口。", provider: endpoint.hostname, elapsedMs: Date.now() - startedAt };
    }
    const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    if (!choices.length) {
      return { ok: false, message: "请求已发送，但响应中没有 choices。请确认该地址兼容 Chat Completions。", provider: endpoint.hostname, elapsedMs: Date.now() - startedAt };
    }
    return {
      ok: true,
      message: "API 连接成功，模型已返回响应（" + endpoint.hostname + " / " + settings.model + "）。",
      model: settings.model,
      provider: endpoint.hostname,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      message: timedOut ? "连接测试超时（15 秒），请检查网络或供应商状态。" : "无法连接 API，请检查 Base URL、网络以及本地服务是否启动。",
      provider: endpoint.hostname,
      elapsedMs: Date.now() - startedAt,
    };
  }
});
