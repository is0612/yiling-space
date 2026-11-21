import { validateEducationTransferRefs } from "./education-transfer";
import { assertGroupObservationCurrent, GROUP_OBSERVATION_SOURCE } from "./group-expression-evidence";
import { validateExperienceReflectionRefs, type ExperienceReflectionRef } from "./experience-reflection";
import { createError } from "h3";
import type { Prisma, PrismaClient, CharacterExpressionHabit } from "../../src/generated/prisma/client";
import { parseExpressionHabitCreate, parseExpressionHabitPatch, parseExpressionHabitSources, expressionHabitNextStatus, expressionHabitPage } from "./expression-habits-domain";
import { loadPreferenceSources, lockPreferenceOwner, listPreferenceSources } from "./preferences-sources";
import type { PreferenceSourceRef } from "./preferences-domain";
import type { GrowthSource, LanguageHabit, LanguageKind, LanguageStatus } from "../../shared/types/growth";

/**
 * 把 Prisma 行整形成 API DTO（`shared/types/growth.ts` 的 `LanguageHabit`）。
 *
 * 与 `publicGoal` / `toPreferenceDto` 同一套理由：日期显式转 ISO（线上字节不变）、
 * JSON 列显式转数组、裸字符串列在边界收窄成契约枚举。
 */
function toLanguageHabitDto(row: CharacterExpressionHabit): LanguageHabit {
  return {
    ...row,
    kind: row.kind as LanguageKind,
    status: row.status as LanguageStatus,
    chatScope: (row.chatScope ?? undefined) as LanguageHabit["chatScope"],
    sourceType: row.sourceType as LanguageHabit["sourceType"],
    reviewedBy: (row.reviewedBy ?? null) as LanguageHabit["reviewedBy"],
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    sourceRefs: row.sourceRefs as unknown as GrowthSource[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
    habitId: habit.id, revision: habit.revision, action, kind: habit.kind, content: habit.content, context: habit.context, chatScope: habit.chatScope ?? "ALL",
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
      kind: parsed.kind, content: parsed.content, context: parsed.context, chatScope: parsed.chatScope, reason: parsed.reason, status: parsed.status,
      sourceType: sourceRefs.length ? "SOURCES" : "MANUAL", sourceRefs } });
    await snapshot(tx, habit, input.ownerId, "CREATE");
    return { habit: toLanguageHabitDto(habit) };
  });
}
export const GROUP_OBSERVATION_PENDING_LIMIT = 12;

