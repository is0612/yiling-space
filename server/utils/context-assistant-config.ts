import { validateChatApiBaseUrl } from "./chat-model-config";

/** 独立语境助手配置；不包含运行期模型调用。 */
export function readContextAssistantSettingsPatch(body: Record<string, unknown>): {
  config: Record<string, unknown>; apiKey: string; clearApiKey: boolean;
} {
  const config: Record<string, unknown> = {};
  for (const [field, max] of [["Model", 120], ["ApiBaseUrl", 500], ["ApiKey", 8192]] as const) {
    const raw = body[`contextAssistant${field}`];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim().length > max) throw new Error(`语境助手 ${field} 必须是最多 ${max} 个字符的文本。`);
    const value = raw.trim();
    if (field !== "ApiKey") config[`contextAssistant${field}`] = field === "ApiBaseUrl" && value ? validateChatApiBaseUrl(value) : value;
  }
  for (const field of ["contextAssistantEnabled", "clearContextAssistantApiKey"]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") throw new Error("语境助手开关和清除 Key 参数必须是布尔值。");
  }
  if (body.contextAssistantEnabled !== undefined) config.contextAssistantEnabled = body.contextAssistantEnabled;
  for (const [field, min, max, integer] of [
    ["Temperature", 0, 2, false], ["MaxInputTokens", 4096, 32768, true], ["MaxOutputTokens", 512, 8192, true],
  ] as const) {
    const value = body[`contextAssistant${field}`];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`语境助手 ${field} 必须是 ${min} 到 ${max} 之间${integer ? "的整数" : "的数字"}。`);
    }
    config[`contextAssistant${field}`] = value;
  }
  return {
    config,
    apiKey: typeof body.contextAssistantApiKey === "string" ? body.contextAssistantApiKey.trim() : "",
    clearApiKey: body.clearContextAssistantApiKey === true,
  };
}

/**
 * 语境助手默认开启，且模型名、地址、Key 都可以留空沿用对话模型
 * （见 `assistant-inheritance`）。所以这里**不再**要求「必须有独立模型名和独立 Key」——
 * 只校验真填了的地址是不是合法地址，以及空地址时回落到的那一个也合法。
 */
export function validateContextAssistantEnabledConfig(config: Record<string, unknown>): void {
  if (config.contextAssistantEnabled === false) return;
  const base = typeof config.contextAssistantApiBaseUrl === "string" && config.contextAssistantApiBaseUrl.trim()
    ? config.contextAssistantApiBaseUrl
    : typeof config.chatApiBaseUrl === "string" && config.chatApiBaseUrl.trim()
      ? config.chatApiBaseUrl
      : process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  validateChatApiBaseUrl(base);
}
