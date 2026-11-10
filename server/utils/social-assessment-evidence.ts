import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;
export type SocialAssessmentSourceManifest = {
  experienceId: string;
  memoryEventId: string;
  sourceScopeId: string;
  sourceHash: string;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function hashSocialAssessmentSource(row: { title: string; detail: string; occurredAt: Date; participants: string[]; confidence: number | null }) {
  return createHash("sha256").update(JSON.stringify([row.title, row.detail, row.occurredAt.toISOString(), row.participants, row.confidence])).digest("hex");
}
export function buildSocialAssessmentSourceManifest(rows: Array<{ id: string; memoryEvent: { id: string; memoryScopeId: string; title: string; detail: string; occurredAt: Date; participants: string[]; confidence: number | null } }>): SocialAssessmentSourceManifest[] {
  return rows.map(row => ({ experienceId: row.id, memoryEventId: row.memoryEvent.id, sourceScopeId: row.memoryEvent.memoryScopeId, sourceHash: hashSocialAssessmentSource(row.memoryEvent) }));
}
export function readSocialAssessmentSourceManifest(value: unknown): SocialAssessmentSourceManifest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return typeof row.experienceId === "string" && uuid.test(row.experienceId)
      && typeof row.memoryEventId === "string" && uuid.test(row.memoryEventId)
      && typeof row.sourceScopeId === "string" && uuid.test(row.sourceScopeId)
      && typeof row.sourceHash === "string" && /^[a-f0-9]{64}$/.test(row.sourceHash)
      ? [row as SocialAssessmentSourceManifest] : [];
  });
}
/** Reads only evidence belonging to this relationship and this role. Private sources stay within their original scope. */
export async function collectSocialAssessmentSourceManifest(
  prisma: Database, characterId: string, relationshipScopeId: string, experienceIds: readonly string[],
): Promise<SocialAssessmentSourceManifest[]> {
  if (!experienceIds.length) return [];
  const rows = await prisma.socialExperience.findMany({
    where: {
      id: { in: [...new Set(experienceIds)] }, scopeId: relationshipScopeId,
      scope: { is: { characterId, scopeType: "EXTERNAL_IDENTITY" } },
      assessmentDispatchStatus: { in: ["LEGACY", "QUEUED"] },
      memoryEvent: { is: { status: "ACTIVE", memoryScope: { is: { characterId } } } },
    },
    select: { id: true, memoryEventId: true, memoryEvent: { select: { memoryScopeId: true, title: true, detail: true, occurredAt: true, participants: true, confidence: true } } },
    orderBy: { id: "asc" },
  });
  return rows.map(row => ({ experienceId: row.id, memoryEventId: row.memoryEventId, sourceScopeId: row.memoryEvent.memoryScopeId, sourceHash: hashSocialAssessmentSource(row.memoryEvent) }));
}
/** Call inside completion/review transaction. Scope-first locks prevent changes during final validation. */
export async function validateSocialAssessmentSourceManifest(
  tx: Prisma.TransactionClient, characterId: string, relationshipScopeId: string, rawManifest: unknown,
  requiredIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(requiredIds)].sort();
  const manifest = readSocialAssessmentSourceManifest(rawManifest);
  if (!ids.length || !Array.isArray(rawManifest) || manifest.length !== rawManifest.length) return false;
  const byId = new Map(manifest.map(item => [item.experienceId, item]));
  if (byId.size !== manifest.length || ids.some(id => !byId.has(id))) return false;
  const selected = ids.map(id => byId.get(id)!);
  const scopeIds = [...new Set([relationshipScopeId, ...selected.map(item => item.sourceScopeId)])].sort();
  const scopes = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "memory_scopes" WHERE "id" IN (${Prisma.join(scopeIds.map(id => Prisma.sql`${id}::uuid`))})
      AND "characterId" = ${characterId}::uuid ORDER BY "id" FOR SHARE
  `;
  if (scopes.length !== scopeIds.length) return false;
  // Lock source rows only after scopes; the conditional read below rechecks source ownership and activity.
  const sourceIds = [...new Set(selected.map(item => item.memoryEventId))].sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "memory_events" WHERE "id" IN (${Prisma.join(sourceIds.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR SHARE`);
  const current = await collectSocialAssessmentSourceManifest(tx, characterId, relationshipScopeId, ids);
  if (current.length !== ids.length) return false;
  return current.every(row => {
    const old = byId.get(row.experienceId)!;
    return row.memoryEventId === old.memoryEventId && row.sourceScopeId === old.sourceScopeId && row.sourceHash === old.sourceHash;
  });
}
