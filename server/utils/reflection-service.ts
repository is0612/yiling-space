import { createError } from "h3";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { buildPage } from "./pagination";
import { collectReflectionSources, reflectionSourcesHash, validateReflectionSourceRefs } from "./reflection-worker";

const runInclude = { suggestions: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] } };
export function parseReflectionRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({ statusCode: 400, statusMessage: "请求无效。" });
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["requestKey", "days"].includes(key)) || typeof body.requestKey !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.requestKey) || ![7, 14, 30].includes(Number(body.days)) || typeof body.days !== "number") throw createError({ statusCode: 400, statusMessage: "请选择7、14或30天，并提供有效请求编号。" });
  return { requestKey: body.requestKey, days: body.days };
}
async function own(prisma: PrismaClient | Prisma.TransactionClient, ownerId: string, characterId: string) {
  if (!await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}
function publicRun<T extends { leaseToken?: unknown; leaseExpiresAt?: unknown; fencingToken?: unknown }>(run: T) {
  const { leaseToken: _token, leaseExpiresAt: _expiry, fencingToken: _fence, ...item } = run;
  return item;
}
export async function listReflectionRuns(prisma: PrismaClient, input: { ownerId: string; characterId: string; page: number; pageSize: number }) {
  await own(prisma, input.ownerId, input.characterId);
  const where = { characterId: input.characterId, character: { ownerId: input.ownerId } };
  const [rows, total] = await Promise.all([
    prisma.reflectionRun.findMany({ where, include: runInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.reflectionRun.count({ where }),
  ]);
  return buildPage(rows.map(publicRun), total, input.page, input.pageSize);
}
export async function requestReflection(prisma: PrismaClient, input: { ownerId: string; characterId: string; requestKey: string; days: number }, now = new Date()) {
  const parsed = parseReflectionRequest({ requestKey: input.requestKey, days: input.days });
  return prisma.$transaction(async tx => {
    // Serialize requests per role, not globally; a repeated network request reuses the same job.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`;
    if (!rows.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const existing = await tx.reflectionRun.findUnique({ where: { characterId_requestKey: { characterId: input.characterId, requestKey: parsed.requestKey } }, include: runInclude });
    if (existing) {
      const days = Math.round((existing.periodEnd.getTime() - existing.periodStart.getTime()) / 86_400_000);
      if (days !== parsed.days) throw createError({ statusCode: 409, statusMessage: "请求编号已用于其它反思时间段。" });
      return { run: publicRun(existing), created: false };
    }
    if (await tx.reflectionRun.findFirst({ where: { characterId: input.characterId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } })) throw createError({ statusCode: 409, statusMessage: "当前角色已有待执行或运行中的反思，请先等待完成。" });
    const periodStart = new Date(now.getTime() - parsed.days * 86_400_000);
    const sourcesHash = reflectionSourcesHash(await collectReflectionSources(tx, input.characterId, periodStart, now));
    const completed = await tx.reflectionRun.findFirst({ where: { characterId: input.characterId, status: "SUCCEEDED", sourcesHash }, include: runInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (completed) return { run: publicRun(completed), created: false };
    const run = await tx.reflectionRun.create({ data: { characterId: input.characterId, requestKey: parsed.requestKey, periodStart, periodEnd: now, sourcesHash }, include: runInclude });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: "reflection.requested", entityType: "ReflectionRun", entityId: run.id, details: { days: parsed.days } } });
    return { run: publicRun(run), created: true };
  });
}
export async function retryReflection(prisma: PrismaClient, input: { ownerId: string; characterId: string; runId: string }) {
  return prisma.$transaction(async tx => {
    const character = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`;
    if (!character.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const run = await tx.reflectionRun.findFirst({ where: { id: input.runId, characterId: input.characterId } });
    if (!run) throw createError({ statusCode: 404, statusMessage: "反思任务不存在。" });
    if (await tx.characterGrowthImportIdentity.findUnique({ where: { characterId_domain_localId: { characterId: input.characterId, domain: "reflectionRun", localId: run.id } } })) throw createError({ statusCode: 409, statusMessage: "导入的反思仅作历史留档，请重新发起一次反思。" });
    if (await tx.reflectionRun.count({ where: { characterId: input.characterId, status: { in: ["QUEUED", "RUNNING"] } } })) throw createError({ statusCode: 409, statusMessage: "当前角色已有待执行反思。" });
    const changed = await tx.reflectionRun.updateMany({ where: { id: run.id, status: "FAILED" }, data: { status: "QUEUED", attemptCount: 0, runAt: new Date(), leaseToken: null, leaseExpiresAt: null, completedAt: null } });
    if (!changed.count) throw createError({ statusCode: 409, statusMessage: "仅失败任务可以重新排队。" });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: "reflection.manual_retry", entityType: "ReflectionRun", entityId: run.id, details: { previousAttemptCount: run.attemptCount, previousLastError: run.lastError } } });
    return { run: publicRun(await tx.reflectionRun.findUniqueOrThrow({ where: { id: run.id }, include: runInclude })) };
  });
}
export async function deleteReflections(prisma: PrismaClient, input: { ownerId: string; characterId: string; runId?: string }) {
  return prisma.$transaction(async tx => {
    // Share the request/retry lock order, then lock runs against worker completion.
    const character = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`;
    if (!character.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const runs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "reflection_runs" WHERE "characterId"=${input.characterId}::uuid
        AND (${input.runId ?? null}::uuid IS NULL OR "id"=${input.runId ?? null}::uuid)
      ORDER BY "id" FOR UPDATE
    `;
    if (input.runId && !runs.length) throw createError({ statusCode: 404, statusMessage: "反思任务不存在。" });
    const ids = runs.map(run => run.id);
    const deletedSuggestions = await tx.reflectionSuggestion.count({ where: { runId: { in: ids } } });
    const deleted = await tx.reflectionRun.deleteMany({ where: { characterId: input.characterId, id: { in: ids } } });
    // Cascading deletion also removes accepted conclusions. Missing runs fence out old workers.
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId,
      action: input.runId ? "reflection.deleted" : "reflection.cleared", entityType: input.runId ? "ReflectionRun" : "Character", entityId: input.runId ?? input.characterId,
      details: { deletedRuns: deleted.count, deletedSuggestions } } });
    return { deletedRuns: deleted.count, deletedSuggestions };
  });
}

export function parseReflectionReview(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({ statusCode: 400, statusMessage: "审核内容无效。" });
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["decision", "note"].includes(key)) || !["ACCEPTED", "REJECTED", "DEFERRED"].includes(String(body.decision)) || (body.note !== undefined && typeof body.note !== "string")) throw createError({ statusCode: 400, statusMessage: "审核决定无效。" });
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 500) throw createError({ statusCode: 400, statusMessage: "审核说明最多500字。" });
  return { decision: body.decision as "ACCEPTED" | "REJECTED" | "DEFERRED", note };
}
export async function reviewReflectionSuggestion(prisma: PrismaClient, input: { ownerId: string; characterId: string; suggestionId: string; decision: "ACCEPTED" | "REJECTED" | "DEFERRED"; note: string }) {
  return prisma.$transaction(async tx => {
    await own(tx, input.ownerId, input.characterId);
    const suggestion = await tx.reflectionSuggestion.findFirst({ where: { id: input.suggestionId, run: { characterId: input.characterId, character: { ownerId: input.ownerId } } } });
    if (!suggestion) throw createError({ statusCode: 404, statusMessage: "反思建议不存在。" });
    if (!["PENDING", "DEFERRED"].includes(suggestion.status)) throw createError({ statusCode: 409, statusMessage: "该建议已完成处置，请刷新。" });
    if (input.decision === "ACCEPTED" && !await validateReflectionSourceRefs(tx, input.characterId, suggestion.sourceRefs)) throw createError({ statusCode: 409, statusMessage: "建议来源已失效或变更，不能接受，请重新发起反思。" });
    const now = new Date();
    const changed = await tx.reflectionSuggestion.updateMany({ where: { id: suggestion.id, status: suggestion.status, updatedAt: suggestion.updatedAt }, data: { status: input.decision, reviewNote: input.note || null, reviewedAt: now, acceptedAt: input.decision === "ACCEPTED" ? now : null } });
    if (!changed.count) throw createError({ statusCode: 409, statusMessage: "建议已被其它请求处理，请刷新。" });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: `reflection.suggestion.${input.decision.toLowerCase()}`, entityType: "ReflectionSuggestion", entityId: suggestion.id, details: { runId: suggestion.runId, previousStatus: suggestion.status, note: input.note } } });
    return { suggestion: await tx.reflectionSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } }) };
  });
}
