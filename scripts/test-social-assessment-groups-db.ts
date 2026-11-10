import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { listSocialAssessmentGroups } from "../server/utils/social-assessment-groups";

assert(/^\/yiling_social_assessment_test_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL ?? "").pathname), "Run only test:social-relationship-assessment-isolated.");
const prisma = getPrisma(); const owners: string[] = [], roles: string[] = [], identities: string[] = [];
try {
  for (let i = 0; i < 2; i++) {
    const user = await prisma.user.create({ data: { username: `group-${randomUUID()}`, passwordHash: "test-only", role: "USER" } }); owners.push(user.id);
    const role = await prisma.character.create({ data: { ownerId: user.id, name: "分组测试角色", basePrompt: "测试" } }); roles.push(role.id);
  }
  const scopeIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const identity = await prisma.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `group-${randomUUID()}`, displayName: "同名好友", kind: "HUMAN" } }); identities.push(identity.id);
    const scope = await prisma.memoryScope.create({ data: { characterId: roles[i === 3 ? 1 : 0]!, scopeType: "EXTERNAL_IDENTITY", scopeKey: `group:${randomUUID()}`, externalIdentityId: identity.id, relationshipStage: "FRIEND", relationshipStatus: "NORMAL", relationshipVersion: 2 } }); scopeIds.push(scope.id);
    // One friend has enough records to span several old record pages, but must remain one group.
    for (let n = 0; n < (i === 0 ? 17 : 1); n++) await prisma.socialRelationshipAssessment.create({ data: { scopeId: scope.id, generation: n + 1, evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED", relationshipVersion: 0, status: "SUCCEEDED", outcome: n === 0 ? "CHANGE" : "MAINTAIN", reviewStatus: n === 0 ? "PENDING" : "NOT_REQUIRED", createdAt: new Date(Date.UTC(2026, 10, 10, i + 1, n)) } });
  }
  for (let i = 0; i < 22; i++) await prisma.socialRelationChange.create({ data: { scopeId: scopeIds[0]!, fromStage: i === 0 ? "STRANGER" : "ACQUAINTANCE", toStage: i === 21 ? "FRIEND" : "ACQUAINTANCE", fromStatus: "UNOBSERVED", toStatus: "NORMAL", reason: "测试关系变化", idempotencyKey: `group-change:${randomUUID()}`, createdAt: new Date(Date.UTC(2026, 10, 9, 0, i)) } });
  const input = { ownerId: owners[0]!, characterId: roles[0]!, filter: "ALL" as const, page: 1, pageSize: 2, skip: 0 };
  const first = await listSocialAssessmentGroups(prisma, input);
  const second = await listSocialAssessmentGroups(prisma, { ...input, page: 2, skip: 2 });
  assert.equal(first.total, 3); assert.equal(first.items.length, 2); assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.scopeId)).size, 3);
  assert([...first.items, ...second.items].every(row => row.friend.displayName === "同名好友"));
  assert(![...first.items, ...second.items].some(row => row.scopeId === scopeIds[3]));
  const many = [...first.items, ...second.items].find(row => row.scopeId === scopeIds[0])!;
  assert.equal(many.assessmentCount, 17); assert.equal(many.changes.length, 20); assert.equal(many.changeCount, 22);
  assert.equal(many.changes.at(-1)?.toStage, "FRIEND");
  assert(many.changes.every((row, i, all) => !i || row.createdAt >= all[i - 1]!.createdAt));
  const filtered = await listSocialAssessmentGroups(prisma, { ...input, filter: "ACTIONABLE", pageSize: 50 });
  assert.equal(filtered.total, 3); assert(filtered.items.every(row => row.matchingCount === 1));
  assert.equal(filtered.items.find(row => row.scopeId === scopeIds[0])?.latestAssessment?.outcome, "MAINTAIN", "Latest metadata is not restricted to matching actionable row.");
  assert.equal((await listSocialAssessmentGroups(prisma, { ...input, scopeId: scopeIds[0] })).items[0]?.assessmentCount, 17);
  assert.equal((await listSocialAssessmentGroups(prisma, { ...input, scopeId: scopeIds[3] })).total, 0);
  assert.equal((await listSocialAssessmentGroups(prisma, { ...input, ownerId: owners[1]! })).total, 0);
  console.log("Social assessment groups DB: distinct-scope pagination, same-name accounts, filters, owner isolation, actual bounded progression passed.");
} finally {
  await prisma.socialRelationshipAssessment.deleteMany({ where: { scope: { characterId: { in: roles } } } });
  await prisma.socialRelationChange.deleteMany({ where: { scope: { characterId: { in: roles } } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.externalIdentity.deleteMany({ where: { id: { in: identities } } });
  await prisma.character.deleteMany({ where: { id: { in: roles } } });
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