export async function saveGroupObservationHabit(prisma: PrismaClient, input: Owner & { suggestion: { kind: string; content: string; context: string; reason: string }; source: Prisma.InputJsonObject; automatic?: { conversationId: string; leaseToken: string } }) {
  const parsed = parseExpressionHabitCreate(input.suggestion);
  return prisma.$transaction(async tx => {
    // Serialize saves for this character so concurrent requests cannot create duplicate candidates.
    const owner = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR NO KEY UPDATE`;
    if (!owner.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const refs = [input.source];
    await assertGroupObservationCurrent(tx, input.characterId, refs);
    const exact = await tx.characterExpressionHabit.findFirst({ where: { characterId: input.characterId, sourceType: GROUP_OBSERVATION_SOURCE, sourceRefs: { equals: refs } } });
    if (exact) return { habit: toLanguageHabitDto(exact), reused: true };
    if (input.automatic) {
      const { conversationId, leaseToken } = input.automatic;
      const lease = await tx.$queryRaw<Array<{ conversationId: string }>>`SELECT "conversationId" FROM "group_observation_progress" WHERE "conversationId"=${conversationId}::uuid AND "enabled" AND "leaseToken"=${leaseToken}::uuid AND "leaseUntil">clock_timestamp() FOR UPDATE`;
      if (!lease.length) throw createError({ statusCode: 409, statusMessage: "自动观察已停用或由其他任务接手。" });
      if (await tx.characterExpressionHabit.count({ where: { characterId: input.characterId, sourceType: GROUP_OBSERVATION_SOURCE, status: "PENDING" } }) >= GROUP_OBSERVATION_PENDING_LIMIT) return { habit: null, reused: false };
      const duplicate = await tx.characterExpressionHabit.findFirst({ where: { characterId: input.characterId, sourceType: GROUP_OBSERVATION_SOURCE, kind: parsed.kind, context: parsed.context, content: parsed.content } });
      if (duplicate) return { habit: toLanguageHabitDto(duplicate), reused: true };
    }
    const habit = await tx.characterExpressionHabit.create({ data: { characterId: input.characterId, kind: parsed.kind, content: parsed.content, context: parsed.context, reason: parsed.reason, status: "PENDING", chatScope: "ALL", sourceType: GROUP_OBSERVATION_SOURCE, sourceRefs: refs } });
    await snapshot(tx, habit, input.ownerId, "CREATE");
    return { habit: toLanguageHabitDto(habit), reused: false };
  });
}
export async function updateExpressionHabit(prisma: PrismaClient, input: Owner & { habitId: string; body: unknown; reviewedBy?: "OWNER" | "SELF" }) {
  const parsed = parseExpressionHabitPatch(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const current = await tx.characterExpressionHabit.findFirst({ where: { id: input.habitId, characterId: input.characterId } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "表达习惯不存在。" });
    if (current.conversationId && !await tx.conversation.findFirst({ where: { id: current.conversationId, characterId: input.characterId, memoryScopeId: current.memoryScopeId!, memoryScope: { OR: [{ scopeType: "CHARACTER_GLOBAL" }, { scopeType: "USER_PRIVATE", userId: input.ownerId }, { scopeType: "EXTERNAL_IDENTITY", externalIdentity: { status: "VERIFIED", linkedUserId: input.ownerId } }] } }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "表达习惯不存在。" });
    if (current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "表达习惯已被修改，请刷新后再试。" });
    const status = expressionHabitNextStatus(current.status, parsed.operation);
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && current.sourceType === "EDUCATION_TRANSFER") {
      if (current.conversationId || current.memoryScopeId || !await validateEducationTransferRefs(tx, input.characterId, current.sourceRefs)) throw createError({ statusCode: 409, statusMessage: "教育来源或授权已变化，请重新核对候选。" });
    }
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
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && current.sourceType === GROUP_OBSERVATION_SOURCE) {
      await assertGroupObservationCurrent(tx, input.characterId, current.sourceRefs);
    }
    // After first acceptance, this domain owns the habit independently from historical evidence.
    const kind = parsed.kind ?? current.kind; const content = parsed.content ?? current.content;
    const chatScope = parsed.chatScope ?? current.chatScope ?? "ALL";
    if (current.sourceType === "EXPERIENCE_REFLECT" && chatScope === "GROUP") throw createError({ statusCode: 400, statusMessage: "原私聊经验不能扩展到群聊。" });
    const context = parsed.context ?? current.context; const reason = parsed.reason ?? current.reason;
    if (parsed.operation === "EDIT" && kind === current.kind && content === current.content && context === current.context && chatScope === (current.chatScope ?? "ALL") && reason === current.reason) return { habit: toLanguageHabitDto(current) };
    // A status decision records who made it; edits keep the previous reviewer untouched.
    const decision = parsed.operation === "ACTIVATE" || parsed.operation === "REJECT" || parsed.operation === "DISABLE";
    const changed = await tx.characterExpressionHabit.updateMany({ where: { id: current.id, characterId: input.characterId, revision: parsed.expectedRevision, status: current.status },
      data: { kind, content, context, chatScope, reason, status, revision: { increment: 1 },
        ...(decision ? { reviewedBy: input.reviewedBy ?? "OWNER", reviewedAt: new Date() } : {}) } });
    if (changed.count !== 1) throw createError({ statusCode: 409, statusMessage: "表达习惯刚刚发生变化，请刷新后再试。" });
    const habit = await tx.characterExpressionHabit.findUniqueOrThrow({ where: { id: current.id } });
    await snapshot(tx, habit, input.ownerId, parsed.operation);
    return { habit: toLanguageHabitDto(habit) };
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
