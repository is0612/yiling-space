import assert from "node:assert/strict";
import { buildSelfUnderstandingView, selfUnderstandingReferences, wantsSelfUnderstanding, type SelfUnderstandingEvidence } from "../server/utils/self-understanding";
for (const text of ["你是谁？", "你对自己的认识是什么？", "你这段时间有什么变化？", "你的性格是怎样的？"]) assert(wantsSelfUnderstanding(text));
for (const text of ["哈哈", "最近天气如何", "你最近看了什么", "你能告诉我 PostgreSQL 是什么吗"]) assert(!wantsSelfUnderstanding(text));
const base = { state: "ACTIVE" as const, scope: "character" as const, revision: 2, updatedAt: "2026-11-18T00:00:00Z", text: "持续学习园艺" };
const records: SelfUnderstandingEvidence[] = [
  { ...base, domain: "preferences", id: "pref-1" },
  { ...base, domain: "knowledge", id: "knowledge-1", text: "关于幼苗光照的知识", confidence: 0.3 },
  { ...base, domain: "reflection", id: "reflection-1", state: "ACCEPTED", text: "可能更愿意先核对证据" },
  { ...base, domain: "experience", id: "exp-1", scope: "private", conversationId: "room-a", context: "讨论方案" },
  { ...base, domain: "experience", id: "exp-other", scope: "private", conversationId: "room-b" },
];
const view = buildSelfUnderstandingView({ name: "测试角色", avatar: "鲸鱼形象", groupChat: false, conversationId: "room-a", evidence: records });
assert.equal(view.presentation.meaning, "appearance_only");
assert.deepEqual(view.identity, { name: "测试角色" });
const imageView = buildSelfUnderstandingView({ name: "测试角色", avatar: "https://fixture.invalid/avatar?token=IMAGE_TOKEN_SENTINEL", groupChat: false, evidence: [] });
assert.equal(imageView.presentation.avatar, "configured_image");
assert(!JSON.stringify(imageView).includes("IMAGE_TOKEN_SENTINEL"));
assert.equal(view.evidence.find(row => row.domain === "reflection")?.status, "accepted_interpretation");
assert.equal(view.evidence.find(row => row.domain === "experience")?.status, "scoped_experience");
assert.equal(view.evidence.find(row => row.domain === "knowledge")?.status, "active_record");
assert.equal(view.evidence.find(row => row.domain === "knowledge")?.confidence, 0.3);
assert(!view.evidence.some(row => row.id === "exp-other"));
assert(!JSON.stringify(view).includes("room-a"));
assert.equal(view.evidence[0]?.revision, 2);
const references = selfUnderstandingReferences(view);
assert.equal(references[0]?.revision, 2);
assert(!JSON.stringify(references).includes("持续学习园艺"));
assert(!references.some(row => "excerpt" in row || "context" in row));
assert(view.notProvided.includes("social"));
const publicView = buildSelfUnderstandingView({ name: "测试角色", groupChat: true, conversationId: "room-a", evidence: records });
assert(publicView.evidence.every(row => row.scope === "character"));
const unsafe = [ ...records, { ...base, domain: "goals", id: "pending", state: "PENDING" }, { ...base, domain: "goals", id: "archived", state: "ARCHIVED" }, { ...base, domain: "reflection", id: "unreviewed", state: "PENDING" } ] as SelfUnderstandingEvidence[];
assert.deepEqual(buildSelfUnderstandingView({ name: "测试角色", groupChat: false, conversationId: "room-a", evidence: unsafe }).evidence, view.evidence);
const many = Array.from({ length: 500 }, (_, index) => ({ ...base, domain: "memory" as const, id: `m-${index}`, text: "a".repeat(5000) }));
assert(JSON.stringify(buildSelfUnderstandingView({ name: "测试角色", groupChat: false, evidence: many }).evidence).length < 6100);
const changed = buildSelfUnderstandingView({ name: "新名字", groupChat: false, evidence: [{ ...records[0]!, revision: 3, text: "新偏好" }] });
assert.equal(changed.identity.name, "新名字");
assert.equal(changed.evidence[0]?.revision, 3);
assert.equal(view.evidence[0]?.revision, 2);
console.log("Self-understanding view: on-demand trigger, appearance separation, source versions, interpretation states, room/public boundaries, pending exclusion, budgets and fresh reads passed.");
