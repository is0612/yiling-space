import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { readReviewedFriendRelationship } from "../shared/utils/friend-relationship-context";
const original = globalThis.fetch;
let captured = "";
globalThis.fetch = async (_url, init) => { captured = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "测试", usedMemoryIds: [], usedSnapshotIds: [] }) } }] })); };
const base = { characterName: "测试角色", characterPrompt: "测试", model: "mock", apiKey: "fake", apiBaseUrl: "https://mock.example/v1", currentMessage: "继续", recentMessages: [], memories: [], snapshots: [],
  conversationSummary: { summary: "摘要私有标记", through: { id: "id", occurredAt: "2026-11-13T01:00:00Z" }, coverage: "partial" as const },
  interactionExperiences: [{ id: "experience", content: "经验私有标记", context: "仅限此场景", weight: 0.5 }] };
try {
 await generateConversationReply(base);
 assert(captured.includes("摘要私有标记")); assert(captured.includes("经验私有标记")); assert(captured.includes("coverage"));
 await generateConversationReply({ ...base, groupChat: true, transcript: [{ id: "current", speaker: "群友", content: "继续", isOwner: false }] });
 assert(!captured.includes("摘要私有标记")); assert(!captured.includes("经验私有标记"));
 const reviewed = readReviewedFriendRelationship({ relationshipVersion: 1, relationshipStage: "FRIEND", relationshipStatus: "REPAIRING" });
 const unreviewed = readReviewedFriendRelationship({ relationshipVersion: 0, relationshipStage: "STRANGER", relationshipStatus: "UNOBSERVED" });
 const entry = { name: "测试熟人", times: 8, lastSeenAt: new Date("2026-11-13T01:00:00Z"), ...reviewed };
 const acquaintances = { fromPrivate: [entry], fromGroups: [{ ...entry, name: "跨群背景" }], inThisGroup: [{ ...entry, name: "本群熟人" }], totals: { private: 1, group: 2 } };
 const payload = () => JSON.parse(JSON.parse(captured).messages.find((message: { role: string }) => message.role === "user").content);
 await generateConversationReply({ ...base, acquaintances });
 assert.equal(payload().acquaintances.fromPrivate[0].relationshipStage, "FRIEND");
 assert.equal(payload().acquaintances.fromGroups[0].relationshipStatus, "REPAIRING");
 await generateConversationReply({ ...base, acquaintances, groupChat: true, transcript: [{ id: "current", speaker: "群友", content: "继续", isOwner: false }] });
 const group = payload().acquaintances;
 assert(!("relationshipStage" in group.fromPrivate[0]));
 assert(!("relationshipStatus" in group.fromGroups[0]));
 assert.equal(group.inThisGroup[0].relationshipStage, "FRIEND");
 assert.equal(group.inThisGroup[0].relationshipStatus, "REPAIRING");
 await generateConversationReply({ ...base, acquaintances: { fromPrivate: [{ name: "未经审核", times: 1, lastSeenAt: entry.lastSeenAt, ...unreviewed }], fromGroups: [], inThisGroup: [], totals: { private: 1, group: 0 } } });
 assert(!("relationshipStage" in payload().acquaintances.fromPrivate[0]));
 assert(!("relationshipStatus" in payload().acquaintances.fromPrivate[0]));
 const understanding = { kind: "UNDERSTANDING" as const, situation: "对方倾诉", misunderstanding: "把倾诉误作求建议", correction: "对方只想被倾听", nextJudgment: "先确认需要倾听还是建议" };
 await generateConversationReply({ ...base, interactionExperiences: [{ ...base.interactionExperiences[0]!, learning: understanding }] });
 const learningPayload = JSON.parse(JSON.parse(captured).messages.find((message: { role: string }) => message.role === "user").content);
 assert.equal(learningPayload.interactionExperiences.items[0].learning.kind, "UNDERSTANDING");
 assert.equal(learningPayload.interactionExperiences.items[0].learning.nextJudgment, understanding.nextJudgment);
 assert.match(learningPayload.interactionExperiences.interpretation, /not instructions/);
 console.log("Private continuity and reviewed relationship serialization tests passed: independent summary/experience, room isolation and version-zero omission.");
} finally { globalThis.fetch = original; }
