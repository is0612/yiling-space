/**
 * 凭据存储。
 *
 * 2026-11-12 改成明文：加密这层挡不住真威胁（密钥文件 `credentials-encryption.key`
 * 和数据库放在同一台机器上，拿到库的人基本也拿得到密钥），却挡住了用户自己核对 ——
 * 「这个助手的 Key 到底填了没、填的是哪把」在页面上永远是空白。
 * 现在明文存进 modelConfig，页面用密码框显示，至少能看见配了什么。
 *
 * 旧密文仍然读得出来（`v1.` 前缀走解密），保证迁移脚本跑完之前存量角色不掉线。
 * 新增写入一律写明文字段，密文字段只在兼容读取时出现。
 */
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

/** 只用来判断「是不是同一个地址」，不做格式校验（那件事归 chat-model-config）。 */
function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
type ApiKeyFieldPair = { plain: string; legacy: string };

export type ApiKeyWrite = { fields: ApiKeyFieldPair; value?: string; clear?: boolean };

/**
 * 把一次保存里的 Key 变更落到 modelConfig 上。
 *
 * 三条不能破的规矩，全是踩出来的：
 * ① 有新值：写明文字段、删旧密文；
 * ② 明确清除：两个都删；
 * ③ 既没新值也没要求清除：**旧密文不能直接删**。存量的 Key 还躺在旧字段里，
 *    先解密迁成明文再删；解不开（换过机器）就原样留着，等用户重填。
 *
 * 2026-11-12 实况：② 之前写成「先无条件 delete legacy，再按需写明文」，于是用户
 * 保存一次角色，Key 静默消失，整条渠道停在 `model_not_configured`，群里一个字不回。
 */
export async function applyApiKeyWrites(
  config: Record<string, unknown>,
  writes: readonly ApiKeyWrite[],
): Promise<void> {
  for (const write of writes) {
    if (write.value) {
      config[write.fields.plain] = write.value;
      delete config[write.fields.legacy];
      continue;
    }
    if (write.clear) {
      delete config[write.fields.plain];
      delete config[write.fields.legacy];
      continue;
    }
    const legacy = config[write.fields.legacy];
    if (typeof legacy !== "string" || !legacy.startsWith("v1.")) continue;
    const plainSaved = config[write.fields.plain];
    if (typeof plainSaved === "string" && plainSaved.trim()) {
      // 明文已经在：以它为准，旧密文只是残留。
      delete config[write.fields.legacy];
      continue;
    }
    const migrated = await decryptApiKey(legacy).catch(() => "");
    if (migrated) {
      config[write.fields.plain] = migrated;
      delete config[write.fields.legacy];
    }
  }
}

/**
 * 八把 Key 的字段名。新增服务商时在这里补一行，别在各处再手写一遍字符串 ——
 * 名字写错的表现是「明明填了却说没配」，最难查。
 */
export const API_KEY_FIELDS = {
  chat: { plain: "chatApiKey", legacy: "chatApiKeyEncrypted" },
  voice: { plain: "voiceApiKey", legacy: "voiceApiKeyEncrypted" },
  asr: { plain: "asrApiKey", legacy: "asrApiKeyEncrypted" },
  vision: { plain: "visionApiKey", legacy: "visionApiKeyEncrypted" },
  memoryAssistant: { plain: "memoryAssistantApiKey", legacy: "memoryAssistantApiKeyEncrypted" },
  contextAssistant: { plain: "contextAssistantApiKey", legacy: "contextAssistantApiKeyEncrypted" },
  knowledgeAssistant: { plain: "knowledgeAssistantApiKey", legacy: "knowledgeAssistantApiKeyEncrypted" },
  socialRelationshipAssessmentAssistant: {
    plain: "socialRelationshipAssessmentAssistantApiKey",
    legacy: "socialRelationshipAssessmentAssistantApiKeyEncrypted",
  },
} as const satisfies Record<string, ApiKeyFieldPair>;

/**
 * 读一把 Key：明文优先，退回旧密文。解不开就当没配 ——
 * 一个损坏的密文不该让整个设置页崩掉。
 */
export async function readApiKeyField(configValue: unknown, fields: ApiKeyFieldPair): Promise<string> {
  const config = asRecord(configValue);
  const plain = config[fields.plain];
  if (typeof plain === "string" && plain.trim()) return plain.trim();
  const legacy = config[fields.legacy];
  if (typeof legacy !== "string" || !legacy.startsWith("v1.")) return "";
  try {
    return (await decryptApiKey(legacy)).trim();
  } catch {
    return "";
  }
}

/**
 * 只读明文字段，不解密。给同步场景（DTO）用：回显需要的是明文，
 * 而旧密文本来也回显不出来 —— 页面看到「已配置」但输入框空，就是这种情况。
 */
