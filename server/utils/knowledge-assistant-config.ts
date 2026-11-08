import { validateChatApiBaseUrl } from "./chat-model-config";

export function readKnowledgeAssistantSettingsPatch(body: Record<string, unknown>): {
  config: Record<string, unknown>;
  apiKey: string;
  clearApiKey: boolean;
} {
  const config: Record<string, unknown> = {};
  if (body.knowledgeAutoCollectEnabled !== undefined) {
    if (typeof body.knowledgeAutoCollectEnabled !== "boolean") throw new Error("聊天知识候选自动收集开关必须是布尔值。");
    config.knowledgeAutoCollectEnabled = body.knowledgeAutoCollectEnabled;
  }
  if (body.knowledgeAssistantEnabled !== undefined) {
    if (typeof body.knowledgeAssistantEnabled !== "boolean") throw new Error("知识处理助手开关必须是布尔值。");
    config.knowledgeAssistantEnabled = body.knowledgeAssistantEnabled;
  }
  if (body.knowledgeAssistantModel !== undefined) {
    if (typeof body.knowledgeAssistantModel !== "string" || body.knowledgeAssistantModel.trim().length > 120) {
      throw new Error("知识处理助手模型名称必须是最多 120 个字符的文本。");
    }
    config.knowledgeAssistantModel = body.knowledgeAssistantModel.trim();
  }
  if (body.knowledgeAssistantApiBaseUrl !== undefined) {
    if (typeof body.knowledgeAssistantApiBaseUrl !== "string" || body.knowledgeAssistantApiBaseUrl.trim().length > 500) {
      throw new Error("知识处理助手 API 地址必须是最多 500 个字符的文本。");
    }
    const value = body.knowledgeAssistantApiBaseUrl.trim();
    config.knowledgeAssistantApiBaseUrl = value ? validateChatApiBaseUrl(value) : "";
  }
  for (const [key, min, max, integer] of [
    ["knowledgeAssistantTemperature", 0, 2, false],
    ["knowledgeAssistantMaxInputTokens", 4096, 32768, true],
    ["knowledgeAssistantMaxOutputTokens", 512, 8192, true],
  ] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isInteger(raw))) {
      throw new Error(`知识处理助手 ${key} 必须是 ${min} 到 ${max} 之间${integer ? "的整数" : "的数字"}。`);
    }
    config[key] = raw;
  }
  if (body.clearKnowledgeAssistantApiKey !== undefined && typeof body.clearKnowledgeAssistantApiKey !== "boolean") {
    throw new Error("清除知识处理助手 API Key 的参数无效。");
  }
  const rawKey = body.knowledgeAssistantApiKey;
  if (rawKey !== undefined && (typeof rawKey !== "string" || rawKey.trim().length > 8192)) {
    throw new Error("知识处理助手 API Key 必须是最多 8192 个字符的文本。");
  }
  return {
    config,
    apiKey: typeof rawKey === "string" ? rawKey.trim() : "",
    clearApiKey: body.clearKnowledgeAssistantApiKey === true,
  };
}

export function validateKnowledgeAssistantEnabledConfig(config: Record<string, unknown>): void {
  if (config.knowledgeAssistantEnabled !== true) return;
  if (typeof config.knowledgeAssistantModel !== "string" || !config.knowledgeAssistantModel.trim()) {
    throw new Error("启用知识处理助手前，请先填写模型名称。");
  }
  if (typeof config.knowledgeAssistantApiKeyEncrypted !== "string" || !config.knowledgeAssistantApiKeyEncrypted.startsWith("v1.")) {
    throw new Error("启用知识处理助手前，请先保存知识处理助手专用 API Key。");
  }
  const base = typeof config.knowledgeAssistantApiBaseUrl === "string" && config.knowledgeAssistantApiBaseUrl.trim()
    ? config.knowledgeAssistantApiBaseUrl
    : typeof config.chatApiBaseUrl === "string" && config.chatApiBaseUrl.trim()
      ? config.chatApiBaseUrl
      : process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  validateChatApiBaseUrl(base);
}
