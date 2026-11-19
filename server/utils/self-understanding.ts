export const SELF_UNDERSTANDING_DOMAINS = ["memory", "experience", "preferences", "language", "goals", "social", "reflection", "knowledge"] as const;
export type SelfUnderstandingDomain = typeof SELF_UNDERSTANDING_DOMAINS[number];

/** Fast path only decides whether the user explicitly asked for a self view, never what it means. */
export function wantsSelfUnderstanding(message: string, context?: {
  groupChat: boolean;
  previousMessage?: { role: string; occurredAt: Date | string; metadata?: unknown };
  now?: Date;
}): boolean {
  if (message.length > 800) return false;
  if (asksSelfUnderstandingHistory(message)) return true;
  if (/(?:你是谁|你是什么样的|你的(?:性格|身份|自我认知)|你(?:觉得|认为|怎么看)(?:你自己|自己)|你对自己的(?:认识|理解|看法)|你和(?:以前|过去).{0,8}(?:不同|区别)|梳理.{0,8}你的成长)/u.test(message)) return true;
  // Only the immediately preceding server-authored private reply can anchor an omitted subject.
  // Never inherit across group speakers, intervening topics, sessions, or a long pause.
  const previous = context?.previousMessage;
  if (!context || context.groupChat || !previous || previous.role !== "ASSISTANT" || message.length > 120) return false;
  const metadata = previous.metadata && typeof previous.metadata === "object" && !Array.isArray(previous.metadata)
    ? previous.metadata as Record<string, unknown> : {};
  if (!Array.isArray(metadata.providedSelfUnderstandingSources)) return false;
  const age = (context.now ?? new Date()).getTime() - new Date(previous.occurredAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) return false;
  if (/(?:这是哪来的(?:消息|说法|判断|结论)|(?:你刚才|刚才那句|这个说法|你这个判断).{0,12}(?:依据|来源)|^(?:依据|来源)(?:是什么|在哪里|呢))/u.test(message.trim())) return true;
  return /^(?:那[，,\s]*)?(?:(?:这段时间|最近|现在)(?:有什么|有哪些|有啥|有|的)?(?:变化|改变|成长)|(?:和|与)(?:以前|过去)相比(?:有什么|有哪些)?(?:变化|不同)|有没有(?:具体的?)?(?:经历|例子|依据)(?:能说明|支持|吗)?)[？?。！!，,\s]*(?:有没有(?:具体的?)?(?:经历|例子|依据|记录)(?:能说明|支持|吗)?[？?。！!\s]*)?$/u.test(message.trim());
}

/** Request the bounded historical comparison only for explicit retrospective questions. */
export function asksSelfUnderstandingHistory(message: string, authorizedFollowup = false): boolean {
  if (message.length > 800) return false;
  if (authorizedFollowup && /^(?:那[，,\s]*)?(?:(?:和|与)(?:以前|过去)相比|(?:最近|现在|这段时间)(?:有什么|有哪些|有啥|有|的)?(?:变化|改变|成长)|有没有(?:具体的?)?(?:经历|例子))/u.test(message.trim())) return true;
  return /(?:你(?:的)?(?:身份.{0,8}(?:形成|得来)|(?:表达习惯|偏好|目标|和.{1,28}的关系).{0,12}(?:变|演变)|(?:经历过什么|有哪些重要经历)|(?:以前|过去|刚认识|和过去|与以前).{0,24}(?:现在|变化|不同|区别)|(?:最近|现在|这段时间)(?:自己)?(?:有(?:什么|哪些|啥)?|发生了|的)?(?:变化|改变|成长))|(?:过去的你|以前的你).{0,16}现在的你)/u.test(message);
}

export type SelfUnderstandingEvidence = {
  domain: SelfUnderstandingDomain; id: string; text: string;
  state: "ACTIVE" | "ACCEPTED";
  scope: "character" | "private";
  revision?: number; updatedAt: string; occurredAt?: string; context?: string; confidence?: number | null; excerptTruncated?: boolean; subject?: "current_character_response";
  /** Only request-authorized conversation evidence may be passed by a trusted domain adapter. */
  conversationId?: string;
};
export type SelfUnderstandingView = {
  version: 1;
  identity: { name: string };
  presentation: { avatar: string; meaning: "appearance_only"; changeableByOwner: true };
  runtimeEvidence: { events: "not_supplied_by_this_view"; currentAbilities: "not_assessed_by_this_view";
    memoryRead: "not_performed_by_this_view" | "authorized_scoped_read_succeeded"; historyCompleteness: "not_established" };
  evidence: Array<{
    domain: SelfUnderstandingDomain; id: string; excerpt: string;
    scope: "character" | "private"; status: "confirmed_record" | "active_record" | "accepted_interpretation" | "scoped_experience";
    revision?: number; updatedAt: string; occurredAt?: string; context?: string; confidence?: number | null; excerptTruncated?: boolean; subject?: "current_character_response";
  }>;
  coverage: { selectedMemorySources: number; selectedInteractionFeedbackSources: number; unselectedMeaning: "not_in_this_bounded_view" };
  notProvided: Array<Exclude<SelfUnderstandingDomain, "experience"> | "interaction_feedback_cards">;
  /** Only present for a retrospective question. An empty array does not establish no change. */
  history?: import("./self-understanding-history").SelfUnderstandingHistoryEntry[];
};

