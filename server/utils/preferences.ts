import { createError } from "h3";
import type { Prisma, PrismaClient, CharacterPreference } from "../../src/generated/prisma/client";
import { parsePreferenceCreate, parsePreferencePatch, parsePreferenceSources, preferenceNextStatus, preferencePage } from "./preferences-domain";
import { assertPreferenceOwner, loadPreferenceSources, lockPreferenceOwner } from "./preferences-sources";

async function snapshot(tx: Prisma.TransactionClient, preference: CharacterPreference, actorId: string, action: string) {
  await tx.characterPreferenceRevision.create({ data: {
    preferenceId: preference.id, revision: preference.revision, action, kind: preference.kind, topic: preference.topic,
    reason: preference.reason, status: preference.status, sourceType: preference.sourceType,
    sourceRefs: preference.sourceRefs as Prisma.InputJsonValue, actorId,
  } });
  await tx.auditLog.create({ data: { actorType: "USER", actorId, characterId: preference.characterId,
    action: `preference.${action.toLowerCase()}`, entityType: "CharacterPreference", entityId: preference.id,
    details: { revision: preference.revision, status: preference.status, kind: preference.kind } } });
}
export async function createPreference(prisma: PrismaClient, input: { ownerId: string; characterId: string; body: unknown }) {
  const parsed = parsePreferenceCreate(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const sourceRefs = parsed.sources.length ? await loadPreferenceSources(tx, input.characterId, parsed.sources) : [];
    const preference = await tx.characterPreference.create({ data: { characterId: input.characterId,
      kind: parsed.kind, topic: parsed.topic, reason: parsed.reason, status: parsed.status,
      sourceType: sourceRefs.length ? "SOURCES" : "MANUAL", sourceRefs } });
    await snapshot(tx, preference, input.ownerId, "CREATE");
    return { preference };
  });
}
export async function updatePreference(prisma: PrismaClient, input: { ownerId: string; characterId: string; preferenceId: string; body: unknown }) {
  const parsed = parsePreferencePatch(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const current = await tx.characterPreference.findFirst({ where: { id: input.preferenceId, characterId: input.characterId } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "偏好不存在。" });
    if (current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "偏好已被修改，请刷新后再试。" });
    const status = preferenceNextStatus(current.status, parsed.operation);
    // Accepted preferences survive original source deletion. Only first acceptance needs live evidence.
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && current.sourceType === "SOURCES") {
      const raw = Array.isArray(current.sourceRefs) ? current.sourceRefs : [];
      const refs = parsePreferenceSources(raw.map(value => {
        const row = value as Record<string, unknown>;
        return { type: row.type, id: row.id, hash: row.hash };
      }));
      await loadPreferenceSources(tx, input.characterId, refs);
    }
    const kind = parsed.kind ?? current.kind; const topic = parsed.topic ?? current.topic; const reason = parsed.reason ?? current.reason;
    if (parsed.operation === "EDIT" && kind === current.kind && topic === current.topic && reason === current.reason) return { preference: current };
    const changed = await tx.characterPreference.updateMany({ where: { id: current.id, characterId: input.characterId, revision: parsed.expectedRevision, status: current.status }, data: { kind, topic, reason, status, revision: { increment: 1 } } });
    if (changed.count !== 1) throw createError({ statusCode: 409, statusMessage: "偏好刚刚发生变化，请刷新后再试。" });
    const preference = await tx.characterPreference.findUniqueOrThrow({ where: { id: current.id } });
    await snapshot(tx, preference, input.ownerId, parsed.operation);
    return { preference };
  });
}
export async function listPreferences(prisma: PrismaClient, input: { ownerId: string; characterId: string; status: string; q: string; page: number; pageSize: number }) {
  await assertPreferenceOwner(prisma, input.ownerId, input.characterId);
  const where: Prisma.CharacterPreferenceWhereInput = { characterId: input.characterId,
    ...(input.status === "ALL" ? {} : { status: input.status }),
    ...(input.q ? { OR: [{ topic: { contains: input.q, mode: "insensitive" } }, { reason: { contains: input.q, mode: "insensitive" } }] } : {}) };
  const [items, total] = await Promise.all([prisma.characterPreference.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterPreference.count({ where })]);
  return preferencePage(items, total, input.page, input.pageSize);
}
export async function listPreferenceHistory(prisma: PrismaClient, input: { ownerId: string; characterId: string; preferenceId: string; page: number; pageSize: number }) {
  await assertPreferenceOwner(prisma, input.ownerId, input.characterId);
  if (!await prisma.characterPreference.findFirst({ where: { id: input.preferenceId, characterId: input.characterId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "偏好不存在。" });
  const where = { preferenceId: input.preferenceId, preference: { characterId: input.characterId, character: { ownerId: input.ownerId } } };
  const [items, total] = await Promise.all([prisma.characterPreferenceRevision.findMany({ where, orderBy: { revision: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterPreferenceRevision.count({ where })]);
  return preferencePage(items, total, input.page, input.pageSize);
}
