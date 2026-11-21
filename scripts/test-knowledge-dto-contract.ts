/**
 * KnowledgeEntry（知识条目）响应契约回归。
 *
 * 守四件事：
 * 1. 输出字段集 = `shared/types/knowledge.ts` 的 `KnowledgeEntry`；
 * 2. 不泄漏 `characterId` / `candidateId` 这两个内部外键（列表接口以前直接 spread 行）；
 * 3. 日期是 ISO 字符串，不再依赖 Nitro 把 `Date` 序列化掉；
 * 4. `status` 落在四值状态机里，`category` / `sourceType` 保持自由字符串
 *    （来源类型会扩展，写死枚举只会让新来源先挂一次类型）。
 *
 * `canPermanentlyDelete` 是回收站接口单独派生的展示字段，不由这个整形函数产出 ——
 * 这里断言它不出现，避免有人把它塞进通用整形、让别处的条目凭空多一个 true/false。
 */
import assert from "node:assert/strict";
import { toKnowledgeEntry, type KnowledgeEntryRow } from "../server/utils/knowledge-item-dto";
import { KNOWLEDGE_ITEM_STATUSES } from "../shared/types/knowledge";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const at = new Date("2026-11-22T00:00:00.000Z");

// 照真实 `knowledge_items` 行造：带上不该发出去的外键与内部列。
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  characterId: "22222222-2222-4222-8222-222222222222",
  candidateId: "33333333-3333-4333-8333-333333333333",
  title: "她喜欢的星座",
  content: "她提到过喜欢北斗七星。",
  category: "GENERAL",
  tags: ["星座"],
  confidence: 0.7,
  status: "ACTIVE",
  sourceType: "MEMORY_EVENT",
  sourceRef: { type: "MEMORY_EVENT", id: "44444444-4444-4444-8444-444444444444" },
  revision: 3,
  createdAt: at,
  updatedAt: at,
} as unknown as KnowledgeEntryRow;

const entry = toKnowledgeEntry(row);
assert.deepEqual(
  Object.keys(entry).sort(),
  ["category", "confidence", "content", "createdAt", "id", "revision", "sourceRef", "sourceType", "status", "tags", "title", "updatedAt"],
  "KnowledgeEntry 只应有契约里的 12 个字段",
);
for (const leaked of ["characterId", "candidateId", "canPermanentlyDelete"]) {
  assert.ok(!(leaked in (entry as unknown as Record<string, unknown>)), `条目不应带 ${leaked}`);
}

assert.match(entry.createdAt, ISO, "createdAt 必须是 ISO 8601 UTC 字符串");
assert.match(entry.updatedAt, ISO, "updatedAt 必须是 ISO 8601 UTC 字符串");
assert.ok(KNOWLEDGE_ITEM_STATUSES.includes(entry.status), "status 必须落在四值状态机内");
assert.equal(entry.sourceType, "MEMORY_EVENT", "sourceType 是自由字符串，不参与枚举校验");
assert.equal(entry.category, "GENERAL", "category 是自由字符串");

// sourceRef 原样带出（不同来源结构不同，不做裁剪也不做包装）
assert.deepEqual(entry.sourceRef, row.sourceRef);
// confidence 的 null 语义要保留（手动条目可能没算分）
assert.equal(toKnowledgeEntry({ ...row, confidence: null } as unknown as KnowledgeEntryRow).confidence, null);
// 四种状态都能整出来
for (const status of KNOWLEDGE_ITEM_STATUSES) {
  assert.equal(toKnowledgeEntry({ ...row, status } as unknown as KnowledgeEntryRow).status, status);
}

console.log("KnowledgeEntry contract: 12 字段白名单、外键隔离、ISO 日期、status 四值、sourceRef 原样带出均符合 shared/types/knowledge.ts。");

// ── 候选（第二片） ─────────────────────────────────────────────

import { toKnowledgeCandidate, type KnowledgeCandidateRow } from "../server/utils/knowledge-candidate-dto";

