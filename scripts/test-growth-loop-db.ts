import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { processAutomaticInteractionExperience } from "../server/utils/interaction-experience-automatic";
import { enqueueExperienceReflections } from "../server/utils/experience-reflection";
import { processNextReflectionRun } from "../server/utils/reflection-worker";
import { updateExpressionHabit } from "../server/utils/expression-habits";
import { loadExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { generateInteractionExperience, readInteractionExperiences, updateInteractionExperience } from "../server/utils/interaction-experiences";

assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_reflection_test_[a-f0-9]{32}$/);
const db = getPrisma(), originalFetch = globalThis.fetch;
process.env.LLM_API_KEY = "loop-mock"; process.env.LLM_MODEL = "loop-mock";
process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
let experienceCalls = 0, reviewCalls = 0, reflectionCalls = 0;
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
    } else if (typeof payload.feedback === "string") {
      assert(request.messages[0].content.includes("消息相邻不能证明反馈指向你"));
      output = payload.feedback === "刚才是在说另一位成员，下次先听清我说的是谁。" ? {
        content: "先确认指代再接话", context: "群聊多人接话", feedbackQuote: "刚才是在说另一位成员",
        learning: { kind: "REFERENCE", situation: "群聊多人接话", misunderstanding: "误以为在说自己", correction: "反馈说明是在说另一位成员", nextJudgment: "先确认指代再接话" },
      } : { skip: "no_feedback" };
    } else if (payload.candidate) {
      // Automatic extraction requires an independent semantic review for each candidate.
      reviewCalls++;
      assert(request.messages[0].content.includes("独立第二轮语义审核者"));
      assert.equal(payload.assistant.content, "讨论方案时先铺陈背景");
      assert.equal(payload.feedback.content, "讨论方案时先说结论更好");
      assert.equal(payload.candidate.learning.kind, "EXPRESSION");
      assert(payload.feedback.content.includes(payload.candidate.feedbackQuote));
      output = { status: "ACTIVE", reason: "明确反馈支持该场景中的表达组织纠正", attribution: "USER_SUPPORTED", feedbackQuote: payload.candidate.feedbackQuote };
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
  const automatic = await processAutomaticInteractionExperience(db);
  assert.equal(automatic.status, "SUCCEEDED", JSON.stringify(automatic));
  assert.equal(reviewCalls, 3, "Each extracted experience must pass independent semantic review");
  const experiences = await db.interactionExperience.findMany({ where: { characterId: character.id } });
  assert.equal(experiences.length, 3, "Unqualified laughter must not become an experience");
  assert(experiences.every(row => row.feedbackQuote === "先说结论更好"));
  assert(experiences.every(row => row.status === "ACTIVE"), "Only reviewed ACTIVE evidence may feed reflection");
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
  const publicScope = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", platformAccountKey: randomUUID(), displayName: "合成连接" } });
  const binding = await db.characterChannelBinding.create({ data: { characterId: character.id, connectionId: connection.id } });
  const createGroup = (externalConversationId: string) => db.conversation.create({ data: { characterId: character.id, memoryScopeId: publicScope.id, channelBindingId: binding.id, externalConversationId } });
  const sourceGroup = await createGroup("g:1");
  const siblingGroup = await createGroup("g:2");
  const readGroup = (conversationId = sourceGroup.id) => readInteractionExperiences(db, { characterId: character.id, conversationId, memoryScopeId: publicScope.id, group: true, query: "群聊多人接话" });
  const ownerInput = { ownerId: owner.id, characterId: character.id };
  let acceptedGroupExperience: Awaited<ReturnType<typeof updateInteractionExperience>>["item"] | undefined;
  for (let index = 0; index < 3; index++) {
    const at = start + index * 86_400_000;
    const reply = await db.message.create({ data: { conversationId: sourceGroup.id, role: "ASSISTANT", content: "你是在说我吗？", occurredAt: new Date(at) } });
    const unrelated = await db.message.create({ data: { conversationId: sourceGroup.id, role: "USER", content: "下午见。", occurredAt: new Date(at + 1000) } });
    const feedback = await db.message.create({ data: { conversationId: sourceGroup.id, role: "USER", content: "刚才是在说另一位成员，下次先听清我说的是谁。", occurredAt: new Date(at + 2000) } });
    assert.equal((await generateInteractionExperience(db, { ...ownerInput, assistantMessageId: reply.id, feedbackMessageId: unrelated.id })).item, null);
    const { item } = await generateInteractionExperience(db, { ...ownerInput, assistantMessageId: reply.id, feedbackMessageId: feedback.id });
    assert.equal(item?.status, "PENDING");
    assert(!(await readGroup()).some(row => row.id === item!.id), "Pending group feedback must not influence replies");
    ({ item: acceptedGroupExperience } = await updateInteractionExperience(db, { ...ownerInput, id: item!.id, revision: item!.revision, operation: "ACCEPT" }));
    assert((await readGroup()).some(row => row.id === item!.id));
  }
  assert.equal((await readGroup()).length, 3);
  assert.deepEqual(await readGroup(siblingGroup.id), [], "The shared scope does not share the learning across groups");
  assert.equal(await enqueueExperienceReflections(db), 0, "Even repeated group feedback must not enter the private reflection queue");
  await updateInteractionExperience(db, { ...ownerInput, id: acceptedGroupExperience!.id, revision: acceptedGroupExperience!.revision, operation: "DISABLE" });
  assert(!(await readGroup()).some(row => row.id === acceptedGroupExperience!.id));
  console.log("Raw messages → valued short-term experiences → repeated-evidence reflection → PENDING growth → owner activation → scoped future read passed; no candidate auto-promotion, strategy conversion or duplicate processing.");
} finally { globalThis.fetch = originalFetch; await db.$disconnect(); }
