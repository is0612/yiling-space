import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { parseEventTimeRange } from "./memory-event-time";
import { parseEventParticipantQuery } from "./memory-event-retrieval";
import { extractMemoryAssistantSearchTerms, estimateTokens } from "./memory-retrieval";
import type { MemoryAssistantCandidate } from "./memory-assistant";
import { normalizeOwnerHistoryTerms } from "./owner-history-terms";

export const OWNER_HISTORY_TTL_MS = 20 * 60_000;
export type OwnerHistoryCursor = { id: string; occurredAt: string };
export type OwnerHistoryCoverage = {
  groupIds: string[]; start: string; end: string; direction: "earlier" | "latest";
  count: number; actualFirst: string | null; actualLast: string | null;
  sampledFirst: string | null; sampledLast: string | null;
  truncated: boolean; hasEarlier: boolean; oldestCursor?: OwnerHistoryCursor;
  /** A failed identity/room precondition is not a completed zero-result database read. */
  reason?: "unresolved_participant" | "unresolved_group";
};
export type OwnerHistoryPlan = {
  query: string; groupId?: string; participantName?: string;
  start: string; end: string; anchoredAt: string;
  evidenceIds: string[];
  direction?: "earlier" | "latest";
  cursor?: OwnerHistoryCursor;
  mode?: "topic" | "page" | "boundary";
  topicTerms?: string[];
  /** Original question range survives page navigation and topic changes. */
  rootStart?: string; rootEnd?: string;
};
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const validDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
export function readOwnerHistoryPlan(value: unknown, now: Date): OwnerHistoryPlan | null {
  const v = object(value);
  if (!validDate(v.anchoredAt) || !validDate(v.start) || !validDate(v.end)
    || now.getTime() < Date.parse(v.anchoredAt) || now.getTime() - Date.parse(v.anchoredAt) >= OWNER_HISTORY_TTL_MS
    || Date.parse(v.start) >= Date.parse(v.end) || typeof v.query !== "string" || v.query.length > 500) return null;
  if (v.groupId !== undefined && (typeof v.groupId !== "string" || !/^\d{5,12}$/u.test(v.groupId))) return null;
  if (v.participantName !== undefined && (typeof v.participantName !== "string" || !v.participantName.trim() || v.participantName.length > 40)) return null;
  if (v.direction !== undefined && v.direction !== "earlier" && v.direction !== "latest") return null;
  const cursor = object(v.cursor);
  if (v.cursor !== undefined && (typeof cursor.id !== "string" || !uuid.test(cursor.id) || !validDate(cursor.occurredAt))) return null;
  return { query: v.query, start: v.start, end: v.end, anchoredAt: v.anchoredAt,
    ...(["topic", "page", "boundary"].includes(String(v.mode)) ? { mode: v.mode as OwnerHistoryPlan["mode"] } : {}),
    ...(normalizeOwnerHistoryTerms(v.topicTerms).length ? { topicTerms: normalizeOwnerHistoryTerms(v.topicTerms) } : {}),
    ...(validDate(v.rootStart) && validDate(v.rootEnd) ? { rootStart: v.rootStart, rootEnd: v.rootEnd } : {}),
    ...(v.direction === "earlier" || v.direction === "latest" ? { direction: v.direction } : {}),
    ...(v.cursor !== undefined ? { cursor: { id: cursor.id as string, occurredAt: cursor.occurredAt as string } } : {}),
    ...(typeof v.groupId === "string" ? { groupId: v.groupId } : {}),
    ...(typeof v.participantName === "string" ? { participantName: v.participantName } : {}),
    evidenceIds: Array.isArray(v.evidenceIds) ? [...new Set(v.evidenceIds.filter((id): id is string => typeof id === "string" && uuid.test(id)))].slice(0, 24) : [] };
}

