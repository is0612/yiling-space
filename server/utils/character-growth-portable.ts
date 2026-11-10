import { createError } from "h3";
import { createHash } from "node:crypto";

/** v5 portable growth history. Never spread database rows into these records. */
export const CHARACTER_GROWTH_LIMITS = { rowsPerTable: 4000, totalRows: 20000, text: 20000, jsonBytes: 16384, jsonDepth: 6, jsonNodes: 500, tags: 30 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message: string): never { throw createError({ statusCode: 400, statusMessage: `成长数据无效：${message}` }); }
type Reader<T> = (value: unknown, path: string) => T;
const text = (max: number = CHARACTER_GROWTH_LIMITS.text): Reader<string> => (v, p) => typeof v === "string" && v.length <= max && !v.includes("\u0000") ? v : fail(p);
const uuid: Reader<string> = (v, p) => typeof v === "string" && UUID.test(v) ? v.toLowerCase() : fail(p);
const integer: Reader<number> = (v, p) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647 ? v : fail(p);
const probability: Reader<number> = (v, p) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fail(p);
const date: Reader<string> = (v, p) => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v))) return fail(p);
  const canonical = new Date(v).toISOString();
  // Reject normalized invalid calendar dates such as February 30.
  if (v.endsWith("Z") && canonical.slice(0, 10) !== v.slice(0, 10)) return fail(p);
  return canonical;
};
const optional = <T>(read: Reader<T>): Reader<T | undefined> => (v, p) => v === undefined ? undefined : read(v, p);
const boolean: Reader<boolean> = (v, p) => typeof v === "boolean" ? v : fail(p);
const nullable = <T>(read: Reader<T>): Reader<T | null> => (v, p) => v === null ? null : read(v, p);
const enumeration = <const T extends readonly string[]>(values: T): Reader<T[number]> => (v, p) => typeof v === "string" && values.includes(v) ? v as T[number] : fail(p);
const list = <T>(read: Reader<T>, max: number = CHARACTER_GROWTH_LIMITS.tags): Reader<T[]> => (v, p) => Array.isArray(v) && v.length <= max ? v.map((x, i) => read(x, `${p}[${i}]`)) : fail(p);
type Shape = Record<string, Reader<unknown>>;
type Output<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
function object<S extends Shape>(shape: S): Reader<Output<S>> {
  return (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(path);
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !Object.hasOwn(shape, key))) return fail(`${path}:未知字段`);
    return Object.fromEntries(Object.entries(shape).map(([key, read]) => [key, read(input[key], `${path}.${key}`)])) as Output<S>;
  };
}
export type GrowthPortableJson = null | string | number | boolean | GrowthPortableJson[] | { [key: string]: GrowthPortableJson };
// Metadata is inert display/provenance data, never an action or credential envelope.
const JSON_KEYS = new Set(["kind", "sourceHash", "sourceId", "occurredAt", "ownerProposed", "title", "content", "category", "tags", "confidence", "reason", "recommendation", "isKnowledge", "relatedItemIds", "observations", "facts", "inferences", "recommendations", "summary", "note", "label", "url", "source", "sourceType", "origin", "scope", "type", "id", "key", "hash", "excerpt", "eventId", "memoryEventId", "experienceId", "scopeId", "candidateId", "itemId", "requestId", "assessmentId", "changeId", "revision", "dayKey", "state", "count", "reasons", "triggerReasons", "imported", "historical", "sourceDomain", "eventType", "schemaVersion"]);
export const parseGrowthMetadata: Reader<GrowthPortableJson> = (value, path = "metadata") => {
  let nodes = 0;
  function visit(v: unknown, depth: number): GrowthPortableJson {
    if (++nodes > CHARACTER_GROWTH_LIMITS.jsonNodes || depth > CHARACTER_GROWTH_LIMITS.jsonDepth) return fail(path);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : fail(path);
    if (typeof v === "string") return text(4000)(v, path);
    if (Array.isArray(v)) return v.length <= 100 ? v.map(x => visit(x, depth + 1)) : fail(path);
    if (!v || typeof v !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail(path);
    return Object.fromEntries(Object.entries(v).map(([key, item]) => {
      if (!JSON_KEYS.has(key)) return fail(`${path}.${key}`);
      return [key, visit(item, depth + 1)];
    }));
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > CHARACTER_GROWTH_LIMITS.jsonBytes) return fail(path);
  return result;
};
const stage = enumeration(["STRANGER", "ACQUAINTANCE", "FRIEND", "CLOSE_FRIEND"]);
const socialStatus = enumeration(["NORMAL", "DISTANT", "CONFLICT", "REPAIRING", "UNOBSERVED"]);
const sourceType = enumeration(["MANUAL", "IMPORT", "MEMORY_EVENT"]);
const itemStatus = enumeration(["ACTIVE", "ARCHIVED", "TRASHED"]);
const category = enumeration(["GENERAL", "SCIENCE", "TECHNOLOGY", "HISTORY", "CULTURE", "LANGUAGE", "SKILL", "OTHER"]);
const reviewStatus = enumeration(["NOT_REQUIRED", "PENDING", "DEFERRED", "ACCEPTED", "REJECTED", "STALE"]);
const timestamps = { createdAt: date, updatedAt: date };
const knowledgeBody = { title: text(240), content: text(), category, tags: list(text(40)), confidence: nullable(probability), status: itemStatus, sourceType, sourceRef: parseGrowthMetadata };
const ref = object({ key: text(100), type: enumeration(["memory", "knowledge", "snapshot"]), id: uuid, hash: text(64), title: text(200), excerpt: text(600), valid: optional((v, p) => v === false ? false as const : fail(p)) });
const schemas = {
  knowledgeCandidates: object({ id: uuid, sourceType, sourceRef: parseGrowthMetadata, rawContent: text(), status: enumeration(["PENDING", "REVIEW", "ACCEPTED", "DISMISSED", "FAILED"]), processedResult: parseGrowthMetadata, processingError: nullable(text(2000)), processedAt: nullable(date), ...timestamps }),
  knowledgeItems: object({ id: uuid, candidateId: nullable(uuid), ...knowledgeBody, revision: integer, ...timestamps }),
  knowledgeRevisions: object({ id: uuid, itemId: uuid, revision: integer, ...knowledgeBody, action: enumeration(["CONTENT_EDIT", "MERGE", "ARCHIVE", "UNARCHIVE", "TRASH", "RESTORE"]), createdAt: date }),
  knowledgeRelations: object({ id: uuid, sourceItemId: uuid, targetItemId: uuid, relationType: enumeration(["DUPLICATE", "CONFLICT", "MERGED_INTO"]), status: enumeration(["OPEN", "RESOLVED", "DISMISSED"]), resolution: nullable(enumeration(["DISMISS", "KEEP_BOTH", "KEEP_SEPARATE", "CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "MERGED", "SOURCE_MERGED", "RESOLVE"])), metadata: parseGrowthMetadata, resolvedAt: nullable(date), ...timestamps }),
  socialRelationships: object({ id: uuid, platform: text(40), platformUid: text(255), relationshipStage: nullable(stage), relationshipStatus: nullable(socialStatus), relationshipVersion: integer, relationshipUpdatedAt: nullable(date) }),
  socialExperiences: object({ id: uuid, scopeId: uuid, memoryEventId: uuid, sourceKey: text(64), createdAt: date }),
  socialAssessments: object({ id: uuid, scopeId: uuid, generation: integer, triggerReasons: list(text(80)), evaluatedStage: stage, evaluatedStatus: socialStatus, relationshipVersion: integer, outcome: nullable(enumeration(["CHANGE", "MAINTAIN", "INSUFFICIENT", "REVIEW"])), suggestedStage: nullable(stage), suggestedStatus: nullable(socialStatus), reason: nullable(text()), observations: parseGrowthMetadata, confidence: nullable(probability), modelProvider: nullable(text(80)), modelName: nullable(text(160)), promptVersion: nullable(text(80)), inputCutoffAt: nullable(date), status: enumeration(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]), reviewStatus, reviewedAt: nullable(date), error: nullable(text(2000)), startedAt: date, completedAt: nullable(date), createdAt: date }),
  socialReviews: object({ id: uuid, assessmentId: uuid, decision: enumeration(["DEFERRED", "ACCEPTED", "REJECTED", "STALE"]), note: nullable(text(4000)), createdAt: date }),
  socialChanges: object({ id: uuid, scopeId: uuid, fromStage: stage, toStage: stage, fromStatus: nullable(socialStatus), toStatus: nullable(socialStatus), relationshipVersionBefore: nullable(integer), relationshipVersionAfter: nullable(integer), assessmentId: nullable(uuid), reason: text(), createdAt: date }),
  socialChangeEvidence: object({ id: uuid, changeId: uuid, experienceId: uuid }),
  socialAssessmentEvidence: object({ id: uuid, assessmentId: uuid, experienceId: uuid, scopeId: uuid, kind: enumeration(["NEW", "CONTEXT"]), createdAt: date }),
  reflectionRuns: object({ id: uuid, periodStart: date, periodEnd: date, status: enumeration(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]), attemptCount: integer, maxAttempts: integer, lastError: nullable(text(500)), model: nullable(text(120)), promptVersion: nullable(text(80)), sourcesHash: nullable(text(64)), completedAt: nullable(date), ...timestamps }),
  reflectionSuggestions: object({ id: uuid, runId: uuid, title: text(200), observation: text(1500), inference: text(1500), recommendation: text(1500), sourceRefs: list(ref, 33), status: enumeration(["PENDING", "ACCEPTED", "REJECTED", "DEFERRED"]), reviewNote: nullable(text(500)), reviewedAt: nullable(date), acceptedAt: nullable(date), ...timestamps }),
  growthEvents: object({ id: uuid, sourceDomain: enumeration(["memory", "social", "knowledge", "preference", "corpus", "state", "reflection", "goal"]), eventType: text(120), schemaVersion: integer, aggregateType: text(120), aggregateId: uuid, occurredAt: date, payload: parseGrowthMetadata, createdAt: date }),
  growthDeliveries: object({ id: uuid, eventId: uuid, consumerKey: text(120), status: enumeration(["QUEUED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"]), attemptCount: integer, maxAttempts: integer, lastError: nullable(text(2000)), processedAt: nullable(date), ...timestamps }),
};
export type CharacterGrowthBundle = { version: 1; warnings?: string[]; tables: { [K in keyof typeof schemas]: Array<ReturnType<(typeof schemas)[K]>> } };
export type CharacterGrowthTable = keyof CharacterGrowthBundle["tables"];
export function emptyCharacterGrowthBundle(): CharacterGrowthBundle {
  return { version: 1, warnings: [], tables: Object.fromEntries(Object.keys(schemas).map(key => [key, []])) as unknown as CharacterGrowthBundle["tables"] };
}
export function growthCounts(bundle: CharacterGrowthBundle): { [K in CharacterGrowthTable]: number } {
  return Object.fromEntries(Object.entries(bundle.tables).map(([key, rows]) => [key, rows.length])) as { [K in CharacterGrowthTable]: number };
}
/** Optional top-level context proves that external references are inside this very card. */
export type CharacterGrowthContext = { eventIds: ReadonlySet<string>; snapshotIds: ReadonlySet<string>; friends: ReadonlySet<string>; includeFriends: boolean };
export function parseCharacterGrowthBundle(value: unknown, context?: CharacterGrowthContext): CharacterGrowthBundle {
  const envelope = object({ warnings: optional(list(text(500), 100)), version: (v: unknown, p: string) => v === 1 ? 1 as const : fail(p), tables: object(Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, list(schema as Reader<unknown>, CHARACTER_GROWTH_LIMITS.rowsPerTable)]))) })(value, "growth");
  const bundle = envelope as CharacterGrowthBundle;
  if (Object.values(growthCounts(bundle)).reduce((a, b) => a + b, 0) > CHARACTER_GROWTH_LIMITS.totalRows) fail("总条数超限");
  const t = bundle.tables;
  const ids = Object.fromEntries(Object.entries(t).map(([key, rows]) => {
    const set = new Set(rows.map(row => row.id));
    if (set.size !== rows.length) fail(`${key}:重复ID`);
    return [key, set];
  })) as Record<CharacterGrowthTable, Set<string>>;
  function link(table: CharacterGrowthTable, id: string | null) { if (id !== null && !ids[table].has(id)) fail(`${table}:悬空引用`); }
  function unique(rows: unknown[], key: (row: any) => string) { const keys = rows.map(key); if (new Set(keys).size !== keys.length) fail("重复业务键"); }
  unique(t.knowledgeItems.filter(row => row.candidateId), row => row.candidateId);
  unique(t.knowledgeRevisions, row => `${row.itemId}:${row.revision}`);
  unique(t.knowledgeRelations, row => `${row.relationType}:${row.relationType === "MERGED_INTO" ? [row.sourceItemId, row.targetItemId].join(":") : [row.sourceItemId, row.targetItemId].sort().join(":")}`);
  unique(t.socialRelationships, row => `${row.platform}:${row.platformUid}`);
  unique(t.socialExperiences, row => `${row.scopeId}:${row.sourceKey}`);
  unique(t.socialChangeEvidence, row => `${row.changeId}:${row.experienceId}`);
  unique(t.socialAssessmentEvidence, row => `${row.assessmentId}:${row.experienceId}`);
  unique(t.growthDeliveries, row => `${row.eventId}:${row.consumerKey}`);
  for (const row of t.knowledgeItems) { link("knowledgeCandidates", row.candidateId); if (row.revision < 1) fail("知识版本"); }
  for (const row of t.knowledgeRevisions) { link("knowledgeItems", row.itemId); if (row.revision < 1) fail("知识版本"); }
  for (const row of t.knowledgeRelations) { link("knowledgeItems", row.sourceItemId); link("knowledgeItems", row.targetItemId); if (row.sourceItemId === row.targetItemId) fail("自关联"); }
  for (const row of [...t.socialExperiences, ...t.socialAssessments, ...t.socialChanges]) link("socialRelationships", row.scopeId);
  for (const row of t.socialReviews) link("socialAssessments", row.assessmentId);
  for (const row of t.socialChanges) { link("socialAssessments", row.assessmentId); if (row.assessmentId && t.socialAssessments.find(a => a.id === row.assessmentId)?.scopeId !== row.scopeId) fail("关系变更跨朋友"); }
  for (const row of t.socialChangeEvidence) { link("socialChanges", row.changeId); link("socialExperiences", row.experienceId); if (t.socialChanges.find(c => c.id === row.changeId)?.scopeId !== t.socialExperiences.find(e => e.id === row.experienceId)?.scopeId) fail("变更证据跨朋友"); }
  for (const row of t.socialAssessmentEvidence) { link("socialAssessments", row.assessmentId); link("socialExperiences", row.experienceId); link("socialRelationships", row.scopeId); if (t.socialAssessments.find(a => a.id === row.assessmentId)?.scopeId !== row.scopeId || t.socialExperiences.find(e => e.id === row.experienceId)?.scopeId !== row.scopeId) fail("评估证据跨朋友"); }
  for (const row of t.reflectionRuns) { if (row.periodStart >= row.periodEnd || row.maxAttempts < 1 || row.sourcesHash !== null && !/^[a-f0-9]{64}$/.test(row.sourcesHash)) fail("反思时间或摘要"); }
  for (const row of t.reflectionSuggestions) {
    link("reflectionRuns", row.runId);
    if (!row.sourceRefs.length || row.status === "ACCEPTED" && !row.acceptedAt) fail("反思建议来源或采纳时间");
    for (const r of row.sourceRefs) { if (r.key !== `${r.type}:${r.id}` || !/^[a-f0-9]{64}$/.test(r.hash)) fail("反思引用"); if (r.valid !== false && r.type === "knowledge") link("knowledgeItems", r.id); }
  }
  for (const row of t.growthEvents) if (!new RegExp(`^${row.sourceDomain}\\.[a-z][a-z0-9.-]*$`).test(row.eventType) || row.schemaVersion < 1) fail("成长事件类型");
  for (const row of t.growthDeliveries) { link("growthEvents", row.eventId); if (row.maxAttempts < 1) fail("投递次数"); }
  // Only proven, non-private knowledge provenance is portable.
  for (const row of [...t.knowledgeCandidates, ...t.knowledgeItems, ...t.knowledgeRevisions]) {
    if (row.sourceRef !== null) {
      if (Array.isArray(row.sourceRef) || typeof row.sourceRef !== "object") fail("知识来源");
      const r = row.sourceRef;
      if (r.scope !== undefined && r.scope !== "character" && r.scope !== "CHARACTER_GLOBAL") fail("私人或未知知识来源");
      if (row.sourceType === "MEMORY_EVENT" && typeof r.memoryEventId !== "string" && typeof r.eventId !== "string") fail("忆泡知识来源");
    } else if (row.sourceType === "MEMORY_EVENT") fail("缺少忆泡来源");
  }
  if (context) validateCharacterGrowthContext(bundle, context);
  return bundle;
}
export function validateCharacterGrowthContext(bundle: CharacterGrowthBundle, context: CharacterGrowthContext): void {
  const t = bundle.tables;
  if (!context.includeFriends && Object.entries(t).some(([key, rows]) => key.startsWith("social") && rows.length)) fail("不含朋友的卡片带有社交数据");
  for (const row of t.socialRelationships) if (!context.friends.has(`${row.platform}:${row.platformUid}`)) fail("未导出的朋友");
  for (const row of t.socialExperiences) if (!context.eventIds.has(row.memoryEventId)) fail("社交忆泡来源不在卡片中");
  for (const row of t.reflectionSuggestions) for (const r of row.sourceRefs) {
    if (r.valid === false) continue;
    if (r.type === "memory" && !context.eventIds.has(r.id) || r.type === "snapshot" && !context.snapshotIds.has(r.id)) fail("反思来源不在卡片中");
  }
  for (const row of [...t.knowledgeCandidates, ...t.knowledgeItems, ...t.knowledgeRevisions]) if (row.sourceType === "MEMORY_EVENT" && row.sourceRef && typeof row.sourceRef === "object" && !Array.isArray(row.sourceRef)) {
    if (!context.eventIds.has(String(row.sourceRef.memoryEventId ?? row.sourceRef.eventId))) fail("知识来源不在卡片中");
  }
}
/** Use a stable card root/table/source UUID, then retain this identity on re-export. */
export function characterGrowthMappedId(root: string, table: CharacterGrowthTable, sourceId: string): string {
  uuid(root, "root"); uuid(sourceId, "sourceId");
  const hash = createHash("sha256").update(JSON.stringify([root.toLowerCase(), table, sourceId.toLowerCase()])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
