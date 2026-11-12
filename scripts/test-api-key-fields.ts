/**
 * API Key 字段写入的回归测试。
 *
 * 起源：2026-11-12 凭据改明文之后，保存角色时旧循环先无条件删掉 `xxxApiKeyEncrypted`，
 * 又没有新值可写 —— 存量角色的 Key 静默消失，整条 QQ/网页对话停在 `model_not_configured`，
 * 表现是「她不回消息了」，页面上只有一句「未配置」。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { API_KEY_FIELDS, applyApiKeyWrites, encryptApiKey } from "../server/utils/credential-encryption";

const chat = API_KEY_FIELDS.chat;

// ① 有新值：写明文、删旧密文。
{
  const config: Record<string, unknown> = { chatApiKeyEncrypted: await encryptApiKey("sk-old") };
  await applyApiKeyWrites(config, [{ fields: chat, value: "sk-new" }]);
  assert.equal(config.chatApiKey, "sk-new", "新 Key 要落到明文字段。");
  assert.equal("chatApiKeyEncrypted" in config, false, "写完明文要清掉旧密文。");
}

// ② 明确清除：两个都删。
{
  const config: Record<string, unknown> = { chatApiKey: "sk-a", chatApiKeyEncrypted: await encryptApiKey("sk-b") };
  await applyApiKeyWrites(config, [{ fields: chat, clear: true }]);
  assert.equal("chatApiKey" in config, false, "清除要删明文。");
  assert.equal("chatApiKeyEncrypted" in config, false, "清除要删旧密文。");
}

// ③ 没新值、也没要求清除：旧密文必须迁成明文，不能直接丢。
{
  const config: Record<string, unknown> = { chatApiKeyEncrypted: await encryptApiKey("sk-legacy") };
  await applyApiKeyWrites(config, [{ fields: chat }]);
  assert.equal(config.chatApiKey, "sk-legacy", "只改人设/别名时，存量 Key 不能掉。");
  assert.equal("chatApiKeyEncrypted" in config, false, "迁移完成后旧密文退场。");
}

// ④ 明文已经在：以明文为准，旧密文只是残留。
{
  const config: Record<string, unknown> = { chatApiKey: "sk-plain", chatApiKeyEncrypted: await encryptApiKey("sk-legacy") };
  await applyApiKeyWrites(config, [{ fields: chat }]);
  assert.equal(config.chatApiKey, "sk-plain", "明文优先，不能被旧密文覆盖。");
  assert.equal("chatApiKeyEncrypted" in config, false, "残留密文顺手清掉。");
}

// ⑤ 解不开的旧密文：原样留着，等用户自己重填。
{
  const bogus = [
    "v1",
    randomBytes(12).toString("base64url"),
    randomBytes(16).toString("base64url"),
    randomBytes(24).toString("base64url"),
  ].join(".");
  const config: Record<string, unknown> = { chatApiKeyEncrypted: bogus };
  await applyApiKeyWrites(config, [{ fields: chat }]);
  assert.equal("chatApiKey" in config, false, "解不开就不要假装迁成功。");
  assert.equal(config.chatApiKeyEncrypted, bogus, "换过机器解不开时，密文要留着，不能替用户抹掉。");
}

// ⑥ 八把 Key 一起处理，互不串台。
{
  const config: Record<string, unknown> = { voiceApiKeyEncrypted: await encryptApiKey("sk-voice") };
  await applyApiKeyWrites(config, [
    { fields: chat, value: "sk-chat" },
    { fields: API_KEY_FIELDS.voice },
  ]);
  assert.equal(config.chatApiKey, "sk-chat");
  assert.equal(config.voiceApiKey, "sk-voice", "语音那把不能因为保存对话模型被删。");
}

console.log("API Key 字段写入测试通过：新值覆盖、显式清除、旧密文自动迁明文、明文优先、解不开保留、多把互不影响。");
