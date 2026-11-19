import type { PrismaClient } from "../../src/generated/prisma/client";
import { buildSelfUnderstandingView, type SelfUnderstandingEvidence } from "./self-understanding";
import { validateExperienceReflectionRefs, type ExperienceReflectionRef } from "./experience-reflection";
import { validateReflectionSourceRefs } from "./reflection-worker";
import { readExperienceLearning } from "./interaction-experience-domain";
import { loadSelfUnderstandingHistory } from "./self-understanding-history";

/** Internal adapter: callers must resolve actor, character ownership and readable scopes first. */
export async function loadSelfUnderstanding(prisma: PrismaClient, input: {
  characterId: string; readableScopeIds: readonly string[]; conversationId?: string; groupChat: boolean;
  includeHistory?: boolean; profileOwner?: boolean; includeAllExpressionScenes?: boolean;
}) {
  const character = await prisma.character.findUniqueOrThrow({ where: { id: input.characterId }, select: { name: true, avatar: true } });
  const scopes = await prisma.memoryScope.findMany({ where: { characterId: input.characterId, id: { in: [...input.readableScopeIds] },
    ...(input.groupChat ? { scopeType: "CHARACTER_GLOBAL" } : {}) }, select: { id: true, scopeType: true } });
  const scopeIds = scopes.map(row => row.id), globalIds = new Set(scopes.filter(row => row.scopeType === "CHARACTER_GLOBAL").map(row => row.id));
  const room = !input.groupChat && input.conversationId ? await prisma.conversation.findFirst({ where: { id: input.conversationId,
    characterId: input.characterId, memoryScopeId: { in: scopeIds } }, select: { id: true, memoryScopeId: true } }) : null;
  const eventWhere = { memoryScopeId: { in: scopeIds }, status: "ACTIVE" as const,
    ...(input.groupChat ? { conversationId: { in: input.conversationId ? [input.conversationId] : [] } } : {}) };
  const [memories, events, earlyEvents, preferences, habits, goals, knowledge, relationships, reflections, experiences] = await Promise.all([
    prisma.memoryItem.findMany({ where: { memoryScopeId: { in: scopeIds }, status: "ACTIVE", deletedAt: null }, orderBy: [{ importance: "desc" }, { updatedAt: "desc" }], take: 6 }),
    prisma.memoryEvent.findMany({ where: eventWhere, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 4 }),
    input.includeHistory ? prisma.memoryEvent.findMany({ where: eventWhere, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 2 }) : Promise.resolve([]),
    prisma.characterPreference.findMany({ where: { characterId: input.characterId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 6 }),
    prisma.characterExpressionHabit.findMany({ where: { characterId: input.characterId, status: "ACTIVE", chatScope: { in: input.includeAllExpressionScenes && input.profileOwner && !input.groupChat ? ["ALL", "GROUP", "PRIVATE"] : ["ALL", input.groupChat ? "GROUP" : "PRIVATE"] },
      OR: [{ conversationId: null, memoryScopeId: null }, ...(room ? [{ conversationId: room.id, memoryScopeId: room.memoryScopeId }] : [])] }, orderBy: { updatedAt: "desc" }, take: 6 }),
    prisma.characterGoal.findMany({ where: { characterId: input.characterId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 6 }),
    prisma.knowledgeItem.findMany({ where: { characterId: input.characterId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 4 }),
    input.profileOwner && !input.groupChat ? prisma.memoryScope.findMany({ where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY", relationshipVersion: { gt: 0 }, interactionCount: { gt: 0 },
      friendChatPolicy: { not: "BLOCK" }, OR: [{ friendChatPolicy: "ALLOW" }, { externalIdentity: { is: { kind: { not: "AI" } } } }] },
      include: { externalIdentity: { select: { displayName: true } } }, orderBy: { lastInteractedAt: "desc" }, take: 6 }) : Promise.resolve([]),
    prisma.reflectionSuggestion.findMany({ where: { status: "ACCEPTED", run: { characterId: input.characterId,
      OR: [{ conversationId: null, memoryScopeId: null }, ...(room ? [{ conversationId: room.id, memoryScopeId: room.memoryScopeId }] : [])] } },
      include: { run: { select: { conversationId: true, memoryScopeId: true } } }, orderBy: { acceptedAt: "desc" }, take: 4 }),
    room ? prisma.interactionExperience.findMany({ where: { characterId: input.characterId, conversationId: room.id, memoryScopeId: room.memoryScopeId, status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 3 }) : Promise.resolve([]),
  ]);
  const evidence: SelfUnderstandingEvidence[] = [];
  const origin = (scopeId: string) => globalIds.has(scopeId) ? "character" as const : "private" as const;
  const appendMemory = (row: typeof memories[number]) => evidence.push({ domain: "memory", id: row.id, text: row.content, state: "ACTIVE", scope: origin(row.memoryScopeId), confidence: row.confidence, updatedAt: row.updatedAt.toISOString() });
  const appendEpisode = (row: typeof events[number]) => evidence.push({ domain: "memory", id: row.id, text: `${row.title}: ${row.detail}`, context: row.sourceMessageId ? "经历摘要，留有原文指针" : "经历摘要，本条未保留原文指针", occurredAt: row.occurredAt.toISOString(), state: "ACTIVE", scope: origin(row.memoryScopeId), confidence: row.confidence, updatedAt: row.createdAt.toISOString() });
  // Retrospectives give both ends of the observable timeline a place before
  // general memories consume the shared prompt budget. Sampling does not rank significance.
  if (input.includeHistory) {
    for (let i = 0; i < events.length; i++) {
      if (earlyEvents[i]) appendEpisode(earlyEvents[i]!);
      appendEpisode(events[i]!);
    }
    for (const row of memories) appendMemory(row);
  } else {
    for (const row of memories) appendMemory(row);
    for (const row of events) appendEpisode(row);
  }
  for (const row of preferences) evidence.push({ domain: "preferences", id: row.id, text: `${row.kind}: ${row.topic}`, state: "ACTIVE", scope: "character", revision: row.revision, updatedAt: row.updatedAt.toISOString() });
  for (const row of habits) {
    if (row.sourceType === "EXPERIENCE_REFLECT" && (!room || !await prisma.$transaction(tx => validateExperienceReflectionRefs(tx, input.characterId, row.sourceRefs as unknown as ExperienceReflectionRef[], { conversationId: room.id, memoryScopeId: room.memoryScopeId })))) continue;
    evidence.push({ domain: "language", id: row.id, text: row.content, context: input.includeAllExpressionScenes && input.profileOwner && !input.groupChat
        ? [row.chatScope === "GROUP" ? "适用场景：群聊" : row.chatScope === "PRIVATE" ? "适用场景：私聊" : "适用场景：通用", row.context].filter(Boolean).join(" · ")
        : row.context, state: "ACTIVE", scope: row.conversationId ? "private" : "character",
      ...(row.conversationId ? { conversationId: row.conversationId } : {}), revision: row.revision, updatedAt: row.updatedAt.toISOString() });
  }
  for (const row of goals) evidence.push({ domain: "goals", id: row.id, text: `${row.title}: ${row.description}`, state: "ACTIVE", scope: "character", revision: row.revision, updatedAt: row.updatedAt.toISOString() });
  for (const row of knowledge) evidence.push({ domain: "knowledge", id: row.id, text: `${row.title}: ${row.content}`, state: "ACTIVE", scope: "character", revision: row.revision, updatedAt: row.updatedAt.toISOString(), confidence: row.confidence, context: "已学知识，不是人格特征" });
  for (const row of relationships) if (row.externalIdentity?.displayName) evidence.push({ domain: "social", id: row.id,
    text: `${row.externalIdentity.displayName}: ${row.relationshipStage}, ${row.relationshipStatus}`, state: "ACTIVE", scope: "character", revision: row.relationshipVersion, updatedAt: row.updatedAt.toISOString() });
  for (const row of reflections) {
    const refs = Array.isArray(row.sourceRefs) ? row.sourceRefs : [];
    const valid = row.run.conversationId && room
      ? await prisma.$transaction(tx => validateExperienceReflectionRefs(tx, input.characterId, refs as unknown as ExperienceReflectionRef[], { conversationId: room.id, memoryScopeId: room.memoryScopeId }))
      : !refs.some(ref => ref && typeof ref === "object" && "type" in ref && ref.type === "experience")
        && await prisma.$transaction(tx => validateReflectionSourceRefs(tx, input.characterId, refs));
    if (!valid || !refs.length) continue;
    // Reserve space for all three semantic layers. A long observation must not clip away its correction.
    evidence.push({ domain: "reflection", id: row.id, text: `观察: ${row.observation.slice(0, 70)}; 暂时推断: ${row.inference.slice(0, 60)}; 建议: ${row.recommendation.slice(0, 85)}`, state: "ACCEPTED",
      excerptTruncated: row.observation.length > 70 || row.inference.length > 60 || row.recommendation.length > 85,
      context: "已采纳的解释；保留观察对象及原情境，不是当前能力或永久身份的证明",
      scope: row.run.conversationId ? "private" : "character", ...(row.run.conversationId ? { conversationId: row.run.conversationId } : {}), updatedAt: row.updatedAt.toISOString() });
  }
  for (const row of experiences) {
    const learning = readExperienceLearning(row.learning);
    evidence.push({ domain: "experience", id: row.id,
      ...(learning ? { subject: "current_character_response" as const } : {}),
      text: learning ? `用户纠正: ${learning.correction.slice(0, 100)}; 下次判断: ${learning.nextJudgment.slice(0, 100)}` : row.content,
      excerptTruncated: Boolean(learning && (learning.correction.length > 100 || learning.nextJudgment.length > 100)),
      context: row.context, state: "ACTIVE", scope: "private", conversationId: row.conversationId,
      revision: row.revision, updatedAt: row.updatedAt.toISOString() });
  }
  const view = buildSelfUnderstandingView({ name: character.name, avatar: character.avatar ?? undefined, groupChat: input.groupChat, conversationId: room?.id, evidence, scopedMemoryReadSucceeded: scopeIds.length > 0 });
  if (!input.includeHistory) return view;
  try {
    const history = await loadSelfUnderstandingHistory(prisma, { characterId: input.characterId, current: view.evidence, groupChat: input.groupChat, includeAllExpressionScenes: input.profileOwner && input.includeAllExpressionScenes });
    return { ...view, history };
  } catch {
    // A history query failure is not a successful empty comparison. Keep the
    // independently read current evidence available for this reply.
    console.warn("[self-understanding] historical comparison unavailable");
    return view;
  }
}
