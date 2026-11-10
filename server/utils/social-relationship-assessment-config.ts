import { validateChatApiBaseUrl } from "./chat-model-config";

export type SocialRelationshipAssessmentAssistantSettingsPatch = {
  config: Record<string, unknown>;
  apiKey: string;
  clearApiKey: boolean;
};

export function readSocialRelationshipAssessmentAssistantSettingsPatch(
  body: Record<string, unknown>,
): SocialRelationshipAssessmentAssistantSettingsPatch {
  const config: Record<string, unknown> = {};
  if (body.socialRelationshipAssessmentAssistantEnabled !== undefined) {
    if (typeof body.socialRelationshipAssessmentAssistantEnabled !== "boolean") {
      throw new Error("关系评估助手开关必须是布尔值。");
    }
    config.socialRelationshipAssessmentAssistantEnabled = body.socialRelationshipAssessmentAssistantEnabled;
  }

  for (const [field, max, label] of [
    ["Model", 120, "关系评估助手模型名称"],
    ["ApiBaseUrl", 500, "关系评估助手 API 地址"],
  ] as const) {
    const raw = body[`socialRelationshipAssessmentAssistant${field}`];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim().length > max) {
      throw new Error(`${label}必须是最多 ${max} 个字符的文本。`);
    }
    const value = raw.trim();
    config[`socialRelationshipAssessmentAssistant${field}`] = field === "ApiBaseUrl" && value
      ? validateChatApiBaseUrl(value)
      : value;
  }

  for (const [field, min, max, integer] of [
    ["Temperature", 0, 2, false],
    ["MaxInputTokens", 4_096, 32_768, true],
    // 下限从 512 提到 1024：思考型模型的思考过程本身就要 1500~2000 tokens，
    // 给 512 必然是「空正文 + finish_reason=length」，等于让每次评估注定失败。
    ["MaxOutputTokens", 1_024, 8_192, true],
  ] as const) {
    const raw = body[`socialRelationshipAssessmentAssistant${field}`];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isInteger(raw))) {
      throw new Error(`关系评估助手 ${field} 必须是 ${min} 到 ${max} 之间${integer ? "的整数" : "的数字"}。`);
    }
    config[`socialRelationshipAssessmentAssistant${field}`] = raw;
  }

  if (body.clearSocialRelationshipAssessmentAssistantApiKey !== undefined
    && typeof body.clearSocialRelationshipAssessmentAssistantApiKey !== "boolean") {
    throw new Error("清除关系评估助手 API Key 的参数无效。");
  }
  const rawKey = body.socialRelationshipAssessmentAssistantApiKey;
  if (rawKey !== undefined && (typeof rawKey !== "string" || rawKey.trim().length > 8_192)) {
    throw new Error("关系评估助手 API Key 必须是最多 8192 个字符的文本。");
  }

  return {
    config,
    apiKey: typeof rawKey === "string" ? rawKey.trim() : "",
    clearApiKey: body.clearSocialRelationshipAssessmentAssistantApiKey === true,
  };
}

/**
 * 评估助手必须完整使用自己的模型、地址和 Key。
 * 不回落到聊天模型、记忆助手、语境助手、知识助手或全局环境变量。
 */
export function validateSocialRelationshipAssessmentAssistantEnabledConfig(
  config: Record<string, unknown>,
): void {
  if (config.socialRelationshipAssessmentAssistantEnabled !== true) return;
  if (typeof config.socialRelationshipAssessmentAssistantModel !== "string"
    || !config.socialRelationshipAssessmentAssistantModel.trim()) {
    throw new Error("启用关系评估助手前，请先填写独立模型名称。");
  }
  if (typeof config.socialRelationshipAssessmentAssistantApiBaseUrl !== "string"
    || !config.socialRelationshipAssessmentAssistantApiBaseUrl.trim()) {
    throw new Error("启用关系评估助手前，请先填写独立 API 地址。");
  }
  validateChatApiBaseUrl(config.socialRelationshipAssessmentAssistantApiBaseUrl);
  if (typeof config.socialRelationshipAssessmentAssistantApiKeyEncrypted !== "string"
    || !config.socialRelationshipAssessmentAssistantApiKeyEncrypted.startsWith("v1.")) {
    throw new Error("启用关系评估助手前，请先保存关系评估助手专用 API Key。");
  }
}
