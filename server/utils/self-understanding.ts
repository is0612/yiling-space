export const SELF_UNDERSTANDING_DOMAINS = ["memory", "experience", "preferences", "language", "goals", "social", "reflection", "knowledge"] as const;
export type SelfUnderstandingDomain = typeof SELF_UNDERSTANDING_DOMAINS[number];

/** Fast path only decides whether the user explicitly asked for a self view, never what it means. */
export function wantsSelfUnderstanding(message: string): boolean {
  if (message.length > 800) return false;
  return /(?:你是谁|你是什么样的|你的(?:性格|身份|自我认知)|你(?:觉得|认为|怎么看)(?:你自己|自己)|你对自己的(?:认识|理解|看法)|你(?:最近|现在|这段时间|与以前相比).{0,12}(?:变化|改变|成长)|你和(?:以前|过去).{0,8}(?:不同|区别)|梳理.{0,8}你的成长)/u.test(message);
}

export type SelfUnderstandingEvidence = {
  domain: SelfUnderstandingDomain; id: string; text: string;
  state: "ACTIVE" | "ACCEPTED";
  scope: "character" | "private";
  revision?: number; updatedAt: string; context?: string; confidence?: number | null;
  /** Only request-authorized conversation evidence may be passed by a trusted domain adapter. */
  conversationId?: string;
};
export type SelfUnderstandingView = {
  version: 1;
  identity: { name: string };
  presentation: { avatar: string; meaning: "appearance_only" };
  evidence: Array<{
    domain: SelfUnderstandingDomain; id: string; excerpt: string;
    scope: "character" | "private"; status: "confirmed_record" | "active_record" | "accepted_interpretation" | "scoped_experience";
    revision?: number; updatedAt: string; context?: string; confidence?: number | null;
  }>;
  notProvided: SelfUnderstandingDomain[];
};

export function selfUnderstandingReferences(view: SelfUnderstandingView) {
  return view.evidence.map(({ excerpt: _excerpt, context: _context, ...reference }) => reference);
}

/** No inference, writes or cross-turn cache. The caller supplies freshly authorized domain records. */
export function buildSelfUnderstandingView(input: {
  name: string; avatar?: string; groupChat: boolean; conversationId?: string;
  evidence: readonly SelfUnderstandingEvidence[];
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
    presentation: { avatar: /^(?:https?:|data:|blob:|\/)/iu.test((input.avatar ?? "").trim()) ? "configured_image" : (input.avatar ?? "").trim().slice(0, 80), meaning: "appearance_only" },
    evidence, notProvided: SELF_UNDERSTANDING_DOMAINS.filter(domain => !evidence.some(row => row.domain === domain)),
  };
}
