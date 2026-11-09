import { createError, getRouterParam } from "h3";
import { buildChatCompletionsEndpoint } from "../../../../../utils/chat-model-config";
import { resolveCharacterSocialRelationshipAssessmentAssistantApiKey } from "../../../../../utils/credential-encryption";
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

  const config = asRecord(character.modelConfig);
  const model = typeof config.socialRelationshipAssessmentAssistantModel === "string"
    ? config.socialRelationshipAssessmentAssistantModel.trim()
    : "";
  const baseUrl = typeof config.socialRelationshipAssessmentAssistantApiBaseUrl === "string"
    ? config.socialRelationshipAssessmentAssistantApiBaseUrl.trim()
    : "";
  if (!model) return { ok: false, message: "请先保存关系评估助手模型名称。" };
  if (!baseUrl) return { ok: false, message: "请先保存关系评估助手独立 API 地址。" };

  let apiKey = "";
  try {
    apiKey = await resolveCharacterSocialRelationshipAssessmentAssistantApiKey(character.modelConfig);
  } catch {
    return { ok: false, message: "关系评估助手 API Key 解密失败，请重新保存专用 Key。" };
  }
  if (!apiKey) return { ok: false, message: "请先保存关系评估助手专用 API Key。" };

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
