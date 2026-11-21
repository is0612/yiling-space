import type { PrismaClient } from "../../src/generated/prisma/client";

type SourceRow = { id: string; role: string; content: string; metadata?: unknown; conversationId?: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Read-only foreign evidence is useful while chatting, but is not an automatic learning source. */
export function excludesAutomaticGrowth(value: unknown): boolean {
  const row = object(value);
  return row.kind === "AI" || row.readOnly === true || row.excludeFromGrowth === true;
}
/** Remove only excluded nested evidence. Never remove a human's surrounding main message. */
export function stripReadOnlyEvidence(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map(item => stripReadOnlyEvidence(item, depth + 1)).filter(item => item !== undefined);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (excludesAutomaticGrowth(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const clean = stripReadOnlyEvidence(item, depth + 1);
    return clean === undefined ? [] : [[key, clean]];
  }));
}
export function sanitizeAutomaticSource<T extends SourceRow>(row: T, verifiedAiAuthors: ReadonlySet<string> = new Set()): T | null {
  const meta = object(row.metadata);
  const author = typeof meta.authorOpenId === "string" ? meta.authorOpenId : "";
  const platform = typeof meta.platform === "string" ? meta.platform : "";
  if (excludesAutomaticGrowth(meta) || (row.role === "USER" && verifiedAiAuthors.has(`${platform}:${author}`))) return null;
  const clean = stripReadOnlyEvidence(row) as T;
  return clean;
}

/**
 * Identity lookup is exact platform + account and scoped to this character's known identities.
 * Missing/unknown identities remain unknown, never inferred from nickname or message wording.
 * Callers retain their existing conversation/scope authorization; this filter cannot widen it.
 */
export async function filterAutomaticSources<T extends SourceRow>(
  prisma: Pick<PrismaClient, "externalIdentity"> & Partial<Pick<PrismaClient, "conversation">>,
  characterId: string,
  rows: readonly T[],
): Promise<T[]> {
  const byPlatform = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.role !== "USER") continue;
    const meta = object(row.metadata);
    if (typeof meta.platform !== "string" || typeof meta.authorOpenId !== "string" || !meta.authorOpenId) continue;
    const ids = byPlatform.get(meta.platform) ?? new Set<string>();
    ids.add(meta.authorOpenId); byPlatform.set(meta.platform, ids);
  }
  const ai = new Set<string>();
  const roomIds = [...new Set(rows.map(row => row.conversationId).filter((id): id is string => Boolean(id)))];
  const verifiedRooms = new Set(roomIds.length && prisma.conversation
    ? (await prisma.conversation.findMany({ where: { id: { in: roomIds }, characterId }, select: { id: true } })).map(room => room.id) : []);
  for (const [platform, ids] of byPlatform) {
    // Some isolated pure-reader mocks deliberately have no identity delegate. Production
    // callers pass PrismaClient; absent metadata never manufactures an identity lookup.
    if (!prisma.externalIdentity) continue;
    const observedInRole = rows.filter(row => row.role === "USER" && row.conversationId && verifiedRooms.has(row.conversationId)
      && object(row.metadata).platform === platform).map(row => String(object(row.metadata).authorOpenId ?? ""));
    const matches = await prisma.externalIdentity.findMany({ where: { platform, platformUid: { in: [...ids] }, kind: "AI",
      OR: [{ memoryScopes: { some: { characterId } } }, ...(observedInRole.length ? [{ platformUid: { in: observedInRole } }] : [])] }, select: { platformUid: true } });
    for (const match of matches) ai.add(`${platform}:${match.platformUid}`);
  }
  return rows.flatMap(row => { const clean = sanitizeAutomaticSource(row, ai); return clean ? [clean] : []; });
}

/** Used before automatic knowledge candidates are composed from an included source list. */
export function automaticKnowledgeLines<T extends { id?: string; content: string }>(rows: readonly T[]): T[] {
  return rows.flatMap(row => excludesAutomaticGrowth(row) ? [] : [stripReadOnlyEvidence(row) as T]);
}
