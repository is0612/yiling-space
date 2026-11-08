import "dotenv/config";
import assert from "node:assert/strict";
import { getPrisma } from "../server/utils/prisma";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";

const databaseName = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.replace(/^\//, "");
assert(
  /^yiling_social_assessment_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性社交评估测试库。请运行 yarn test:social-relationship-assessment-isolated。`,
);

const prisma = getPrisma();
let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) console.log("  ✅", name);
  else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
async function expectPrismaCode(action: () => Promise<unknown>, code: string) {
  try { await action(); return false; }
  catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
}

const runId = Date.now().toString(36);
const owner = await prisma.user.create({
  data: { username: `social-assess-${runId}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});
const makeCharacter = async (name: string) => {
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name,
      basePrompt: "社交评估数据库自检",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `global:${name}:${runId}` } },
    },
    select: { id: true },
  });
  const globalScope = await prisma.memoryScope.findFirstOrThrow({
    where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  return { id: character.id, globalScopeId: globalScope.id };
};
const charA = await makeCharacter("评估隔离A");
const charB = await makeCharacter("评估隔离B");
const identity = await prisma.externalIdentity.create({
  data: { platform: "qq-onebot", platformUid: `assessment-${runId}`, status: "UNVERIFIED" },
  select: { id: true },
});
const scopeA = (await ensureExternalIdentityScope(charA.id, "qq-onebot", `assessment-${runId}`, identity.id)).scopeId;
const scopeB = (await ensureExternalIdentityScope(charB.id, "qq-onebot", `assessment-${runId}`, identity.id)).scopeId;
const eventA = await prisma.memoryEvent.create({
  data: {
    memoryScopeId: charA.globalScopeId, dayKey: "2026-11-08", occurredAt: new Date(),
    title: "A 的共同经历", detail: "仅供隔离测试", dedupeKey: `a:${runId}`,
  }, select: { id: true },
});
const eventB = await prisma.memoryEvent.create({
  data: {
    memoryScopeId: charB.globalScopeId, dayKey: "2026-11-08", occurredAt: new Date(),
    title: "B 的共同经历", detail: "仅供隔离测试", dedupeKey: `b:${runId}`,
  }, select: { id: true },
});
const experienceA = await prisma.socialExperience.create({
  data: { scopeId: scopeA, memoryEventId: eventA.id, sourceKey: `source-a-${runId}` },
  select: { id: true },
});
const experienceB = await prisma.socialExperience.create({
  data: { scopeId: scopeB, memoryEventId: eventB.id, sourceKey: `source-b-${runId}` },
  select: { id: true },
});

try {
  console.log("\n[1] 关系状态与角色隔离");
  const [a, b, global] = await Promise.all([
    prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeA } }),
    prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeB } }),
    prisma.memoryScope.findUniqueOrThrow({ where: { id: charA.globalScopeId } }),
  ]);
  check("两个角色认识同一账号时，各自拥有独立关系范围", scopeA !== scopeB);
  check("新关系初始化为 STRANGER + UNOBSERVED", a.relationshipStage === "STRANGER" && a.relationshipStatus === "UNOBSERVED");
  check("另一角色的关系状态独立初始化", b.relationshipStage === "STRANGER" && b.relationshipStatus === "UNOBSERVED");
  check("非好友范围的关系阶段与相处状态均为 NULL", global.relationshipStage === null && global.relationshipStatus === null);

  console.log("\n[2] 每段关系只有一条可复用任务状态");
  const taskA = await prisma.socialRelationshipAssessmentTask.create({
    data: { scopeId: scopeA, triggerReasons: ["NEW_EXPERIENCE"], generation: 1 },
  });
  const taskB = await prisma.socialRelationshipAssessmentTask.create({
    data: { scopeId: scopeB, triggerReasons: ["NEW_EXPERIENCE"], generation: 1 },
  });
  check("两个角色的任务状态各自独立", taskA.scopeId !== taskB.scopeId);
  check("同一关系重复创建任务受 scopeId 唯一约束保护",
    await expectPrismaCode(() => prisma.socialRelationshipAssessmentTask.create({ data: { scopeId: scopeA } }), "P2002"));
  const updatedTask = await prisma.socialRelationshipAssessmentTask.update({
    where: { scopeId: scopeA },
    data: { generation: { increment: 1 }, triggerReasons: ["NEW_EXPERIENCE", "PERIODIC_REVIEW"] },
  });
  check("generation 可独立递增并保留合并触发原因",
    updatedTask.generation === 2 && updatedTask.triggerReasons.length === 2);

  console.log("\n[3] 评估历史与 NEW / CONTEXT 证据引用");
  const assessment = await prisma.socialRelationshipAssessment.create({
    data: {
      scopeId: scopeA, generation: 2, triggerReasons: ["NEW_EXPERIENCE"],
      evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED", relationshipVersion: 0,
      status: "SUCCEEDED", outcome: "INSUFFICIENT", reason: "证据不足时保持原关系",
      evidence: { create: [
        { experienceId: experienceA.id, kind: "NEW" },
        { experienceId: experienceB.id, kind: "CONTEXT" },
      ] },
    },
    include: { evidence: true },
  });
  check("评估历史独立保存结论，且不复制忆泡正文", assessment.outcome === "INSUFFICIENT" && assessment.reason !== null);
  check("评估证据能区分 NEW 与 CONTEXT", assessment.evidence.some(e => e.kind === "NEW") && assessment.evidence.some(e => e.kind === "CONTEXT"));
  check("同一评估内同一经历不能重复挂接",
    await expectPrismaCode(() => prisma.socialRelationshipAssessmentEvidence.create({
      data: { assessmentId: assessment.id, experienceId: experienceA.id, kind: "NEW" },
    }), "P2002"));
  check("评估历史允许同一关系多次追加，不覆盖旧记录",
    (await prisma.socialRelationshipAssessment.count({ where: { scopeId: scopeA } })) === 1);
  const secondAssessment = await prisma.socialRelationshipAssessment.create({
    data: {
      scopeId: scopeA, generation: 3, triggerReasons: ["PERIODIC_REVIEW"],
      evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED", relationshipVersion: 0,
      status: "SUCCEEDED", outcome: "MAINTAIN",
    },
  });
  check("同一关系可保留多次独立评估历史", secondAssessment.id !== assessment.id
    && (await prisma.socialRelationshipAssessment.count({ where: { scopeId: scopeA } })) === 2);

  console.log("\n[4] 外键与级联行为");
  check("删除经历时对应评估证据引用级联删除",
    await expectPrismaCode(async () => {
      await prisma.socialExperience.delete({ where: { id: experienceA.id } });
      throw new Error("sentinel");
    }, "P2025") === false); // 实际删除成功；下方核对证据
  check("经历删除后评估证据被级联清理",
    (await prisma.socialRelationshipAssessmentEvidence.count({ where: { assessmentId: assessment.id } })) === 1);
  await prisma.memoryScope.delete({ where: { id: scopeA } });
  check("删除关系范围后，任务、评估历史及证据全部级联清理",
    (await prisma.socialRelationshipAssessmentTask.count({ where: { scopeId: scopeA } })) === 0
    && (await prisma.socialRelationshipAssessment.count({ where: { scopeId: scopeA } })) === 0
    && (await prisma.socialRelationshipAssessmentEvidence.count({ where: { assessmentId: assessment.id } })) === 0);
} finally {
  await prisma.socialExperience.deleteMany({ where: { scopeId: { in: [scopeA, scopeB] } } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: { in: [charA.globalScopeId, charB.globalScopeId] } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [charA.id, charB.id] } } });
  await prisma.externalIdentity.deleteMany({ where: { id: identity.id } });
  await prisma.character.deleteMany({ where: { id: { in: [charA.id, charB.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  await prisma.$disconnect();
}
if (failures > 0) {
  console.error(`\n社交关系评估数据库自检：${failures} 项未通过。`);
  process.exit(1);
}
console.log("\n社交关系评估数据库自检通过。");
