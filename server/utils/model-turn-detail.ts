export type TurnEvidence = { id?: string; member?: string; speaker?: string; content: string; occurredAt?: string };
export type TurnSource = { id: string; type: "memory" | "snapshot" | "event" | "message"; scope: "character" | "private"; title?: string; content: string; occurredAt?: string };
export type TurnDetailPatch = {
  context?: { status: "not_enabled" | "not_applicable" | "success" | "failed"; summary?: string; participation?: "invited" | "observing" | "uncertain"; uncertainty?: string; evidence?: TurnEvidence[] };
  memory?: { status: "not_needed" | "not_enabled" | "no_sources" | "failed" | "success"; query?: string; sources?: TurnSource[] };
  response?: { action: "reply" | "silent"; reply: string; explanation?: string };
};
export type ModelTurnDetail = {
  version: 1; groupChat: boolean; messages: TurnEvidence[];
  context: NonNullable<TurnDetailPatch["context"]>;
  memory: NonNullable<TurnDetailPatch["memory"]>;
  response: { status: "success" | "failed"; action?: "reply" | "silent"; reply?: string; explanation?: string };
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}
function evidence(value: unknown): TurnEvidence[] {
  return (Array.isArray(value) ? value : []).slice(-20).map(item => {
    const row = object(item);
    return { content: text(row.content, 1200) ?? "", id: text(row.id, 120), member: text(row.member, 80), speaker: text(row.speaker, 80), occurredAt: text(row.occurredAt, 40) };
  }).filter(row => row.content);
}
/** Explicit allowlist: diagnostics are evidence summaries, never serialized prompts/provider reasoning. */
export function sanitizeModelTurnDetail(value: unknown): ModelTurnDetail {
  const raw = object(value), context = object(raw.context), memory = object(raw.memory), response = object(raw.response);
  const groupChat = raw.groupChat === true;
  const sources: TurnSource[] = (Array.isArray(memory.sources) ? memory.sources : []).slice(0, 8).flatMap(item => {
    const row = object(item);
    if (!["memory", "snapshot", "event", "message"].includes(String(row.type)) || !["character", "private"].includes(String(row.scope)) || (groupChat && row.scope !== "character")) return [];
    const id = text(row.id, 120), content = text(row.content, 1600);
    if (!id || !content) return [];
    return [{ id, content, type: row.type as TurnSource["type"], scope: row.scope as TurnSource["scope"], title: text(row.title, 160), occurredAt: text(row.occurredAt, 40) }];
  });
  return {
    version: 1, groupChat, messages: evidence(raw.messages),
    context: {
      status: ["not_enabled", "not_applicable", "success", "failed"].includes(String(context.status)) ? context.status as ModelTurnDetail["context"]["status"] : "not_enabled",
      summary: text(context.summary, 1600), uncertainty: text(context.uncertainty, 400),
      participation: ["invited", "observing", "uncertain"].includes(String(context.participation)) ? context.participation as ModelTurnDetail["context"]["participation"] : undefined,
      evidence: evidence(context.evidence).slice(0, 12),
    },
    memory: {
      status: ["not_needed", "not_enabled", "no_sources", "failed", "success"].includes(String(memory.status)) ? memory.status as ModelTurnDetail["memory"]["status"] : "not_needed",
      query: text(memory.query, 240), sources,
    },
    response: {
      status: response.status === "success" ? "success" : "failed",
      action: response.action === "reply" || response.action === "silent" ? response.action : undefined,
      reply: text(response.reply, 4000), explanation: text(response.explanation, 400),
    },
  };
}
export function createModelTurnDetail(groupChat: boolean, messages: TurnEvidence[]) {
  const detail: ModelTurnDetail = { version: 1, groupChat, messages, context: { status: groupChat ? "not_enabled" : "not_applicable" }, memory: { status: "not_needed" }, response: { status: "failed" } };
  return {
    update(patch: TurnDetailPatch) {
      if (patch.context) detail.context = patch.context;
      if (patch.memory) detail.memory = patch.memory;
      if (patch.response) detail.response = { status: "success", ...patch.response };
    },
    serialize() {
      const safe = sanitizeModelTurnDetail(detail);
      // JSON escaping can expand control characters; enforce the stored size as well as field limits.
      let serialized = JSON.stringify(safe);
      while (serialized.length > 80_000) {
        if (safe.messages.length > 1) safe.messages.shift();
        else if (safe.context.evidence?.length) safe.context.evidence.pop();
        else if (safe.memory.sources?.length) safe.memory.sources.pop();
        else {
          safe.response.reply = safe.response.reply?.slice(0, 1000);
          safe.context.summary = safe.context.summary?.slice(0, 400);
          break;
        }
        serialized = JSON.stringify(safe);
      }
      return JSON.stringify(safe);
    },
  };
}
export function readModelTurnDetail(value: unknown): ModelTurnDetail | null {
  if (typeof value !== "string" || value.length > 80_000) return null;
  try { const parsed: unknown = JSON.parse(value); return object(parsed).version === 1 ? sanitizeModelTurnDetail(parsed) : null; } catch { return null; }
}
export function readModelTurnId(metadata: unknown): string | null {
  const value = object(metadata).turnId;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
