import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

type DB = PrismaClient | Prisma.TransactionClient;
export type ExperienceScope = { conversationId: string; memoryScopeId: string };
export type ExperienceReflectionRef = { key: string; type: "experience"; id: string; hash: string; conversationId: string; memoryScopeId: string };
export function experienceReflectionHash(row: { content: string; context: string; evidenceHash: string; learning?: unknown; revision: number; conversationId: string; memoryScopeId: string }) {
  return createHash("sha256").update(JSON.stringify([row.content, row.context, row.evidenceHash, row.learning ?? {}, row.revision, row.conversationId, row.memoryScopeId])).digest("hex");
}
export async function collectExperienceReflectionSources(db: DB, characterId: string, scope: ExperienceScope, start: Date, end: Date) {
  const candidates = await db.interactionExperience.findMany({ where: { characterId, ...scope, status: "ACTIVE", createdAt: { gte: start, lt: end }, conversation: { characterId, memoryScopeId: scope.memoryScopeId, OR: [{ channelBindingId: null }, { externalConversationId: { startsWith: "c:" } }] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 300 });
  const feedback = await db.message.findMany({ where: { id: { in: candidates.map(row => row.feedbackMessageId) }, conversationId: scope.conversationId, role: "USER" }, select: { id: true, occurredAt: true } });
  const occurredAtById = new Map(feedback.map(row => [row.id, row.occurredAt.toISOString()]));
  const dayById = new Map(feedback.map(row => [row.id, row.occurredAt.toISOString().slice(0,10)]));
  const counts = new Map<string, number>(); const seen = new Set<string>();
  const rows = candidates.filter(row => { const day = dayById.get(row.feedbackMessageId); if (!day || seen.has(row.feedbackMessageId) || (counts.get(day) ?? 0) >= 15) return false; seen.add(row.feedbackMessageId); counts.set(day, (counts.get(day) ?? 0)+1); return true; }).slice(0,30);
  return rows.map(row => ({ key: `experience:${row.id}`, type: "experience" as const, id: row.id, hash: experienceReflectionHash(row), ...scope, feedbackOccurredAt: occurredAtById.get(row.feedbackMessageId)!, title: "本会话互动经验", excerpt: JSON.stringify({ content: row.content, context: row.context, learning: row.learning }).slice(0, 1200) }));
}
export async function validateExperienceReflectionRefs(tx: Prisma.TransactionClient, characterId: string, refs: readonly ExperienceReflectionRef[], expected?: ExperienceScope) {
  const valid = await validateExperienceReflectionRefsBatch(tx, characterId, [{ id: "single", refs }], expected);
  return valid.has("single");
}

/**
 * 同一 scope 的多组来源一次事务、一次锁、一次查询校验完。
 * 逐组调用会在同一事务里重复 FOR SHARE，把锁窗口拉到整批结束；这里只读一次快照后逐组比对 hash。
 */
export async function validateExperienceReflectionRefsBatch(
  tx: Prisma.TransactionClient,
  characterId: string,
  groups: readonly { id: string; refs: readonly ExperienceReflectionRef[] }[],
  expected?: ExperienceScope,
): Promise<Set<string>> {
  const valid = new Set<string>();
  if (!groups.length) return valid;
  if (groups.some(group => !group.refs.length || group.refs.length > 30)) return valid;
  const allRefs = groups.flatMap(group => group.refs);
  const scope = expected ?? { conversationId: allRefs[0]!.conversationId, memoryScopeId: allRefs[0]!.memoryScopeId };
  if (!scope.conversationId || !scope.memoryScopeId
    || allRefs.some(ref => ref.type !== "experience" || ref.key !== `experience:${ref.id}` || ref.conversationId !== scope.conversationId || ref.memoryScopeId !== scope.memoryScopeId)) return valid;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT c."id" FROM "conversations" c JOIN "memory_scopes" s ON s."id"=c."memoryScopeId" WHERE c."id"=${scope.conversationId}::uuid AND c."characterId"=${characterId}::uuid AND s."id"=${scope.memoryScopeId}::uuid FOR SHARE OF c,s`;
  if (!locked.length) return valid;
  const room = await tx.conversation.findFirst({ where: { id: scope.conversationId, characterId, memoryScopeId: scope.memoryScopeId, OR: [{ channelBindingId: null }, { externalConversationId: { startsWith: "c:" } }] }, select: { id: true } });
  if (!room) return valid;
  const rows = await tx.$queryRaw<Array<{ id: string; content: string; context: string; evidenceHash: string; learning: Prisma.JsonValue; revision: number; conversationId: string; memoryScopeId: string }>>`SELECT "id", "content", "context", "evidenceHash", "learning", "revision", "conversationId", "memoryScopeId" FROM "interaction_experiences" WHERE "characterId"=${characterId}::uuid AND "conversationId"=${scope.conversationId}::uuid AND "memoryScopeId"=${scope.memoryScopeId}::uuid AND "status"='ACTIVE' FOR SHARE`;
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const group of groups) {
    if (group.refs.every(ref => { const row = byId.get(ref.id); return row && experienceReflectionHash(row) === ref.hash; })) valid.add(group.id);
  }
  return valid;
}
/** Three distinct feedback messages across at least two UTC days; never generalize one exchange. */
export function hasRepeatedExperienceEvidence(rows: readonly { feedbackMessageId: string; createdAt: Date }[]) {
  return new Set(rows.map(row => row.feedbackMessageId)).size >= 3 && new Set(rows.map(row => row.createdAt.toISOString().slice(0, 10))).size >= 2;
}
/** Uses existing reflection queue and lease/retry worker. One deterministic evidence batch, not one model call per card. */
export async function enqueueExperienceReflections(prisma: PrismaClient, now = new Date()) {
  const experiences = await prisma.$queryRaw<Array<{ id: string; characterId: string; conversationId: string; memoryScopeId: string; feedbackMessageId: string; createdAt: Date }>>`WITH fresh AS (SELECT e.* FROM "interaction_experiences" e JOIN "characters" c ON c."id"=e."characterId" JOIN "conversations" v ON v."id"=e."conversationId" AND v."characterId"=e."characterId" AND v."memoryScopeId"=e."memoryScopeId" WHERE (v."channelBindingId" IS NULL OR v."externalConversationId" LIKE 'c:%') AND e."status"='ACTIVE' AND c."modelConfig"->>'interactionExperienceAutoEnabled'='true' AND NOT EXISTS (SELECT 1 FROM "reflection_runs" r WHERE r."characterId"=e."characterId" AND r."conversationId"=e."conversationId" AND r."memoryScopeId"=e."memoryScopeId" AND r."periodEnd">e."createdAt")), eligible AS (SELECT e."conversationId",e."memoryScopeId" FROM fresh e JOIN "messages" m ON m."id"=e."feedbackMessageId" AND m."conversationId"=e."conversationId" AND m."role"='USER' GROUP BY e."conversationId",e."memoryScopeId" HAVING count(DISTINCT m."id")>=3 AND count(DISTINCT (m."occurredAt" AT TIME ZONE 'UTC')::date)>=2 ORDER BY min(e."createdAt") LIMIT 10) SELECT e."id",e."characterId",e."conversationId",e."memoryScopeId",e."feedbackMessageId",e."createdAt" FROM (SELECT f.*,row_number() OVER (PARTITION BY f."conversationId",f."memoryScopeId",(m."occurredAt" AT TIME ZONE 'UTC')::date ORDER BY f."createdAt" DESC,f."id" DESC) AS position FROM fresh f JOIN eligible g ON g."conversationId"=f."conversationId" AND g."memoryScopeId"=f."memoryScopeId" JOIN "messages" m ON m."id"=f."feedbackMessageId" AND m."conversationId"=f."conversationId") e WHERE e.position<=15 ORDER BY e."createdAt",e."id" LIMIT 300`;
  const groups = new Map<string, typeof experiences>();
  for (const row of experiences) { const key = `${row.characterId}:${row.conversationId}:${row.memoryScopeId}`; const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
  let queued = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    const scope = { conversationId: first.conversationId, memoryScopeId: first.memoryScopeId };
    const prior = await prisma.reflectionRun.findMany({ where: { characterId: first.characterId, ...scope }, select: { periodEnd: true, status: true }, orderBy: { periodEnd: "desc" }, take: 1 });
    if (prior.some(row => row.status === "RUNNING" || row.status === "QUEUED")) continue;
    const fresh = group.filter(row => !prior[0] || row.createdAt >= prior[0].periodEnd).slice(0, 30);
    const feedback = await prisma.message.findMany({ where: { id: { in: fresh.map(row => row.feedbackMessageId) }, conversationId: scope.conversationId, role: "USER" }, select: { id: true, occurredAt: true } });
    if (!hasRepeatedExperienceEvidence(feedback.map(row => ({ feedbackMessageId: row.id, createdAt: row.occurredAt })))) continue;
    const start = fresh[0]!.createdAt, end = new Date(fresh[fresh.length - 1]!.createdAt.getTime() + 1);
    const refs = await collectExperienceReflectionSources(prisma, first.characterId, scope, start, end);
    if (refs.length < 3) continue;
    const selected = await prisma.interactionExperience.findMany({ where: { id: { in: refs.map(ref => ref.id) }, characterId: first.characterId, ...scope }, select: { feedbackMessageId: true } });
    const selectedFeedback = feedback.filter(row => selected.some(item => item.feedbackMessageId === row.id));
    if (!hasRepeatedExperienceEvidence(selectedFeedback.map(row => ({ feedbackMessageId: row.id, createdAt: row.occurredAt })))) continue;
    const hex = createHash("sha256").update(JSON.stringify(refs.map(ref => [ref.key, ref.hash]))).digest("hex");
    const requestKey = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    await prisma.reflectionRun.upsert({ where: { characterId_requestKey: { characterId: first.characterId, requestKey } }, update: {}, create: { characterId: first.characterId, ...scope, requestKey, periodStart: start, periodEnd: end, runAt: now } });
    queued++;
  }
  return queued;
}
