import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  buildChatCompletionsEndpoint,
  buildModelsEndpoint,
  readChatModelSettingsPatch,
  resolveChatModelSettings,
  validateChatApiBaseUrl,
} from "../server/utils/chat-model-config";
import { decryptApiKeyWithKey, encryptApiKeyWithKey, resolveCharacterApiKey } from "../server/utils/credential-encryption";

const defaults = resolveChatModelSettings({}, "ci-default-model");
assert.equal(defaults.model, "ci-default-model");
assert.equal(defaults.temperature, 0.7);
assert.equal(defaults.maxTokens, 1800);
assert.equal(defaults.apiBaseUrl, "https://api.openai.com/v1");
assert.equal(defaults.apiKeyConfigured, false);
assert.equal(defaults.apiKeySource, "missing");

const custom = resolveChatModelSettings({
  chatModel: " custom-model ",
  chatTemperature: 1.2,
  chatMaxTokens: 4096,
  chatApiBaseUrl: "https://api.example.com/v1/",
  chatApiKeyEncrypted: "v1.encrypted-placeholder",
}, "fallback");
assert.equal(custom.model, "custom-model");
assert.equal(custom.temperature, 1.2);
assert.equal(custom.maxTokens, 4096);
assert.equal(custom.apiBaseUrl, "https://api.example.com/v1");
assert.equal(custom.apiKeyConfigured, true);
assert.equal(custom.apiKeySource, "character");

assert.equal(resolveChatModelSettings({ chatModel: "  " }, "env-model").model, "env-model");
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").temperature, 0.7);
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").maxTokens, 1800);

assert.deepEqual(
  readChatModelSettingsPatch({
    chatModel: "  ",
    chatTemperature: 0,
    chatMaxTokens: 8192,
    chatApiBaseUrl: "https://api.deepseek.com/v1/",
    chatApiKey: "  secret-token  ",
    clearApiKey: false,
  }),
  {
    chatModel: "",
    chatTemperature: 0,
    chatMaxTokens: 8192,
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "secret-token",
    clearApiKey: false,
  },
  "API options and trimmed keys should be parsed without echoing keys in public DTOs.",
);

