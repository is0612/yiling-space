import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { updateExpressionHabit } from "../server/utils/expression-habits";
import {
  countSelfReviewedToday,
  parseSelfReviewDecisions,
  selfReviewDayStart,
  SELF_REVIEW_DAILY_LIMIT,
  type SelfReviewCandidate,
} from "../server/utils/expression-habit-self-review";

const candidates: SelfReviewCandidate[] = [
  { id: "a", revision: 1, kind: "TONE", content: "语气温和", context: "", reason: "多次这样回", sourceType: "SOURCES" },
  { id: "b", revision: 2, kind: "LENGTH", content: "回答简短", context: "", reason: "她说喜欢短句", sourceType: "GROUP_OBSERVATION" },
];
const candidatesById = new Map(candidates.map(row => [row.id, row]));

assert.deepEqual(parseSelfReviewDecisions('{"decisions":[{"id":"a","decision":"ACCEPT","reason":"确实是我"}]}', candidates),
  [{ candidate: candidatesById.get("a"), accept: true, reason: "确实是我" }]);
assert.equal(parseSelfReviewDecisions('{"decisions":[{"id":"b","decision":"REJECT","reason":"一次口误"}]}', candidates)[0]?.accept, false);
assert.throws(() => parseSelfReviewDecisions('{"decisions":[{"id":"zzz","decision":"ACCEPT","reason":"x"}]}', candidates), /SELF_REVIEW_INVALID/);
assert.throws(() => parseSelfReviewDecisions('{"decisions":[{"id":"a","decision":"MAYBE","reason":"x"}]}', candidates), /SELF_REVIEW_INVALID/);
assert.throws(() => parseSelfReviewDecisions('{"decisions":[{"id":"a","decision":"ACCEPT","reason":"  "}]}', candidates), /SELF_REVIEW_INVALID/);
assert.throws(() => parseSelfReviewDecisions('{"decisions":[{"id":"a","decision":"ACCEPT","reason":"x"},{"id":"a","decision":"ACCEPT","reason":"y"}]}', candidates), /SELF_REVIEW_INVALID/);
assert.throws(() => parseSelfReviewDecisions("not json", candidates), /SELF_REVIEW_INVALID/);

const start = selfReviewDayStart(new Date("2026-11-21T00:30:00+08:00"));
assert.equal(start.toISOString(), "2026-11-20T16:00:00.000Z", "Day boundary follows +08:00");

const db = getPrisma();
const actor = randomUUID();
const characterId = randomUUID();
const habitIds: string[] = [];
try {
  await db.user.create({ data: { id: actor, username: `self-review-${actor}`, passwordHash: "x", role: "ADMIN" } });
  await db.character.create({ data: { id: characterId, ownerId: actor, name: "自审角色", basePrompt: "test" } });
  // Manual habits have no source to re-validate, so activation itself is the thing under test here.
  const habit = await db.characterExpressionHabit.create({ data: { characterId, kind: "TONE", content: "语气温和", context: "",
    reason: "多次这样回", status: "PENDING", sourceType: "MANUAL", sourceRefs: [] } });
  habitIds.push(habit.id);
  assert.equal(await countSelfReviewedToday(db, characterId), 0);

  const activated = await updateExpressionHabit(db, { ownerId: actor, characterId, habitId: habit.id, reviewedBy: "SELF",
    body: { expectedRevision: habit.revision, operation: "ACTIVATE" } });
  assert.equal(activated.habit.status, "ACTIVE");
  assert.equal(activated.habit.reviewedBy, "SELF");
  assert.ok(activated.habit.reviewedAt);
  assert.equal(await countSelfReviewedToday(db, characterId), 1);

  // Owner edits must not silently relabel a self-reviewed habit.
  const edited = await updateExpressionHabit(db, { ownerId: actor, characterId, habitId: habit.id,
    body: { expectedRevision: activated.habit.revision, operation: "EDIT", content: "语气更温和" } });
  assert.equal(edited.habit.reviewedBy, "SELF");

  const disabled = await updateExpressionHabit(db, { ownerId: actor, characterId, habitId: habit.id,
    body: { expectedRevision: edited.habit.revision, operation: "DISABLE" } });
  assert.equal(disabled.habit.status, "DISABLED");
  assert.equal(disabled.habit.reviewedBy, "OWNER", "Owner override is recorded as the owner's decision");
  assert.equal(await countSelfReviewedToday(db, characterId), 0, "Overridden items no longer count against her quota");
  // Rejecting a sourced candidate never needs to re-read its evidence, but must still record who decided.
  const sourced = await db.characterExpressionHabit.create({ data: { characterId, kind: "WORDING", content: "爱用短句", context: "",
    reason: "群聊里多次这样", status: "PENDING", sourceType: "SOURCES", sourceRefs: [{ type: "MEMORY_EVENT", id: randomUUID(), hash: "x" }] } });
  habitIds.push(sourced.id);
  const rejected = await updateExpressionHabit(db, { ownerId: actor, characterId, habitId: sourced.id, reviewedBy: "SELF",
    body: { expectedRevision: sourced.revision, operation: "REJECT" } });
  assert.equal(rejected.habit.status, "REJECTED");
  assert.equal(rejected.habit.reviewedBy, "SELF");
  // A broken source still blocks activation, which is exactly the guard the owner path relies on.
  await assert.rejects(() => updateExpressionHabit(db, { ownerId: actor, characterId, habitId: sourced.id, reviewedBy: "SELF",
    body: { expectedRevision: rejected.habit.revision, operation: "ACTIVATE" } }), /来源|刷新/);
  assert.equal(SELF_REVIEW_DAILY_LIMIT, 5);
  console.log("Expression self-review: strict decision parsing, +08:00 day boundary, SELF/OWNER provenance and quota counting passed.");
} finally {
  await db.characterExpressionHabitRevision.deleteMany({ where: { habitId: { in: habitIds } } }).catch(() => {});
  await db.characterExpressionHabit.deleteMany({ where: { id: { in: habitIds } } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { characterId, actorId: actor } }).catch(() => {});
  await db.character.deleteMany({ where: { id: characterId, ownerId: actor } }).catch(() => {});
  await db.user.deleteMany({ where: { id: actor } }).catch(() => {});
  await db.$disconnect();
}
