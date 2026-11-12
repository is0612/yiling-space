/**
 * 助手（记忆 / 语境 / 知识 / 关系评估）与对话模型之间的关系。
 *
 * 2026-11-12 之前，这四个助手各自必须填一整套「服务商 + 地址 + Key + 模型名」才能启用。
 * 结果是同一个 Key 在五个地方各填一遍 —— 换服务商时漏掉一处，表现就是某个助手
 * 悄悄失败，而报错只写「鉴权失败」，看不出是它。
 *
 * 现在改成默认继承对话模型，只有真想换别家时才逐字段覆写：
 *   - 模型名、地址：留空 → 用对话模型的
 *   - API Key：留空 **且** 地址与对话模型一致 → 用对话模型的；
 *     地址不一样时**不继承** —— 把 A 家的 Key 发到 B 家只会换回 401，
 *     而这种失败最容易被误读成「Key 填错了」。
 *
 * 继承判断集中在这里，四个助手各自只管调用，别再各写一遍 if。
 */
import { resolveChatModelSettings } from "./chat-model-config";
import { API_KEY_FIELDS, readApiKeyField, resolveCharacterApiKey } from "./credential-encryption";

export type AssistantFieldNames = {
  /** 助手自己的模型名字段；空字符串 = 跟随对话模型 */
  model: string;
  /** 助手自己的地址字段；空字符串 = 跟随对话模型 */
  baseUrl: string;
  /** 助手自己的 Key 字段（明文 + 旧密文两个名字） */
  apiKey: { plain: string; legacy: string };
};

/**
 * 四个助手的字段名。保存校验和运行期读的是同一份 ——
 * 分开写两份的结果是「保存时校验通过、运行时读不到」，最难查的那种不一致。
 */
export const ASSISTANT_FIELDS = {
  memory: {
    model: "memoryAssistantModel",
    baseUrl: "memoryAssistantApiBaseUrl",
    apiKey: API_KEY_FIELDS.memoryAssistant,
  },
  context: {
    model: "contextAssistantModel",
    baseUrl: "contextAssistantApiBaseUrl",
    apiKey: API_KEY_FIELDS.contextAssistant,
  },
  knowledge: {
    model: "knowledgeAssistantModel",
    baseUrl: "knowledgeAssistantApiBaseUrl",
    apiKey: API_KEY_FIELDS.knowledgeAssistant,
  },
  socialAssessment: {
    model: "socialRelationshipAssessmentAssistantModel",
    baseUrl: "socialRelationshipAssessmentAssistantApiBaseUrl",
    apiKey: API_KEY_FIELDS.socialRelationshipAssessmentAssistant,
  },
} as const satisfies Record<string, AssistantFieldNames>;

export type ResolvedAssistantConnection = {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  modelSource: "assistant" | "chat";
  baseUrlSource: "assistant" | "chat";
  apiKeySource: "assistant" | "chat" | "environment" | "missing";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 解出一个助手的实际连接信息。
 *
 * 地址先解析再判断 Key 继承：先看助手有没有单独填地址，没有才跟随对话模型。
 * `chatSettings.apiBaseUrl` 已经过 validateChatApiBaseUrl 归一化，
 * 所以这里比较的是「归一化后的对话地址 vs 助手自己填的地址」。
 */
export async function resolveAssistantConnection(
  configValue: unknown,
  fields: AssistantFieldNames,
): Promise<ResolvedAssistantConnection> {
  const config = asRecord(configValue);
  const chat = resolveChatModelSettings(configValue);

  const configuredModel = text(config[fields.model], 120);
  const configuredBaseUrl = text(config[fields.baseUrl], 500);

  const model = configuredModel || chat.model;
  const apiBaseUrl = configuredBaseUrl || chat.apiBaseUrl;

  const ownKey = await readApiKeyField(configValue, fields.apiKey);
  if (ownKey) {
    return {
      model,
      apiBaseUrl,
      apiKey: ownKey,
      modelSource: configuredModel ? "assistant" : "chat",
      baseUrlSource: configuredBaseUrl ? "assistant" : "chat",
      apiKeySource: "assistant",
    };
  }

  // 没单独填 Key。只有地址和对话模型一致时才借用它的 Key。
  const inheritsKey = normalizeEndpoint(apiBaseUrl) === normalizeEndpoint(chat.apiBaseUrl);
  if (!inheritsKey) {
    return {
      model,
      apiBaseUrl,
      apiKey: "",
      modelSource: configuredModel ? "assistant" : "chat",
      baseUrlSource: configuredBaseUrl ? "assistant" : "chat",
      apiKeySource: "missing",
    };
  }

  const chatKey = await resolveCharacterApiKey(configValue, apiBaseUrl).catch(() => "");
  return {
    model,
    apiBaseUrl,
    apiKey: chatKey,
    modelSource: configuredModel ? "assistant" : "chat",
    baseUrlSource: configuredBaseUrl ? "assistant" : "chat",
    apiKeySource: chatKey ? (chat.apiKeySource === "environment" ? "environment" : "chat") : "missing",
  };
}

/** 助手是否「留空、完全跟随对话模型」：页面用它决定显示「跟随对话模型」还是具体值。 */
export function isAssistantFullyInherited(configValue: unknown, fields: AssistantFieldNames): boolean {
  const config = asRecord(configValue);
  return !text(config[fields.model]) && !text(config[fields.baseUrl]) && !text(config[fields.apiKey.plain]);
}

export type AssistantConnectionSummary = {
  model: string;
  apiBaseUrl: string;
  hasApiKey: boolean;
  modelSource: "assistant" | "chat";
  baseUrlSource: "assistant" | "chat";
};

/**
 * 同步版的连接摘要，给 DTO 用。
 *
 * DTO 是同步构建的，不能为了判断一个布尔值把整条链改成 async。
 * 所以这里只判断「有没有配」，不尝试解旧密文 —— 密文也算「有」，
 * 反正迁移脚本跑过之后就不该再有密文了。
 */
export function summarizeAssistantConnection(
  configValue: unknown,
  fields: AssistantFieldNames,
  chat: { model: string; apiBaseUrl: string; apiKeyConfigured: boolean },
): AssistantConnectionSummary {
  const config = asRecord(configValue);
  const configuredModel = text(config[fields.model], 120);
  const configuredBaseUrl = text(config[fields.baseUrl], 500);
  const model = configuredModel || chat.model;
  const apiBaseUrl = configuredBaseUrl || chat.apiBaseUrl;

  const ownKey = text(config[fields.apiKey.plain], 8192);
  const legacyKey = typeof config[fields.apiKey.legacy] === "string"
    && (config[fields.apiKey.legacy] as string).startsWith("v1.");
  const inheritsKey = normalizeEndpoint(apiBaseUrl) === normalizeEndpoint(chat.apiBaseUrl) && chat.apiKeyConfigured;

  return {
    model,
    apiBaseUrl,
    hasApiKey: Boolean(ownKey) || legacyKey || inheritsKey,
    modelSource: configuredModel ? "assistant" : "chat",
    baseUrlSource: configuredBaseUrl ? "assistant" : "chat",
  };
}