/** Only explicit history tasks and referential follow-ups inherit a task; ordinary chat clears it. */
export function planOwnerHistory(message: string, previous: OwnerHistoryPlan | null, now: Date, timeZone: string): OwnerHistoryPlan | null {
  const text = message.trim();
  if (/换个话题|换话题|不聊这个|先不查|不用查|别查了|算了|聊点别的|我去(?:看看|检查|弄|处理)|继续(?:去)?聊天|先这样|晚安/u.test(text)) return null;
  const live = previous && readOwnerHistoryPlan(previous, now);
  const groupId = /(?:群(?:号)?\s*[:：]?\s*(\d{5,12})|(\d{5,12})\s*(?:这个|那个)?群)/u.exec(text)?.slice(1).find(Boolean)
    ?? (live ? /^(\d{5,12})(?=\s*(?:那边|这边|那里|这里|[，,：:]|$))/u.exec(text)?.[1] : undefined);
  const groupTask = /群里|群聊|群的|这个群|那个群|群记录/u.test(text) || Boolean(groupId);
  const historyTask = /记录|历史|刚才|之前|今晚|昨晚|昨天|今天|前天|上次|说过|聊过|回过|答应过|回复过|发生|怎么|咋|了/u.test(text);
  const wantsEarlier = /更早|再早|往前|向前|之前|以前|到不了|查不到|读不到/u.test(text);
  // A retry after reloading the adapter is still the same live earlier-history task.
  // Match the entire short utterance so unrelated conversation cannot inherit history access.
  const retryEarlier = live?.direction === "earlier" && /^(?:现在呢|还是呢|再看看|再试试)[？?。！!\s]*$/u.test(text);
  const followup = Boolean(live) && text.length <= 180 && (retryEarlier || Boolean(groupId) || wantsEarlier || /他|她|那|这|哪种|哪句|怎么|为什么|你都|你不是|有没有|到底|继续|再查|再找|回复|回答/u.test(text));
  if (!(groupTask && (historyTask || groupId)) && !followup) return null;
  const inherit = Boolean(live && followup && (!groupId || !live.groupId || groupId === live.groupId));
  const parsedParticipant = /(?:这个群|那个群|群里|群)的\s*([^\s，。？！,!?]{1,12})(?:[，。？！,!?]|$)/u.exec(text)?.[1]
    ?? parseEventParticipantQuery(text) ?? undefined;
  const explicitParticipant = parsedParticipant && !/聊天|记录|历史|消息|大家|事情|内容/u.test(parsedParticipant) ? parsedParticipant : undefined;
  // A relative day is resolved once. Unqualified follow-ups retain the absolute range after midnight.
  const explicitTime = /今晚|昨晚|昨天|今天|前天|大前天|上周|本周|\d{1,4}[年/月.-]\d{1,2}|\d{1,2}月\d{1,2}/u.test(text);
  let range = explicitTime ? parseEventTimeRange(text, now, timeZone) : null;
  // After midnight, “tonight” normally means the evening immediately preceding this morning.
  if (/今晚/u.test(text)) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
    range = parseEventTimeRange(hour < 6 ? "昨天" : "今天", now, timeZone);
    if (range) range = { ...range, start: new Date(range.start.getTime() + 18 * 3_600_000), end: new Date(Math.min(now.getTime() + 1, range.end.getTime() + 6 * 3_600_000)) };
  }
  // Direction and date are independent: “tonight, earlier” starts at the early end
  // of tonight. A subsequent earlier request moves before the sampled cursor in the
  // SAME frozen range; the loader expands time only after that range is exhausted.
  const earlierPage = Boolean(inherit && wantsEarlier && !explicitTime);
  const start = range?.start.toISOString() ?? (inherit ? live!.start : new Date(now.getTime() - 2 * 3_600_000).toISOString());
  const end = range?.end.toISOString() ?? (inherit ? live!.end : new Date(now.getTime() + 1).toISOString());
  const changedTarget = Boolean(explicitParticipant && explicitParticipant !== live?.participantName) || Boolean(groupId && groupId !== live?.groupId) || explicitTime;
  return {
    query: (inherit && !changedTarget ? `${live!.query}\n追问：${text}` : text).slice(-500),
    ...(groupId || (inherit && live?.groupId) ? { groupId: groupId || live!.groupId } : {}),
    ...(explicitParticipant || (inherit && live?.participantName) ? { participantName: explicitParticipant || live!.participantName } : {}),
    start, end, anchoredAt: inherit ? live!.anchoredAt : now.toISOString(),
    direction: wantsEarlier ? "earlier" : inherit && !changedTarget ? live!.direction ?? "latest" : "latest",
    // A bare retry re-reads the SAME page: keeping the cursor would silently move the
    // window backwards and answer "现在呢" with an older slice the owner never asked for.
    ...(earlierPage && live?.cursor && !changedTarget ? { cursor: live.cursor } : {}),
    evidenceIds: inherit && !changedTarget && !earlierPage ? live!.evidenceIds : [],
  };
}

