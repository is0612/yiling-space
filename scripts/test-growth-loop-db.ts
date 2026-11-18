import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { processAutomaticInteractionExperience } from "../server/utils/interaction-experience-automatic";
import { enqueueExperienceReflections } from "../server/utils/experience-reflection";
import { processNextReflectionRun } from "../server/utils/reflection-worker";
import { updateExpressionHabit } from "../server/utils/expression-habits";
import { loadExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { readInteractionExperiences } from "../server/utils/interaction-experiences";

assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_reflection_test_[a-f0-9]{32}$/);
const db = getPrisma(), originalFetch = globalThis.fetch;
process.env.LLM_API_KEY = "loop-mock"; process.env.LLM_MODEL = "loop-mock";
process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
let experienceCalls = 0, reflectionCalls = 0;
try {
  const owner = await db.user.create({ data: { username: `loop-${randomUUID()}`, passwordHash: "fixture" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "合成闭环角色", basePrompt: "测试", modelConfig: { interactionExperienceAutoEnabled: true } } });
  const scope = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "USER_PRIVATE", scopeKey: randomUUID(), userId: owner.id } });
  const room = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id } });
  const otherRoom = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id } });
  const start = Date.now() - 4 * 86_400_000;
  await db.interactionExperienceActivation.upsert({ where: { id: 1 }, create: { id: 1, anchorAt: new Date(start - 1000) }, update: { anchorAt: new Date(start - 1000) } });
  for (let i = 0; i < 4; i++) {
    await db.message.create({ data: { conversationId: room.id, role: "ASSISTANT", content: i ? "讨论方案时先铺陈背景" : "你好", occurredAt: new Date(start + i * 86_400_000) } });
    await db.message.create({ data: { conversationId: room.id, role: "USER", content: i ? "讨论方案时先说结论更好" : "哈哈", occurredAt: new Date(start + i * 86_400_000 + 1000) } });
  }
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:4010/v1/chat/completions");
    const request = JSON.parse(String(init?.body));
    const payload = JSON.parse(request.messages[1].content);
    let output: unknown;
    if (payload.pairs) {
      experienceCalls++;
      output = { experiences: payload.pairs.filter((pair: { feedbackMessageId: string }) => payload.messages.find((m: { id: string }) => m.id === pair.feedbackMessageId)?.content !== "哈哈").map((pair: object) => ({
        ...pair, content: "讨论方案时先说结论", context: "讨论方案", feedbackQuote: "先说结论更好",
        learning: { kind: "EXPRESSION", situation: "讨论方案", misunderstanding: "先铺陈背景", correction: "先说结论更好", nextJudgment: "先说结论" },
      })) };
    } else {
      reflectionCalls++;
      assert(payload.sources.every((source: {type:string}) => source.type === "experience"));
      const feedbackDays = new Set(payload.sources.map((source: {feedbackOccurredAt:string}) => source.feedbackOccurredAt.slice(0, 10)));
      assert.equal(feedbackDays.size, 3, "Batch insertion time must not erase distinct feedback dates");
      assert(request.messages[0].content.includes("feedbackOccurredAt"));
      assert(request.messages[0].content.includes("expression是可选的结构化候选"));
      assert(request.messages[0].content.includes("不满足则省略"));
      output = { suggestions: [{ title: "表达组织", observation: "多次明确纠正", inference: "方案场景适合结论先行", recommendation: "讨论方案时先给结论", sourceRefs: payload.sources.map((source: {key:string}) => source.key), expression: { kind: "TONE", content: "先说结论", context: "讨论方案" } }] };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  };
  assert.equal((await processAutomaticInteractionExperience(db)).status, "SUCCEEDED");
  const experiences = await db.interactionExperience.findMany({ where: { characterId: character.id } });
  assert.equal(experiences.length, 3, "Unqualified laughter must not become an experience");
  assert(experiences.every(row => row.feedbackQuote === "先说结论更好"));
  assert.equal(await db.characterExpressionHabit.count({ where: { characterId: character.id } }), 0);
  await processAutomaticInteractionExperience(db);
  assert.equal(experienceCalls, 1, "Finished messages must not be analyzed again");
  assert.equal(await enqueueExperienceReflections(db), 1);
  await enqueueExperienceReflections(db);
  assert.equal(await db.reflectionRun.count({ where: { characterId: character.id } }), 1);
  assert.equal((await processNextReflectionRun(db, { workerId: "loop-test" })).status, "SUCCEEDED");
  assert.equal(reflectionCalls, 1);
  const habit = await db.characterExpressionHabit.findFirstOrThrow({ where: { characterId: character.id } });
  assert.equal(habit.status, "PENDING");
  const read = (conversationId = room.id, scene: "PRIVATE" | "GROUP" = "PRIVATE") => loadExpressionHabitsForPrompt(db, character.id, "讨论方案", undefined, { conversationId, memoryScopeId: scope.id }, scene);
  assert.equal((await read()).length, 0, "Candidate cannot affect stable expression");
  await updateExpressionHabit(db, { ownerId: owner.id, characterId: character.id, habitId: habit.id, body: { operation: "ACTIVATE", expectedRevision: habit.revision } });
  assert.deepEqual((await read()).map(row => row.id), [habit.id]);
  assert.equal((await read(otherRoom.id)).length, 0);
  assert.equal((await read(room.id, "GROUP")).length, 0);
  assert.equal((await readInteractionExperiences(db, { characterId: character.id, conversationId: room.id, memoryScopeId: scope.id, query: "讨论方案" })).length, 3);
  await db.interactionExperience.update({ where: { id: experiences[0]!.id }, data: { status: "DISABLED" } });
  assert.equal((await read()).length, 0, "Invalid source stops derived expression on the next read");
  // Even if a model proposes expression from strategy evidence, the server must not promote it.
  for (let i = 0; i < 3; i++) {
    const feedback = await db.message.create({ data: { conversationId: otherRoom.id, role: "USER", content: "先核对再处理", occurredAt: new Date(start + i * 86_400_000) } });
    await db.interactionExperience.create({ data: { characterId: character.id, conversationId: otherRoom.id, memoryScopeId: scope.id,
      assistantMessageId: randomUUID(), feedbackMessageId: feedback.id, content: "先核对再处理", context: "讨论方案", feedbackQuote: "先核对再处理",
      evidenceHash: "b".repeat(64), status: "ACTIVE", learning: { kind: "STRATEGY", situation: "处理事项", misunderstanding: "未核对就处理", correction: "先核对", nextJudgment: "先核对再处理" } } });
  }
  assert.equal(await enqueueExperienceReflections(db), 1);
  assert.equal((await processNextReflectionRun(db, { workerId: "loop-strategy-test" })).status, "SUCCEEDED");
  assert.equal(await db.characterExpressionHabit.count({ where: { characterId: character.id, conversationId: otherRoom.id } }), 0,
    "Strategy evidence cannot become expression even if the model supplies expression");
  console.log("Raw messages → valued short-term experiences → repeated-evidence reflection → PENDING growth → owner activation → scoped future read passed; no candidate auto-promotion, strategy conversion or duplicate processing.");
} finally { globalThis.fetch = originalFetch; await db.$disconnect(); }
