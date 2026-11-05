import { generateConversationReply, type ConversationReplyInput } from "./chat-reply";
import { analyzeGroupContext, ContextAssistantError, type ContextAnalysis } from "./context-assistant";
import {
  callMemoryAssistant,
  generateConversationReplyWithMemoryAssistant,
  type MemoryAssistantCandidate,
  type MemoryAssistantRuntime,
  type ConversationReplyWithMemoryAssistant,
} from "./memory-assistant";
import type { ModelUsageTokens } from "./model-usage";

/** 单轮有界流程：分析一次 → 最多检索一次 → 角色最终决定；不执行分析器提出的其他动作。 */
export async function generateGroupContextReply(input: {
  chatInput: ConversationReplyInput;
  assistant: MemoryAssistantRuntime | null;
  contextAssistant?: MemoryAssistantRuntime | null;
  candidates: MemoryAssistantCandidate[];
  analysisBackground?: ConversationReplyInput["groupBackground"];
  loadCandidates?: (query: string) => Promise<MemoryAssistantCandidate[]>;
  recordAssistantUsage: (entry: {
    kind: "context-assistant" | "memory-assistant";
    model: string;
    usage?: ModelUsageTokens;
    status: string;
  }) => Promise<void>;
}): Promise<ConversationReplyWithMemoryAssistant> {
  if (!input.contextAssistant || !input.chatInput.groupChat) {
    return generateConversationReplyWithMemoryAssistant(input);
  }
  const record = async (entry: Parameters<typeof input.recordAssistantUsage>[0]) => {
    // 记账失败不能改变成功的分析或回复。
    await input.recordAssistantUsage(entry).catch(() => undefined);
  };
  let analysis: ContextAnalysis;
  try {
    const result = await analyzeGroupContext(input.contextAssistant, {
      ...input.chatInput,
      groupBackground: input.analysisBackground ?? input.chatInput.groupBackground,
    });
    analysis = result.analysis;
    await record({ kind: "context-assistant", model: input.contextAssistant.model, usage: result.usage, status: "success" });
  } catch (error) {
    await record({
      kind: "context-assistant", model: input.contextAssistant.model,
      ...(error instanceof ContextAssistantError ? { usage: error.usage } : {}), status: "failed",
    });
    return generateConversationReplyWithMemoryAssistant(input);
  }

  let sources: MemoryAssistantCandidate[] = [];
  let memoryStatus: NonNullable<ConversationReplyInput["contextAnalysis"]>["memoryStatus"];
  if (analysis.memoryQuery) {
    memoryStatus = "unavailable";
    if (input.assistant) {
      try {
        // 群内检索只允许全局范围，检索器外再做一次边界校验。
        const candidates = (input.loadCandidates
          ? await input.loadCandidates(analysis.memoryQuery)
          : input.candidates).filter(source => source.scope === "character");
        if (candidates.length) {
          const result = await callMemoryAssistant(input.assistant, analysis.memoryQuery, candidates);
          sources = result.sources;
          memoryStatus = sources.length ? "success" : "no_sources";
          await record({ kind: "memory-assistant", model: input.assistant.model, usage: result.usage, status: memoryStatus });
        } else {
          memoryStatus = "no_sources";
        }
      } catch (error) {
        memoryStatus = "failed";
        const usage = error !== null && typeof error === "object" && "usage" in error
          ? error.usage as ModelUsageTokens | undefined : undefined;
        await record({ kind: "memory-assistant", model: input.assistant.model, usage, status: "failed" });
      }
    }
  }

  const evidenceIds = new Set(analysis.evidenceMessageIds);
  const original = input.chatInput;
  // 大背景留给分析器，角色拿到本轮原话、被引用证据和少量最近互动。
  const background = (input.analysisBackground ?? original.groupBackground ?? [])
    .filter(line => line.id && evidenceIds.has(line.id))
    .map(line => ({ ...line, content: line.content.slice(0, 600) }));
  const unique = <T extends { id: string }>(base: T[], extra: T[]): T[] => {
    const ids = new Set(base.map(item => item.id));
    return [...base, ...extra.filter(item => !ids.has(item.id))];
  };
  return generateConversationReply({
    ...original,
    allowSilent: true,
    groupBackground: background,
    recentMessages: original.recentMessages.slice(-6),
    contextAnalysis: {
      summary: analysis.summary,
      evidenceMessageIds: analysis.evidenceMessageIds,
      participation: analysis.participation,
      ...(analysis.uncertainty ? { uncertainty: analysis.uncertainty } : {}),
      ...(memoryStatus ? { memoryStatus } : {}),
    },
    // 本轮已由语境助手作出检索判断，禁止再次检索循环。
    memoryAssistantAvailable: false,
    memoryAssistantEvidenceProvided: sources.length > 0,
    memories: unique(original.memories, sources.filter(s => s.sourceType === "memory").map(s => ({
      id: s.id, category: s.category ?? "FACT", content: s.content ?? "", confidence: null,
      relevanceScore: s.relevanceScore, scope: s.scope,
      ...(s.occurredAt ? { occurredAt: s.occurredAt } : {}),
    }))),
    snapshots: unique(original.snapshots, sources.filter(s => s.sourceType === "snapshot").map(s => ({
      id: s.id, summary: s.summary ?? "", periodStart: s.periodStart ?? "", periodEnd: s.periodEnd ?? "",
      version: s.version ?? 1, relevanceScore: s.relevanceScore, scope: s.scope,
    }))),
    events: unique(original.events ?? [], sources.filter(s => s.sourceType === "event").map(s => ({
      id: s.id, occurredAt: s.occurredAt ?? "", title: s.title ?? "", detail: s.detail ?? "",
      participants: s.participants ?? [], scope: s.scope,
      ...(s.timeOfDay ? { timeOfDay: s.timeOfDay } : {}), ...(s.place ? { place: s.place } : {}),
    }))),
    rawMessages: unique(original.rawMessages ?? [], sources.filter(s => s.sourceType === "message").map(s => ({
      id: s.id, role: s.role ?? "USER", content: s.content ?? "", occurredAt: s.occurredAt ?? "",
      scope: s.scope, ...(s.speaker ? { speaker: s.speaker } : {}), isOwner: s.isOwner === true,
    }))),
  });
}
