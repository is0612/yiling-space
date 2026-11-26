import { automaticKnowledgeLines } from "./automatic-source-policy";
import type { AssistantTurnContext } from "./assistant-turn-context";
import { assertAssistantTurnChannel, executeAssistantGroupTurn, runAssistantTurnStage, skipAssistantTurnStage, validateAssistantTurnEvidence, snapshotAssistantTurnData } from "./assistant-turn-execution";
import type { TurnDetailPatch } from "./model-turn-detail";
import { generateConversationReply, type ConversationKnowledgeItem, type ConversationReplyInput } from "./chat-reply";
import { analyzeGroupContext, ContextAssistantError, type ContextAnalysis, type PreviousWorkingContext } from "./context-assistant";
import {
  callMemoryAssistant,
  memoryAssistantTurnSource,
  generateConversationReplyWithMemoryAssistant,
  type MemoryAssistantCandidate,
  type MemoryAssistantRuntime,
  type ConversationReplyWithMemoryAssistant,
} from "./memory-assistant";
import type { ModelUsageTokens } from "./model-usage";

/** 单轮有界流程：分析一次 → 最多检索一次 → 角色最终决定；不执行分析器提出的其他动作。 */
type GroupContextReplyInput = {
  turnContext?: AssistantTurnContext;
  chatInput: ConversationReplyInput;
  assistant: MemoryAssistantRuntime | null;
  contextAssistant?: MemoryAssistantRuntime | null;
  candidates: MemoryAssistantCandidate[];
  requiredHistoryLookup?: Parameters<typeof generateConversationReplyWithMemoryAssistant>[0]["requiredHistoryLookup"];
  suppressHistoryLookup?: boolean;
  onTurnDetail?: (detail: TurnDetailPatch) => void;
  analysisBackground?: ConversationReplyInput["groupBackground"];
  previousWorkingContext?: PreviousWorkingContext;
  onWorkingContext?: (value: { summary: string; evidenceMessageIds: string[] }) => Promise<void>;
  onKnowledgeCandidate?: (candidate: { rawContent: string; sourceMessageIds: string[]; reason: string; speakers?: string[] }) => Promise<void>;
  loadKnowledge?: (query: string) => Promise<ConversationKnowledgeItem[]>;
  loadCandidates?: (query: string) => Promise<MemoryAssistantCandidate[]>;
  recordAssistantUsage: (entry: {
    kind: "context-assistant" | "memory-assistant";
    model: string;
    usage?: ModelUsageTokens;
    status: string;
  }) => Promise<void>;
};
export async function generateGroupContextReply(input: GroupContextReplyInput): Promise<ConversationReplyWithMemoryAssistant> {
  if (input.turnContext) assertAssistantTurnChannel(input.turnContext, input.chatInput.groupChat === true);
  if (!input.chatInput.groupChat || !input.turnContext) return generateGroupContextReplyInternal(input);
  // Snapshot data before validation/keying: deferred execution must never observe caller mutations.
  const { readOnlyTools, ...chatData } = input.chatInput;
  const captured: GroupContextReplyInput = { ...input,
    chatInput: { ...snapshotAssistantTurnData(chatData), ...(readOnlyTools ? { readOnlyTools } : {}) }, assistant: snapshotAssistantTurnData(input.assistant),
    contextAssistant: snapshotAssistantTurnData(input.contextAssistant), candidates: snapshotAssistantTurnData(input.candidates),
    analysisBackground: snapshotAssistantTurnData(input.analysisBackground), previousWorkingContext: snapshotAssistantTurnData(input.previousWorkingContext),
  };
  validateAssistantTurnEvidence(input.turnContext, captured.chatInput, captured.analysisBackground, captured.previousWorkingContext);
  return executeAssistantGroupTurn(input.turnContext, { chatInput: chatData, assistant: captured.assistant, contextAssistant: captured.contextAssistant, candidates: captured.candidates, analysisBackground: captured.analysisBackground, previousWorkingContext: captured.previousWorkingContext }, () => generateGroupContextReplyInternal(captured));
}
async function generateGroupContextReplyInternal(input: GroupContextReplyInput): Promise<ConversationReplyWithMemoryAssistant> {
  const turnContext = input.turnContext;
  const report = (detail: TurnDetailPatch) => {
    try { input.onTurnDetail?.(detail); } catch { /* Diagnostics never affect generation. */ }
  };
  if (!input.chatInput.groupChat) {
    // QQ private knowledge analysis and its SQL lookup are owned by the channel pipeline.
    // Do not mark those already-recorded stages as skipped here.
    report({ context: { status: "not_applicable" } });
    return generateConversationReplyWithMemoryAssistant(input);
  }
  if (!input.contextAssistant) {
    skipAssistantTurnStage(turnContext, "context", "not_enabled");
    skipAssistantTurnStage(turnContext, "knowledge", "not_needed");
    report({ context: { status: "not_enabled", durationMs: 0 }, knowledge: { status: "not_needed", durationMs: 0 } });
    return generateConversationReplyWithMemoryAssistant(input);
  }
  const record = async (entry: Parameters<typeof input.recordAssistantUsage>[0]) => {
    // 记账失败不能改变成功的分析或回复。
    await input.recordAssistantUsage(entry).catch(() => undefined);
  };
  const contextStartedAt = Date.now();
  let analysis: ContextAnalysis;
  try {
    const result = await runAssistantTurnStage(turnContext, "context", "group-context", { chatInput: input.chatInput, runtime: input.contextAssistant, background: input.analysisBackground, previous: input.previousWorkingContext }, observer => analyzeGroupContext(input.contextAssistant!, {
      ...input.chatInput,
      groupBackground: input.analysisBackground ?? input.chatInput.groupBackground,
    }, input.previousWorkingContext, observer));
    analysis = turnContext ? { ...result.analysis, evidenceMessageIds: result.analysis.evidenceMessageIds.filter(id => turnContext.hasEvidence(id)),
      ...(result.analysis.workingEvidenceMessageIds ? { workingEvidenceMessageIds: result.analysis.workingEvidenceMessageIds.filter(id => turnContext.hasEvidence(id)) } : {}),
      ...(result.analysis.knowledgeCandidate ? { knowledgeCandidate: { ...result.analysis.knowledgeCandidate, evidenceMessageIds: result.analysis.knowledgeCandidate.evidenceMessageIds.filter(id => turnContext.hasEvidence(id)) } } : {}),
    } : result.analysis;
    await record({ kind: "context-assistant", model: input.contextAssistant.model, usage: result.usage, status: "success" });
  } catch (error) {
    report({ context: { status: "failed", durationMs: Date.now() - contextStartedAt }, knowledge: { status: "not_needed", durationMs: 0 } });
    await record({
      kind: "context-assistant", model: input.contextAssistant.model,
      ...(error instanceof ContextAssistantError ? { usage: error.usage } : {}), status: "failed",
    });
    skipAssistantTurnStage(turnContext, "knowledge", "not_needed");
    return generateConversationReplyWithMemoryAssistant(input);
  }

  const evidenceIds = new Set(analysis.evidenceMessageIds);
  const currentSources = [
    ...(input.chatInput.transcript ?? []),
    ...input.chatInput.recentMessages,
    ...(input.analysisBackground ?? input.chatInput.groupBackground ?? []),
  ];
  // Validated carried originals remain available after they leave the recent window.
  // 不标 `typeof currentSources`：evidence 的来源形状与 transcript 不同（role / mentions 的有无），
  // 标了就要求两者是同一个联合成员，编译期直接拒掉 —— 下面只读 id/member/speaker/content 四个字段。
  const replySources = [...currentSources, ...(input.previousWorkingContext?.evidence ?? [])];
  if (analysis.workingEvidenceMessageIds?.length && input.onWorkingContext) {
    await input.onWorkingContext({ summary: analysis.workingSummary ?? "", evidenceMessageIds: analysis.workingEvidenceMessageIds }).catch(() => undefined);
  }
  const seenEvidence = new Set<string>();
  const evidence = replySources
    .filter(line => {
      if (!line.id || !evidenceIds.has(line.id) || seenEvidence.has(line.id)) return false;
      seenEvidence.add(line.id);
      return true;
    }).slice(0, 12).map(line => {
      // `member` 只在部分来源上存在（transcript 行没有），联合类型上不能直接读；
      // 这里只是给证据挑一个展示名，缺了退回 speaker 就够了。
      const member = "member" in line && typeof line.member === "string" ? line.member : undefined;
      return {
        id: line.id,
        ...(member ? { member } : {}),
        ...(line.speaker ? { speaker: line.speaker } : {}),
        content: line.content.slice(0, 600),
        ...(line.occurredAt ? { occurredAt: line.occurredAt } : {}),
      };
    });
  report({ context: { status: "success", durationMs: Date.now() - contextStartedAt, summary: analysis.summary, participation: analysis.participation,
    ...(analysis.uncertainty ? { uncertainty: analysis.uncertainty } : {}), evidence } });

  if (analysis.knowledgeCandidate && input.onKnowledgeCandidate) {
    const candidateIds = new Set(analysis.knowledgeCandidate.evidenceMessageIds);
    const seen = new Set<string>();
    const selected = automaticKnowledgeLines(currentSources)
      .filter(line => {
        if (!line.id || !candidateIds.has(line.id) || seen.has(line.id)) return false;
        seen.add(line.id);
        return true;
      }).slice(0, 4);
    const rawContent = selected.map(line => `[${line.speaker || line.member || "群聊"}] ${line.content.slice(0, 4_000)}`).join("\n").slice(0, 20_000);
    if (rawContent.trim()) {
      await input.onKnowledgeCandidate({
        rawContent,
        sourceMessageIds: selected.flatMap(line => line.id ? [line.id] : []),
        reason: analysis.knowledgeCandidate.reason,
        // 只是「谁在说话」的展示名，用来在候选列表里标来源；
        // 判定是不是知识来源必须用账号（见 knowledge-collect-policy），昵称不作数。
        speakers: [...new Set(selected.map(line => line.speaker || line.member).filter((name): name is string => Boolean(name)))],
      }).catch(() => undefined);
    }
  }

  let sources: MemoryAssistantCandidate[] = [];
  let memoryStatus: NonNullable<ConversationReplyInput["contextAnalysis"]>["memoryStatus"];
  const memoryStartedAt = Date.now();
  if (analysis.memoryQuery) {
    memoryStatus = "unavailable";
    if (input.assistant) {
      try {
        const result = await runAssistantTurnStage(turnContext, "memory", analysis.memoryQuery, { chatInput: input.chatInput, assistant: input.assistant, candidates: input.candidates, query: analysis.memoryQuery }, async observer => {
          // Recheck public scope even when a trusted loader accidentally returns private candidates.
          const candidates = (input.loadCandidates ? await input.loadCandidates(analysis.memoryQuery!) : input.candidates).filter(source => source.scope === "character");
          if (!candidates.length) return { sources: [] as MemoryAssistantCandidate[], status: "no_sources" as const };
          const selected = await callMemoryAssistant(input.assistant!, analysis.memoryQuery!, candidates, observer);
          const status = selected.sources.length ? "success" as const : "no_sources" as const;
          await record({ kind: "memory-assistant", model: input.assistant!.model, usage: selected.usage, status });
          return { sources: selected.sources, status };
        }, result => result.sources.length === 0);
        sources = [...result.sources]; memoryStatus = result.status;
      } catch (error) {
        memoryStatus = "failed";
        const usage = error !== null && typeof error === "object" && "usage" in error
          ? error.usage as ModelUsageTokens | undefined : undefined;
        await record({ kind: "memory-assistant", model: input.assistant.model, usage, status: "failed" });
      }
    }
  }

  // 与下方 report 用同一优先级：分析器没要求就是 not_needed，没配运行时才是 not_enabled。
  if (!analysis.memoryQuery || !input.assistant) skipAssistantTurnStage(turnContext, "memory", !analysis.memoryQuery ? "not_needed" : "not_enabled");
  report({ memory: { status: !analysis.memoryQuery ? "not_needed" : !input.assistant ? "not_enabled"
    : memoryStatus === "failed" ? "failed" : sources.length ? "success" : "no_sources",
    ...(analysis.memoryQuery ? { query: analysis.memoryQuery } : {}), sources: sources.map(memoryAssistantTurnSource),
    durationMs: Date.now() - memoryStartedAt } });

  let knowledgeItems: ConversationKnowledgeItem[] = [];
  let knowledgeStatus: NonNullable<ConversationReplyInput["contextAnalysis"]>["knowledgeStatus"];
  const knowledgeStartedAt = Date.now();
  if (analysis.knowledgeQuery) {
    knowledgeStatus = "unavailable";
    if (input.loadKnowledge) {
      try {
        knowledgeItems = await runAssistantTurnStage(turnContext, "knowledge", analysis.knowledgeQuery, { query: analysis.knowledgeQuery, chatInput: input.chatInput }, () => input.loadKnowledge!(analysis.knowledgeQuery!), items => items.length === 0);
        knowledgeStatus = knowledgeItems.length ? "success" : "no_sources";
      } catch {
        knowledgeStatus = "failed";
      }
    }
  }

  // 同上：没要求检索记 not_needed，只有能力未配置才记 not_enabled。
  if (!analysis.knowledgeQuery || !input.loadKnowledge) skipAssistantTurnStage(turnContext, "knowledge", !analysis.knowledgeQuery ? "not_needed" : "not_enabled");
  report({ knowledge: { status: !analysis.knowledgeQuery ? "not_needed" : !input.loadKnowledge ? "not_enabled"
    : knowledgeStatus === "failed" ? "failed" : knowledgeStatus === "no_sources" ? "no_sources" : "success",
    ...(analysis.knowledgeQuery ? { query: analysis.knowledgeQuery } : {}),
    durationMs: Date.now() - knowledgeStartedAt, itemCount: knowledgeItems.length } });
  const original = input.chatInput;
  // 大背景留给分析器，角色拿到本轮原话、被引用证据和少量最近互动。
  const recentMessages = original.recentMessages.slice(-6);
  const shownIds = new Set([...original.transcript ?? [], ...recentMessages].map(line => line.id));
  const background = replySources.flatMap(line => {
    if (!line.id || !evidenceIds.has(line.id) || shownIds.has(line.id)) return [];
    shownIds.add(line.id);
    return [{ ...line, content: line.content.slice(0, 600) }];
  });
  const unique = <T extends { id: string }>(base: T[], extra: T[]): T[] => {
    const ids = new Set(base.map(item => item.id));
    return [...base, ...extra.filter(item => !ids.has(item.id))];
  };
  const finalInput: ConversationReplyInput = {
    ...original,
    allowSilent: true,
    groupBackground: background,
    recentMessages,
    contextAnalysis: {
      summary: analysis.summary,
      evidenceMessageIds: analysis.evidenceMessageIds,
      participation: analysis.participation,
      ...(analysis.uncertainty ? { uncertainty: analysis.uncertainty } : {}),
      ...(memoryStatus ? { memoryStatus } : {}),
      ...(knowledgeStatus ? { knowledgeStatus } : {}),
    },
    // 本轮已由语境助手作出检索判断，禁止再次检索循环。
    memoryAssistantAvailable: false,
    memoryAssistantEvidenceProvided: sources.length > 0,
    knowledgeItems,
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
  };
  return runAssistantTurnStage(turnContext, "response", "group-final", finalInput, observer => generateConversationReply(finalInput, observer));
}
