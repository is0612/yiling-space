import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const KEY_PATH = resolve(process.cwd(), ".data", "credentials-encryption.key");
let cachedKey: Promise<Buffer> | null = null;

async function loadEncryptionKey(): Promise<Buffer> {
  try {
    const existing = await readFile(KEY_PATH);
    if (existing.length !== 32) throw new Error("本地凭据加密密钥文件长度无效。");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32);
  try {
    await writeFile(KEY_PATH, generated, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(KEY_PATH);
    if (existing.length !== 32) throw new Error("本地凭据加密密钥文件长度无效。");
    return existing;
  }
}

async function getEncryptionKey(): Promise<Buffer> {
  cachedKey ??= loadEncryptionKey();
  return cachedKey;
}

export function encryptApiKeyWithKey(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("凭据加密密钥必须为 32 字节。");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptApiKeyWithKey(encrypted: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("凭据加密密钥必须为 32 字节。");
  const [version, ivText, tagText, dataText, extra] = encrypted.split(".");
  if (version !== "v1" || !ivText || !tagText || dataText === undefined || extra !== undefined) {
    throw new Error("已保存的 API Key 加密格式无效。");
  }
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(dataText, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("已保存的 API Key 加密参数无效。");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function encryptApiKey(plaintext: string): Promise<string> {
  return encryptApiKeyWithKey(plaintext, await getEncryptionKey());
}

export async function decryptApiKey(encrypted: string): Promise<string> {
  return decryptApiKeyWithKey(encrypted, await getEncryptionKey());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function resolveCharacterApiKey(configValue: unknown, effectiveBaseUrl?: string): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.chatApiKeyEncrypted;
  if (typeof encrypted === "string" && encrypted.startsWith("v1.")) {
    const decrypted = await decryptApiKey(encrypted);
    if (decrypted.trim()) return decrypted.trim();
  }

  const environmentKey = process.env.LLM_API_KEY?.trim() || "";
  if (!environmentKey) return "";
  // Never send a global fallback key to a different per-character endpoint.
  const environmentBaseUrl = (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const targetBaseUrl = (effectiveBaseUrl || environmentBaseUrl).replace(/\/+$/, "");
  return targetBaseUrl === environmentBaseUrl ? environmentKey : "";
}

export function isCharacterApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.chatApiKeyEncrypted === "string" && config.chatApiKeyEncrypted.startsWith("v1.");
}

/**
 * 语音服务的 Key（TTS 与 ASR 共用一个：硅基流动这类一家全包，分开配只会让人填两遍）。
 *
 * 与聊天 Key 分开存是关键：它几乎总是**不同的服务商**（DeepSeek 没有语音接口），
 * 混用一份字段会导致「换语音服务商时把聊天 Key 也换了」。
 * 返回空字符串 = 没配（调用方自己去回落环境变量）。
 */
export async function resolveCharacterVoiceApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.voiceApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  const decrypted = await decryptApiKey(encrypted);
  return decrypted.trim();
}

export function isVoiceApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.voiceApiKeyEncrypted === "string" && config.voiceApiKeyEncrypted.startsWith("v1.");
}

/**
 * 识别（ASR）专用的 Key。
 *
 * 为什么要有第二把：`voiceApiKeyEncrypted` 是 TTS 与 ASR 共用的，默认假设「一家全包」
 * （硅基流动那样）。可一旦合成换成只做合成的服务商（Breeze、OpenAI 官方），
 * 那条共用路径就会把这家的 Key 喂给识别服务商，换回来一个 401 —— 报错里只写
 * 「鉴权失败」，看不出是拿错了 Key。所以识别允许单独填一把，留空才回落到共用的。
 */
export async function resolveCharacterAsrApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.asrApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  const decrypted = await decryptApiKey(encrypted);
  return decrypted.trim();
}

export function isAsrApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.asrApiKeyEncrypted === "string" && config.asrApiKeyEncrypted.startsWith("v1.");
}

/**
 * 图片（看图 / 以后的生图）模型的 Key。
 *
 * 和语音同一套理由，甚至更硬：视觉模型几乎必然是**另一家**服务商
 * （DeepSeek 没有视觉接口，看图得去智谱 / 通义 / OpenAI），
 * 混用聊天那把 Key 打过去只会拿到 401，而且报错信息完全看不出是这个原因。
 *
 * 返回空字符串 = 没配，调用方自己往环境变量、再往聊天 Key 回落。
 */
export async function resolveCharacterVisionApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.visionApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  const decrypted = await decryptApiKey(encrypted);
  return decrypted.trim();
}

/**
 * 记忆助手使用独立凭据。这里故意不回落到聊天 Key 或环境变量：
 * 助手可能指向另一家服务商，绝不能把聊天凭据发到另一个 API 地址。
 */
export async function resolveCharacterMemoryAssistantApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.memoryAssistantApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  const decrypted = await decryptApiKey(encrypted);
  return decrypted.trim();
}

export function isMemoryAssistantApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.memoryAssistantApiKeyEncrypted === "string"
    && config.memoryAssistantApiKeyEncrypted.startsWith("v1.");
}

/** 语境助手凭据独立保存，不回落聊天、记忆助手或环境变量 Key。 */
export async function resolveCharacterContextAssistantApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.contextAssistantApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  return (await decryptApiKey(encrypted)).trim();
}

export function isContextAssistantApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.contextAssistantApiKeyEncrypted === "string"
    && config.contextAssistantApiKeyEncrypted.startsWith("v1.");
}

export function isVisionApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.visionApiKeyEncrypted === "string" && config.visionApiKeyEncrypted.startsWith("v1.");
}


/** 知识处理助手使用独立凭据，不回落到聊天、记忆或语境助手 Key。 */
export async function resolveCharacterKnowledgeAssistantApiKey(configValue: unknown): Promise<string> {
  const config = asRecord(configValue);
  const encrypted = config.knowledgeAssistantApiKeyEncrypted;
  if (typeof encrypted !== "string" || !encrypted.startsWith("v1.")) return "";
  return (await decryptApiKey(encrypted)).trim();
}

export function isKnowledgeAssistantApiKeySaved(configValue: unknown): boolean {
  const config = asRecord(configValue);
  return typeof config.knowledgeAssistantApiKeyEncrypted === "string"
    && config.knowledgeAssistantApiKeyEncrypted.startsWith("v1.");
}
