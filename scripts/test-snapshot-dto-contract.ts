/**
 * Snapshot（阶段总结）响应契约回归。
 *
 * 这一批形状原先只在前端 `app/utils/mock-data.ts` 里定义，服务端 DTO 反过来 import 它 ——
 * 服务端依赖前端。现在两边都指向 `shared/types/snapshot.ts`，本测试守住三件事：
 *
 * 1. `label` / `kind` / `pendingReview` 三个字段**总是有值**（前端原先写成可选，
 *    是在迁就演示数据，不是在描述接口）；
 * 2. 列表行不泄漏 `structuredContent` / `snapshotKey` / 来源原文这些重字段；
 * 3. `status` / `statusTone` 是服务端算好的展示态，取值只有那两种。
 */
import assert from "node:assert/strict";
import { toMemorySnapshotDetail, toMemorySnapshotSummaries, type SnapshotRecord } from "../server/utils/memory-snapshot-dto";
import type { Snapshot, SnapshotDetail } from "../shared/types/snapshot";

const at = new Date("2026-11-22T00:00:00.000Z");

function record(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    snapshotKey: "automatic:2026-11-22",
    version: 1,
    kind: "AUTOMATIC",
    periodStart: new Date("2026-11-15T00:00:00.000Z"),
    periodEnd: new Date("2026-11-22T00:00:00.000Z"),
    summary: "最近更习惯在晚间分享视频。",
    // 真实落库形状是 `{ analysis: {...} }` 一层嵌套：`readSnapshotAnalysis` 读 `root.analysis`。
    structuredContent: {
      analysis: {
        importantEvents: [{ title: "一起看片", detail: "聊到深夜", evidenceMessageIds: ["m1"] }],
        factAndPreferenceChanges: [],
        relationshipChanges: [],
        goalsAndCommitments: [],
        unresolvedTopics: [],
        differencesFromPrevious: [],
        memoryChangesApplied: [],
      },
    },
    status: "CURRENT",
    createdAt: at,
    reviews: [],
    sources: [],
    ...overrides,
  };
}

const rows = toMemorySnapshotSummaries([record()], "Asia/Shanghai");
assert.equal(rows.length, 1);
const row = rows[0] as Snapshot & Record<string, unknown>;

for (const field of ["id", "number", "label", "version", "date", "range", "summary", "events", "messages", "status", "statusTone", "kind", "pendingReview"]) {
  assert.ok(field in row, `Snapshot 缺少契约字段 ${field}`);
}
assert.equal(typeof row.label, "string", "label 必须总是一个字符串（自动「第 N 份」/ 手动「存档」）");
assert.ok(row.label.length > 0, "label 不能是空串");
assert.equal(row.kind, "AUTOMATIC");
assert.equal(typeof row.pendingReview, "number", "pendingReview 必须是数字（列表角标直接用它）");
assert.equal(row.status, "当前版本");
assert.equal(row.statusTone, "green");

// 外层重字段不能出现在列表行里。
for (const leaked of ["structuredContent", "snapshotKey", "periodStart", "periodEnd", "createdAt", "sources", "reviews", "status_raw"]) {
  assert.ok(!(leaked in row), `列表行不应带 ${leaked}`);
}
// 来源原文不能进列表（一页几十份就是几兆）。
assert.ok(!JSON.stringify(row).includes("一起看片"), "列表行不应包含分析内容");

// 已替代的那一份：展示态成对切换，不是各算各的。
const superseded = toMemorySnapshotSummaries([record({ status: "SUPERSEDED" })], "Asia/Shanghai")[0]!;
assert.equal(superseded.status, "已被替代");
assert.equal(superseded.statusTone, "gray");

// 手动存档：label 固定「存档」，number 恒为 0，不进「第 N 份」序列。
const manual = toMemorySnapshotSummaries([
  record({ snapshotKey: `manual:${at.toISOString()}`, kind: "MANUAL", createdAt: new Date(at.getTime() + 1000) }),
], "Asia/Shanghai")[0]!;
assert.equal(manual.kind, "MANUAL");
assert.equal(manual.number, 0, "手动存档不占「第 N 份」序号");
assert.equal(manual.label, "存档");

// 详情：evidenceIndex 必填，且不把 structuredContent 原样抛出去。
const detail = toMemorySnapshotDetail(record(), "Asia/Shanghai") as SnapshotDetail & Record<string, unknown>;
assert.ok("evidenceIndex" in detail, "SnapshotDetail 必须带 evidenceIndex（「依据 #3」靠它）");
assert.ok(detail.analysis, "详情应解析出 analysis");
assert.ok(!("structuredContent" in detail), "详情不应把 structuredContent 原样抛出去");

console.log("Snapshot contract: 必填 label/kind/pendingReview、展示态成对、手动存档序号、详情 evidenceIndex 与列表字段隔离均符合 shared/types/snapshot.ts。");
