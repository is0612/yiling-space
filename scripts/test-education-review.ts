import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { updateExpressionHabit } from "../server/utils/expression-habits";
import { loadExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { validateEducationTransferRefs, type EducationSource } from "../server/utils/education-transfer";
import { experienceReflectionHash } from "../server/utils/experience-reflection";

// Pure service tests: real education-source validation, in-memory Prisma boundaries only.
const characterId = "character-a", ownerId = "owner-a", privateRoom = "private-room-marker", privateScope = "private-scope-marker";
const learning = { kind: "EXPRESSION", situation: "日常交流", misunderstanding: "机械追问", correction: "自然结束句子", nextJudgment: "避免机械反问" };
const experience = {
  id: "10000000-0000-4000-8000-000000000001", characterId, conversationId: privateRoom, memoryScopeId: privateScope,
  feedbackMessageId: "feedback-private-marker", content: "避免机械反问", context: "日常交流", evidenceHash: "evidence", revision: 1, learning,
  conversation: { characterId, memoryScopeId: privateScope, channelBindingId: "binding", externalConversationId: "c:123456789",
    character: { ownerId, memorySetting: { timezone: "Asia/Shanghai" } },
    memoryScope: { scopeType: "EXTERNAL_IDENTITY", userId: null, educationEnabled: true, externalIdentity: { platformUid: "123456789" } },
    channelBinding: { connection: { platform: "qq-onebot", metadata: {} } } },
};
const ref: EducationSource = { version: 1, type: "experience", key: `experience:${experience.id}`, id: experience.id,
  hash: experienceReflectionHash(experience), conversationId: privateRoom, memoryScopeId: privateScope,
  feedbackMessageId: experience.feedbackMessageId, proposer: { kind: "authorized", platform: "qq-onebot", identity: "123456789" }, educationMode: "explicit" };
type Habit = { id: string; characterId: string; kind: string; content: string; context: string; reason: string; revision: number; status: string; conversationId: string | null; memoryScopeId: string | null; sourceType: string; sourceRefs: unknown };
const candidate = (): Habit => ({ id: "habit", characterId, kind: "WORDING", content: "避免机械反问", context: "", reason: "private-reason-marker", revision: 1, status: "PENDING", conversationId: null, memoryScopeId: null, sourceType: "EDUCATION_TRANSFER", sourceRefs: [ref] });
let habit = candidate(), authorized = true, stale = false, feedbackPresent = true, evidenceReads = 0, updates = 0, cas = true;
const history: unknown[] = [], audits: unknown[] = [];
const db = {
  $transaction: async <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> => fn(db as unknown as PrismaClient),
  $queryRaw: async (sql: TemplateStringsArray, requestedCharacter: string, requestedOwner: unknown) => {
    assert.equal(requestedCharacter, characterId, "lock targets requested character");
    const statement = sql.join("?");
    if (statement.includes('FROM "characters"')) return requestedOwner === ownerId ? [{ id: characterId }] : [];
    assert(statement.includes("FOR SHARE"), "education evidence locks must be held during acceptance");
    assert(statement.includes('FROM "memory_scopes"') || statement.includes('FROM "interaction_experiences"'));
    return [{ id: statement.includes('FROM "memory_scopes"') ? privateScope : experience.id }];
  },
  interactionExperience: { findMany: async (q: { where: { characterId: string; status: string; id: { in: string[] } } }) => {
    evidenceReads++; assert.equal(q.where.characterId, characterId); assert.equal(q.where.status, "ACTIVE"); assert.deepEqual(q.where.id.in, [experience.id]);
    return [{ ...experience, revision: stale ? 2 : 1, conversation: { ...experience.conversation, memoryScope: { ...experience.conversation.memoryScope, educationEnabled: authorized } } }];
  } },
  message: { findFirst: async (q: { where: { id: string; conversationId: string; role: string } }) => {
    assert.deepEqual(q.where, { id: experience.feedbackMessageId, conversationId: privateRoom, role: "USER" });
    return feedbackPresent ? { id: experience.feedbackMessageId, role: "USER", metadata: { authorOpenId: "123456789" }, occurredAt: new Date("2026-11-14T00:00:00Z") } : null;
  } },
  characterExpressionHabit: {
    findFirst: async (q: { where: { id: string; characterId: string } }) => q.where.id === habit.id && q.where.characterId === habit.characterId ? { ...habit } : null,
    updateMany: async (q: { where: { id: string; characterId: string; revision: number; status: string }; data: Omit<Habit, "id" | "characterId" | "revision" | "conversationId" | "memoryScopeId" | "sourceType" | "sourceRefs"> & { revision: { increment: number } } }) => {
      assert.deepEqual(q.where, { id: habit.id, characterId, revision: habit.revision, status: habit.status });
      if (!cas) return { count: 0 };
      updates++; const { revision, ...fields } = q.data; habit = { ...habit, ...fields, revision: habit.revision + revision.increment }; return { count: 1 };
    },
    findUniqueOrThrow: async () => ({ ...habit }),
  },
  characterExpressionHabitRevision: { create: async (q: { data: unknown }) => { history.push(q.data); } },
  auditLog: { create: async (q: { data: unknown }) => { audits.push(q.data); } },
};
const prisma = db as unknown as PrismaClient;
const update = (operation: string, expectedRevision = habit.revision, overrides: Record<string, string> = {}) => updateExpressionHabit(prisma, { ownerId, characterId, habitId: habit.id, ...overrides, body: { operation, expectedRevision } });
const statusCode = (code: number) => (error: unknown) => (error as { statusCode?: number }).statusCode === code;

assert(await validateEducationTransferRefs(db as never, characterId, [ref]));
evidenceReads = 0;
await update("ACTIVATE");
assert.equal(evidenceReads, 1, "first acceptance calls real education evidence validator");
assert.equal(habit.status, "ACTIVE"); assert.equal(habit.revision, 2); assert.equal(history.length, 1); assert.equal(audits.length, 1);
authorized = false; stale = true; feedbackPresent = false;
const readsAfterAccept = evidenceReads;
await update("DISABLE"); await update("ACTIVATE");
assert.equal(habit.status, "ACTIVE"); assert.equal(habit.revision, 4);
assert.equal(evidenceReads, readsAfterAccept, "accepted domain-owned habit survives permission revocation and source cleanup");
await assert.rejects(update("EDIT"), statusCode(400));
assert.equal(evidenceReads, readsAfterAccept);
for (const failure of ["revoked", "stale", "missing"] as const) {
  habit = candidate(); authorized = failure !== "revoked"; stale = failure === "stale"; feedbackPresent = failure !== "missing";
  const before = updates;
  await assert.rejects(update("ACTIVATE"), statusCode(409));
  assert.equal(updates, before); assert.equal(habit.status, "PENDING");
}
habit = candidate(); authorized = true; stale = false; feedbackPresent = true;
let reads = evidenceReads;
await assert.rejects(update("ACTIVATE", 99), statusCode(409)); assert.equal(evidenceReads, reads, "revision mismatch precedes evidence I/O");
await assert.rejects(update("ACTIVATE", 1, { ownerId: "other-owner" }), statusCode(404)); assert.equal(evidenceReads, reads, "owner gate precedes private evidence I/O");
habit.characterId = "other-character";
await assert.rejects(update("ACTIVATE"), statusCode(404)); assert.equal(evidenceReads, reads, "cannot update a different character's habit");
habit = candidate(); cas = false;
await assert.rejects(update("ACTIVATE"), statusCode(409)); cas = true;

const rows = ["ACTIVE", "PENDING", "DISABLED", "REJECTED"].map((status, index) => ({ ...candidate(), id: `habit-${index}`, status }));
rows.push({ ...candidate(), id: "other-role", characterId: "other-character", status: "ACTIVE" });
let queries = 0;
const reader = {
  characterExpressionHabit: { findMany: async (q: { where: { characterId: string; status: string; AND: Array<{ OR: unknown[] }> } }) => {
    queries++; assert.equal(q.where.status, "ACTIVE"); assert.deepEqual(q.where.AND, [{ OR: [{ conversationId: null, memoryScopeId: null }] }]);
    return rows.filter(row => row.characterId === q.where.characterId); // Also exercise selector's independent ACTIVE check.
  } },
  $transaction: async () => { throw Error("global accepted education must not re-read private evidence"); },
} as unknown as PrismaClient;
const selected = await loadExpressionHabitsForPrompt(reader, characterId, "你好");
assert.deepEqual(selected.map(row => row.id), ["habit-0"]);
assert.deepEqual(Object.keys(selected[0]!).sort(), ["content", "context", "id", "kind", "revision"]);
for (const marker of ["sourceRefs", "reason", privateRoom, privateScope, ref.id, ref.feedbackMessageId, ref.proposer.identity]) assert(!JSON.stringify(selected).includes(marker));
assert.deepEqual(await loadExpressionHabitsForPrompt(reader, "unrelated-character", "你好"), []);
assert.equal(queries, 2);
console.log("Education review mocks passed: first-accept validation, revoked/stale evidence, independent reactivation, owner/character/revision gates and private-free ACTIVE global retrieval.");
