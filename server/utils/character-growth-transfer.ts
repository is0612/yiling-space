import { randomUUID, createHash } from "node:crypto";
import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";
import { emptyCharacterGrowthBundle, parseCharacterGrowthBundle, parseGrowthMetadata, growthCounts, type CharacterGrowthBundle, type CharacterGrowthTable } from "./character-growth-portable";

const domains: Record<CharacterGrowthTable, string> = { knowledgeCandidates: "knowledgeCandidate", knowledgeItems: "knowledgeItem", knowledgeRevisions: "knowledgeItemRevision", knowledgeRelations: "knowledgeItemRelation", socialRelationships: "socialRelationship", socialExperiences: "socialExperience", socialAssessments: "socialRelationshipAssessment", socialReviews: "socialRelationshipAssessmentReview", socialChanges: "socialRelationChange", socialChangeEvidence: "socialRelationChangeEvidence", socialAssessmentEvidence: "socialRelationshipAssessmentEvidence", reflectionRuns: "reflectionRun", reflectionSuggestions: "reflectionSuggestion", growthEvents: "growthEvent", growthDeliveries: "growthEventDelivery" };
// Dynamic delegate access is confined to this fixed table whitelist.
type Delegate = { findMany(args: unknown): Promise<any[]>; createMany(args: unknown): Promise<{ count: number }> };
function delegate(db: DB, table: CharacterGrowthTable): Delegate { return (db as unknown as Record<string, Delegate>)[domains[table]]!; }
function metadata(value: unknown) { try { return parseGrowthMetadata(value ?? null, "growth"); } catch { return null; } }
function portable(row: Row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, iso(value)])); }
function pick(row: Row, names: string[]) { return Object.fromEntries(names.map(key => [key, row[key] ?? null])); }

type DB = PrismaClient | Prisma.TransactionClient;
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const hash = (title: string, content: string) => createHash("sha256").update(JSON.stringify([title, content])).digest("hex");
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const stamp = (value: unknown) => value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const fields = (names: string[]) => Object.fromEntries(names.map(key => [key, true]));
const candidateFields = ["id", "sourceType", "sourceRef", "rawContent", "status", "processedResult", "processedAt", "createdAt", "updatedAt"];
const itemFields = ["id", "candidateId", "title", "content", "category", "tags", "confidence", "status", "sourceType", "sourceRef", "revision", "createdAt", "updatedAt"];
const revisionFields = ["id", "itemId", "revision", "title", "content", "category", "tags", "confidence", "status", "sourceType", "sourceRef", "action", "createdAt"];
const relationFields = ["id", "sourceItemId", "targetItemId", "relationType", "status", "resolution", "createdAt", "updatedAt", "resolvedAt"];
const assessmentFields = ["id", "scopeId", "generation", "triggerReasons", "evaluatedStage", "evaluatedStatus", "relationshipVersion", "outcome", "suggestedStage", "suggestedStatus", "reason", "observations", "confidence", "modelProvider", "modelName", "promptVersion", "inputCutoffAt", "status", "reviewStatus", "reviewedAt", "startedAt", "completedAt", "createdAt"];
const runFields = ["id", "requestKey", "periodStart", "periodEnd", "status", "attemptCount", "maxAttempts", "runAt", "model", "promptVersion", "completedAt", "createdAt", "updatedAt"];
const suggestionFields = ["id", "runId", "title", "observation", "inference", "recommendation", "sourceRefs", "status", "reviewNote", "reviewedAt", "acceptedAt", "createdAt", "updatedAt"];
const eventFields = ["id", "sourceDomain", "eventType", "schemaVersion", "aggregateType", "aggregateId", "occurredAt", "payload", "createdAt"];
const deliveryFields = ["id", "eventId", "consumerKey", "status", "attemptCount", "maxAttempts", "runAt", "processedAt", "createdAt", "updatedAt"];

async function own(db: DB, characterId: string, ownerId: string) {
  const character = await db.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}