/**
 * Rebuild a bounded earlier-history task after the short task was lost (adapter reload,
 * restart or the twenty-minute expiry). A bare "现在呢/再看看" is the owner asking whether
 * the group can be read *now* — answering it without querying is how the same wrong
 * "I cannot see this group" was repeated three times.
 *
 * The caller must resolve and authorize `groupId` before calling; this only assembles the
 * query from the same tonight window used by an explicit request. It never widens the
 * window or looks at anyone else's conversations.
 */
export function planRestartedHistoryRetry(groupId: string, now: Date, timeZone: string): OwnerHistoryPlan | null {
  const base = planOwnerHistory("今晚群里的聊天记录", null, now, timeZone);
  return base ? { ...base, groupId, direction: "earlier" } : null;
}

export function applyOwnerHistoryIntent(previous: OwnerHistoryPlan | null, proposed: OwnerHistoryPlan | null,
  intent: import("./owner-history-intent").OwnerHistoryIntent, message: string): { plan: OwnerHistoryPlan | null; lookup: boolean } {
  if (intent.action === "clear") return { plan: null, lookup: false };
  if (intent.action === "hold") return { plan: previous, lookup: false };
  const base = proposed ?? previous;
  if (!base) return { plan: null, lookup: false };
  const newRange = proposed && previous && (proposed.start !== previous.start || proposed.end !== previous.end);
  const newGroup = proposed?.groupId && previous?.groupId && proposed.groupId !== previous.groupId;
  const rootStart = base.rootStart ?? (newRange || newGroup ? base.start : previous?.rootStart ?? base.start);
  const rootEnd = base.rootEnd ?? (newRange || newGroup ? base.end : previous?.rootEnd ?? base.end);
  if (intent.action === "retry") return { plan: { ...base, rootStart, rootEnd, cursor: undefined }, lookup: true };
  if (intent.action === "page") return { plan: { ...base, mode: "page", direction: "earlier", rootStart, rootEnd,
    ...(previous?.cursor ? { cursor: previous.cursor } : {}), evidenceIds: [] }, lookup: true };
  return { plan: { ...base, mode: intent.action, start: rootStart, end: rootEnd, rootStart, rootEnd,
    query: intent.query || message, direction: "latest", cursor: undefined, evidenceIds: [],
    topicTerms: intent.action === "topic" ? normalizeOwnerHistoryTerms(intent.keywords) : undefined,
    ...(intent.participantName ? { participantName: intent.participantName } : {}) }, lookup: true };
}

