/**
 * 清理「执行失败」的关系评估记录，并把用尽重试次数的任务重新排回队列。
 *
 * 背景（2026-11-10）：关系评估助手配的是思考型模型，而「最大输出 Token」留在了 2048。
 * 思考过程本身要 1700~2048 tokens，正文还没开始写就被截断 —— 每次评估都拿到空正文，
 * 报「没有返回可解析的 JSON 结果」，退避重试 3 次全是同一个结果。结果是：
 *   - 同一个好友在「关系评估历史」里连着出现 3~5 张一模一样的失败卡片；
 *   - 任务用尽重试后停在 FAILED，除了等一条新经历，再也不会被领取。
 *
 * 执行器侧的根因已经修好（默认 4096 起、截断后抬预算重试一次、失败原因写清 finish_reason），
 * 本脚本处理存量：删掉那些只剩噪音的失败卡片，把 FAILED 任务重新排回队列。
 *
 * 只动 status = FAILED 的评估行 —— 成功记录、证据关联、人工处置审计一律不碰
 * （失败行本身没有证据以外的关联，删除时由数据库级联带走证据行）。
 *
 * 用法：
 *   yarn clean:social-assessment-failures            # 只报告，不删
 *   yarn clean:social-assessment-failures --apply    # 真删 + 重新排队
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，清理脚本无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** 与执行器保持一致：思考型模型给 2048 必然截断。 */
const RECOMMENDED_OUTPUT_TOKENS = 4_096;

type FailedGroup = {
  displayName: string;
  platform: string;
  platformUid: string;
  rows: number;
  lastError: string | null;
};

async function readFailedGroups(): Promise<FailedGroup[]> {
  return prisma.$queryRaw<FailedGroup[]>`
    SELECT
      COALESCE(NULLIF(i."displayName", ''), '（无昵称）') AS "displayName",
      COALESCE(i."platform", '未知平台') AS "platform",
      COALESCE(i."platformUid", '未知账号') AS "platformUid",
      COUNT(*)::int AS "rows",
      MAX(left(a."error", 80)) AS "lastError"
    FROM "social_relationship_assessments" AS a
    INNER JOIN "memory_scopes" AS s ON s."id" = a."scopeId"
    LEFT JOIN "external_identities" AS i ON i."id" = s."externalIdentityId"
    WHERE a."status" = 'FAILED'::"SocialRelationshipAssessmentStatus"
    GROUP BY 1, 2, 3
    ORDER BY 4 DESC, 1 ASC
  `;
}

async function readAssistantBudgets() {
  const characters = await prisma.character.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, modelConfig: true },
  });
  return characters.flatMap((character) => {
    const config = character.modelConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) return [];
    const record = config as Record<string, unknown>;
    if (record.socialRelationshipAssessmentAssistantEnabled !== true) return [];
    const output = record.socialRelationshipAssessmentAssistantMaxOutputTokens;
    return [{
      name: character.name,
      model: typeof record.socialRelationshipAssessmentAssistantModel === "string"
        ? record.socialRelationshipAssessmentAssistantModel
        : "",
      maxOutputTokens: typeof output === "number" ? output : RECOMMENDED_OUTPUT_TOKENS,
    }];
  });
}

try {
  const [groups, failedAssessments, failedTasks, budgets] = await Promise.all([
    readFailedGroups(),
    prisma.socialRelationshipAssessment.count({ where: { status: "FAILED" } }),
    prisma.socialRelationshipAssessmentTask.count({ where: { status: "FAILED" } }),
    readAssistantBudgets(),
  ]);

  console.log("\n=== 关系评估失败存量 ===");
  console.log(`失败评估记录：${failedAssessments} 条，涉及 ${groups.length} 位好友`);
  for (const group of groups) {
    console.log(`  · ${group.displayName}（${group.platform} ${group.platformUid}）：${group.rows} 条`);
    if (group.lastError) console.log(`      最近一次错误：${group.lastError}`);
  }
  console.log(`用尽重试、停在 FAILED 的任务：${failedTasks} 条`);

  if (!budgets.length) {
    console.log("\n当前没有角色启用关系评估助手。");
  } else {
    console.log("\n=== 关系评估助手配置 ===");
    for (const budget of budgets) {
      const tight = budget.maxOutputTokens < RECOMMENDED_OUTPUT_TOKENS;
      console.log(`  · ${budget.name}：${budget.model || "（未填模型）"}，最大输出 Token ${budget.maxOutputTokens}${tight ? " ⚠️ 思考型模型容易截断" : ""}`);
    }
    if (budgets.some((budget) => budget.maxOutputTokens < RECOMMENDED_OUTPUT_TOKENS)) {
      console.log(`  提示：清完存量后，请到「关系评估 AI 设置」把最大输出 Token 调到 ${RECOMMENDED_OUTPUT_TOKENS} 以上，否则下一轮还会失败。`);
    }
  }

  if (!failedAssessments && !failedTasks) {
    console.log("\n没有需要清理的失败存量。");
  } else if (!apply) {
    console.log("\n这是预演，没有改动任何数据。确认后加 --apply 执行：删除失败评估记录，并把 FAILED 任务重新排队。");
  } else {
    const requeued = await prisma.$executeRaw`
      UPDATE "social_relationship_assessment_tasks"
      SET
        "status" = 'QUEUED'::"SocialRelationshipAssessmentTaskStatus",
        "attemptCount" = 0,
        "runAt" = NOW(),
        "lastError" = NULL,
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "triggerReasons" = CASE
          WHEN 'EXISTING_EXPERIENCE_RECOVERY' = ANY("triggerReasons") THEN "triggerReasons"
          ELSE array_append("triggerReasons", 'EXISTING_EXPERIENCE_RECOVERY')
        END,
        "updatedAt" = NOW()
      WHERE "status" = 'FAILED'::"SocialRelationshipAssessmentTaskStatus"
    `;
    const deleted = await prisma.socialRelationshipAssessment.deleteMany({ where: { status: "FAILED" } });
    console.log(`\n已删除 ${deleted.count} 条失败评估记录，${requeued} 条任务重新排队。`);
    console.log("下一轮本地 Worker 运行时会重新评估这些关系；前提是关系评估助手已启用且输出预算够用。");
  }
} finally {
  await prisma.$disconnect();
}