export function readApiKeyFieldPlain(configValue: unknown, fields: ApiKeyFieldPair): string {
  const config = asRecord(configValue);
  const value = config[fields.plain];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 是否存过 Key。同步版本：只说「有没有」，不尝试解密 ——
 * DTO 是同步构建的，为了一个布尔值把它整条链改成 async 不值得。
 */
export function isApiKeyFieldSaved(configValue: unknown, fields: ApiKeyFieldPair): boolean {
  const config = asRecord(configValue);
  const plain = config[fields.plain];
  if (typeof plain === "string" && plain.trim()) return true;
  const legacy = config[fields.legacy];
  return typeof legacy === "string" && legacy.startsWith("v1.");
}

/**
 * 角色自己的对话 Key。
 *
 * `effectiveBaseUrl` 是这次真正要请求的地址。角色 Key 只属于角色配置的那个地址：
 * 换了别家还把这把 Key 发过去只会 401，而报错只写「鉴权失败」，指不到这里。
 * 所以地址不一致时返回空字符串，让调用方自己决定怎么办。
 */
export async function resolveCharacterApiKey(configValue: unknown, effectiveBaseUrl?: string): Promise<string> {
  const config = asRecord(configValue);
  const ownKey = await readApiKeyField(configValue, API_KEY_FIELDS.chat);
  if (ownKey) {
    const configured = normalizeEndpoint(
      typeof config.chatApiBaseUrl === "string" && config.chatApiBaseUrl.trim()
        ? config.chatApiBaseUrl
        : process.env.LLM_BASE_URL?.trim() || DEFAULT_ENDPOINT,
    );
    if (!effectiveBaseUrl || normalizeEndpoint(effectiveBaseUrl) === configured) return ownKey;
    return "";
  }

  const environmentKey = process.env.LLM_API_KEY?.trim() || "";
  if (!environmentKey) return "";
  // 同理：全局兜底 Key 不发给另一家地址。
  const environmentBaseUrl = normalizeEndpoint(process.env.LLM_BASE_URL?.trim() || DEFAULT_ENDPOINT);
  return normalizeEndpoint(effectiveBaseUrl || environmentBaseUrl) === environmentBaseUrl ? environmentKey : "";
}

export function isCharacterApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.chat);
}

/**
 * 语音服务的 Key（TTS 与 ASR 共用一个：硅基流动这类一家全包，分开配只会让人填两遍）。
 *
 * 与聊天 Key 分开存是关键：它几乎总是**不同的服务商**（DeepSeek 没有语音接口），
 * 混用一份字段会导致「换语音服务商时把聊天 Key 也换了」。
 * 返回空字符串 = 没配（调用方自己去回落环境变量）。
 */
export async function resolveCharacterVoiceApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.voice);
}

export function isVoiceApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.voice);
}

/**
 * 识别（ASR）专用的 Key。
 *
 * 为什么要有第二把：`voiceApiKey` 是 TTS 与 ASR 共用的，默认假设「一家全包」
 * （硅基流动那样）。可一旦合成换成只做合成的服务商（Breeze、OpenAI 官方），
 * 那条共用路径就会把这家的 Key 喂给识别服务商，换回来一个 401 —— 报错里只写
 * 「鉴权失败」，看不出是拿错了 Key。所以识别允许单独填一把，留空才回落到共用的。
 */
export async function resolveCharacterAsrApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.asr);
}

export function isAsrApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.asr);
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
  return readApiKeyField(configValue, API_KEY_FIELDS.vision);
}

export function isVisionApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.vision);
}

/*
 * 下面四个助手（记忆 / 语境 / 知识 / 关系评估）在 2026-11-12 之前刻意「不回落到聊天 Key」，
 * 因为它们可能指向另一家服务商，把聊天凭据发过去必然 401。
 *
 * 现在的规则更细：**留空且地址与对话模型一致**时才继承对话 Key（见各运行期的
 * resolve*AssistantRuntime）。这个函数本身只负责「这把助手 Key 有没有自己存」，
 * 不掺和继承 —— 继承判断要拿到地址，那是调用方的事。
 */

export async function resolveCharacterMemoryAssistantApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.memoryAssistant);
}

export function isMemoryAssistantApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.memoryAssistant);
}

export async function resolveCharacterContextAssistantApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.contextAssistant);
}

export function isContextAssistantApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.contextAssistant);
}

export async function resolveCharacterKnowledgeAssistantApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.knowledgeAssistant);
}

export function isKnowledgeAssistantApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.knowledgeAssistant);
}

export async function resolveCharacterSocialRelationshipAssessmentAssistantApiKey(configValue: unknown): Promise<string> {
  return readApiKeyField(configValue, API_KEY_FIELDS.socialRelationshipAssessmentAssistant);
}

export function isSocialRelationshipAssessmentAssistantApiKeySaved(configValue: unknown): boolean {
  return isApiKeyFieldSaved(configValue, API_KEY_FIELDS.socialRelationshipAssessmentAssistant);
}
