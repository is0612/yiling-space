import "dotenv/config";
import { readFile } from "node:fs/promises";
import { getPrisma } from "../server/utils/prisma";
import { collectWatchdogFindings } from "../server/utils/watchdog";

// Repeatable, aggregate-only observation. No raw messages, identities, keys or model calls.
const args = process.argv.slice(2);
if (args.some(arg => !/^--hours=\d+$/.test(arg))) throw new Error("Usage: tsx scripts/probe-growth-acceptance.ts [--hours=24]");
const hours = Number(args.at(-1)?.slice("--hours=".length) ?? 24);
if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("hours must be between 1 and 168");
const now = new Date(), since = new Date(now.getTime() - hours * 3_600_000);
const db = getPrisma();
try {
  const source = await readFile("server/utils/chat-reply.ts", "utf8");
  const sourceVersion = /const PROMPT_TEMPLATE_VERSION = "(conversation-retrieval-v\d+)"/.exec(source)?.[1] ?? "unknown";
  const report = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const replies = await tx.$queryRaw<Array<{ entry: string; version: string; count: number; lastAt: Date; selfViews: number }>>`
      SELECT CASE WHEN c."channelBindingId" IS NULL THEN 'web'
        WHEN c."externalConversationId" LIKE 'g:%' THEN 'group' ELSE 'private-channel' END AS "entry",
        CASE WHEN m."metadata"->>'promptTemplateVersion' ~ '^conversation-retrieval-v[0-9]+$'
          THEN m."metadata"->>'promptTemplateVersion' ELSE 'unknown' END AS "version",
        COUNT(*)::int AS "count", MAX(m."ingestedAt") AS "lastAt",
        COUNT(*) FILTER (WHERE jsonb_typeof(m."metadata"->'providedSelfUnderstandingSources') = 'array')::int AS "selfViews"
      FROM "messages" m JOIN "conversations" c ON c."id" = m."conversationId"
      WHERE m."role" = 'ASSISTANT' AND m."ingestedAt" >= ${since} AND m."ingestedAt" <= ${now}
      GROUP BY 1, 2 ORDER BY 1, 2
    `;
    const generations = await tx.$queryRaw<Array<{ kind: string; status: string; count: number; lastAt: Date }>>`
      SELECT "kind", CASE WHEN "metadata"->>'status' IN ('success','failed','no_sources','not_enabled')
        THEN "metadata"->>'status' ELSE 'other' END AS "status", COUNT(*)::int AS "count", MAX("createdAt") AS "lastAt"
      FROM "model_usages" WHERE "kind" IN ('chat','channel','context-assistant','memory-assistant')
        AND "createdAt" >= ${since} AND "createdAt" <= ${now} GROUP BY 1, 2 ORDER BY 1, 2
    `;
    const experienceProgress = await tx.interactionExperienceProgress.groupBy({ by: ["status"], _count: { _all: true }, _max: { updatedAt: true } });
    const channels = await tx.platformConnection.groupBy({ by: ["status"], where: { platform: "qq-onebot" }, _count: { _all: true }, _max: { lastEventAt: true } });
    const experiences = await tx.interactionExperience.groupBy({ by: ["status"], where: { createdAt: { gte: since, lte: now } }, _count: { _all: true } });
    const reflections = await tx.reflectionRun.groupBy({ by: ["status"], where: { createdAt: { gte: since, lte: now } }, _count: { _all: true } });
    const suggestions = await tx.reflectionSuggestion.groupBy({ by: ["status"], where: { createdAt: { gte: since, lte: now } }, _count: { _all: true } });
    const automaticExperience = await tx.$queryRaw<Array<{ enabled: number; total: number }>>`
      SELECT COUNT(*) FILTER (WHERE "modelConfig"->>'interactionExperienceAutoEnabled' = 'true')::int AS "enabled", COUNT(*)::int AS "total" FROM "characters" WHERE "status" = 'ACTIVE'
    `;
    const expiredExperienceLeases = await tx.interactionExperienceProgress.count({ where: { status: "RUNNING", leaseUntil: { lt: now } } });
    const expiredReflectionLeases = await tx.reflectionRun.count({ where: { status: "RUNNING", leaseExpiresAt: { lt: now } } });
    return { replies, generations, channels, automaticExperience: automaticExperience[0], experienceProgress, experiences, reflections, suggestions, expiredExperienceLeases, expiredReflectionLeases };
  }, { timeout: 30_000 });
  const findings = await collectWatchdogFindings(db, now);
  const watchdog = findings.reduce<Record<string, { severity: string; count: number }>>((result, finding) => {
    const row = result[finding.code] ?? { severity: finding.severity, count: 0 }; row.count++; result[finding.code] = row; return result;
  }, {});
  const endpoints = await Promise.all([3000, 8801].map(async port => {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000), redirect: "error" }); return { port, status: response.status, reachable: true }; }
    catch { return { port, reachable: false }; }
  }));
  console.log(JSON.stringify({ capturedAt: now.toISOString(), since: since.toISOString(), hours, readOnly: true, modelCalls: 0,
    sourceVersion, observedCurrentVersionReplies: report.replies.filter(row => row.version === sourceVersion).reduce((sum, row) => sum + row.count, 0),
    endpoints, ...report, watchdog, limitations: ["Counters do not establish semantic quality or which revision a running process loaded.", "Zero candidate or self-view counts do not prove a defect without an eligible real interaction."] }, null, 2));
} catch {
  console.error("实际使用基线读取失败。请运行 check:env 检查数据库连接；本工具未调用模型或写入业务数据。");
  process.exitCode = 1;
} finally { await db.$disconnect(); }
