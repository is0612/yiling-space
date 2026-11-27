import assert from "node:assert/strict";
import { eventCandidate, memoryCandidate, parseStaleAudit } from "../server/utils/stale-memory-parse";

/**
 * 失效体检的解析边界：模型可以乱写，落库前的白名单不能松。
 * 只测纯函数，不连库、不调模型。
 */

const memories = [
  memoryCandidate({ id: "11111111-1111-4111-8111-111111111111", category: "FACT", content: "她暂时看不到自己生成的图。", importance: 0.75, updatedAt: new Date("2026-11-22T16:36:04Z") }, 0),
  memoryCandidate({ id: "22222222-2222-4222-8222-222222222222", category: "PREFERENCE", content: "她喜欢软乎乎的动漫少女图。", importance: 0.6, updatedAt: new Date("2026-11-22T14:30:49Z") }, 1),
];
const events = [
  eventCandidate({ id: "33333333-3333-4333-8333-333333333333", dayKey: "2026-11-22", title: "一起试画图", detail: "她第一次用本机引擎出图。", participants: ["主人"] }, 0),
];

assert.equal(memories[0]!.shortId, "M1");
assert.equal(memories[1]!.shortId, "M2");
assert.equal(events[0]!.shortId, "E1");
assert.match(memories[0]!.content, /看不到自己/, "正文要原样给模型，不能丢关键信息。");
assert.match(memories[0]!.meta, /重要度 0\.75/);

// 正常返回：白名单内的 id 才能落下来。
assert.deepEqual(
  parseStaleAudit('{"items":[{"id":"M1","verdict":"CONTRADICTED","reason":"看图功能已经修好","confidence":0.9}]}', memories),
  [{ kind: "MEMORY", id: memories[0]!.id, verdict: "CONTRADICTED", reason: "看图功能已经修好", confidence: 0.9 }],
);

// 代码围栏 / 前后废话：宽松解析要能吃下去。
assert.equal(
  parseStaleAudit('好的，结果如下：\n```json\n{"items":[{"id":"e1","verdict":"contradicted","reason":"当事人确认这次出图测试并未运行","confidence":0.7}]}\n```', events).length,
  1,
  "围栏、前缀、小写 id 都应被接受。",
);

// 白名单之外：编的 id、别的轮次的 id、未知 verdict、空 reason 全部丢掉。
assert.deepEqual(parseStaleAudit(JSON.stringify({
  items: [
    { id: "M99", verdict: "OBSOLETE", reason: "编号不存在" },
    { id: "M1", verdict: "DELETE", reason: "不认识的判决" },
    { id: "M1", verdict: "OBSOLETE", reason: "" },
    { id: "E1", verdict: "OBSOLETE", reason: "忆泡不在这一批" },
  ],
}), memories), [], "任何一条都不该通过。");

// 同一条只认第一次；confidence 越界要夹回 0~1。
const clamped = parseStaleAudit(JSON.stringify({
  items: [
    { id: "M1", verdict: "OBSOLETE", reason: "临时状态", confidence: 5 },
    { id: "M1", verdict: "CONTRADICTED", reason: "重复提名", confidence: 0.9 },
  ],
}), memories);
assert.equal(clamped.length, 1);
assert.equal(clamped[0]!.confidence, 1);
assert.equal(clamped[0]!.verdict, "OBSOLETE");

// 关系 / 偏好类不接受「过时」：整条归档会为了删一句过期玩笑，把熟人一起忘掉。
assert.deepEqual(
  parseStaleAudit('{"items":[{"id":"M2","verdict":"OBSOLETE","reason":"约好的日子过了","confidence":0.95}]}', memories),
  [],
);
// 但被推翻仍然要报：关系本身变了、规则改了，这类是真失效。
assert.equal(
  parseStaleAudit('{"items":[{"id":"M2","verdict":"CONTRADICTED","reason":"偏好已经改了","confidence":0.95}]}', memories).length,
  1,
);

// 低分项不进列表：模型自己说拿不准的，摆出来只会让人逐条划掉。
assert.deepEqual(
  parseStaleAudit('{"items":[{"id":"M1","verdict":"OBSOLETE","reason":"不太确定","confidence":0.4}]}', memories),
  [],
);

// DUPLICATE 不在这个功能的判决范围里（重复是另一条检查链路），一律当成未知判决丢掉。
assert.deepEqual(
  parseStaleAudit('{"items":[{"id":"M1","verdict":"DUPLICATE","reason":"和别的条目重复","confidence":0.9}]}', memories),
  [],
);

// 空结果、坏 JSON、数组根：都不能抛。
for (const text of ['{"items":[]}', "", "not json", "[]"]) {
  assert.deepEqual(parseStaleAudit(text, memories), []);
}

// 模拟模型把日期或结束当成失效证据；分类与 kind 各自提供硬保护。
for (const [category, content] of [
  ["EVENT", "语音曾故障，排查后重启恢复。"],
  ["EVENT", "已经完成重要功能的开发和回归测试。"],
  ["EVENT", "两人第一次一起看流星雨。"],
  ["RELATIONSHIP", "两人是长期搭档，曾约在周一见面。"],
  ["PREFERENCE", "偏爱深色主题，曾在某天提及。"],
] as const) {
  const candidate = { ...memories[0]!, category, content };
  const verdict = (value: string, reason: string) => parseStaleAudit(JSON.stringify({
    items: [{ id: candidate.shortId, verdict: value, reason, confidence: 0.99 }],
  }), [candidate]);
  assert.deepEqual(verdict("OBSOLETE", "约定的日期已过去或事情已经结束"), [], content);
  assert.equal(verdict("CONTRADICTED", "当事人明确纠正原记录这一事实").length, 1, content);
}
assert.deepEqual(parseStaleAudit('{"items":[{"id":"E1","verdict":"OBSOLETE","reason":"日期过了","confidence":0.99}]}', events), []);

for (const [category, content, verdict, reason] of [
  ["FACT", "当前使用旧模型。", "CONTRADICTED", "同一角色已切换到新模型"],
  ["FACT", "临时启用调试配置。", "OBSOLETE", "已明确撤回调试配置"],
  ["COMMITMENT", "还需做一次回归。", "OBSOLETE", "负责人确认回归已完成"],
] as const) {
  const candidate = { ...memories[0]!, category, content };
  const items = parseStaleAudit(JSON.stringify({ items: [{ id: candidate.shortId, verdict, reason, confidence: 0.9 }] }), [candidate]);
  assert.equal(items[0]?.verdict, verdict, content);
}

console.log("test:stale-memory-audit —— 全部通过");
