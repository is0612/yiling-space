import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { loadChatKnowledge } from "../server/utils/chat-knowledge-retrieval";
import type { GrowthReadDiagnostic } from "../server/utils/growth-read-diagnostics";
const entries: GrowthReadDiagnostic[] = [];
let calls = 0;
const prisma = { knowledgeItem: { findMany: async (query: unknown) => {
  calls++;
  assert.deepEqual(query, { where: { characterId: "character-a", status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 300,
    select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, sourceType: true, updatedAt: true } });
  return [{ id: "knowledge-a", title: "番茄育苗", content: "保持通风", category: "GENERAL", tags: ["番茄"], confidence: null, sourceType: "MANUAL", updatedAt: new Date("2026-11-18T00:00:00Z") }];
} } } as unknown as PrismaClient;
const selected = await loadChatKnowledge(prisma, "character-a", "番茄育苗", entry => entries.push(entry));
assert.equal(calls, 1);
assert.equal(selected[0]?.id, "knowledge-a");
assert.equal(entries[0]?.status, "provided");
assert.deepEqual(entries[0]?.provided, [{ id: "knowledge-a", updatedAt: "2026-11-18T00:00:00.000Z" }]);
assert(!JSON.stringify(entries).includes("保持通风"));
await loadChatKnowledge(prisma, "character-a", "番茄育苗", () => { throw new Error("observer"); });
const failure = new Error("database unavailable");
const broken = { knowledgeItem: { findMany: async () => { throw failure; } } } as unknown as PrismaClient;
await assert.rejects(loadChatKnowledge(broken, "character-a", "query", entry => entries.push(entry)), error => error === failure);
assert.equal(entries.at(-1)?.status, "failed");
const naturalRows = [
  { id: "voice", title: "语音克隆参考音的选择与验收要点", content: "参考音以 5–10 秒为宜，应干净、情绪稳定；参考音不是越长越好。" },
  { id: "style", title: "让角色说话更自然：优先改句式结构而非标点", content: "角色说话显得像 AI，往往在句式结构：层层嵌套、先总后分、结尾必升华。" },
].map(row => ({ ...row, category: "GENERAL", tags: [], confidence: null, sourceType: "MANUAL", updatedAt: new Date() }));
const naturalDb = { knowledgeItem: { findMany: async () => naturalRows } } as unknown as PrismaClient;
for (const [question, expected] of [["参考音录一分钟会不会更好", "voice"], ["角色说话显得像 AI 时，应该怎么办呀", "style"]]) {
  const diagnostics: GrowthReadDiagnostic[] = [];
  const result = await loadChatKnowledge(naturalDb, "character-a", question!, entry => diagnostics.push(entry));
  assert.equal(result[0]?.id, expected);
  assert(result[0]?.content, "Natural questions receive approved knowledge content without a model query");
  assert.equal(diagnostics.at(-1)?.status, "provided");
}
console.log("Shared chat knowledge reader: isolation, bounded SQL, diagnostics, failure propagation and natural question retrieval passed.");
