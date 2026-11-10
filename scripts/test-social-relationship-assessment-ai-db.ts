import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";
import { enqueueSocialRelationshipAssessment } from "../server/utils/social-relationship-queue";
import { processNextSocialRelationshipAssessmentTask } from "../server/utils/social-relationship-assessment-ai";

const databaseName = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.replace(/^\//, "");
assert(/^yiling_social_assessment_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性社交评估测试库。`);

const prisma = getPrisma();
const runId = randomUUID().replaceAll("-", "").slice(0, 16);
const owner = await prisma.user.create({
  data: { username: `social-ai-${runId}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});
const makeCharacter = async (name: string, enabled: boolean) => {
  const modelConfig = enabled ? {
    socialRelationshipAssessmentAssistantEnabled: true,
    socialRelationshipAssessmentAssistantModel: "assessment-test-model",
    socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.openai.com/v1",
    socialRelationshipAssessmentAssistantApiKeyEncrypted: await encryptApiKey("isolated-assessment-secret"),
    socialRelationshipAssessmentAssistantTemperature: 0.2,
    socialRelationshipAssessmentAssistantMaxInputTokens: 8_192,
    socialRelationshipAssessmentAssistantMaxOutputTokens: 1_024,
  } : { socialRelationshipAssessmentAssistantEnabled: false };
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id, name, basePrompt: "关系评估 AI 隔离测试",
      modelConfig,
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `social-ai-global:${name}:${runId}` } },
    },
    select: { id: true },
  });
  const global = await prisma.memoryScope.findFirstOrThrow({
    where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" }, select: { id: true },
  });
  return { id: character.id, globalScopeId: global.id };
};

const enabledCharacter = await makeCharacter("评估助手启用角色", true);
const disabledCharacter = await makeCharacter("评估助手关闭角色", false);
const identity = await prisma.externalIdentity.create({
  data: { platform: "qq-onebot", platformUid: `social-ai-${runId}`, displayName: "测试好友", kind: "HUMAN" },
  select: { id: true },
});
const enabledScope = (await ensureExternalIdentityScope(enabledCharacter.id, "qq-onebot", `social-ai-${runId}`, identity.id)).scopeId;
const disabledScope = (await ensureExternalIdentityScope(disabledCharacter.id, "qq-onebot", `social-ai-${runId}`, identity.id)).scopeId;

async function addExperience(characterGlobalScopeId: string, relationshipScopeId: string, title: string, detail: string, key: string) {
  const event = await prisma.memoryEvent.create({
    data: {
      memoryScopeId: characterGlobalScopeId, dayKey: "2026-11-09", occurredAt: new Date(),
      title, detail, dedupeKey: key,
    },
    select: { id: true },
  });
  return prisma.socialExperience.create({
    data: { scopeId: relationshipScopeId, memoryEventId: event.id, sourceKey: key },
    select: { id: true },
  });
}

const firstExperience = await addExperience(
  enabledCharacter.globalScopeId, enabledScope, "朋友主动帮助我们的角色", "对方在我们的角色遇到困难时主动提供了具体帮助，之后双方表达了感谢。", `event-a-${runId}`,
);
const pendingExperience = await addExperience(
  enabledCharacter.globalScopeId, enabledScope, "待派发经历", "PENDING_EVIDENCE_MUST_NOT_REACH_MODEL", `pending-${runId}`,
);
await prisma.socialExperience.update({
  where: { id: pendingExperience.id }, data: { assessmentDispatchStatus: "PENDING" },
});
await prisma.$transaction(tx => enqueueSocialRelationshipAssessment(tx, {
  scopeId: enabledScope, reason: "NEW_EXPERIENCE",
}));
await prisma.socialRelationshipAssessmentTask.create({
  data: { scopeId: disabledScope, triggerReasons: ["NEW_EXPERIENCE"], generation: 1 },
});

const outputs = [
  {
    outcome: "CHANGE", suggestedStage: "ACQUAINTANCE", suggestedStatus: "NORMAL",
    reason: "存在一段明确的互相支持经历，建议从陌生调整为认识。",
    confidence: 0.82, observations: ["出现了主动帮助与积极回应"],
    evidenceExperienceIds: [firstExperience.id], newEvidenceExperienceIds: [firstExperience.id],
    needsMoreEvidence: false, cautionFlags: [],
  },
  {
    outcome: "CHANGE", suggestedStage: "FRIEND", suggestedStatus: "NORMAL",
    reason: "只引用了历史背景，不能支持本轮关系变化。",
    confidence: 0.9, observations: [],
    evidenceExperienceIds: [firstExperience.id], newEvidenceExperienceIds: [],
    needsMoreEvidence: false, cautionFlags: [],
  },
];
const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({
    authorization: new Headers(init?.headers).get("authorization") ?? "",
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
  });
  const output = outputs.shift();
  assert(output, "不应发生额外的模型调用。");
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