export type OwnerHistoryAuthorization = { characterId: string; bindingId: string; privateScopeId: string; conversationId: string; ownerUid: string };
export function ownerHistoryConversationWhere(auth: OwnerHistoryAuthorization): Prisma.ConversationWhereInput {
  return { id: auth.conversationId, characterId: auth.characterId, channelBindingId: auth.bindingId,
    memoryScopeId: auth.privateScopeId, externalConversationId: `c:${auth.ownerUid}`,
    channelBinding: { connection: { platform: "qq-onebot" } } };
}
export async function loadOwnerHistoryContext(prisma: Pick<PrismaClient, "conversation">, auth: OwnerHistoryAuthorization, now: Date): Promise<{ plan: OwnerHistoryPlan | null; updatedAt: Date; historyContext: Prisma.JsonValue | null } | null> {
  const row = await prisma.conversation.findFirst({ where: ownerHistoryConversationWhere(auth), select: { metadata: true, updatedAt: true } });
  return row ? { plan: readOwnerHistoryPlan(object(row.metadata).ownerHistoryContext, now), updatedAt: row.updatedAt,
    historyContext: (object(row.metadata).ownerHistoryContext ?? null) as Prisma.JsonValue | null } : null;
}
export async function saveOwnerHistoryContext(prisma: PrismaClient, auth: OwnerHistoryAuthorization, expectedHistoryContext: Prisma.JsonValue | null, plan: OwnerHistoryPlan | null): Promise<boolean> {
  // Compare this field independently: background continuity summaries legitimately update
  // the same conversation while generation is running. A whole-metadata CAS still guards
  // each merge, with just one retry if an unrelated writer wins after our read.
  const fingerprint = (value: unknown): string => JSON.stringify(value ?? null, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await prisma.$transaction(async tx => {
      const row = await tx.conversation.findFirst({ where: ownerHistoryConversationWhere(auth), select: { metadata: true } });
      if (!row || fingerprint(object(row.metadata).ownerHistoryContext) !== fingerprint(expectedHistoryContext)) return "stale";
      const updated = await tx.conversation.updateMany({ where: { ...ownerHistoryConversationWhere(auth),
        metadata: { equals: row.metadata === null ? Prisma.DbNull : row.metadata as Prisma.InputJsonValue } },
        data: { metadata: { ...object(row.metadata), ownerHistoryContext: plan } as Prisma.InputJsonObject,
          updatedAt: new Date() } });
      return updated.count === 1 ? "saved" : "conflict";
    });
    if (result !== "conflict") return result === "saved";
  }
  return false;
}

