import { createError } from "h3";
import type { Prisma, PrismaClient, CharacterGoal } from "../../src/generated/prisma/client";
import { parseGoalCreate, parseGoalPatch, parseGoalProgress, parseGoalSources, goalNextStatus, goalProgressPayloadHash, goalPage } from "./goals-domain";
import { loadPreferenceSources, lockPreferenceOwner, listPreferenceSources } from "./preferences-sources";
import type { PreferenceSourceRef } from "./preferences-domain";
type Owner = { ownerId: string; characterId: string };
async function own(tx: PrismaClient | Prisma.TransactionClient, input: Owner) { if (!await tx.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "角色不存在。" }); }
export async function loadGoalSources(tx: Prisma.TransactionClient, characterId: string, refs: readonly PreferenceSourceRef[]) {
  try { return await loadPreferenceSources(tx, characterId, refs); }
  catch (error) { if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 409) throw createError({ statusCode: 409, statusMessage: "目标来源已失效、变更或不属于当前角色公开范围，请重新选择。" }); throw error; }
}
const progressSelect = { id: true, goalId: true, requestKey: true, content: true, sourceRefs: true, createdAt: true } as const;
const goalInclude = { _count: { select: { progress: true } }, progress: { select: progressSelect, orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 1 } };
type ProgressDto = Prisma.CharacterGoalProgressGetPayload<{ select: typeof progressSelect }>;
function publicGoal<T extends { _count: { progress: number }; progress: ProgressDto[] }>(row: T) { const { _count, progress, ...goal } = row; return { ...goal, progressCount: _count.progress, latestProgress: progress[0] ?? null }; }
async function snapshot(tx: Prisma.TransactionClient, goal: CharacterGoal, actorId: string, action: string, progressId?: string) {
  await tx.characterGoalRevision.create({ data: { goalId: goal.id, revision: goal.revision, action, kind: goal.kind, title: goal.title, description: goal.description, reason: goal.reason, status: goal.status, sourceType: goal.sourceType, sourceRefs: goal.sourceRefs as Prisma.InputJsonValue, actorId } });
  await tx.auditLog.create({ data: { actorType: "USER", actorId, characterId: goal.characterId, action: `goal.${action.toLowerCase()}`, entityType: "CharacterGoal", entityId: goal.id, details: { revision: goal.revision, status: goal.status, ...(progressId ? { progressId } : {}) } } });
}
async function goalDto(tx: Prisma.TransactionClient, id: string) { return publicGoal(await tx.characterGoal.findUniqueOrThrow({ where: { id }, include: goalInclude })); }
export async function createGoal(prisma: PrismaClient, input: Owner & { body: unknown }) {
  const parsed = parseGoalCreate(input.body);
  return prisma.$transaction(async tx => { await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const sourceRefs = parsed.sources.length ? await loadGoalSources(tx, input.characterId, parsed.sources) : [];
    const goal = await tx.characterGoal.create({ data: { characterId: input.characterId, kind: parsed.kind, title: parsed.title, description: parsed.description, reason: parsed.reason, status: parsed.status, sourceType: sourceRefs.length ? "SOURCES" : "MANUAL", sourceRefs } });
    await snapshot(tx, goal, input.ownerId, "CREATE"); return { goal: await goalDto(tx, goal.id) }; });
}
export async function updateGoal(prisma: PrismaClient, input: Owner & { goalId: string; body: unknown }) {
  const parsed = parseGoalPatch(input.body);
  return prisma.$transaction(async tx => { await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const current = await tx.characterGoal.findFirst({ where: { id: input.goalId, characterId: input.characterId } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "目标不存在。" });
    if (current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "目标已被修改，请刷新。" });
    const status = goalNextStatus(current.status, parsed.operation);
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && current.sourceType === "SOURCES") {
      const refs = parseGoalSources((Array.isArray(current.sourceRefs) ? current.sourceRefs : []).map(value => { const row = value as Record<string, unknown>; return { type: row.type, id: row.id, hash: row.hash }; }));
      await loadGoalSources(tx, input.characterId, refs);
    }
    const kind = parsed.kind ?? current.kind, title = parsed.title ?? current.title, description = parsed.description ?? current.description, reason = parsed.reason ?? current.reason;
    if (parsed.operation === "EDIT" && kind === current.kind && title === current.title && description === current.description && reason === current.reason) return { goal: await goalDto(tx, current.id) };
    const changed = await tx.characterGoal.updateMany({ where: { id: current.id, revision: parsed.expectedRevision, status: current.status }, data: { kind, title, description, reason, status, revision: { increment: 1 } } });
    if (!changed.count) throw createError({ statusCode: 409, statusMessage: "目标刚刚发生变化，请刷新。" });
    await snapshot(tx, await tx.characterGoal.findUniqueOrThrow({ where: { id: current.id } }), input.ownerId, parsed.operation);
    return { goal: await goalDto(tx, current.id) }; });
}
export async function addGoalProgress(prisma: PrismaClient, input: Owner & { goalId: string; body: unknown }) {
  const parsed = parseGoalProgress(input.body), payloadHash = goalProgressPayloadHash(parsed);
  return prisma.$transaction(async tx => { await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    // Serialize append and its replay against transitions; do not rely only on the unique key.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "character_goals" WHERE "id"=${input.goalId}::uuid AND "characterId"=${input.characterId}::uuid FOR UPDATE`;
    if (!locked.length) throw createError({ statusCode: 404, statusMessage: "目标不存在。" });
    const existing = await tx.characterGoalProgress.findUnique({ where: { goalId_requestKey: { goalId: input.goalId, requestKey: parsed.requestKey } } });
    if (existing) { if (existing.payloadHash !== payloadHash) throw createError({ statusCode: 409, statusMessage: "请求编号已用于不同的进展内容。" });
      const { payloadHash: _hash, ...progress } = existing; return { progress, goal: await goalDto(tx, input.goalId), created: false }; }
    const current = await tx.characterGoal.findUniqueOrThrow({ where: { id: input.goalId } });
    if (!["ACTIVE", "PAUSED"].includes(current.status) || current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "仅当前版本的进行中或暂停目标可以追加进展。" });
    const sourceRefs = parsed.sources.length ? await loadGoalSources(tx, input.characterId, parsed.sources) : [];
    const progress = await tx.characterGoalProgress.create({ data: { goalId: current.id, requestKey: parsed.requestKey, payloadHash, content: parsed.content, sourceRefs }, select: progressSelect });
    const goal = await tx.characterGoal.update({ where: { id: current.id }, data: { revision: { increment: 1 } } });
    await snapshot(tx, goal, input.ownerId, "PROGRESS", progress.id);
    return { progress, goal: await goalDto(tx, current.id), created: true }; });
}
export async function listGoals(prisma: PrismaClient, input: Owner & { status: string; q: string; page: number; pageSize: number }) {
  await own(prisma, input); const where: Prisma.CharacterGoalWhereInput = { characterId: input.characterId, ...(input.status === "ALL" ? {} : { status: input.status }), ...(input.q ? { OR: ["title", "description", "reason"].map(field => ({ [field]: { contains: input.q, mode: "insensitive" } })) } : {}) };
  const [rows, total] = await Promise.all([prisma.characterGoal.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize, include: goalInclude }), prisma.characterGoal.count({ where })]);
  return goalPage(rows.map(publicGoal), total, input.page, input.pageSize);
}
async function assertGoal(prisma: PrismaClient, input: Owner & { goalId: string }) { await own(prisma, input); if (!await prisma.characterGoal.findFirst({ where: { id: input.goalId, characterId: input.characterId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "目标不存在。" }); }
export async function listGoalHistory(prisma: PrismaClient, input: Owner & { goalId: string; page: number; pageSize: number }) {
  await assertGoal(prisma, input); const where = { goalId: input.goalId, goal: { characterId: input.characterId, character: { ownerId: input.ownerId } } };
  const [rows, total] = await Promise.all([prisma.characterGoalRevision.findMany({ where, orderBy: { revision: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterGoalRevision.count({ where })]); return goalPage(rows, total, input.page, input.pageSize);
}
export async function listGoalProgress(prisma: PrismaClient, input: Owner & { goalId: string; page: number; pageSize: number }) {
  await assertGoal(prisma, input); const where = { goalId: input.goalId, goal: { characterId: input.characterId, character: { ownerId: input.ownerId } } };
  const [rows, total] = await Promise.all([prisma.characterGoalProgress.findMany({ where, select: progressSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterGoalProgress.count({ where })]); return goalPage(rows, total, input.page, input.pageSize);
}
export async function listGoalSources(prisma: PrismaClient, input: Owner & { type: PreferenceSourceRef["type"]; q: string; page: number; pageSize: number }) { return listPreferenceSources(prisma, input); }
