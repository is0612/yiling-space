import { isIP } from "node:net";
import { isCharacterApiKeySaved } from "./credential-encryption";

export type ChatModelSettingsPatch = {
  chatModel?: string;
  chatTemperature?: number;
  chatMaxTokens?: number;
  chatApiBaseUrl?: string;
  chatApiKey?: string;
  clearApiKey?: boolean;
};
export type ResolvedChatModelSettings = {
  model: string;
  temperature: number;
  maxTokens: number;
  apiBaseUrl: string;
  apiKeyConfigured: boolean;
  apiKeySource: "character" | "environment" | "missing";
};

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1800;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 8192;
const MAX_MODEL_LENGTH = 120;
const MAX_BASE_URL_LENGTH = 500;
const MAX_API_KEY_LENGTH = 8192;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function validateChatApiBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) return "";
  if (input.length > MAX_BASE_URL_LENGTH) throw new Error("API Base URL 不能超过 500 个字符。");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("API Base URL 格式无效，请填写完整地址，例如 https://api.deepseek.com/v1。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API Base URL 只支持 HTTPS；HTTP 仅允许 localhost 本机地址。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API Base URL 不应包含用户名、密码、查询参数或片段。");
  }
  const hostname = url.hostname.toLowerCase();
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const isLoopbackName = unbracketedHostname === "localhost"
    || unbracketedHostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(unbracketedHostname)
    || unbracketedHostname === "::1";
  const ipVersion = isIP(unbracketedHostname);
  const isPrivateIpv4 = ipVersion === 4 && (() => {
    const octets = unbracketedHostname.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    const third = octets[2] ?? -1;
    return first === 0
      || first === 10
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 88 && third === 99)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  })();
  const isPrivateIpv6 = ipVersion === 6 && (
    // Reject IPv4-compatible IPv6 literals too: they can encode loopback/private IPv4 targets.
    (unbracketedHostname.startsWith("::") && unbracketedHostname !== "::1")
    || unbracketedHostname.startsWith("fc")
    || unbracketedHostname.startsWith("fd")
    || /^fe[89ab]/.test(unbracketedHostname)
  );
  const isLocalOnlyHostname = isLoopbackName
    || unbracketedHostname.endsWith(".local")
    || unbracketedHostname.endsWith(".internal")
    || unbracketedHostname.endsWith(".lan")
    || unbracketedHostname === "home.arpa";
  if (isPrivateIpv4 || isPrivateIpv6 || isLocalOnlyHostname && process.env.NODE_ENV === "production") {
    throw new Error("API Base URL 不允许指向私有网络或本机地址；生产环境请使用可公开访问的 HTTPS 模型服务。");
  }
  if (url.protocol === "http:" && !(isLoopbackName && process.env.NODE_ENV !== "production")) {
    throw new Error("为了保护 API Key，HTTP 仅允许非生产环境的本机 API 地址；其他地址必须使用 HTTPS。");
  }
  if (url.pathname.endsWith("/chat/completions")) {
    throw new Error("请填写 API 根地址（例如 https://api.example.com/v1），不要填写 /chat/completions。");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return url.origin + (pathname === "/" ? "" : pathname);
}

export function buildChatCompletionsEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写 API Base URL。");
  return new URL(normalized + "/chat/completions");
}

/** `GET /models` 端点：OpenAI 兼容规范，用来拉服务商的可用模型列表 */
export function buildModelsEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写 API Base URL。");
  return new URL(normalized + "/models");
}

/** API Key is accepted for saving but must be encrypted before it reaches modelConfig. */
export function readChatModelSettingsPatch(body: Record<string, unknown>): ChatModelSettingsPatch {
  const patch: ChatModelSettingsPatch = {};
  if ("chatModel" in body) {
    if (typeof body.chatModel !== "string") throw new Error("模型名称必须是文本。");
    const model = body.chatModel.trim();
    if (model.length > MAX_MODEL_LENGTH) throw new Error("模型名称不能超过 120 个字符。");
    patch.chatModel = model;
  }
  if ("chatTemperature" in body) {
    const value = body.chatTemperature;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) throw new Error("模型温度必须是 0 到 2 之间的数字。");
    patch.chatTemperature = Math.round(value * 10) / 10;
  }
  if ("chatMaxTokens" in body) {
    const value = body.chatMaxTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS) throw new Error("最大输出 Token 必须是 256 到 8192 之间的整数。");
    patch.chatMaxTokens = value;
  }
  if ("chatApiBaseUrl" in body) {
    if (typeof body.chatApiBaseUrl !== "string") throw new Error("API Base URL 必须是文本。");
    patch.chatApiBaseUrl = validateChatApiBaseUrl(body.chatApiBaseUrl);
  }
  if ("chatApiKey" in body) {
    if (typeof body.chatApiKey !== "string") throw new Error("API Key 必须是文本。");
    const key = body.chatApiKey.trim();
    if (key.length > MAX_API_KEY_LENGTH) throw new Error("API Key 不能超过 8192 个字符。");
    if (key) patch.chatApiKey = key;
  }
  if ("clearApiKey" in body) {
    if (typeof body.clearApiKey !== "boolean") throw new Error("清除 API Key 的参数无效。");
    patch.clearApiKey = body.clearApiKey;
  }
  return patch;
}

export function resolveChatModelSettings(
  value: unknown,
  fallbackModel = process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
): ResolvedChatModelSettings {
  const config = asRecord(value);
  const configuredModel = typeof config.chatModel === "string" ? config.chatModel.trim() : "";
  const temperature = config.chatTemperature;
  const maxTokens = config.chatMaxTokens;
  const configuredBaseUrl = typeof config.chatApiBaseUrl === "string" ? config.chatApiBaseUrl.trim() : "";
  const apiBaseUrl = validateChatApiBaseUrl(configuredBaseUrl || process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const characterKeySaved = isCharacterApiKeySaved(config);
  const environmentBaseUrl = validateChatApiBaseUrl(process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const environmentKeySaved = Boolean(process.env.LLM_API_KEY?.trim()) && (!configuredBaseUrl || apiBaseUrl === environmentBaseUrl);
  return {
    model: (configuredModel || fallbackModel).slice(0, MAX_MODEL_LENGTH),
    temperature: typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? Math.round(temperature * 10) / 10 : DEFAULT_TEMPERATURE,
    maxTokens: typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= MIN_MAX_TOKENS && maxTokens <= MAX_MAX_TOKENS ? maxTokens : DEFAULT_MAX_TOKENS,
    apiBaseUrl,
    apiKeyConfigured: characterKeySaved || environmentKeySaved,
    apiKeySource: characterKeySaved ? "character" : environmentKeySaved ? "environment" : "missing",
  };
}

export function isChatModelConfigured(configValue?: unknown): boolean {
  try {
    const settings = resolveChatModelSettings(configValue);
    return Boolean(settings.model && settings.apiKeyConfigured);
  } catch {
    return false;
  }
}

/**
 * 渠道回复是否允许带表情。默认关闭：默认开会变成每个角色一上来就在每句后面贴一张，
 * 而且要关的时候人已经先烦了。
 */
export function isEmojiEnabled(configValue: unknown): boolean {
  return asRecord(configValue).emojiEnabled === true;
}