export async function loadCharacterGrowth(input: { prisma?: DB; characterId: string; ownerId: string; includeFriends: boolean; eventIds?: ReadonlySet<string>; snapshotIds?: ReadonlySet<string>; friends?: Array<{ platform: string; platformUid: string }> }): Promise<CharacterGrowthBundle> {
  const db = input.prisma ?? getPrisma(); const { characterId, ownerId } = input;
  await own(db, characterId, ownerId);
  const bundle = emptyCharacterGrowthBundle(); const t = bundle.tables;
  const warnings = new Set<string>();
  warnings.add("聊天原文、CHAT来源知识、执行租约和验证身份绑定不包含在成长迁移中。");
  if (!input.includeFriends) warnings.add("分享导出不含朋友社交历史，无法证明当前公开有效来源的反思建议会跳过。");
  const ledger = await db.characterGrowthImportIdentity.findMany({ where: { characterId }, select: { domain: true, originId: true, localId: true } });
  const origins = new Map(ledger.map(row => [`${row.domain}:${row.localId}`, row.originId]));
  const origin = (table: CharacterGrowthTable, id: string) => origins.get(`${domains[table]}:${id}`) ?? id;
  const events = await db.memoryEvent.findMany({ where: { status: "ACTIVE", memoryScope: { characterId, scopeType: "CHARACTER_GLOBAL" } }, select: { id: true, originId: true, title: true, detail: true } });
  const eventMap = new Map(events.filter(row => !input.eventIds || input.eventIds.has(row.originId ?? row.id)).map(row => [row.id, row]));
  const snapshots = await db.memorySnapshot.findMany({ where: { status: "CURRENT", memoryScope: { characterId, scopeType: "CHARACTER_GLOBAL" } }, select: { id: true, originId: true, periodStart: true, periodEnd: true, summary: true } });
  const snapshotMap = new Map(snapshots.filter(row => !input.snapshotIds || input.snapshotIds.has(row.originId ?? row.id)).map(row => [row.id, row]));
  function provenance(type: unknown, value: unknown): unknown | undefined {
    const ref = object(value);
    if (type === "MANUAL" || type === "IMPORT") {
      if (ref.scope && !["character", "CHARACTER_GLOBAL"].includes(String(ref.scope))) return undefined;
      return metadata(Object.fromEntries(["url", "title", "source", "scope"].filter(key => ref[key] !== undefined).map(key => [key, ref[key]])));
    }
    if (type !== "MEMORY_EVENT") return undefined;
    const event = eventMap.get(String(ref.memoryEventId ?? ref.eventId));
    if (!event || ref.sourceHash !== hash(event.title, event.detail)) return undefined;
    return { kind: "MEMORY_EVENT", memoryEventId: event.originId ?? event.id, sourceHash: ref.sourceHash, scope: "CHARACTER_GLOBAL" };
  }
  const candidates = await delegate(db, "knowledgeCandidates").findMany({ where: { characterId, sourceType: { in: ["MANUAL", "IMPORT", "MEMORY_EVENT"] } }, select: fields(candidateFields), orderBy: { id: "asc" } });
  for (const row of candidates) {
    const sourceRef = provenance(row.sourceType, row.sourceRef); if (sourceRef === undefined) continue;
    t.knowledgeCandidates.push(portable({ ...row, id: origin("knowledgeCandidates", row.id), sourceRef, processedResult: row.processedResult ? metadata(pick(object(row.processedResult), ["title", "content", "category", "tags", "confidence", "reason", "isKnowledge"])) : null, processingError: null }) as never);
  }
  const candidateIds = new Set(t.knowledgeCandidates.map(row => row.id));
  const items = await delegate(db, "knowledgeItems").findMany({ where: { characterId, sourceType: { in: ["MANUAL", "IMPORT", "MEMORY_EVENT"] } }, select: fields(itemFields), orderBy: { id: "asc" } });
  for (const row of items) {
    const sourceRef = provenance(row.sourceType, row.sourceRef); if (sourceRef === undefined) continue;
    const candidateId = row.candidateId ? origin("knowledgeCandidates", row.candidateId) : null;
    t.knowledgeItems.push(portable({ ...row, id: origin("knowledgeItems", row.id), candidateId: candidateId && candidateIds.has(candidateId) ? candidateId : null, sourceRef }) as never);
  }
  const allowedItems = items.filter(row => t.knowledgeItems.some(item => item.id === origin("knowledgeItems", row.id)));
  const itemIds = allowedItems.map(row => row.id);
  const revisions = await delegate(db, "knowledgeRevisions").findMany({ where: { itemId: { in: itemIds }, item: { characterId }, sourceType: { in: ["MANUAL", "IMPORT", "MEMORY_EVENT"] } }, select: fields(revisionFields) });
  for (const row of revisions) { const sourceRef = provenance(row.sourceType, row.sourceRef); if (sourceRef !== undefined) t.knowledgeRevisions.push(portable({ ...row, id: origin("knowledgeRevisions", row.id), itemId: origin("knowledgeItems", row.itemId), sourceRef }) as never); }
  const relations = await delegate(db, "knowledgeRelations").findMany({ where: { characterId, sourceItemId: { in: itemIds }, targetItemId: { in: itemIds } }, select: fields(relationFields) });
  for (const row of relations) t.knowledgeRelations.push(portable({ ...row, id: origin("knowledgeRelations", row.id), sourceItemId: origin("knowledgeItems", row.sourceItemId), targetItemId: origin("knowledgeItems", row.targetItemId), metadata: null }) as never);
  if (input.includeFriends) {
    const scopes = await db.memoryScope.findMany({ where: { characterId, scopeType: "EXTERNAL_IDENTITY", interactionCount: { gt: 0 }, externalIdentityId: { not: null } }, take: 500, orderBy: [{ lastInteractedAt: "desc" }, { createdAt: "desc" }], select: { id: true, relationshipStage: true, relationshipStatus: true, relationshipVersion: true, relationshipUpdatedAt: true, externalIdentity: { select: { platform: true, platformUid: true } } } });
    const eligibleScopes = scopes.filter(row => row.externalIdentity && (!input.friends || input.friends.some(friend => friend.platform === row.externalIdentity!.platform && friend.platformUid === row.externalIdentity!.platformUid)));
    for (const row of eligibleScopes) if (row.externalIdentity) t.socialRelationships.push(portable({ ...pick(row as unknown as Row, ["relationshipStage", "relationshipStatus", "relationshipVersion", "relationshipUpdatedAt"]), id: origin("socialRelationships", row.id), ...row.externalIdentity }) as never);
    const scopeIds = eligibleScopes.map(row => row.id);
    const exps = await delegate(db, "socialExperiences").findMany({ where: { scopeId: { in: scopeIds }, scope: { characterId }, memoryEventId: { in: [...eventMap.keys()] } }, select: fields(["id", "scopeId", "memoryEventId", "sourceKey", "createdAt"]) });
    for (const row of exps) t.socialExperiences.push(portable({ ...row, id: origin("socialExperiences", row.id), scopeId: origin("socialRelationships", row.scopeId), memoryEventId: eventMap.get(row.memoryEventId)!.originId ?? row.memoryEventId }) as never);
    const assessments = await delegate(db, "socialAssessments").findMany({ where: { scopeId: { in: scopeIds }, scope: { characterId } }, select: fields(assessmentFields) });
    for (const row of assessments) t.socialAssessments.push(portable({ ...row, id: origin("socialAssessments", row.id), scopeId: origin("socialRelationships", row.scopeId), observations: Array.isArray(row.observations) ? metadata(row.observations) : metadata({ observations: strings(object(row.observations).observations) }), status: row.status === "RUNNING" ? "FAILED" : row.status, error: row.status === "RUNNING" ? "导出时未完成，仅保留历史。" : null }) as never);
    const assessmentIds = assessments.map(row => row.id);
    const reviews = await delegate(db, "socialReviews").findMany({ where: { assessmentId: { in: assessmentIds }, assessment: { scope: { characterId } } }, select: fields(["id", "assessmentId", "decision", "note", "createdAt"]) });
    for (const row of reviews) t.socialReviews.push(portable({ ...row, id: origin("socialReviews", row.id), assessmentId: origin("socialAssessments", row.assessmentId) }) as never);
    const changes = await delegate(db, "socialChanges").findMany({ where: { scopeId: { in: scopeIds }, scope: { characterId } }, select: fields(["id", "scopeId", "fromStage", "toStage", "fromStatus", "toStatus", "relationshipVersionBefore", "relationshipVersionAfter", "assessmentId", "reason", "createdAt"]) });
    for (const row of changes) t.socialChanges.push(portable({ ...row, id: origin("socialChanges", row.id), scopeId: origin("socialRelationships", row.scopeId), assessmentId: assessmentIds.includes(row.assessmentId) ? origin("socialAssessments", row.assessmentId) : null }) as never);
    const changeEvidence = await delegate(db, "socialChangeEvidence").findMany({ where: { changeId: { in: changes.map(row => row.id) }, experienceId: { in: exps.map(row => row.id) } }, select: fields(["id", "changeId", "experienceId"]) });
    for (const row of changeEvidence) t.socialChangeEvidence.push({ ...row, id: origin("socialChangeEvidence", row.id), changeId: origin("socialChanges", row.changeId), experienceId: origin("socialExperiences", row.experienceId) } as never);
    const evidence = await delegate(db, "socialAssessmentEvidence").findMany({ where: { assessmentId: { in: assessmentIds }, experienceId: { in: exps.map(row => row.id) }, scopeId: { in: scopeIds } }, select: fields(["id", "assessmentId", "experienceId", "scopeId", "kind", "createdAt"]) });
    for (const row of evidence) t.socialAssessmentEvidence.push(portable({ ...row, id: origin("socialAssessmentEvidence", row.id), assessmentId: origin("socialAssessments", row.assessmentId), experienceId: origin("socialExperiences", row.experienceId), scopeId: origin("socialRelationships", row.scopeId) }) as never);
  }
  // Card v5 has no conversation mapping: exporting a scoped run would silently globalize it.
  const runs = await delegate(db, "reflectionRuns").findMany({ where: { characterId, conversationId: null, memoryScopeId: null }, select: fields(runFields) });
  for (const row of runs) t.reflectionRuns.push(portable({ ...pick(row, runFields.filter(key => !["requestKey", "runAt"].includes(key))), id: origin("reflectionRuns", row.id), status: ["QUEUED", "RUNNING"].includes(row.status) ? "FAILED" : row.status, lastError: ["QUEUED", "RUNNING"].includes(row.status) ? "导出时未完成，仅保留历史。" : null, sourcesHash: null }) as never);
  const suggestions = await delegate(db, "reflectionSuggestions").findMany({ where: { runId: { in: runs.map(row => row.id) }, run: { characterId, conversationId: null, memoryScopeId: null } }, select: fields(suggestionFields) });
  for (const row of suggestions) {
    const refs = Array.isArray(row.sourceRefs) ? row.sourceRefs.map((value: unknown) => {
      const ref = object(value); let id: string | undefined;
      if (ref.valid === false) return { ...pick(ref, ["type", "hash", "title", "excerpt", "id", "key"]), valid: false };
      if (ref.type === "memory") { const e = eventMap.get(String(ref.id)); if (e && ref.hash === hash(e.title, e.detail)) id = e.originId ?? e.id; }
      if (ref.type === "snapshot") { const s = snapshotMap.get(String(ref.id)); if (s && ref.hash === hash(`阶段总结 ${s.periodStart.toISOString()} — ${s.periodEnd.toISOString()}`, s.summary)) id = s.originId ?? s.id; }
      if (ref.type === "knowledge") { const k = allowedItems.find(item => item.id === ref.id); if (k && ref.hash === hash(k.title, k.content)) id = origin("knowledgeItems", k.id); }
      return id ? { ...pick(ref, ["type", "hash", "title", "excerpt"]), id, key: `${ref.type}:${id}` } : { ...pick(ref, ["type", "hash", "title", "excerpt"]), id: String(ref.id), key: `${ref.type}:${ref.id}`, valid: false };
    }) : [];
    if (refs.some((ref: unknown) => object(ref).valid === false)) warnings.add(input.includeFriends ? "部分反思来源失效，保留为不可用证据的历史引用。" : "部分反思建议来源无法证明公开有效，已从分享导出中排除。");
    if (refs.length && (input.includeFriends || refs.every((ref: unknown) => object(ref).valid !== false))) t.reflectionSuggestions.push(portable({ ...row, id: origin("reflectionSuggestions", row.id), runId: origin("reflectionRuns", row.runId), sourceRefs: refs }) as never);
  }
  const aggregateTables: Record<string, CharacterGrowthTable> = { KnowledgeItem: "knowledgeItems", KnowledgeCandidate: "knowledgeCandidates", SocialExperience: "socialExperiences", SocialRelationshipAssessment: "socialAssessments", ReflectionRun: "reflectionRuns", ReflectionSuggestion: "reflectionSuggestions" };
  const growthEvents = await delegate(db, "growthEvents").findMany({ where: { characterId }, select: fields(eventFields) });
  for (const row of growthEvents) {
    const table = aggregateTables[row.aggregateType]; let id: string | undefined;
    if (table) { const mapped = origin(table, row.aggregateId); if (t[table].some(item => item.id === mapped)) id = mapped; }
    if (row.aggregateType === "MemoryEvent") { const e = eventMap.get(row.aggregateId); if (e) id = e.originId ?? e.id; }
    if (!id) { warnings.add("部分成长事件缺少可迁移的聚合来源，未导出其事件和投递历史。"); continue; }
    const payload: Row = {}; const raw = object(row.payload);
    if (raw.sourceId === row.aggregateId) payload.sourceId = id;
    if (raw.sourceType === row.aggregateType) payload.sourceType = row.aggregateType;
    if (["DRAFT", "FINAL"].includes(String(raw.state))) payload.state = raw.state;
    t.growthEvents.push(portable({ ...row, id: origin("growthEvents", row.id), aggregateId: id, payload }) as never);
  }
  const exportedEvents = new Set(t.growthEvents.map(row => row.id));
  const deliveries = await delegate(db, "growthDeliveries").findMany({ where: { event: { characterId } }, select: fields(deliveryFields) });
  for (const row of deliveries) { const eventId = origin("growthEvents", row.eventId); if (exportedEvents.has(eventId)) t.growthDeliveries.push(portable({ ...pick(row, deliveryFields.filter(key => key !== "runAt")), id: origin("growthDeliveries", row.id), eventId, status: ["QUEUED", "RUNNING", "RETRY_WAIT"].includes(row.status) ? "SKIPPED" : row.status, lastError: null }) as never); }
  bundle.warnings = [...warnings];
  return parseCharacterGrowthBundle(bundle);
}

