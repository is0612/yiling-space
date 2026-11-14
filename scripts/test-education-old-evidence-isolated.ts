import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { getPrisma } from "../server/utils/prisma";
import { processEducationTransfer } from "../server/utils/education-transfer";

const source = new URL(process.env.DATABASE_URL!);
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname));
source.pathname = "/postgres";
const name = `yiling_old_evidence_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_old_evidence_test_[a-f0-9]{32}$/.test(name));
const target = new URL(source); target.pathname = `/${name}`;
const admin = new Client({ connectionString: source.toString() });
await admin.connect();
let created = false;
const originalFetch = globalThis.fetch;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  process.env.DATABASE_URL = target.toString();
  assert.equal(spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "inherit" }).status, 0);
  process.env.LLM_API_KEY = "mock-test-only"; process.env.LLM_MODEL = "mock"; process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
  const db = getPrisma();
  try {
    const owner = await db.user.create({ data: { username: `test-${randomUUID()}`, passwordHash: "not-a-login-hash" } });
    const character = await db.character.create({ data: { ownerId: owner.id, name: "旧证据隔离测试", basePrompt: "test", modelConfig: { interactionExperienceAutoEnabled: true } } });
    const scope = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "USER_PRIVATE", scopeKey: "private", userId: owner.id } });
    const room = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id } });
    async function experience(label: string) {
      const assistant = await db.message.create({ data: { conversationId: room.id, role: "ASSISTANT", content: "示例回复", occurredAt: new Date() } });
      const feedback = await db.message.create({ data: { conversationId: room.id, role: "USER", content: `长期表达反馈${label}`, occurredAt: new Date(Date.now() + 1) } });
      return db.interactionExperience.create({ data: { characterId: character.id, conversationId: room.id, memoryScopeId: scope.id, assistantMessageId: assistant.id, feedbackMessageId: feedback.id, content: "自然表达", context: "表达反馈", feedbackQuote: feedback.content, evidenceHash: "a".repeat(64), status: "ACTIVE", learning: { kind: "EXPRESSION", situation: "表达反馈", misunderstanding: "", correction: "自然表达", nextJudgment: "自然回应" } } });
    }
    const old = await experience("旧");
    await db.auditLog.create({ data: { actorType: "SYSTEM", characterId: character.id, action: "education_transfer.checked", entityType: "InteractionExperience", entityId: old.id, details: { revision: old.revision } } });
    const fresh = await experience("新");
    let calls = 0;
    let candidates: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.messages[1].content);
      assert(!input.newIds.includes(old.id));
      assert(input.sources.some((row: {id:string}) => row.id === old.id), "old history remains available without being new evidence");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] }));
    };
    const draft = (id: string, content: string) => ({ kind: "WORDING", mode: "explicit", content, sourceIds: [id], privacySafe: true, consistent: true, general: true });
    candidates = [draft(old.id, "旧建议只作背景")];
    const now = new Date();
    assert.equal((await processEducationTransfer(db, now)).status, "SUCCEEDED");
    assert.equal(await db.characterExpressionHabit.count({ where: { characterId: character.id } }), 0);
    assert.equal(await db.auditLog.count({ where: { action: "education_transfer.checked", entityId: fresh.id } }), 1);
    const state = (await db.conversation.findUniqueOrThrow({ where: { id: room.id } })).metadata as {educationTransfer:{status:string}};
    assert.equal(state.educationTransfer.status, "SUCCEEDED");
    assert.equal((await processEducationTransfer(db, new Date(now.getTime() + 600_000))).processed, false);
    assert.equal(calls, 1, "checkpoint prevents model reprocessing on the next eligible round");

    const mixed = await experience("混合新");
    candidates = [draft(old.id, "旧建议不应回滚合法建议"), draft(mixed.id, "优先使用自然常用词")];
    assert.equal((await processEducationTransfer(db, new Date(now.getTime() + 1_200_000))).status, "SUCCEEDED");
    const habits = await db.characterExpressionHabit.findMany({ where: { characterId: character.id } });
    assert.equal(habits.length, 1);
    assert.equal(habits[0]!.content, "优先使用自然常用词");
    assert.equal(habits[0]!.status, "PENDING");
    const refs = habits[0]!.sourceRefs as Array<{id:string}>;
    assert.deepEqual(refs.map(ref => ref.id), [mixed.id]);
    assert.equal(await db.auditLog.count({ where: { action: "education_transfer.checked", entityId: mixed.id } }), 1);
    await processEducationTransfer(db, new Date(now.getTime() + 1_800_000));
    assert.equal(calls, 2);
    const insufficient = await experience("重复不足");
    candidates = [{ ...draft(insufficient.id, "不足三条证据不迁移"), mode: "repeated" }];
    assert.equal((await processEducationTransfer(db, new Date(now.getTime() + 2_400_000))).status, "SUCCEEDED");
    assert.equal(await db.characterExpressionHabit.count({ where: { characterId: character.id } }), 1);
    assert.equal(await db.auditLog.count({ where: { action: "education_transfer.checked", entityId: insufficient.id } }), 1);
    const wrongDomain = await experience("领域错误");
    const validMixed = await experience("领域混合合法");
    candidates = [{ ...draft(wrongDomain.id, "领域不符不能迁移"), domain: "interaction", kind: "STRATEGY", context: "表达反馈" }, draft(validMixed.id, "日常回应简短自然")];
    assert.equal((await processEducationTransfer(db, new Date(now.getTime() + 3_000_000))).status, "SUCCEEDED");
    assert.equal(await db.characterInteractionGuidance.count({ where: { characterId: character.id } }), 0);
    assert.equal(await db.characterExpressionHabit.count({ where: { characterId: character.id } }), 2);
    for (const item of [wrongDomain, validMixed]) assert.equal(await db.auditLog.count({ where: { action: "education_transfer.checked", entityId: item.id } }), 1);
    await processEducationTransfer(db, new Date(now.getTime() + 3_600_000));
    assert.equal(calls, 4, "permanent old-only/domain/count errors must all checkpoint without retrying");
    console.log("Old evidence isolated regression passed: old-only succeeds/checkpoints/no repeat; mixed retains valid candidate; insufficient repeated evidence and wrong domain never create candidates or repeat model calls.");
  } finally { await db.$disconnect(); }
} finally {
  globalThis.fetch = originalFetch;
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