assert.throws(() => readChatModelSettingsPatch({ chatModel: "x".repeat(121) }), /120 个字符/);
assert.throws(() => readChatModelSettingsPatch({ chatTemperature: 2.1 }), /0 到 2/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 255 }), /256 到 8192/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 1024.5 }), /整数/);
assert.throws(() => readChatModelSettingsPatch({ chatApiKey: "k".repeat(8193) }), /8192 个字符/);
assert.throws(() => validateChatApiBaseUrl("http://api.example.com/v1"), /必须使用 HTTPS/);
assert.throws(() => validateChatApiBaseUrl("https://10.0.0.8/v1"), /私有网络/);
assert.throws(() => validateChatApiBaseUrl("https://172.16.0.1/v1"), /私有网络/);
assert.throws(() => validateChatApiBaseUrl("https://192.168.1.10/v1"), /私有网络/);
assert.throws(() => validateChatApiBaseUrl("https://169.254.169.254/latest/meta-data"), /私有网络/);
assert.throws(() => validateChatApiBaseUrl("https://100.100.100.200/v1"), /私有网络/, "Carrier-grade NAT addresses are not public provider endpoints.");
assert.throws(() => validateChatApiBaseUrl("https://198.18.0.1/v1"), /私有网络/, "Benchmarking-only IPv4 space must not be used as a provider endpoint.");
assert.throws(() => validateChatApiBaseUrl("https://203.0.113.10/v1"), /私有网络/, "Documentation-only IPv4 ranges must not be accepted as public provider endpoints.");
assert.throws(() => validateChatApiBaseUrl("https://224.0.0.1/v1"), /私有网络/, "Multicast IPv4 addresses must not be accepted.");
assert.throws(() => validateChatApiBaseUrl("https://[fd00::1]/v1"), /私有网络/);
assert.throws(() => validateChatApiBaseUrl("https://[fc00::1]/v1"), /私有网络/, "IPv6 unique-local addresses must be rejected.");
assert.throws(() => validateChatApiBaseUrl("https://[fe80::1]/v1"), /私有网络/, "IPv6 link-local addresses must be rejected.");
assert.throws(() => validateChatApiBaseUrl("https://[::ffff:7f00:1]/v1"), /私有网络/, "IPv4-mapped IPv6 loopback must not bypass IPv4 restrictions.");
assert.throws(() => validateChatApiBaseUrl("https://[::ffff:a00:1]/v1"), /私有网络/, "IPv4-mapped IPv6 private addresses must not bypass IPv4 restrictions.");
assert.throws(() => validateChatApiBaseUrl("https://[::7f00:1]/v1"), /私有网络/, "IPv4-compatible IPv6 loopback must not bypass IPv4 restrictions.");
assert.throws(() => validateChatApiBaseUrl("https://[::a00:1]/v1"), /私有网络/, "IPv4-compatible IPv6 private addresses must not bypass IPv4 restrictions.");
const originalNodeEnv = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = "production";
  assert.throws(() => validateChatApiBaseUrl("https://service.internal/v1"), /本机地址/);
  assert.throws(() => validateChatApiBaseUrl("http://127.0.0.1:4010/v1"), /本机地址/);
  assert.throws(() => validateChatApiBaseUrl("https://127.0.0.2/v1"), /本机地址/);
  assert.throws(() => validateChatApiBaseUrl("https://service.localhost/v1"), /本机地址/);
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}
assert.throws(() => validateChatApiBaseUrl("ftp://api.example.com/v1"), /只支持 HTTPS/);
assert.throws(() => validateChatApiBaseUrl("https://user:pass@api.example.com/v1"), /不应包含用户名/);
assert.throws(() => validateChatApiBaseUrl("https://api.example.com/v1/chat/completions"), /不要填写 \/chat\/completions/);
assert.equal(validateChatApiBaseUrl("http://127.0.0.1:4010/v1/"), "http://127.0.0.1:4010/v1");
assert.equal(validateChatApiBaseUrl("http://[::1]:4010/v1/"), "http://[::1]:4010/v1", "Development should retain local IPv6 loopback support.");
assert.equal(buildChatCompletionsEndpoint("https://api.example.com/v1").href, "https://api.example.com/v1/chat/completions");
// 模型列表接口：尾斜杠要被吃掉，根地址要直接拼 /models
assert.equal(buildModelsEndpoint("https://api.deepseek.com/").href, "https://api.deepseek.com/models");
assert.equal(buildModelsEndpoint("https://api.example.com/v1").href, "https://api.example.com/v1/models");
assert.throws(() => buildModelsEndpoint(""), /请先填写 API Base URL/);
assert.throws(() => buildModelsEndpoint("https://api.example.com/v1/chat/completions"), /不要填写 \/chat\/completions/);

const encryptionKey = randomBytes(32);
const plaintextKey = "api-key-must-not-be-stored-in-plain-text";
const encryptedKey = encryptApiKeyWithKey(plaintextKey, encryptionKey);
assert.notEqual(encryptedKey, plaintextKey);
assert.match(encryptedKey, /^v1\./);
assert.equal(decryptApiKeyWithKey(encryptedKey, encryptionKey), plaintextKey);
assert.throws(() => decryptApiKeyWithKey(encryptedKey, randomBytes(32)), /Unsupported state|authenticate|unable to authenticate/i);

const previousApiKey = process.env.LLM_API_KEY;
const previousBaseUrl = process.env.LLM_BASE_URL;
try {
  process.env.LLM_API_KEY = "global-fallback-test-key";
  process.env.LLM_BASE_URL = "https://api.example.com/v1/";
  assert.equal(
    await resolveCharacterApiKey({}, "https://api.example.com/v1"),
    "global-fallback-test-key",
    "The global key should be usable with the configured global provider URL.",
  );
  assert.equal(
    await resolveCharacterApiKey({}, "https://other-provider.example/v1"),
    "",
    "The global key must never be sent to a character-specific provider URL.",
  );
} finally {
  if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = previousApiKey;
  if (previousBaseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = previousBaseUrl;
}

console.log("Chat API settings tests passed: URL safety, encryption round-trip, per-character key isolation, defaults, and malformed input boundaries.");