try {
  console.log("\n[1] 启用助手的关系任务调用独立模型并保存建议");
  const firstRun = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `social-ai-worker-${runId}` });
  assert.equal(firstRun.processed, true);
  assert(firstRun.assessmentId, "成功执行必须生成评估历史 ID");
  assert.equal(firstRun.outcome, "CHANGE");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.authorization, "Bearer isolated-assessment-secret");
  const sentMessages = requests[0]!.body.messages as Array<{ role: string; content: string }>;
  assert(sentMessages.some(message => message.content.includes("对方在我们的角色遇到困难时主动提供了具体帮助")));
  assert(!sentMessages.some(message => message.content.includes("PENDING_EVIDENCE_MUST_NOT_REACH_MODEL")),
    "尚未派发的经历不能提前进入模型输入");
  const firstAssessment = await prisma.socialRelationshipAssessment.findUniqueOrThrow({
    where: { id: firstRun.assessmentId },
    include: { evidence: true },
  });
  assert.equal(firstAssessment.status, "SUCCEEDED");
  assert.equal(firstAssessment.reviewStatus, "PENDING", "有效 CHANGE 建议应进入人工待确认状态");
  assert.equal(firstAssessment.outcome, "CHANGE");
  assert.equal(firstAssessment.suggestedStage, "ACQUAINTANCE");
  assert(firstAssessment.evidence.some(item => item.experienceId === firstExperience.id && item.kind === "NEW"));
  assert(firstAssessment.evidence.every(item => item.experienceId !== pendingExperience.id));
  const unchangedScope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: enabledScope } });
  assert.equal(unchangedScope.relationshipStage, "STRANGER", "AI 不得自动修改关系阶段");
  assert.equal(unchangedScope.relationshipStatus, "UNOBSERVED", "AI 不得自动修改相处状态");
  assert.equal(unchangedScope.relationshipVersion, 0, "AI 不得递增关系版本");
  const pausedTask = await prisma.socialRelationshipAssessmentTask.findUniqueOrThrow({ where: { scopeId: enabledScope } });
  assert.equal(pausedTask.status, "PAUSED");

  console.log("\n[2] CONTEXT 不能单独支持变化建议");
  const secondExperience = await addExperience(
    enabledCharacter.globalScopeId, enabledScope, "普通聊天中的分歧", "双方对一件小事看法不同，但没有出现持续伤害或信任破坏。", `event-b-${runId}`,
  );
  await prisma.$transaction(tx => enqueueSocialRelationshipAssessment(tx, {
    scopeId: enabledScope, reason: "NEW_EXPERIENCE",
  }));
  const secondRun = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `social-ai-worker-${runId}` });
  assert.equal(secondRun.processed, true);
  assert(secondRun.assessmentId, "第二次执行必须生成评估历史 ID");
  assert.equal(secondRun.outcome, "REVIEW", "模型只引用 CONTEXT 时，CHANGE 应被降为 REVIEW");
  const secondAssessment = await prisma.socialRelationshipAssessment.findUniqueOrThrow({
    where: { id: secondRun.assessmentId },
    include: { evidence: true },
  });
  assert.equal(secondAssessment.outcome, "REVIEW");
  assert.equal(secondAssessment.suggestedStage, "FRIEND", "待复核保留模型建议供以后人工查看");
  assert(secondAssessment.evidence.some(item => item.experienceId === firstExperience.id && item.kind === "CONTEXT"));
  assert(secondAssessment.evidence.some(item => item.experienceId === secondExperience.id && item.kind === "NEW"));

  console.log("\n[2b] 恢复派发没有新证据时不重复创建历史或调用模型");
  const historyBefore = await prisma.socialRelationshipAssessment.count({ where: { scopeId: enabledScope } });
  await prisma.$transaction(tx => enqueueSocialRelationshipAssessment(tx, { scopeId: enabledScope, reason: "EXISTING_EXPERIENCE_RECOVERY" }));
  const duplicateRun = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `duplicate-${runId}` });
  assert.equal(duplicateRun.processed, true);
  assert.equal(duplicateRun.assessmentId, undefined);
  assert.equal(requests.length, 2);
  assert.equal(await prisma.socialRelationshipAssessment.count({ where: { scopeId: enabledScope } }), historyBefore);
  assert.equal((await prisma.socialRelationshipAssessmentTask.findUniqueOrThrow({ where: { scopeId: enabledScope } })).status, "PAUSED");

  console.log("\n[3] 关闭助手的任务不领取、不消耗重试次数");
  const disabledRun = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `social-ai-worker-${runId}` });
  assert.equal(disabledRun.processed, false);
  const disabledTask = await prisma.socialRelationshipAssessmentTask.findUniqueOrThrow({ where: { scopeId: disabledScope } });
  assert.equal(disabledTask.status, "QUEUED");
  assert.equal(disabledTask.attemptCount, 0);
  assert.equal(requests.length, 2, "关闭助手不应调用模型");

  const usage = await prisma.modelUsage.findMany({
    where: { characterId: enabledCharacter.id, kind: "social-relationship-assistant" },
  });
  assert.equal(usage.length, 2, "两次评估调用均应计入独立用量类别");

  console.log("\n[3b] 明确周期回顾仍允许读取历史经历");
  outputs.push({ outcome: "MAINTAIN", suggestedStage: "STRANGER", suggestedStatus: "UNOBSERVED", reason: "定期回顾保持现状。", confidence: 0.8, observations: [], evidenceExperienceIds: [], newEvidenceExperienceIds: [], needsMoreEvidence: false, cautionFlags: [] });
  await prisma.$transaction(tx => enqueueSocialRelationshipAssessment(tx, { scopeId: enabledScope, reason: "PERIODIC_REVIEW" }));
  const periodicRun = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `periodic-${runId}` });
  assert(periodicRun.assessmentId);
  assert.equal(periodicRun.outcome, "MAINTAIN");
  assert.equal(requests.length, 3);
  console.log("\n[4] 模型执行期间来源归档或改写后，结果降为不可采纳REVIEW");
  for (const mutation of ["archive", "content"] as const) {
    const changing = await addExperience(enabledCharacter.globalScopeId, enabledScope, `变更中来源${mutation}`, "生成模型请求时的证据正文。", `changing-${mutation}-${runId}`);
    const row = await prisma.socialExperience.findUniqueOrThrow({ where: { id: changing.id } });
    globalThis.fetch = (async () => {
      await prisma.memoryEvent.update({ where: { id: row.memoryEventId }, data: mutation === "archive" ? { status: "ARCHIVED" } : { detail: "请求发出后证据正文已更改。" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        outcome: "CHANGE", suggestedStage: "FRIEND", suggestedStatus: "NORMAL", reason: "模型基于旧来源提出变化。", confidence: 0.9, observations: [],
        evidenceExperienceIds: [changing.id], newEvidenceExperienceIds: [changing.id], needsMoreEvidence: false, cautionFlags: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await prisma.$transaction(tx => enqueueSocialRelationshipAssessment(tx, { scopeId: enabledScope, reason: "NEW_EXPERIENCE" }));
    const result = await processNextSocialRelationshipAssessmentTask(prisma, { workerId: `source-change-${mutation}` });
    assert(result.assessmentId);
    const saved = await prisma.socialRelationshipAssessment.findUniqueOrThrow({ where: { id: result.assessmentId } });
    assert.equal(saved.outcome, "REVIEW"); assert.equal(saved.reviewStatus, "NOT_REQUIRED");
    assert.equal(saved.suggestedStage, null); assert.equal(saved.suggestedStatus, null);
    assert.equal((await prisma.memoryScope.findUniqueOrThrow({ where: { id: enabledScope } })).relationshipVersion, 0);
  }
  console.log("社交关系评估 AI 数据库集成测试通过。");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: [enabledCharacter.id, disabledCharacter.id] } } });
  await prisma.socialRelationshipAssessmentTask.deleteMany({ where: { scopeId: { in: [enabledScope, disabledScope] } } });
  await prisma.socialRelationshipAssessment.deleteMany({ where: { scopeId: { in: [enabledScope, disabledScope] } } });
  await prisma.socialExperience.deleteMany({ where: { scopeId: { in: [enabledScope, disabledScope] } } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: { in: [enabledCharacter.globalScopeId, disabledCharacter.globalScopeId] } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [enabledCharacter.id, disabledCharacter.id] } } });
  await prisma.externalIdentity.deleteMany({ where: { id: identity.id } });
  await prisma.character.deleteMany({ where: { id: { in: [enabledCharacter.id, disabledCharacter.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  await prisma.$disconnect();
}
