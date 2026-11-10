import assert from "node:assert/strict";
import { readSocialAssessmentView, toSocialAssessmentGroup, listSocialAssessmentGroups, type SocialAssessmentGroupScope } from "../server/utils/social-assessment-groups";
import type { PrismaClient } from "../src/generated/prisma/client";

assert.equal(readSocialAssessmentView(undefined), "records");
assert.equal(readSocialAssessmentView("people"), "people");
assert.throws(() => readSocialAssessmentView(["people"]));
assert.throws(() => readSocialAssessmentView("nickname"));
const first: SocialAssessmentGroupScope = {
  id: "scope-a", aliases: [], relationshipStage: "FRIEND", relationshipStatus: "NORMAL", relationshipVersion: 2,
  externalIdentity: { displayName: "同名好友", platform: "qq-onebot", platformUid: "sample-a", kind: "HUMAN" },
  _count: { socialAssessments: 8, socialRelationChanges: 2 },
  socialAssessments: [{ id: "assessment-8", status: "SUCCEEDED", outcome: "MAINTAIN", reviewStatus: "NOT_REQUIRED", createdAt: new Date("2026-11-10T10:00:00Z") }],
  socialRelationChanges: [
    { id: "change-2", fromStage: "ACQUAINTANCE", toStage: "FRIEND", fromStatus: "NORMAL", toStatus: "NORMAL", createdAt: new Date("2026-11-10T09:00:00Z") },
    { id: "change-1", fromStage: "STRANGER", toStage: "ACQUAINTANCE", fromStatus: "UNOBSERVED", toStatus: "NORMAL", createdAt: new Date("2026-11-09T09:00:00Z") },
  ],
};
const group = toSocialAssessmentGroup(first, 2);
assert.equal(group.assessmentCount, 8); assert.equal(group.matchingCount, 2);
assert.deepEqual(group.changes.map(row => row.toStage), ["ACQUAINTANCE", "FRIEND"]);
assert.equal(group.currentRelationship.stage, "FRIEND");
assert.equal(group.latestAssessment?.id, "assessment-8");
assert(!("evidence" in group));
assert.deepEqual(first.socialRelationChanges.map(row => row.id), ["change-2", "change-1"], "Mapping cannot mutate stored ordering.");
const noChange = toSocialAssessmentGroup({ ...first, id: "scope-b", relationshipStage: "STRANGER", relationshipVersion: 0, socialRelationChanges: [], _count: { socialAssessments: 3, socialRelationChanges: 0 } }, 3);
assert.equal(noChange.friend.displayName, group.friend.displayName);
assert.notEqual(noChange.scopeId, group.scopeId, "Same-name people must stay independent.");
assert.deepEqual(noChange.changes, [], "Repeated suggestions cannot invent relation progression.");
const truncated = toSocialAssessmentGroup({ ...first, _count: { socialAssessments: 100, socialRelationChanges: 25 } }, 100);
assert.equal(truncated.changeCount, 25);

const seen: Array<{ method: string; args: unknown }> = [];
const db = {
  memoryScope: {
    count: async (args: unknown) => { seen.push({ method: "count", args }); return 51; },
    findMany: async (args: unknown) => { seen.push({ method: "findMany", args }); return [first]; },
  },
  socialRelationshipAssessment: {
    groupBy: async (args: unknown) => { seen.push({ method: "groupBy", args }); return [{ scopeId: first.id, _count: { _all: 2 } }]; },
  },
} as unknown as PrismaClient;
const page = await listSocialAssessmentGroups(db, { characterId: "role-a", ownerId: "owner-a", filter: "ACTIONABLE", page: 3, pageSize: 12, skip: 24 });
assert.equal(page.total, 51); assert.equal(page.items.length, 1);
const query = seen.find(call => call.method === "groupBy")!.args as Record<string, unknown>;
assert.deepEqual(query.by, ["scopeId"]); assert.equal(query.skip, 24); assert.equal(query.take, 12);
assert.match(JSON.stringify(query), /role-a/); assert.match(JSON.stringify(query), /owner-a/); assert.match(JSON.stringify(query), /PENDING/);
const select = (seen.find(call => call.method === "findMany")!.args as { select: { socialAssessments: { take: number }; socialRelationChanges: { take: number } } }).select;
assert.equal(select.socialAssessments.take, 1); assert.equal(select.socialRelationChanges.take, 20);
assert.equal(page.items[0]?.matchingCount, 2);
console.log("Social assessment groups: server-side scope pagination, same-name separation, actual progression, bounded details and filter counts passed.");