export function ownerHistoryGroupWhere(characterId: string, plan: OwnerHistoryPlan): Prisma.MessageWhereInput {
  return { conversation: { characterId, channelBindingId: { not: null },
    externalConversationId: plan.groupId ? `g:${plan.groupId}` : { startsWith: "g:" },
    channelBinding: { connection: { platform: "qq-onebot" } } },
    role: { in: ["USER", "ASSISTANT"] }, occurredAt: { gte: new Date(plan.start), lt: new Date(plan.end) } };
}
export type OwnerHistoryRow = { id: string; conversationId: string; externalMessageId: string | null; role: string; content: string; occurredAt: Date; metadata: unknown; conversation?: { externalConversationId: string | null } };
const author = (row: OwnerHistoryRow): string => String(object(row.metadata).authorOpenId ?? "");
const quote = (row: OwnerHistoryRow): string => String(object(row.metadata).replyToMessageId ?? object(object(row.metadata).quotedMessage).messageId ?? "");
export function ownerHistoryTopicTerms(plan: OwnerHistoryPlan): string[] {
  const precise = normalizeOwnerHistoryTerms(plan.topicTerms).filter(term => term !== plan.participantName);
  return precise.length ? precise : extractMemoryAssistantSearchTerms(plan.query, 16)
    .filter(term => !/^\d+$/u.test(term) && !["群里", "聊天", "记录", "今晚", "今天", "追问"].includes(term));
}
/** Keep participant exchanges across noisy intervening speakers, rather than nearest arbitrary rows. */
export function selectOwnerHistoryEvidence(rows: OwnerHistoryRow[], plan: OwnerHistoryPlan, participantIds: string[]): MemoryAssistantCandidate[] {
  if (plan.participantName && participantIds.length !== 1) return [];
  const ordered = [...new Map(rows.map(row => [row.id, row])).values()].sort((a,b) => a.occurredAt.getTime()-b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const terms = ownerHistoryTopicTerms(plan);
  const score = (row: OwnerHistoryRow) => terms.reduce((n,term) => n + (row.content.includes(term) ? 1 : 0), 0);
  const users = ordered.filter(row => row.role === "USER" && (!participantIds.length || participantIds.includes(author(row))));
  const earlyFirst = plan.direction === "earlier" && !plan.cursor;
  const chronological = (a: OwnerHistoryRow, b: OwnerHistoryRow) => a.occurredAt.getTime()-b.occurredAt.getTime() || a.id.localeCompare(b.id);
  const anchors = [...users].sort((a,b) => plan.direction === "earlier"
    ? (earlyFirst ? chronological(a,b) : chronological(b,a))
    : score(b)-score(a) || chronological(b,a)).slice(0, 4);
  const topicPriority: OwnerHistoryRow[] = [];
  if (plan.mode === "topic") {
    const allAnchors = ordered.filter(row => plan.evidenceIds.includes(row.id));
    const participantContext = participantIds.length ? allAnchors.filter(row => row.role === "USER" && participantIds.includes(author(row))) : [];
    const diverse = [...new Map([
      ...(participantContext.length ? [participantContext[0]!, participantContext[participantContext.length - 1]!] : []),
      ...terms.flatMap(term => {
        const hit = allAnchors.filter(row => row.content.includes(term));
        return hit.length ? [hit[0]!, hit[hit.length - 1]!] : [];
      }),
    ].map(row => [row.id, row])).values()].slice(0, 8);
    const rounds = diverse.map(anchor => {
      const neighbors = ordered.filter(row => row.conversationId === anchor.conversationId && row.role !== anchor.role
        && Math.abs(row.occurredAt.getTime()-anchor.occurredAt.getTime()) <= 180_000);
      const before = neighbors.filter(row => row.occurredAt < anchor.occurredAt).at(-1);
      const after = neighbors.find(row => row.occurredAt >= anchor.occurredAt);
      return [anchor, ...(after ? [after] : []), ...(before ? [before] : [])];
    });
    for (let depth = 0; depth < 3; depth++) for (const round of rounds) {
      const row = round[depth];
      if (row && !topicPriority.some(item => item.id === row.id)) topicPriority.push(row);
    }
  }
  const wanted = new Set(plan.evidenceIds);
  for (const anchor of anchors) {
    wanted.add(anchor.id);
    const samePerson = users.filter(row => row.conversationId === anchor.conversationId && author(row) === author(anchor)
      && Math.abs(row.occurredAt.getTime()-anchor.occurredAt.getTime()) <= 15 * 60_000);
    for (const row of (earlyFirst ? samePerson.slice(0, 12) : samePerson.slice(-12))) wanted.add(row.id);
    // Nearby assistant lines are context candidates, not a code-level claim about their addressee.
    // The final model sees original speakers/times and decides the semantic relationship.
    for (const row of ordered.filter(row => row.conversationId === anchor.conversationId && row.role === "ASSISTANT"
      && row.occurredAt >= anchor.occurredAt && row.occurredAt.getTime()-anchor.occurredAt.getTime() <= 3 * 60_000).slice(0, 6)) wanted.add(row.id);
  }
  for (const row of ordered) if (quote(row) && ordered.some(source => wanted.has(source.id) && source.conversationId === row.conversationId && source.externalMessageId === quote(row))) wanted.add(row.id);
  // Preserve chronological exchanges as a bounded bundle. No second keyword/top-N selection.
  const selected = ordered.filter(row => wanted.has(row.id));
  const result: MemoryAssistantCandidate[] = [];
  let tokens = 0;
  const prioritized = plan.mode === "topic"
    ? [...new Map([...topicPriority, ...selected].map(row => [row.id, row])).values()].slice(0, 24)
    : earlyFirst ? selected.slice(0, 24) : selected.slice(-24);
  for (const row of prioritized) {
    const content = row.content.slice(0, 360), cost = estimateTokens(content) + 16;
    if (tokens + cost > 3200) break;
    tokens += cost;
    const metadata = object(row.metadata);
    const room = row.conversation?.externalConversationId?.replace(/^g:/u, "QQ群 ") ?? (plan.groupId ? `QQ群 ${plan.groupId}` : "某个群");
    result.push({ id: row.id, sourceKey: `message:${row.id}`, sourceType: "message", scope: "character", relevanceScore: 1,
      role: row.role, content: `【${room}；不完整检索片段，样本时间不代表最早记录边界${row.role === "ASSISTANT" ? "；回应对象须结合上下文核实" : ""}】${content}`, occurredAt: row.occurredAt.toISOString(),
      speaker: row.role === "ASSISTANT" ? "自己（群聊记录）" : String(metadata.authorDisplayName ?? "群成员"),
      ...(metadata.isOwner === true ? { isOwner: true } : {}) });
  }
  return result;
}

/** Timestamp + id gives stable pages even when many messages share a millisecond. */
function beforeCursor(cursor: OwnerHistoryCursor): Prisma.MessageWhereInput {
  const occurredAt = new Date(cursor.occurredAt);
  return { OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: cursor.id } }] };
}

