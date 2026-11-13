import { validateExperienceReflectionRefs, type ExperienceReflectionRef } from "./experience-reflection";
import { createError } from "h3";
import type { Prisma, PrismaClient, CharacterExpressionHabit } from "../../src/generated/prisma/client";
import { parseExpressionHabitCreate, parseExpressionHabitPatch, parseExpressionHabitSources, expressionHabitNextStatus, expressionHabitPage } from "./expression-habits-domain";
import { loadPreferenceSources, lockPreferenceOwner, listPreferenceSources } from "./preferences-sources";
import type { PreferenceSourceRef } from "./preferences-domain";

type Owner = { ownerId: string; characterId: string };
async function assertOwner(tx: PrismaClient | Prisma.TransactionClient, input: Owner) {
  if (!await tx.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}
/** Shared gateway enforces exactly the existing public-source access boundary. */
export async function loadExpressionHabitSources(tx: Prisma.TransactionClient, characterId: string, refs: readonly PreferenceSourceRef[]) {
  try { return await loadPreferenceSources(tx, characterId, refs); }
  catch (error) {
    if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 409) throw createError({ statusCode: 409, statusMessage: "表达习惯来源已失效、变更或不属于当前角色公开范围，请重新选择。" });
    throw error;
  }
}
async function snapshot(tx: Prisma.TransactionClient, habit: CharacterExpressionHabit, actorId: string, action: string) {
  await tx.characterExpressionHabitRevision.create({ data: {
    habitId: habit.id, revision: habit.revision, action, kind: habit.kind, content: habit.content, context: habit.context,
    reason: habit.reason, status: habit.status, sourceType: habit.sourceType, sourceRefs: habit.sourceRefs as Prisma.InputJsonValue, actorId,
    conversationId: habit.conversationId, memoryScopeId: habit.memoryScopeId,
  } });
  await tx.auditLog.create({ data: { actorType: "USER", actorId, characterId: habit.characterId,
    action: `expression_habit.${action.toLowerCase()}`, entityType: "CharacterExpressionHabit", entityId: habit.id,
    details: { revision: habit.revision, status: habit.status, kind: habit.kind } } });
}
export async function createExpressionHabit(prisma: PrismaClient, input: Owner & { body: unknown }) {
  const parsed = parseExpressionHabitCreate(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const sourceRefs = parsed.sources.length ? await loadExpressionHabitSources(tx, input.characterId, parsed.sources) : [];
    const habit = await tx.characterExpressionHabit.create({ data: { characterId: input.characterId,
      kind: parsed.kind, content: parsed.content, context: parsed.context, reason: parsed.reason, status: parsed.status,
      sourceType: sourceRefs.length ? "SOURCES" : "MANUAL", sourceRefs } });
    await snapshot(tx, habit, input.ownerId, "CREATE");
    return { habit };
  });
}
export async function updateExpressionHabit(prisma: PrismaClient, input: Owner & { habitId: string; body: unknown }) {
  const parsed = parseExpressionHabitPatch(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const current = await tx.characterExpressionHabit.findFirst({ where: { id: input.habitId, characterId: input.characterId } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "表达习惯不存在。" });
    if (current.conversationId && !await tx.conversation.findFirst({ where: { id: current.conversationId, characterId: input.characterId, memoryScopeId: current.memoryScopeId!, memoryScope: { OR: [{ scopeType: "CHARACTER_GLOBAL" }, { scopeType: "USER_PRIVATE", userId: input.ownerId }, { scopeType: "EXTERNAL_IDENTITY", externalIdentity: { status: "VERIFIED", linkedUserId: input.ownerId } }] } }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "表达习惯不存在。" });
    if (current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "表达习惯已被修改，请刷新后再试。" });
    const status = expressionHabitNextStatus(current.status, parsed.operation);
    if (parsed.operation === "ACTIVATE" && current.sourceType === "EXPERIENCE_REFLECT") {
      if (!current.conversationId || !current.memoryScopeId || !await validateExperienceReflectionRefs(tx, input.characterId, current.sourceRefs as unknown as ExperienceReflectionRef[], { conversationId: current.conversationId, memoryScopeId: current.memoryScopeId })) throw createError({ statusCode: 409, statusMessage: "本会话经验来源已失效，不能启用该表达建议。" });
    }
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && current.sourceType === "SOURCES") {
      const raw = Array.isArray(current.sourceRefs) ? current.sourceRefs : [];
      const refs = parseExpressionHabitSources(raw.map(value => {
        const row = value as Record<string, unknown>; return { type: row.type, id: row.id, hash: row.hash };
      }));
      await loadExpressionHabitSources(tx, input.characterId, refs);
    }
    // After first acceptance, this domain owns the habit independently from historical evidence.
    const kind = parsed.kind ?? current.kind; const content = parsed.content ?? current.content;
    const context = parsed.context ?? current.context; const reason = parsed.reason ?? current.reason;
    if (parsed.operation === "EDIT" && kind === current.kind && content === current.content && context === current.context && reason === current.reason) return { habit: current };
    const changed = await tx.characterExpressionHabit.updateMany({ where: { id: current.id, characterId: input.characterId, revision: parsed.expectedRevision, status: current.status }, data: { kind, content, context, reason, status, revision: { increment: 1 } } });
    if (changed.count !== 1) throw createError({ statusCode: 409, statusMessage: "表达习惯刚刚发生变化，请刷新后再试。" });
    const habit = await tx.characterExpressionHabit.findUniqueOrThrow({ where: { id: current.id } });
    await snapshot(tx, habit, input.ownerId, parsed.operation);
    return { habit };
  });
}
export async function listExpressionHabits(prisma: PrismaClient, input: Owner & { status: string; q: string; page: number; pageSize: number }) {
  await assertOwner(prisma, input);
  const rooms = await prisma.conversation.findMany({ where: { characterId: input.characterId, memoryScope: { OR: [{ scopeType: "CHARACTER_GLOBAL" }, { scopeType: "USER_PRIVATE", userId: input.ownerId }, { scopeType: "EXTERNAL_IDENTITY", externalIdentity: { status: "VERIFIED", linkedUserId: input.ownerId } }] } }, select: { id: true } });
  const where: Prisma.CharacterExpressionHabitWhereInput = { characterId: input.characterId, AND: [{ OR: [{ conversationId: null, memoryScopeId: null }, { conversationId: { in: rooms.map(row => row.id) } }] }],
    ...(input.status === "ALL" ? {} : { status: input.status }),
    ...(input.q ? { OR: [{ content: { contains: input.q, mode: "insensitive" } }, { context: { contains: input.q, mode: "insensitive" } }, { reason: { contains: input.q, mode: "insensitive" } }] } : {}) };
  const [items, total] = await Promise.all([prisma.characterExpressionHabit.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterExpressionHabit.count({ where })]);
  return expressionHabitPage(items, total, input.page, input.pageSize);
}
export async function listExpressionHabitHistory(prisma: PrismaClient, input: Owner & { habitId: string; page: number; pageSize: number }) {
  await assertOwner(prisma, input);
  if (!await prisma.characterExpressionHabit.findFirst({ where: { id: input.habitId, characterId: input.characterId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "表达习惯不存在。" });
  const where = { habitId: input.habitId, habit: { characterId: input.characterId, character: { ownerId: input.ownerId } } };
  const [items, total] = await Promise.all([prisma.characterExpressionHabitRevision.findMany({ where, orderBy: { revision: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterExpressionHabitRevision.count({ where })]);
  return expressionHabitPage(items, total, input.page, input.pageSize);
}
export async function listExpressionHabitSources(prisma: PrismaClient, input: Owner & { type: PreferenceSourceRef["type"]; q: string; page: number; pageSize: number }) {
  return listPreferenceSources(prisma, input);
}
