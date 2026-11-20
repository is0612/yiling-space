import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { resolveChatTimeZone } from "./chat-time-context";
import { parseEventParticipantIdQuery, parseEventParticipantQuery } from "./memory-event-retrieval";
import { parseEventTimeRange } from "./memory-event-time";
import { extractMemoryAssistantSearchTerms } from "./memory-retrieval";

const eventSelect = {
  id: true, occurredAt: true, timeOfDay: true, place: true, participants: true,
  keywords: true, title: true, detail: true, memoryScopeId: true, participantRefs: true,
} satisfies Prisma.MemoryEventSelect;

/** Bounded historical supplement. Authorization and group identity remain the caller's responsibility. */
export async function loadPromptEventCandidates(
  prisma: Pick<PrismaClient, "memoryEvent">,
  input: {
    readableScopeIds: readonly string[];
    query: string;
    timeZone?: string;
    now?: Date;
    participantIds?: readonly string[];
    /** undefined: no group filter; null: group conversation not established, read nothing. */
    groupConversationId?: string | null;
  },
) {
  if (!input.readableScopeIds.length || input.groupConversationId === null) return [];
  const base: Prisma.MemoryEventWhereInput = {
    memoryScopeId: { in: [...new Set(input.readableScopeIds)] }, status: "ACTIVE",
    ...(input.groupConversationId !== undefined ? { conversationId: input.groupConversationId } : {}),
  };
  const recent = await prisma.memoryEvent.findMany({
    where: base, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 200, select: eventSelect,
  });
  // All eligible events are present already. No additional scans for small histories.
  if (recent.length < 200) return recent;

  const range = parseEventTimeRange(input.query, input.now ?? new Date(), resolveChatTimeZone(input.timeZone));
  const first = /第一次|首次|最开始|初次|头一回/u.test(input.query);
  const latest = /最近一次|上一次|上回|上次|最后一次/u.test(input.query);
  const name = parseEventParticipantQuery(input.query);
  const directId = parseEventParticipantIdQuery(input.query);
  const ids = [...new Set([...(input.participantIds ?? []), ...(directId ? [directId] : [])])];
  const hasPerson = Boolean(directId || (name && (name.length >= 2 || ids.length)));
  if (!range && !hasPerson && !first && !latest) return recent;

  const ranged: Prisma.MemoryEventWhereInput = {
    ...base,
    ...(range ? { occurredAt: { gte: range.start, lt: range.end } } : {}),
  };
  const personMatches: Prisma.MemoryEventWhereInput[] = [
    ...ids.map(externalId => ({ participantRefs: { array_contains: [{ kind: "external", externalId }] } })),
    ...(name && name.length >= 2 ? [{ participants: { has: name } }] : []),
  ];
  const direction = first || (range && range.end.getTime() - range.start.getTime() <= 2 * 86400000 && !latest)
    ? "asc" as const : "desc" as const;
  const terms = extractMemoryAssistantSearchTerms(input.query, 20);
  const [intentRows, topicRows] = await Promise.all([
    prisma.memoryEvent.findMany({
      where: { ...ranged, ...(hasPerson ? { OR: personMatches } : {}) },
      orderBy: [{ occurredAt: direction }, { id: direction }], take: range ? 500 : 350, select: eventSelect,
    }),
    // For a first/latest topic query, a generic timeline can fill up with unrelated events.
    // Filter the topic before the cap as well, without making date-only timelines require keywords.
    !hasPerson && terms.length ? prisma.memoryEvent.findMany({
      where: { ...ranged, OR: terms.flatMap(term => [
        { title: { contains: term, mode: "insensitive" as const } },
        { detail: { contains: term, mode: "insensitive" as const } },
        { keywords: { has: term } },
        { place: { contains: term, mode: "insensitive" as const } },
      ]) },
      orderBy: [{ occurredAt: direction }, { id: direction }], take: 350, select: eventSelect,
    }) : Promise.resolve([]),
  ]);
  return [...new Map([...recent, ...intentRows, ...topicRows].map(event => [event.id, event])).values()];
}