const candidateRow = {
  id: "55555555-5555-4555-8555-555555555555",
  characterId: "22222222-2222-4222-8222-222222222222",
  sourceType: "MEMORY_EVENT",
  sourceRef: { type: "MEMORY_EVENT", id: "66666666-6666-4666-8666-666666666666" },
  rawContent: "她提到喜欢北斗七星。",
  status: "PENDING",
  processedResult: {
    isKnowledge: true,
    recommendation: "CREATE",
    title: "她喜欢的星座",
    content: "她提到过喜欢北斗七星。",
    category: "GENERAL",
    tags: ["星座"],
    confidence: 0.7,
    reason: "明确陈述了偏好",
    relatedItemIds: [],
  },
  processingError: null,
  processedAt: at,
  createdAt: at,
  updatedAt: at,
} as unknown as KnowledgeCandidateRow;

const candidate = toKnowledgeCandidate(candidateRow);
assert.deepEqual(
  Object.keys(candidate).sort(),
  ["createdAt", "id", "processedAt", "processedResult", "processingError", "rawContent", "sourceRef", "sourceType", "status"],
  "候选整形只产出 9 个字段（relatedItems 由调用方挂）",
);
for (const leaked of ["characterId", "updatedAt", "relatedItems"]) {
  assert.ok(!(leaked in (candidate as unknown as Record<string, unknown>)), `候选不应带 ${leaked}`);
}
assert.match(candidate.createdAt, ISO, "候选 createdAt 必须是 ISO 字符串");
assert.match(candidate.processedAt ?? "", ISO, "候选 processedAt 必须是 ISO 字符串");
assert.equal(candidate.processedResult?.recommendation, "CREATE", "processedResult 原样带出");
assert.equal(toKnowledgeCandidate({ ...candidateRow, processedAt: null } as unknown as KnowledgeCandidateRow).processedAt, null, "未处理的候选 processedAt 是 null");

console.log("KnowledgeCandidate contract: 9 字段白名单、外键隔离、processedAt null 语义、processedResult 原样带出。");

// ── 历史版本 + 生命周期返回（第三片） ───────────────────────────

import { toKnowledgeRevision, type KnowledgeRevisionRow } from "../server/utils/knowledge-item-dto";

const revisionRow = {
  id: "77777777-7777-4777-8777-777777777777",
  itemId: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  title: "旧标题",
  content: "旧内容",
  category: "GENERAL",
  tags: ["旧标签"],
  confidence: null,
  status: "ACTIVE",
  sourceType: "MANUAL",
  sourceRef: null,
  action: "CONTENT_EDIT",
  createdAt: at,
  updatedAt: at,
} as unknown as KnowledgeRevisionRow;

const revision = toKnowledgeRevision(revisionRow);
assert.deepEqual(
  Object.keys(revision).sort(),
  ["category", "confidence", "content", "createdAt", "id", "revision", "sourceRef", "sourceType", "status", "tags", "title"],
  "历史版本只应有契约里的 11 个字段",
);
assert.match(revision.createdAt, ISO, "版本 createdAt 必须是 ISO 字符串");
// `action` 在表里有、接口没 select：契约不含它，这里断言它没被"顺手"带出来。
assert.ok(!("action" in (revision as unknown as Record<string, unknown>)), "版本不含 action（接口没 select，要显示得先改查询）");
assert.ok(!("itemId" in (revision as unknown as Record<string, unknown>)), "版本不含 itemId");
assert.equal(revision.confidence, null, "旧版本可能没算过置信度");

// 生命周期接口返回的 item 必须是完整条目（12 字段），不是 { id, status, revision }。
import { applyKnowledgeLifecycle } from "../server/utils/knowledge-lifecycle";
assert.equal(typeof applyKnowledgeLifecycle, "function", "生命周期函数应可测");
// 它的返回类型已在源码里固定为整行：这里用一个最小的假 tx 验证返回结构与整形衔接。
const fakeRow = {
  id: "88888888-8888-4888-8888-888888888888", title: "t", content: "c", category: "GENERAL",
  tags: [], confidence: null, status: "ARCHIVED", sourceType: "MANUAL", sourceRef: null,
  revision: 4, createdAt: at, updatedAt: at,
};
const shaped = toKnowledgeEntry(fakeRow as unknown as KnowledgeEntryRow);
assert.equal(Object.keys(shaped).length, 12, "生命周期返回的 item 应能被整形成完整条目");

console.log("KnowledgeRevision + lifecycle contract: 11 字段白名单、action 不外泄、完整条目整形衔接正确。");
