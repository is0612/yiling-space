import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";
import { linkMemoryEventToSocialExperiences } from "../server/utils/social-experiences";
import {
  claimNextSocialRelationshipAssessmentTask,
  completeSocialRelationshipAssessmentTask,
  failSocialRelationshipAssessmentTask,
  renewSocialRelationshipAssessmentLease,
  runSocialRelationshipQueueMaintenance,
  SOCIAL_RELATIONSHIP_TASK_LEASE_MS,
  resolveSocialRelationshipReviewIntervalDays,
} from "../server/utils/social-relationship-queue";

const databaseName = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.replace(/^\//, "");
assert(
  /^yiling_social_queue_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性社交队列测试库。请运行 yarn test:social-relationship-queue-isolated。`,
);

const prisma = getPrisma();
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const now = new Date(Date.now() + 60_000);
let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) console.log("  ✅", name);
  else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

const owner = await prisma.user.create({
  data: { username: `social-queue-${runId}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});
const makeCharacter = async (suffix: string) => {
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name: `社交队列${suffix}`,
      basePrompt: "社交关系队列隔离测试",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `global:queue:${suffix}:${runId}` } },
    },
    select: { id: true },
  });
  const globalScope = await prisma.memoryScope.findFirstOrThrow({
    where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  return { id: character.id, globalScopeId: globalScope.id };
};
const charA = await makeCharacter("A");
const charB = await makeCharacter("B");
const identity = await prisma.externalIdentity.create({
  data: { platform: "qq-onebot", platformUid: `queue-${runId}`, status: "UNVERIFIED" },
  select: { id: true },
});
const scopeA = (await ensureExternalIdentityScope(charA.id, "qq-onebot", `queue-${runId}`, identity.id)).scopeId;
const scopeB = (await ensureExternalIdentityScope(charB.id, "qq-onebot", `queue-${runId}`, identity.id)).scopeId;

async function addEvent(characterId: string, globalScopeId: string, suffix: string, sourceIds: string[]) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.memoryEvent.create({
      data: {
        memoryScopeId: globalScopeId,
        dayKey: "2026-11-08",
        occurredAt: new Date(now.getTime() + Number(suffix.slice(1) || 0)),
        title: `隔离测试经历${suffix}`,
        detail: "仅供社交关系队列测试",
        participants: ["某个好友"],
        participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: `queue-${runId}` }],
        dedupeKey: `social-queue:${characterId}:${suffix}:${runId}`,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    const created = await linkMemoryEventToSocialExperiences(tx, {
      characterId,
      memoryEventId: event.id,
      participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: `queue-${runId}` }],
      sourceMessageIds: sourceIds,
    });
    return { eventId: event.id, created };
  });
}

async function readTask(scopeId: string) {
  return prisma.socialRelationshipAssessmentTask.findUniqueOrThrow({ where: { scopeId } });
}

