/**
 * MemoryItem 响应契约回归。
 *
 * 守三件事：
 * 1. 列表与创建两个接口共用 `toMemoryItem`，形状不会再分叉；
 * 2. 只发契约里的 9 个字段 —— `memoryScopeId` / `confidence` / `recallCount` /
 *    `dedupeKey` 这些内部字段不能跟着 `...row` 漏出去；
 * 3. 日期是 ISO 字符串、`validTo` 的 null 语义保留、`scopeType` 从 `memoryScope` 拍平。
 *
 * 这是 memory 域的第一个切片（MemoryItem）。Snapshot / Event 各自单独做、单独回归。
 */
import assert from "node:assert/strict";
import { toMemoryItem, type MemoryItemRow } from "../server/utils/memory-item-dto";
import { MEMORY_CATEGORIES, MEMORY_SCOPE_TYPES, MEMORY_STATUSES } from "../shared/types/memory";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const at = new Date("2026-11-22T00:00:00.000Z");

// 照真实 `memory_items` 行造：带上所有不该发出去的内部字段。
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  originId: "22222222-2222-4222-8222-222222222222",
  memoryScopeId: "33333333-3333-4333-8333-333333333333",
  category: "PREFERENCE",
  content: "她喜欢在雨天听老歌",
  confidence: 0.8,
  importance: 0.65,
  lastRecalledAt: at,
  recallCount: 7,
  status: "ACTIVE",
  statusBeforeTrash: null,
  deletedAt: null,
  sourceMessageId: "44444444-4444-4444-8444-444444444444",
  sourceSnapshotId: null,
  dedupeKey: "dedupe-key-marker",
  validFrom: at,
  validTo: null,
  createdAt: at,
  updatedAt: at,
  memoryScope: { scopeType: "CHARACTER_GLOBAL" },
} as unknown as MemoryItemRow;

const item = toMemoryItem(row);
const keys = Object.keys(item).sort();
assert.deepEqual(
  keys,
  ["category", "content", "createdAt", "id", "importance", "scopeType", "status", "updatedAt", "validTo"],
  "MemoryItem 只应有契约里的 9 个字段",
);
// 逐条点出不该出现的内部字段，失败时能直接看出是哪一类泄漏。
for (const leaked of ["memoryScopeId", "confidence", "recallCount", "lastRecalledAt", "dedupeKey", "originId", "deletedAt", "sourceMessageId", "memoryScope"]) {
  assert.ok(!(leaked in (item as unknown as Record<string, unknown>)), `MemoryItem 不应带内部字段 ${leaked}`);
}

assert.match(item.createdAt, ISO, "createdAt 必须是 ISO 8601 UTC 字符串");
assert.match(item.updatedAt, ISO, "updatedAt 必须是 ISO 8601 UTC 字符串");
assert.equal(item.validTo, null, "validTo 的 null 语义要保留，不能变成 undefined 或空串");
assert.equal(item.scopeType, "CHARACTER_GLOBAL", "scopeType 从 memoryScope 拍平");
assert.ok(MEMORY_CATEGORIES.includes(item.category), "category 必须在契约枚举内");
assert.ok(MEMORY_STATUSES.includes(item.status), "status 必须在契约枚举内");
assert.ok(MEMORY_SCOPE_TYPES.includes(item.scopeType), "scopeType 必须在契约枚举内");

// validTo 有值时也要 ISO 化
const withValidTo = toMemoryItem({ ...row, validTo: at } as unknown as MemoryItemRow);
assert.match(withValidTo.validTo ?? "", ISO, "validTo 有值时应是 ISO 字符串");

// 三个 scope 各自能拍平（用户私人 / 外部身份）
for (const scopeType of MEMORY_SCOPE_TYPES) {
  const scoped = toMemoryItem({ ...row, memoryScope: { scopeType } } as unknown as MemoryItemRow);
  assert.equal(scoped.scopeType, scopeType);
}

console.log("MemoryItem contract: 列表与创建同源整形、9 字段白名单、ISO 日期、validTo null 语义与 scopeType 拍平均符合 shared/types/memory.ts。");
