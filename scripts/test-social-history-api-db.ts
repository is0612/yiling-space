import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import { collectSocialAssessmentSourceManifest } from "../server/utils/social-assessment-evidence";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname), "Social history API checks require local PostgreSQL.");
assert(/^\/yiling_social_review_test_[a-f0-9]{32}$/.test(databaseUrl.pathname), "Run through the disposable social review database only.");
const prisma = getPrisma();
const originalBypass = process.env.YILING_ALLOW_DEV_OWNER_BYPASS;
process.env.YILING_ALLOW_DEV_OWNER_BYPASS = "false";
(globalThis as Record<string, unknown>).defineEventHandler = (handler: unknown) => handler;
const handler = (await import("../server/api/characters/[id]/growth/social/assessments.get")).default;
const app = createApp();
const router = createRouter();
router.get("/characters/:id/growth/social/assessments", handler);
app.use(router);
const server = createServer(toNodeListener(app));
const owners: string[] = [];
const characters: string[] = [];
const identities: string[] = [];
let listening = false;

type Item = { id: string; status: string; outcome: string | null; reviewStatus: string; canReview: boolean; staleReason: string | null; evidence: Array<{ id: string; detail: string }>; observations: unknown };
type Result = { items: Item[]; total: number; page: number; pageSize: number; totalPages: number; summary: { all: number; actionable: number; accepted: number; failed: number; running: number } };
async function get(characterId: string, cookie: string | undefined, query = "") {
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/characters/${characterId}/growth/social/assessments${query}`, {
    headers: cookie ? { cookie: `yiling_session=${cookie}` } : {}, signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as Result };
}
try {
  for (let index = 0; index < 2; index++) {
    const owner = await prisma.user.create({ data: { username: `history-api-${randomUUID()}`, passwordHash: "isolated-only", role: "USER", status: "ACTIVE" } });
    owners.push(owner.id);
  }
  for (const ownerId of [owners[0]!, owners[0]!, owners[1]!]) {
    const character = await prisma.character.create({ data: { ownerId, name: "社交历史接口测试角色", basePrompt: "synthetic" } });
    characters.push(character.id);
  }
  const globalScopes: string[] = [];
  const relationScopes: string[] = [];
  for (const characterId of characters) {
    const identity = await prisma.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `history-api-${randomUUID()}`, displayName: "测试好友" } });
    identities.push(identity.id);
    globalScopes.push((await prisma.memoryScope.create({ data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } })).id);
    relationScopes.push((await prisma.memoryScope.create({ data: { characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: randomUUID(), externalIdentityId: identity.id, relationshipStage: "STRANGER", relationshipStatus: "UNOBSERVED", relationshipVersion: 0 } })).id);
  }
  const ownerSession = await createSession({ userId: owners[0]! });
  const foreignSession = await createSession({ userId: owners[1]! });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); listening = true;

  async function assessment(input: { role?: number; kind?: "valid" | "version" | "legacy" | "archived" | "cross-source"; execution?: "SUCCEEDED" | "FAILED" | "RUNNING"; review?: "PENDING" | "DEFERRED" | "ACCEPTED" | "REJECTED" | "STALE"; }) {
    const role = input.role ?? 0;
    const sourceRole = input.kind === "cross-source" ? 2 : role;
    const source = await prisma.memoryEvent.create({ data: { memoryScopeId: globalScopes[sourceRole]!, dayKey: "2026-11-10", occurredAt: new Date(), title: "关系依据", detail: input.kind === "cross-source" ? "FOREIGN_SOURCE_SECRET_MUST_NOT_LEAK" : "同一角色的有效社交经历", dedupeKey: randomUUID() } });
    const experience = await prisma.socialExperience.create({ data: { scopeId: relationScopes[role]!, memoryEventId: source.id, sourceKey: randomUUID() } });
    const manifest = await collectSocialAssessmentSourceManifest(prisma, characters[role]!, relationScopes[role]!, [experience.id]);
    const execution = input.execution ?? "SUCCEEDED";
    const row = await prisma.socialRelationshipAssessment.create({ data: {
      scopeId: relationScopes[role]!, generation: 1, evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED", relationshipVersion: input.kind === "version" ? 3 : 0,
      outcome: execution === "SUCCEEDED" ? "CHANGE" : null, suggestedStage: "ACQUAINTANCE", suggestedStatus: "NORMAL", reason: "synthetic suggestion",
      observations: { evidenceExperienceIds: [experience.id], newEvidenceExperienceIds: [experience.id], ...(input.kind === "legacy" ? {} : { sourceManifest: manifest }) },
      status: execution, reviewStatus: input.review ?? "PENDING", error: execution === "FAILED" ? "模拟失败" : null,
      evidence: { create: [{ experienceId: experience.id, kind: "NEW" }] },
    } });
    if (input.kind === "archived") await prisma.memoryEvent.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
    return { row, source, experience };
  }
  const valid = await assessment({ kind: "valid" });
  const deferred = await assessment({ review: "DEFERRED" });
  const changed = await assessment({ kind: "version" });
  const legacy = await assessment({ kind: "legacy" });
  const archived = await assessment({ kind: "archived" });
  const cross = await assessment({ kind: "cross-source" });
  await assessment({ review: "ACCEPTED" });
  await assessment({ review: "REJECTED" });
  await assessment({ review: "STALE" });
  await assessment({ execution: "FAILED" });
  await assessment({ execution: "RUNNING" });
  await assessment({ role: 1 });
  await assessment({ role: 2 });

  console.log("[social-history-api] session authentication, ownership and pagination/filter contracts");
  assert.equal((await get(characters[0]!, undefined)).status, 401);
  assert.equal((await get(characters[0]!, foreignSession.token)).status, 404);
  assert.equal((await get(characters[2]!, ownerSession.token)).status, 404);
  assert.equal((await get(randomUUID(), ownerSession.token)).status, 404);
  const all = await get(characters[0]!, ownerSession.token, "?filter=ALL&pageSize=50");
  assert.equal(all.status, 200); assert.equal(all.body.total, 11); assert.equal(all.body.items.length, 11);
  assert.deepEqual(all.body.summary, { all: 11, actionable: 6, accepted: 1, failed: 1, running: 1 });
  for (const [filter, total] of [["ACTIONABLE", 6], ["ACCEPTED", 1], ["REJECTED", 1], ["STALE", 1], ["FAILED", 1], ["RUNNING", 1]] as const) {
    const response = await get(characters[0]!, ownerSession.token, `?filter=${filter}`);
    assert.equal(response.status, 200); assert.equal(response.body.total, total); assert.equal(response.body.summary.all, 11);
    if (filter === "FAILED") assert(response.body.items.every(item => item.status === "FAILED" && item.outcome === null), "Failed history must not masquerade as a successful assessment.");
  }
  const page1 = await get(characters[0]!, ownerSession.token, "?pageSize=2&page=1");
  const page2 = await get(characters[0]!, ownerSession.token, "?pageSize=2&page=2");
  assert.equal(page1.body.totalPages, 6); assert.equal(page1.body.items.length, 2);
  assert.equal(new Set([...page1.body.items, ...page2.body.items].map(item => item.id)).size, 4);
  for (const query of ["?filter=UNKNOWN", "?filter=ALL&filter=FAILED", "?page=0", "?pageSize=51", "?page=abc"]) assert.equal((await get(characters[0]!, ownerSession.token, query)).status, 400);
  assert.equal((await get(characters[1]!, ownerSession.token)).body.total, 1, "Same owner does not mean shared role history.");

  console.log("[social-history-api] valid source manifests enable acceptance; stale or mismatched sources do not");
  const byId = new Map(all.body.items.map(item => [item.id, item]));
  assert.equal(byId.get(valid.row.id)!.canReview, true); assert.equal(byId.get(valid.row.id)!.staleReason, null);
  assert.equal(byId.get(deferred.row.id)!.canReview, true);
  for (const fixture of [changed, legacy, archived, cross]) {
    assert.equal(byId.get(fixture.row.id)!.canReview, false); assert(byId.get(fixture.row.id)!.staleReason);
  }
  assert.equal(byId.get(cross.row.id)!.evidence.length, 0);
  assert(!JSON.stringify(all.body).includes("FOREIGN_SOURCE_SECRET_MUST_NOT_LEAK"), "Cross-role source text must not leak through historical evidence.");
  await prisma.memoryEvent.update({ where: { id: valid.source.id }, data: { status: "ARCHIVED" } });
  const refreshed = await get(characters[0]!, ownerSession.token, "?pageSize=50");
  assert.equal(refreshed.body.items.find(item => item.id === valid.row.id)!.canReview, false);
  assert.equal(await prisma.socialRelationChange.count({ where: { scopeId: { in: relationScopes } } }), 0, "History reads must never apply relationship changes.");
  console.log("Social history HTTP API checks passed: real sessions, owner/role isolation, strict filters, summary/pagination, source eligibility and no cross-role evidence text.");
} finally {
  if (originalBypass === undefined) delete process.env.YILING_ALLOW_DEV_OWNER_BYPASS;
  else process.env.YILING_ALLOW_DEV_OWNER_BYPASS = originalBypass;
  if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.session.deleteMany({ where: { userId: { in: owners } } });
  await prisma.auditLog.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.character.deleteMany({ where: { id: { in: characters } } });
  await prisma.externalIdentity.deleteMany({ where: { id: { in: identities } } });
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