try {
  console.log("\n[1] 新经历写入与任务触发同事务、重复经历不重复增加代数");
  const firstSource = [`msg-a1-${runId}`, `msg-a2-${runId}`];
  const first = await addEvent(charA.id, charA.globalScopeId, "A1", firstSource);
  const taskA1 = await readTask(scopeA);
  check("首次真实新经历创建唯一任务，generation 从 1 开始", first.created === 1 && taskA1.generation === 1);
  check("任务为 QUEUED 且记录 NEW_EXPERIENCE 原因",
    taskA1.status === "QUEUED" && taskA1.triggerReasons.includes("NEW_EXPERIENCE"));
  check("首次触发同时安排未来回顾时间",
    taskA1.nextReviewAt !== null && taskA1.nextReviewAt.getTime() > now.getTime());

  const duplicate = await prisma.$transaction((tx) => linkMemoryEventToSocialExperiences(tx, {
    characterId: charA.id,
    memoryEventId: first.eventId,
    participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: `queue-${runId}` }],
    sourceMessageIds: firstSource,
  }));
  const afterDuplicate = await readTask(scopeA);
  check("重复 sourceKey 被唯一约束跳过，不制造虚假触发", duplicate === 0 && afterDuplicate.generation === 1);

  const second = await addEvent(charA.id, charA.globalScopeId, "A2", [`msg-a3-${runId}`]);
  const taskA2 = await readTask(scopeA);
  check("新的独立经历合并到同一条任务并递增 generation", second.created === 1 && taskA2.generation === 2);
  check("同一角色的任务不会因新经历产生第二行",
    await prisma.socialRelationshipAssessmentTask.count({ where: { scopeId: scopeA } }) === 1);

  console.log("\n[2] 并发领取与执行期间新经历进入下一代");
  const claims = await Promise.all([
    claimNextSocialRelationshipAssessmentTask(prisma, { workerId: "queue-worker-a", scopeId: scopeA, now }),
    claimNextSocialRelationshipAssessmentTask(prisma, { workerId: "queue-worker-b", scopeId: scopeA, now }),
  ]);
  const activeClaims = claims.filter((claim) => claim !== null);
  check("两个 Worker 并发时同一关系最多只有一个领取成功", activeClaims.length === 1);
  const leaseA = activeClaims[0];
  assert(leaseA);
  const claimedTaskA = await readTask(scopeA);
  check("领取后状态为 RUNNING，尝试次数与 fencing token 递增",
    claimedTaskA.status === "RUNNING" && claimedTaskA.attemptCount === 1
      && claimedTaskA.fencingToken === leaseA.fencingToken);
  check("领取时冻结当前 generation 与原因，待处理原因被移出当前批次",
    leaseA.generation === 2 && leaseA.triggerReasons.includes("NEW_EXPERIENCE")
      && claimedTaskA.triggerReasons.length === 0);

  const duringRun = await addEvent(charA.id, charA.globalScopeId, "A3", [`msg-a4-${runId}`]);
  const whileRunning = await readTask(scopeA);
  check("执行中新增经历只增加下一代，不抢占当前租约",
    duringRun.created === 1 && whileRunning.status === "RUNNING"
      && whileRunning.generation === 3 && whileRunning.leaseToken === leaseA.leaseToken
      && whileRunning.triggerReasons.includes("NEW_EXPERIENCE"));

  const renewedUntil = await renewSocialRelationshipAssessmentLease(prisma, leaseA, now);
  check("正确 token 可以续租，租约截止时间向后延长",
    renewedUntil.getTime() === now.getTime() + SOCIAL_RELATIONSHIP_TASK_LEASE_MS);
  const completedFirstGeneration = await completeSocialRelationshipAssessmentTask(prisma, leaseA, { now });
  const afterFirstCompletion = await readTask(scopeA);
  check("完成当前代时发现 generation 已增加，自动排队下一代而不是暂停",
    completedFirstGeneration === "QUEUED" && afterFirstCompletion.status === "QUEUED"
      && afterFirstCompletion.processedGeneration === 2 && afterFirstCompletion.generation === 3);

  const leaseA2 = await claimNextSocialRelationshipAssessmentTask(prisma, { workerId: "queue-worker-next", scopeId: scopeA, now });
  assert(leaseA2);
  check("下一代领取到新增经历对应的 generation", leaseA2.scopeId === scopeA && leaseA2.generation === 3);
  const completedSecondGeneration = await completeSocialRelationshipAssessmentTask(prisma, leaseA2, {
    now: new Date(now.getTime() + 1_000),
    reviewIntervalDays: 30,
  });
  const pausedTaskA = await readTask(scopeA);
  check("没有新经历时完成任务进入 PAUSED，并保留下次回顾时间",
    completedSecondGeneration === "PAUSED" && pausedTaskA.status === "PAUSED"
      && pausedTaskA.processedGeneration === 3 && pausedTaskA.nextReviewAt !== null);

  console.log("\n[3] 定期回顾与启动补偿");
  await prisma.socialRelationshipAssessmentTask.update({
    where: { scopeId: scopeA },
    data: { nextReviewAt: new Date(now.getTime() - 1_000) },
  });
  // 模拟历史回填直接写入经历、尚未建立任务的旧数据；启动维护应补建而不是漏掉。
  const legacyEvent = await prisma.memoryEvent.create({
    data: {
      memoryScopeId: charB.globalScopeId,
      dayKey: "2026-11-08",
      occurredAt: now,
      title: "历史经历补偿",
      detail: "仅供隔离测试",
      dedupeKey: `legacy:${runId}`,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  await prisma.socialExperience.create({
    data: { scopeId: scopeB, memoryEventId: legacyEvent.id, sourceKey: `legacy-${runId}` },
  });
  const maintenance = await runSocialRelationshipQueueMaintenance(prisma, { now, reviewIntervalDays: 30 });
  const reviewedA = await readTask(scopeA);
  const recoveredB = await readTask(scopeB);
  check("启动补偿为已有经历但没有任务的关系建立待处理任务",
    maintenance.backfilled === 1 && recoveredB.generation === 1
      && recoveredB.triggerReasons.includes("EXISTING_EXPERIENCE_RECOVERY"));
  check("到期回顾只对上一代已处理且 PAUSED 的任务排新 generation",
    maintenance.periodicQueued === 1 && reviewedA.status === "QUEUED"
      && reviewedA.generation === 4 && reviewedA.triggerReasons.includes("PERIODIC_REVIEW"));

  console.log("\n[4] 失败退避、最大尝试次数与新经历重新唤醒");
  const leaseB1 = await claimNextSocialRelationshipAssessmentTask(prisma, { workerId: "queue-worker-fail-1", scopeId: scopeB, now });
  assert(leaseB1);
  check("补偿任务可以被领取", leaseB1.scopeId === scopeB);
  const failedOnce = await failSocialRelationshipAssessmentTask(prisma, leaseB1, new Error("模拟网络失败"), now);
  let retryB = await readTask(scopeB);
  check("第一次暂时失败进入 RETRY_WAIT 并记录错误",
    failedOnce === "RETRY_WAIT" && retryB.status === "RETRY_WAIT"
      && retryB.lastError === "模拟网络失败" && retryB.runAt.getTime() > now.getTime());
  check("失败退避随尝试次数递增", retryB.runAt.getTime() - now.getTime() === 60_000);

  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const lease = await claimNextSocialRelationshipAssessmentTask(prisma, {
      workerId: `queue-worker-fail-${attempt}`,
      scopeId: scopeB,
      now: new Date(retryB.runAt.getTime() + 1),
    });
    assert(lease);
    check(`第 ${attempt} 次领取仍属于同一关系且尝试次数正确`,
      lease.scopeId === scopeB && lease.attemptCount === attempt);
    const failed = await failSocialRelationshipAssessmentTask(
      prisma, lease, new Error(`模拟第${attempt}次失败`), new Date(retryB.runAt.getTime() + 1),
    );
    retryB = await readTask(scopeB);
    check(`第 ${attempt} 次失败${attempt === 3 ? "达到上限后进入 FAILED" : "继续退避重试"}`,
      attempt === 3 ? failed === "FAILED" && retryB.status === "FAILED"
        : failed === "RETRY_WAIT" && retryB.status === "RETRY_WAIT");
  }
  const beforeWake = retryB.generation;
  await addEvent(charB.id, charB.globalScopeId, "B2", [`msg-b2-${runId}`]);
  retryB = await readTask(scopeB);
  check("FAILED 任务遇到真正的新经历会重新排队并重置尝试次数",
    retryB.status === "QUEUED" && retryB.generation === beforeWake + 1 && retryB.attemptCount === 0);

  console.log("\n[5] 租约过期恢复与 fencing");
  const staleLease = await claimNextSocialRelationshipAssessmentTask(prisma, { workerId: "queue-worker-stale", scopeId: scopeB, now });
  assert(staleLease);
  await prisma.socialRelationshipAssessmentTask.update({
    where: { scopeId: scopeB },
    data: { leaseExpiresAt: new Date(now.getTime() - 1) },
  });
  const recovered = await runSocialRelationshipQueueMaintenance(prisma, {
    now: new Date(now.getTime() + 10_000),
    reviewIntervalDays: 30,
  });
  const afterRecovery = await readTask(scopeB);
  check("租约过期任务恢复为 RETRY_WAIT，清除旧租约并保留恢复原因",
    recovered.recoveredLeases === 1 && afterRecovery.status === "RETRY_WAIT"
      && afterRecovery.leaseToken === null && afterRecovery.lockedBy === null
      && afterRecovery.triggerReasons.includes("LEASE_RECOVERY"));
  const newLease = await claimNextSocialRelationshipAssessmentTask(prisma, {
    workerId: "queue-worker-successor",
    scopeId: scopeB,
    now: new Date(afterRecovery.runAt.getTime() + 1),
  });
  assert(newLease);
  check("恢复后新 Worker 获得不同 leaseToken 和更高 fencing token",
    newLease.scopeId === scopeB && newLease.leaseToken !== staleLease.leaseToken
      && newLease.fencingToken > staleLease.fencingToken);
  let staleRejected = false;
  try {
    await completeSocialRelationshipAssessmentTask(prisma, staleLease, {
      now: new Date(afterRecovery.runAt.getTime() + 2),
    });
  } catch (error) {
    staleRejected = error instanceof Error && error.name === "SocialRelationshipAssessmentLeaseLostError";
  }
  check("旧执行者不能提交新租约之后的结果", staleRejected);
  const afterNewFinish = await completeSocialRelationshipAssessmentTask(prisma, newLease, {
    now: new Date(afterRecovery.runAt.getTime() + 3),
  });
  check("新租约仍能正常完成", afterNewFinish === "PAUSED");

  console.log("\n[6] 角色隔离与默认间隔");
  check("同一外部账号在两个角色下仍是两条不同任务",
    scopeA !== scopeB
      && (await prisma.socialRelationshipAssessmentTask.count({ where: { scopeId: { in: [scopeA, scopeB] } } })) === 2);
  check("定期回顾默认间隔可配置且非法值回退为 30 天",
    resolveSocialRelationshipReviewIntervalDays("") === 30
      && resolveSocialRelationshipReviewIntervalDays("0") === 30
      && resolveSocialRelationshipReviewIntervalDays("45") === 45);
} finally {
  await prisma.socialRelationshipAssessmentTask.deleteMany({ where: { scopeId: { in: [scopeA, scopeB] } } });
  await prisma.socialExperience.deleteMany({ where: { scopeId: { in: [scopeA, scopeB] } } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: { in: [charA.globalScopeId, charB.globalScopeId] } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [charA.id, charB.id] } } });
  await prisma.externalIdentity.deleteMany({ where: { id: identity.id } });
  await prisma.character.deleteMany({ where: { id: { in: [charA.id, charB.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n社交关系队列验收：${failures} 项未通过。`);
  process.exit(1);
}
console.log("\n社交关系任务队列数据库验收通过。");
