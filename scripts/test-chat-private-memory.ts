import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import {
  buildUserPrivateScopeKey,
  readStoredMemoryScopeOrigin,
  resolveChatMemoryScopes,
} from "../server/utils/memory-scope-access";

const actingUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const characterId = "33333333-3333-4333-8333-333333333333";

// 1. Scope isolation matrix: only character-global scopes and the acting user's own private
// scopes may be read. Another user's private scope, unverified identities, dangling scopes and
// unknown scope types must all be dropped.
const accessible = resolveChatMemoryScopes([
  { id: "scope-global", scopeType: "CHARACTER_GLOBAL" },
  { id: "scope-own", scopeType: "USER_PRIVATE", userId: actingUserId },
  { id: "scope-other-user", scopeType: "USER_PRIVATE", userId: otherUserId },
  {
    id: "scope-unverified-identity",
    scopeType: "USER_PRIVATE",
    externalIdentityId: "identity-1",
    externalIdentity: { status: "UNVERIFIED", linkedUserId: actingUserId },
  },
  {
    id: "scope-verified-identity",
    scopeType: "USER_PRIVATE",
    externalIdentityId: "identity-2",
    externalIdentity: { status: "VERIFIED", linkedUserId: actingUserId },
  },
  {
    id: "scope-verified-other",
    scopeType: "USER_PRIVATE",
    externalIdentityId: "identity-3",
    externalIdentity: { status: "VERIFIED", linkedUserId: otherUserId },
  },
  { id: "scope-dangling", scopeType: "USER_PRIVATE", userId: null, externalIdentityId: null },
  { id: "scope-external", scopeType: "EXTERNAL_IDENTITY", externalIdentityId: "identity-4" },
], actingUserId);

assert.deepEqual(
  accessible.map((scope) => scope.id),
  ["scope-global", "scope-own", "scope-verified-identity"],
  "Only global scopes and the acting user's own verified private scopes may be read.",
);
assert.deepEqual(
  accessible.map((scope) => scope.origin),
  ["character", "private", "private"],
  "Scope origins must be labelled so the prompt can separate shared from private context.",
);
assert(
  !accessible.some((scope) => scope.id === "scope-other-user"),
  "Another user's private scope must never be readable.",
);
assert(
  !accessible.some((scope) => scope.id === "scope-unverified-identity"),
  "Unverified external identities must not be merged into the acting user's context.",
);
assert(
  !accessible.some((scope) => scope.id === "scope-external"),
  "Only CHARACTER_GLOBAL and USER_PRIVATE scopes are readable in chat.",
);

// 2. Duplicates collapse so a scope cannot be counted twice.
const deduped = resolveChatMemoryScopes([
  { id: "scope-global", scopeType: "CHARACTER_GLOBAL" },
  { id: "scope-global", scopeType: "CHARACTER_GLOBAL" },
  { id: "scope-own", scopeType: "USER_PRIVATE", userId: actingUserId },
  { id: "scope-own", scopeType: "USER_PRIVATE", userId: actingUserId },
], actingUserId);
assert.deepEqual(deduped.map((scope) => scope.id), ["scope-global", "scope-own"]);

// 3. A character with no global scope yields no readable scope at all, so the caller fails loudly
// instead of silently falling back to private memory.
assert.deepEqual(
  resolveChatMemoryScopes([{ id: "scope-own", scopeType: "USER_PRIVATE", userId: actingUserId }], actingUserId)
    .filter((scope) => scope.origin === "character"),
  [],
);

// 4. Private scope keys are deterministic per character + user.
assert.equal(
  buildUserPrivateScopeKey(characterId, actingUserId),
  "character:" + characterId + ":user:" + actingUserId,
);

// 5. Sources stored before scope tracking existed stay character-global.
assert.equal(readStoredMemoryScopeOrigin(undefined), "character");
assert.equal(readStoredMemoryScopeOrigin("private"), "private");
assert.equal(readStoredMemoryScopeOrigin("something-else"), "character");

// 6. The prompt carries the scope label but never the scope IDs or user identifiers.
const originalFetch = globalThis.fetch;
let capturedBody = "";
globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-chat-model",
    choices: [{
      message: {
        role: "assistant",
        content: JSON.stringify({ reply: "记得。", usedMemoryIds: ["memory-private", "memory-global"], usedSnapshotIds: [] }),
      },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const result = await generateConversationReply({
    characterName: "测试角色",
    characterPrompt: "自然地回复。",
    model: "test-chat-model",
    apiKey: "sk-private-memory-test",
    apiBaseUrl: "https://private-provider.example/v1",
    currentMessage: "你还记得我上次说的计划吗？",
    recentMessages: [],
    memories: [
      { id: "memory-private", category: "GOAL", content: "我想在年底前完成转岗。", confidence: 0.9, relevanceScore: 6, scope: "private" },
      { id: "memory-global", category: "FACT", content: "这个角色喜欢较短的回复。", confidence: 0.8, relevanceScore: 3, scope: "character" },
    ],
    snapshots: [{ id: "snapshot-private", summary: "近期聊过转岗计划。", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-09T00:00:00.000Z", version: 1, relevanceScore: 2, scope: "private" }],
  });

  assert.equal(result.promptTemplateVersion, "conversation-retrieval-v23");
  assert.deepEqual(result.usedMemoryIds, ["memory-private", "memory-global"]);

  const requestBody = JSON.parse(capturedBody) as {
    messages: Array<{ role: string; content: string }>;
  };
  const systemMessage = requestBody.messages.find((item) => item.role === "system");
  assert(systemMessage, "The system prompt must exist.");
  assert(
    systemMessage.content.includes("scope") && systemMessage.content.includes("private"),
    "The system prompt must explain how private scope changes the reply rules.",
  );

  const userMessage = requestBody.messages.find((item) => item.role === "user");
  assert(userMessage, "The request must include a structured user context.");
  const promptInput = JSON.parse(userMessage.content) as {
    memories: Array<Record<string, unknown>>;
    snapshots: Array<Record<string, unknown>>;
  };
  assert.equal(promptInput.memories[0]?.scope, "private");
  assert.equal(promptInput.memories[1]?.scope, "character");
  assert.equal(promptInput.snapshots[0]?.scope, "private");
  assert.deepEqual(
    Object.keys(promptInput.memories[0] ?? {}).sort(),
    ["category", "confidence", "content", "id", "relevanceScore", "scope"],
    "Memory prompts must serialize only reply-relevant fields.",
  );
  for (const leaked of [actingUserId, otherUserId, characterId, "scope-own", "scope-global", buildUserPrivateScopeKey(characterId, actingUserId)]) {
    assert(!capturedBody.includes(leaked), "Scope IDs and user identifiers must not appear in the model prompt: " + leaked);
  }
  console.log("Private memory isolation tests passed: scope allow-list, unverified identity rejection, dedupe, legacy source defaults, and scope-labelled prompt without identifier leakage.");
} finally {
  globalThis.fetch = originalFetch;
}
