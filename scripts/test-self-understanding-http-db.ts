import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApp, createRouter, toNodeListener } from "h3";
import getSelfUnderstanding from "../server/api/characters/[id]/growth/self-understanding.get";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
import type { SelfUnderstandingView } from "../server/utils/self-understanding";

const database = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
assert.match(database.pathname, /^\/yiling_collaboration_test_[a-f0-9]{32}$/, "Run through the isolated collaboration runner only.");
process.env.YILING_ALLOW_DEV_OWNER_BYPASS = "false";
const db = getPrisma();
const router = createRouter().get("/api/characters/:id/growth/self-understanding", getSelfUnderstanding);
const api = createServer(toNodeListener(createApp().use(router)));
const originalFetch = globalThis.fetch;
const unexpectedFetches: string[] = [];
globalThis.fetch = async (input) => {
  unexpectedFetches.push(String(input));
  throw new Error("This read-only endpoint must not invoke a model or make network requests.");
};

try {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert(address && typeof address === "object");
  const get = (id: string, token?: string, query = "") => originalFetch(
    `http://127.0.0.1:${address.port}/api/characters/${id}/growth/self-understanding${query}`,
    { headers: token ? { cookie: `yiling_session=${token}` } : {} },
  );
  const owner = await db.user.create({ data: { username: `cognition-owner-${randomUUID()}`, passwordHash: "fixture", role: "USER" } });
  const other = await db.user.create({ data: { username: `cognition-other-${randomUUID()}`, passwordHash: "fixture", role: "ADMIN" } });
  const [ownerSession, otherSession] = await Promise.all([createSession({ userId: owner.id }), createSession({ userId: other.id })]);
  const role = await db.character.create({ data: { ownerId: owner.id, name: "证据页面测试角色", avatar: "https://fixture.invalid/AVATAR_URL_SENTINEL",
    basePrompt: "RAW_PROMPT_SENTINEL", modelConfig: { chatApiKey: "MODEL_KEY_SENTINEL" } } });
  const foreign = await db.character.create({ data: { ownerId: other.id, name: "OTHER_ROLE_SENTINEL", basePrompt: "fixture" } });
  const [shared, privateScope, otherShared] = await Promise.all([
    db.memoryScope.create({ data: { characterId: role.id, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } }),
    db.memoryScope.create({ data: { characterId: role.id, scopeType: "USER_PRIVATE", userId: owner.id, scopeKey: randomUUID() } }),
    db.memoryScope.create({ data: { characterId: foreign.id, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } }),
  ]);
  const contact = await db.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `fixture-${randomUUID()}`, displayName: "合成已审核好友" } });
  const contactScope = await db.memoryScope.create({ data: { characterId: role.id, scopeType: "EXTERNAL_IDENTITY", externalIdentityId: contact.id,
    scopeKey: randomUUID(), relationshipVersion: 1, relationshipStage: "FRIEND", relationshipStatus: "NORMAL", interactionCount: 2 } });
  const group = await db.conversation.create({ data: { characterId: role.id, memoryScopeId: shared.id, externalConversationId: "g:fixture" } });
  const original = await db.message.create({ data: { conversationId: group.id, role: "USER", content: "RAW_GROUP_MESSAGE_SENTINEL", occurredAt: new Date("2026-11-01T02:00:00Z") } });
  const episode = await db.memoryEvent.create({ data: { memoryScopeId: shared.id, conversationId: group.id, sourceMessageId: original.id,
    sourceMessageIds: [original.id], dayKey: "2026-11-01", occurredAt: new Date("2026-11-01T02:00:00Z"), title: "已提炼活动", detail: "合成公开摘要", dedupeKey: randomUUID() } });
  await db.memoryItem.createMany({ data: [
    { memoryScopeId: privateScope.id, category: "FACT", content: "OWNER_PRIVATE_SENTINEL" },
    { memoryScopeId: contactScope.id, category: "FACT", content: "QQ_PRIVATE_SENTINEL" },
    { memoryScopeId: otherShared.id, category: "FACT", content: "OTHER_ROLE_MEMORY_SENTINEL" },
    ...Array.from({ length: 30 }, (_, i) => ({ memoryScopeId: shared.id, category: "FACT" as const, content: `合成公开记忆 ${i} ${"据".repeat(500)}` })),
  ] });
  const preference = await db.characterPreference.create({ data: { characterId: role.id,
    kind: "LIKE", topic: "园艺", reason: "CURRENT_REASON_SENTINEL", status: "ACTIVE", revision: 2 } });
  await db.characterPreferenceRevision.createMany({ data: [
    { preferenceId: preference.id, actorId: owner.id, revision: 1, action: "CREATE", status: "ACTIVE", kind: "INTEREST", topic: "盆栽", reason: "OLD_REASON_SENTINEL", sourceType: "MANUAL", sourceRefs: [] },
    { preferenceId: preference.id, actorId: owner.id, revision: 2, action: "EDIT", status: "ACTIVE", kind: "LIKE", topic: "园艺", reason: "CURRENT_REASON_SENTINEL", sourceType: "MANUAL", sourceRefs: [] },
  ] });

  assert.equal((await get(role.id)).status, 401);
  assert.equal((await get(role.id, "invalid-token")).status, 401);
  assert.equal((await get(role.id, otherSession.token)).status, 404, "Admin role alone is not ownership");
  assert.equal((await get(foreign.id, ownerSession.token)).status, 404);
  assert.equal((await get(randomUUID(), ownerSession.token)).status, 404);
  assert.equal((await get("not-a-uuid", ownerSession.token)).status, 404);

  const groupHabit = await db.characterExpressionHabit.create({ data: { characterId: role.id, kind: "TONE", content: "群聊尽量简洁", context: "公开讨论", reason: "合成验证", status: "ACTIVE", chatScope: "GROUP" } });
  const usageBefore = await db.modelUsage.count({ where: { characterId: role.id } });
  const response = await get(role.id, ownerSession.token, `?conversationId=${group.id}&readableScopeIds=${privateScope.id}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { characterId: string; view: SelfUnderstandingView };
  assert.deepEqual(Object.keys(body).sort(), ["characterId", "view"]);
  assert.equal(body.characterId, role.id);
  assert.equal(body.view.identity.name, role.name);
  assert.equal(body.view.presentation.avatar, "configured_image");
  assert(body.view.evidence.some(row => row.id === episode.id && row.excerpt.includes("合成公开摘要")));
  assert(body.view.evidence.some(row => row.domain === "social" && row.id === contactScope.id));
  assert.equal(body.view.evidence.find(row => row.id === groupHabit.id)?.context, "适用场景：群聊 · 公开讨论");
  assert(body.view.evidence.every(row => row.scope === "character" && row.excerpt.length <= 240));
  assert.equal(body.view.evidence.filter(row => row.domain === "memory" && !row.occurredAt).length, 6);
  assert(body.view.evidence.length <= 24);
  assert.equal(body.view.history?.length, 1);
  const [change] = body.view.history ?? [];
  assert.equal(change?.id, preference.id);
  assert.equal(change?.previous.excerpt, "INTEREST: 盆栽");
  assert.equal(change?.current.excerpt, "LIKE: 园艺");
  const json = JSON.stringify(body);
  for (const sentinel of ["AVATAR_URL_SENTINEL", "RAW_PROMPT_SENTINEL", "MODEL_KEY_SENTINEL", "RAW_GROUP_MESSAGE_SENTINEL", "OWNER_PRIVATE_SENTINEL", "QQ_PRIVATE_SENTINEL", "OTHER_ROLE", "CURRENT_REASON_SENTINEL", "OLD_REASON_SENTINEL", original.id, group.id, contact.platformUid]) {
    assert(!json.includes(sentinel), `Unexpected evidence detail: ${sentinel}`);
  }
  assert.deepEqual(unexpectedFetches, []);
  assert.equal(await db.modelUsage.count({ where: { characterId: role.id } }), usageBefore);

  await db.characterPreference.update({ where: { id: preference.id }, data: { status: "DISABLED", revision: 3 } });
  const updated = await get(role.id, ownerSession.token);
  assert.equal(updated.status, 200);
  const after = await updated.json() as typeof body;
  assert(!after.view.evidence.some(row => row.id === preference.id));
  assert.deepEqual(after.view.history, [], "Disablement also removes the linked comparison");
  console.log("Self-understanding HTTP passed: owner auth, cross-role 404, bounded global evidence and owner relationship, no originals/model calls, historical freshness.");
} finally {
  globalThis.fetch = originalFetch;
  if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
  await db.$disconnect();
}