export async function importCharacterGrowth(tx: Prisma.TransactionClient, input: { characterId: string; ownerId: string; bundle: CharacterGrowthBundle; includeFriends?: boolean; mode?: "new" | "merge"; friends?: Array<{ platform: string; platformUid: string }>; importedFriends?: Array<{ platform: string; platformUid: string }>; [key: string]: unknown }) {
  await own(tx, input.characterId, input.ownerId);
  const bundle = parseCharacterGrowthBundle(input.bundle); const t = bundle.tables;
  const added = growthCounts(emptyCharacterGrowthBundle()); const warnings: string[] = [...(bundle.warnings ?? [])];
  // Serialize merge/import of a role. The parent already owns this transaction.
  await tx.$queryRaw`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`;
  const maps = new Map<CharacterGrowthTable, Map<string, string>>();
  for (const table of Object.keys(t) as CharacterGrowthTable[]) maps.set(table, new Map());
  async function identity(table: CharacterGrowthTable, originId: string, localId?: string) {
    const key = { characterId: input.characterId, domain: domains[table], originId };
    const old = await tx.characterGrowthImportIdentity.findUnique({ where: { characterId_domain_originId: key } });
    if (old && ["reflectionRuns", "reflectionSuggestions"].includes(table)) {
      const globalWhere = table === "reflectionRuns"
        ? { characterId: input.characterId, conversationId: null, memoryScopeId: null }
        : { run: { characterId: input.characterId, conversationId: null, memoryScopeId: null } };
      const existing = await delegate(tx, table).findMany({ where: { id: old.localId }, select: { id: true }, take: 1 });
      const global = await delegate(tx, table).findMany({ where: { id: old.localId, ...globalWhere }, select: { id: true }, take: 1 });
      if (existing.length && !global.length) throw createError({ statusCode: 409, statusMessage: "角色卡反思映射已失效或指向私人范围，不能作为全局内容导入。" });
    }
    const nativeWhere: Record<string, unknown> = table === "reflectionRuns" ? { characterId: input.characterId, conversationId: null, memoryScopeId: null } : table === "reflectionSuggestions" ? { run: { characterId: input.characterId, conversationId: null, memoryScopeId: null } } : table.startsWith("knowledge") && !["knowledgeRevisions"].includes(table) || table === "growthEvents" ? { characterId: input.characterId } : table === "knowledgeRevisions" ? { item: { characterId: input.characterId } } : table === "growthDeliveries" ? { event: { characterId: input.characterId } } : ["socialExperiences", "socialAssessments", "socialChanges"].includes(table) ? { scope: { characterId: input.characterId } } : table === "socialReviews" || table === "socialAssessmentEvidence" ? { assessment: { scope: { characterId: input.characterId } } } : table === "socialChangeEvidence" ? { change: { scope: { characterId: input.characterId } } } : {};
    const native = !old && table !== "socialRelationships" ? (await delegate(tx, table).findMany({ where: { id: originId, ...nativeWhere }, select: { id: true }, take: 1 }))[0] : undefined;
    const id = old?.localId ?? localId ?? native?.id ?? randomUUID();
    if (!old) await tx.characterGrowthImportIdentity.create({ data: { ...key, localId: id } });
    maps.get(table)!.set(originId, id); return id;
  }
  const mapped = (table: CharacterGrowthTable, id: unknown) => typeof id === "string" ? maps.get(table)!.get(id) : undefined;
  const scopes = await tx.memoryScope.findMany({ where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY", externalIdentityId: { not: null } }, select: { id: true, externalIdentity: { select: { platform: true, platformUid: true } } } });
  const importedFriends = input.importedFriends ?? input.friends;
  const friendKeys = importedFriends ? new Set(importedFriends.map(friend => `${friend.platform}:${friend.platformUid}`)) : null;
  if (input.includeFriends !== false) for (const row of t.socialRelationships) {
    const scope = scopes.find(scope => scope.externalIdentity?.platform === row.platform && scope.externalIdentity.platformUid === row.platformUid);
    if (!scope || friendKeys && !friendKeys.has(`${row.platform}:${row.platformUid}`)) { warnings.push("部分社交历史未找到已导入朋友，已跳过。"); continue; }
    const existingIdentity = await tx.characterGrowthImportIdentity.findUnique({ where: { characterId_domain_originId: { characterId: input.characterId, domain: domains.socialRelationships, originId: row.id } } });
    await identity("socialRelationships", row.id, scope.id);
    const current = await tx.memoryScope.findUniqueOrThrow({ where: { id: scope.id }, select: { relationshipVersion: true, relationshipUpdatedAt: true } });
    const date = stamp(row.relationshipUpdatedAt);
    if (input.mode !== "merge" && (!current.relationshipUpdatedAt || date && date >= current.relationshipUpdatedAt)) await tx.memoryScope.update({ where: { id: scope.id }, data: { relationshipStage: row.relationshipStage, relationshipStatus: row.relationshipStatus, relationshipVersion: Math.max(row.relationshipVersion, current.relationshipVersion), relationshipUpdatedAt: date } });
    if (!existingIdentity) added.socialRelationships += 1;
  }
  const events = await tx.memoryEvent.findMany({ where: { status: "ACTIVE", memoryScope: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" } }, select: { id: true, originId: true, title: true, detail: true } });
  const memories = new Map(events.flatMap(row => [[row.originId ?? row.id, row], [row.id, row]] as const));
  const snapshots = await tx.memorySnapshot.findMany({ where: { status: "CURRENT", memoryScope: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" } }, select: { id: true, originId: true, periodStart: true, periodEnd: true, summary: true } });
  const snapshotMap = new Map(snapshots.flatMap(row => [[row.originId ?? row.id, row], [row.id, row]] as const));
  function sourceRef(type: string, value: unknown) {
    const ref = object(value);
    if (type === "MANUAL" || type === "IMPORT") return metadata(Object.fromEntries(["url", "title", "source", "scope"].filter(key => ref[key] !== undefined).map(key => [key, ref[key]])));
    const e = memories.get(String(ref.memoryEventId ?? ref.eventId));
    if (!e || ref.sourceHash !== hash(e.title, e.detail)) return undefined;
    return { kind: "MEMORY_EVENT", memoryEventId: e.id, sourceHash: hash(e.title, e.detail), scope: "CHARACTER_GLOBAL" };
  }
  async function insert(table: CharacterGrowthTable, row: Row, extra: Row = {}) {
    const id = await identity(table, String(row.id));
    const data: Row = { ...row, ...extra, id };
    for (const key of Object.keys(data)) if (/At$/.test(key) || ["periodStart", "periodEnd"].includes(key)) data[key] = data[key] === null ? null : stamp(data[key]);
    for (const key of ["sourceRef", "processedResult", "metadata", "observations", "sourceRefs", "payload"]) if (key in data) data[key] = data[key] === null ? Prisma.DbNull : json(data[key]);
    const result = await delegate(tx, table).createMany({ data: [data], skipDuplicates: true });
    added[table] += result.count;
    return id;
  }
  for (const row of t.knowledgeCandidates) {
    const ref = sourceRef(row.sourceType, row.sourceRef); if (ref === undefined) { warnings.push("部分忆泡知识来源已失效，已跳过。"); continue; }
    await insert("knowledgeCandidates", row, { characterId: input.characterId, sourceRef: ref, processingError: null });
  }
  for (const row of t.knowledgeItems) {
    const ref = sourceRef(row.sourceType, row.sourceRef); if (ref === undefined) continue;
    await insert("knowledgeItems", row, { characterId: input.characterId, candidateId: mapped("knowledgeCandidates", row.candidateId) ?? null, sourceRef: ref });
  }
  for (const row of t.knowledgeRevisions) { const itemId = mapped("knowledgeItems", row.itemId); const ref = sourceRef(row.sourceType, row.sourceRef); if (itemId && ref !== undefined) await insert("knowledgeRevisions", row, { itemId, sourceRef: ref }); }
  for (const row of t.knowledgeRelations) {
    let sourceItemId = mapped("knowledgeItems", row.sourceItemId); let targetItemId = mapped("knowledgeItems", row.targetItemId);
    if (!sourceItemId || !targetItemId) continue;
    if (row.relationType !== "MERGED_INTO" && sourceItemId > targetItemId) [sourceItemId, targetItemId] = [targetItemId, sourceItemId];
    await insert("knowledgeRelations", row, { characterId: input.characterId, sourceItemId, targetItemId, metadata: null });
  }
  if (input.includeFriends !== false) {
    for (const row of t.socialExperiences) {
      const scopeId = mapped("socialRelationships", row.scopeId); const e = memories.get(row.memoryEventId);
      if (scopeId && e) await insert("socialExperiences", row, { scopeId, memoryEventId: e.id, assessmentDispatchStatus: "QUEUED" });
    }
    for (const row of t.socialAssessments) {
      const scopeId = mapped("socialRelationships", row.scopeId); if (!scopeId) continue;
      await insert("socialAssessments", row, { observations: Array.isArray(row.observations) ? metadata(row.observations) : metadata({ observations: strings(object(row.observations).observations) }), scopeId, reviewedByUserId: row.reviewedAt ? input.ownerId : null, status: row.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED" });
    }
    for (const row of t.socialReviews) { const assessmentId = mapped("socialAssessments", row.assessmentId); if (assessmentId) await insert("socialReviews", row, { assessmentId, reviewerUserId: input.ownerId }); }
    for (const row of t.socialChanges) { const scopeId = mapped("socialRelationships", row.scopeId); if (scopeId) await insert("socialChanges", row, { scopeId, assessmentId: mapped("socialAssessments", row.assessmentId) ?? null, idempotencyKey: `import:${await identity("socialChanges", row.id)}` }); }
    for (const row of t.socialChangeEvidence) { const changeId = mapped("socialChanges", row.changeId); const experienceId = mapped("socialExperiences", row.experienceId); if (changeId && experienceId) await insert("socialChangeEvidence", row, { changeId, experienceId }); }
    for (const row of t.socialAssessmentEvidence) { const assessmentId = mapped("socialAssessments", row.assessmentId); const experienceId = mapped("socialExperiences", row.experienceId); const scopeId = mapped("socialRelationships", row.scopeId); if (assessmentId && experienceId && scopeId) await insert("socialAssessmentEvidence", row, { assessmentId, experienceId, scopeId }); }
  }
  for (const row of t.reflectionRuns) await insert("reflectionRuns", row, { characterId: input.characterId, conversationId: null, memoryScopeId: null, requestKey: await identity("reflectionRuns", row.id), status: row.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", sourcesHash: null, runAt: stamp(row.createdAt) });
  const knowledge = await tx.knowledgeItem.findMany({ where: { characterId: input.characterId, id: { in: [...maps.get("knowledgeItems")!.values()] } }, select: { id: true, title: true, content: true, status: true, sourceType: true } });
  for (const row of t.reflectionSuggestions) {
    const runId = mapped("reflectionRuns", row.runId); if (!runId) continue;
    const refs = row.sourceRefs.map(ref => {
      let id: string | undefined; let title: string | undefined; let content: string | undefined;
      if (ref.type === "memory") { const e = memories.get(ref.id); if (e) { id = e.id; title = e.title; content = e.detail; } }
      if (ref.type === "snapshot") { const s = snapshotMap.get(ref.id); if (s) { id = s.id; title = `阶段总结 ${s.periodStart.toISOString()} — ${s.periodEnd.toISOString()}`; content = s.summary; } }
      if (ref.type === "knowledge") { const k = knowledge.find(k => k.id === mapped("knowledgeItems", ref.id)); if (k?.status === "ACTIVE" && ["MANUAL", "IMPORT"].includes(k.sourceType)) { id = k.id; title = k.title; content = k.content; } }
      if (!id || title === undefined || content === undefined || ref.hash !== hash(title, content) || object(ref).valid === false) return { ...ref, id: randomUUID(), key: "", valid: false };
      return { ...ref, id, key: `${ref.type}:${id}`, hash: hash(title, content), title: title.slice(0, 200), excerpt: content.slice(0, 600) };
    }).map(ref => ({ ...ref, key: `${ref.type}:${ref.id}` }));
    if (refs.length) await insert("reflectionSuggestions", row, { runId, sourceRefs: refs });
    if (refs.some(ref => object(ref).valid === false)) warnings.push("部分反思来源失效，已保留历史结论并标记为不可用证据。");
  }
  const aggregateTables: Record<string, CharacterGrowthTable> = { KnowledgeItem: "knowledgeItems", KnowledgeCandidate: "knowledgeCandidates", SocialExperience: "socialExperiences", SocialRelationshipAssessment: "socialAssessments", ReflectionRun: "reflectionRuns", ReflectionSuggestion: "reflectionSuggestions" };
  for (const row of t.growthEvents) {
    const table = aggregateTables[row.aggregateType]; const id = row.aggregateType === "MemoryEvent" ? memories.get(row.aggregateId)?.id : table ? mapped(table, row.aggregateId) : undefined;
    if (!id) { warnings.push("部分成长事件聚合来源未映射，已跳过。"); continue; }
    const payload: Row = {}; const raw = object(row.payload);
    if (raw.sourceId === row.aggregateId) payload.sourceId = id;
    if (raw.sourceType === row.aggregateType) payload.sourceType = row.aggregateType;
    if (["DRAFT", "FINAL"].includes(String(raw.state))) payload.state = raw.state;
    await insert("growthEvents", row, { characterId: input.characterId, aggregateId: id, payload, idempotencyKey: `import:${await identity("growthEvents", row.id)}` });
  }
  for (const row of t.growthDeliveries) { const eventId = mapped("growthEvents", row.eventId); if (eventId) await insert("growthDeliveries", row, { eventId, status: ["QUEUED", "RUNNING", "RETRY_WAIT"].includes(row.status) ? "SKIPPED" : row.status, runAt: stamp(row.createdAt), lastError: ["QUEUED", "RUNNING", "RETRY_WAIT"].includes(row.status) ? "导入的历史投递，不执行或重新投递。" : row.lastError }); }
  return { added, warnings: [...new Set(warnings)] };
}
