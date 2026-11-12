import { createError, getRouterParam } from "h3";
import { buildChatCompletionsEndpoint } from "../../../../../utils/chat-model-config";
import { ASSISTANT_FIELDS, resolveAssistantConnection } from "../../../../../utils/assistant-inheritance";
import { readModelUsage, recordModelUsage } from "../../../../../utils/model-usage";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

type TestResult = { ok: boolean; message: string; model?: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export default defineEventHandler(async (event): Promise<TestResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const connection = await resolveAssistantConnection(character.modelConfig, ASSISTANT_FIELDS.socialAssessment);
  const model = connection.model;
  const baseUrl = connection.apiBaseUrl;
  if (!model) return { ok: false, message: "请先保存关系评估助手模型名称，或先配置对话模型。" };
  if (!connection.apiKey) {
    return {
      ok: false,
      message: connection.baseUrlSource === "assistant"
        ? "关系评估助手用了单独的 API 地址，需要单独填写它的 API Key。"
        : "尚未配置可用的 API Key。请在对话模型里填写 Key，或单独为关系评估助手填一把。",
    };
  }
  const apiKey = connection.apiKey;

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(baseUrl);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "关系评估助手 API 地址无效。" };
  }

  let httpStatus = 0;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你正在进行 API 连通性测试。请只回复 OK。" },
          { role: "user", content: "连接测试" },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    httpStatus = response.status;
    if (!response.ok) {
      await recordModelUsage({
        kind: "social-relationship-assistant",
        model,
        characterId,
        metadata: { operation: "connection-test", success: false, httpStatus },
      });
      return {
        ok: false,
        message: httpStatus === 401 || httpStatus === 403
          ? "模型服务鉴权失败，请检查关系评估助手专用 API Key。"
          : `模型服务返回 HTTP ${httpStatus}，请检查独立 API 地址、模型名称和服务商状态。`,
      };
    }

    const payload: unknown = await response.json();
    const usage = readModelUsage(payload);
    await recordModelUsage({
      kind: "social-relationship-assistant",
      model,
      characterId,
      usage,
      metadata: { operation: "connection-test", success: true, httpStatus },
    });
    return { ok: true, message: "连接成功，关系评估助手模型接口已响应。", model };
  } catch {
    await recordModelUsage({
      kind: "social-relationship-assistant",
      model,
      characterId,
      metadata: { operation: "connection-test", success: false, httpStatus, error: "network-or-timeout" },
    });
    return { ok: false, message: "连接模型服务失败，请检查网络、独立 API 地址和专用 Key。" };
  }
});