export function selfUnderstandingReferences(view: SelfUnderstandingView) {
  return view.evidence.map(({ excerpt: _excerpt, context: _context, ...reference }) => reference);
}

/** No inference, writes or cross-turn cache. The caller supplies freshly authorized domain records. */
export function buildSelfUnderstandingView(input: {
  name: string; avatar?: string; groupChat: boolean; conversationId?: string;
  evidence: readonly SelfUnderstandingEvidence[];
  scopedMemoryReadSucceeded?: boolean;
}): SelfUnderstandingView {
  const evidence: SelfUnderstandingView["evidence"] = [];
  const seen = new Set<string>();
  let used = 0;
  // First item from each domain gets considered before further items from the same domain.
  const queues = SELF_UNDERSTANDING_DOMAINS.map(domain => input.evidence.filter(row => row.domain === domain).slice(0, 8));
  for (let index = 0; index < 8; index++) {
    for (const rows of queues) {
      const row = rows[index];
      if (!row || !/^[a-zA-Z0-9_-]{1,120}$/.test(row.id) || !row.text.trim()) continue;
      if (row.scope !== "character" && row.scope !== "private") continue;
      if (input.groupChat && row.scope !== "character") continue;
      if (row.conversationId && (input.groupChat || row.conversationId !== input.conversationId)) continue;
      if (row.domain === "experience" && (!row.conversationId || row.scope !== "private")) continue;
      if ((row.domain === "reflection" && row.state !== "ACCEPTED") || (row.domain !== "reflection" && row.state !== "ACTIVE")) continue;
      const key = `${row.domain}:${row.id}`;
      if (seen.has(key) || !Number.isFinite(Date.parse(row.updatedAt))) continue;
      const item: SelfUnderstandingView["evidence"][number] = {
        domain: row.domain, id: row.id, excerpt: row.text.trim().slice(0, 240), scope: row.scope,
        status: row.domain === "reflection" ? "accepted_interpretation" : row.domain === "experience" ? "scoped_experience" : row.domain === "memory" || row.domain === "knowledge" ? "active_record" : "confirmed_record",
        ...(Number.isSafeInteger(row.revision) && row.revision! > 0 ? { revision: row.revision } : {}),
        updatedAt: new Date(row.updatedAt).toISOString(),
        ...(row.occurredAt && Number.isFinite(Date.parse(row.occurredAt)) ? { occurredAt: new Date(row.occurredAt).toISOString() } : {}),
        ...(row.domain === "experience" && row.subject === "current_character_response" ? { subject: "current_character_response" as const } : {}),
        ...(row.excerptTruncated || row.text.trim().length > 240 || (row.context?.trim().length ?? 0) > 120 ? { excerptTruncated: true } : {}),
        ...(row.confidence !== undefined ? { confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : null } : {}),
        ...(row.context?.trim() ? { context: row.context.trim().slice(0, 120) } : {}),
      };
      const size = JSON.stringify(item).length;
      if (used + size > 6000 || evidence.length >= 24) continue;
      used += size; seen.add(key); evidence.push(item);
    }
  }
  return {
    version: 1, identity: { name: input.name.trim().slice(0, 100) },
    presentation: { avatar: /^(?:https?:|data:|blob:|\/)/iu.test((input.avatar ?? "").trim()) ? "configured_image" : (input.avatar ?? "").trim().slice(0, 80), meaning: "appearance_only", changeableByOwner: true },
    runtimeEvidence: { events: "not_supplied_by_this_view", currentAbilities: "not_assessed_by_this_view",
      memoryRead: input.scopedMemoryReadSucceeded === true ? "authorized_scoped_read_succeeded" : "not_performed_by_this_view", historyCompleteness: "not_established" },
    coverage: { selectedMemorySources: evidence.filter(row => row.domain === "memory").length,
      selectedInteractionFeedbackSources: evidence.filter(row => row.domain === "experience").length, unselectedMeaning: "not_in_this_bounded_view" },
    evidence, notProvided: SELF_UNDERSTANDING_DOMAINS.filter(domain => !evidence.some(row => row.domain === domain))
      .map(domain => domain === "experience" ? "interaction_feedback_cards" : domain),
  };
}