/** All page, aggregate and existence reads retain the same server-authorized group predicate. */
export async function loadOwnerHistoryPage(prisma: Pick<PrismaClient, "message">, characterId: string, plan: OwnerHistoryPlan, participantIds: string[]): Promise<{ sources: MemoryAssistantCandidate[]; coverage: OwnerHistoryCoverage }> {
  let effective = { ...plan };
  const emptyCoverage: OwnerHistoryCoverage = { groupIds: plan.groupId ? [plan.groupId] : [], start: plan.start, end: plan.end,
    direction: plan.direction ?? "latest", count: 0, actualFirst: null, actualLast: null, sampledFirst: null, sampledLast: null, truncated: false, hasEarlier: false };
  if (plan.participantName && participantIds.length !== 1) return { sources: [], coverage: { ...emptyCoverage, reason: "unresolved_participant" } };
  if ((plan.mode === "topic" || plan.mode === "boundary") && !plan.groupId) return { sources: [], coverage: { ...emptyCoverage, reason: "unresolved_group" } };
  const select = { id: true, conversationId: true, externalMessageId: true, role: true, content: true, occurredAt: true, metadata: true,
    conversation: { select: { externalConversationId: true } } } as const;
  if (plan.mode === "boundary") {
    const where = ownerHistoryGroupWhere(characterId, plan);
    const [count, first, last] = await Promise.all([prisma.message.count({ where }),
      prisma.message.findMany({ where, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 1, select }),
      prisma.message.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 1, select })]);
    const { occurredAt: _range, ...authorized } = where;
    const prior = await prisma.message.findMany({ where: { AND: [authorized, { occurredAt: { lt: new Date(plan.start) } }] }, take: 1, select });
    return { sources: [], coverage: { ...emptyCoverage, count, actualFirst: first[0]?.occurredAt.toISOString() ?? null,
      actualLast: last[0]?.occurredAt.toISOString() ?? null, hasEarlier: prior.length > 0 } };
  }
  const terms = ownerHistoryTopicTerms(plan);
  const userWhere: Prisma.MessageWhereInput = { role: "USER", ...(participantIds.length ? { metadata: { path: ["authorOpenId"], equals: participantIds[0]! } } : {}) };
  const readAnchors = async () => {
    const order = effective.direction === "earlier" && !effective.cursor ? "asc" as const : "desc" as const;
    const where = { AND: [ownerHistoryGroupWhere(characterId, effective),
      ...((effective.direction === "earlier" || effective.mode === "topic") && !participantIds.length ? [] : [userWhere]),
      ...(effective.cursor ? [beforeCursor(effective.cursor)] : [])] };
    if (effective.mode === "topic") {
      const hits = await Promise.all(terms.flatMap(term => (["asc", "desc"] as const).map(order => prisma.message.findMany({
        where: { AND: [where, { content: { contains: term, mode: "insensitive" as const } }] },
        orderBy: [{ occurredAt: order }, { id: order }], take: 1, select,
      }))));
      if (!hits.some(batch => batch.length)) return [];
      const participantContext = participantIds.length ? await Promise.all((["asc", "desc"] as const).map(order => prisma.message.findMany({
        where: { AND: [where, userWhere] }, orderBy: [{ occurredAt: order }, { id: order }], take: 1, select,
      }))) : [];
      // The person's first/last contributions complete the interaction even when their
      // opening action uses different wording than the later topic question.
      return [...new Map([...participantContext.flat(), ...hits.flat()].map(row => [row.id, row])).values()].slice(0, 8);
    }
    // A directional page is chronological, not a new keyword search that jumps over a range.
    const matched = effective.direction !== "earlier" && terms.length ? await prisma.message.findMany({
      where: { AND: [where, { OR: terms.map(term => ({ content: { contains: term, mode: "insensitive" as const } })) }] },
      orderBy: [{ occurredAt: order }, { id: order }], take: 12, select,
    }) : [];
    return matched.length ? matched : prisma.message.findMany({ where, orderBy: [{ occurredAt: order }, { id: order }], take: 12, select });
  };
  let anchors = await readAnchors();
  // Only advance the time window after an actual read proves this range has no prior USER anchors.
  if (!anchors.length && effective.direction === "earlier") {
    effective = { ...effective, end: effective.start, start: new Date(Date.parse(effective.start)-86_400_000).toISOString(), cursor: undefined, evidenceIds: [] };
    anchors = await readAnchors();
  }
  const where = ownerHistoryGroupWhere(characterId, effective);
  const pageWhere: Prisma.MessageWhereInput = { AND: [where, ...(effective.cursor ? [beforeCursor(effective.cursor)] : [])] };
  const retained = effective.evidenceIds.length ? await prisma.message.findMany({ where: { AND: [pageWhere, { id: { in: effective.evidenceIds } }] }, take: 24, select }) : [];
  const expanded = await Promise.all(anchors.slice(0, effective.mode === "topic" ? 8 : 4).flatMap(anchor =>
    (["before", "after"] as const).flatMap(direction => (["USER", "ASSISTANT"] as const).map(role => {
      const sideOrder = direction === "before" ? "desc" as const : "asc" as const;
      return prisma.message.findMany({ where: { AND: [pageWhere, { conversationId: anchor.conversationId, role,
        ...(role === "USER" && anchor.role === "USER" ? { metadata: { path: ["authorOpenId"], equals: author(anchor) } } : {}),
        occurredAt: direction === "before"
          ? { gte: new Date(anchor.occurredAt.getTime()-15*60_000), lte: anchor.occurredAt }
          : { gte: anchor.occurredAt, lte: new Date(anchor.occurredAt.getTime()+15*60_000) },
      }] }, orderBy: [{ occurredAt: sideOrder }, { id: sideOrder }], take: role === "USER" ? 12 : 8, select });
    }))));
  const rows = [...retained, ...anchors, ...expanded.flat()];
  const sources = selectOwnerHistoryEvidence(rows, { ...effective, evidenceIds: [...effective.evidenceIds, ...anchors.map(anchor => anchor.id)] }, participantIds);
  const [count, first, last] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({ where, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 1, select }),
    prisma.message.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 1, select }),
  ]);
  const byId = new Map(rows.map(row => [row.id, row]));
  const sampled = sources.flatMap(source => byId.has(source.id) ? [byId.get(source.id)!] : [])
    .sort((a,b) => a.occurredAt.getTime()-b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const oldest = sampled[0];
  const oldestCursor = oldest ? { id: oldest.id, occurredAt: oldest.occurredAt.toISOString() } : undefined;
  const { occurredAt: _range, ...authorizedGroup } = where;
  const prior = await prisma.message.findMany({ where: { AND: [authorizedGroup, ...(participantIds.length ? [userWhere] : []),
    beforeCursor(oldestCursor ?? effective.cursor ?? { id: "00000000-0000-0000-0000-000000000000", occurredAt: effective.start })] },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 1, select });
  const groupIds = [...new Set([...first, ...last, ...sampled].flatMap(row => row.conversation?.externalConversationId?.startsWith("g:") ? [row.conversation.externalConversationId.slice(2)] : []))];
  return { sources, coverage: { groupIds: plan.groupId ? [plan.groupId] : groupIds, start: effective.start, end: effective.end,
    direction: effective.direction ?? "latest", count, actualFirst: first[0]?.occurredAt.toISOString() ?? null,
    actualLast: last[0]?.occurredAt.toISOString() ?? null, sampledFirst: oldest?.occurredAt.toISOString() ?? null,
    sampledLast: sampled.at(-1)?.occurredAt.toISOString() ?? null, truncated: sources.length < count,
    hasEarlier: prior.length > 0, ...(oldestCursor ? { oldestCursor } : {}) } };
}

/** Compatibility for callers which only need original bounded message evidence. */
export async function loadOwnerHistoryEvidence(prisma: Pick<PrismaClient, "message">, characterId: string, plan: OwnerHistoryPlan, participantIds: string[]): Promise<MemoryAssistantCandidate[]> {
  return (await loadOwnerHistoryPage(prisma, characterId, plan, participantIds)).sources;
}




