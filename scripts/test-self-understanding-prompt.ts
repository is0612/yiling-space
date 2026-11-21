import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { buildSelfUnderstandingView } from "../server/utils/self-understanding";
const original = globalThis.fetch;
const requests: Array<{ messages: Array<{role:string;content:string}> }> = [];
globalThis.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body)));
  return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: "我最近持续学习园艺，也在尝试先核对依据。" }) }, finish_reason: "stop" }] });
};
try {
  const input = { characterName: "测试角色", characterPrompt: "不公开的身份基础", model: "fixture", apiKey: "test", apiBaseUrl: "https://fixture.invalid/v1", currentMessage: "你这段时间有什么变化？", recentMessages: [], memories: [], snapshots: [] };
  const view = buildSelfUnderstandingView({ name: "测试角色", avatar: "鲸鱼外观", groupChat: false, evidence: [
    { domain: "preferences", id: "p-1", text: "LIKE: 园艺", state: "ACTIVE", scope: "character", revision: 2, updatedAt: "2026-11-18T00:00:00Z" },
    { domain: "reflection", id: "r-1", text: "可能愿意先核对依据", state: "ACCEPTED", scope: "character", updatedAt: "2026-11-18T00:00:00Z" },
  ] });
  const historicalView = { ...view, history: [{ domain: "preferences" as const, id: "p-1", scope: "character" as const,
    previous: { revision: 1, excerpt: "INTEREST: 园艺" }, current: { revision: 2, excerpt: "LIKE: 园艺", recordedAt: "2026-11-18T00:00:00Z" } }] };
  const reply = await generateConversationReply({ ...input, selfUnderstanding: historicalView });
  assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v82");
  const system = requests[0]!.messages.find(row => row.role === "system")!.content;
  assert(system.includes("presentation is appearance only"));
  assert(system.includes("provisional discussion, never confirmed facts or automatic writes"));
  assert(system.includes("Private evidence stays within this private conversation"));
  assert(system.includes("do not claim appearance becomes permanent once chosen"));
  assert(system.includes("Past lookup failures do not establish permanent inability"));
  assert(system.includes("identify it as your unsupported guess and withdraw it"));
  assert(system.includes("a quoted old mistake or another person's situation is not your current belief"));
  assert(system.includes("authorized_scoped_read_succeeded"));
  assert(system.includes("keep your own dated changes separate"));
  assert(system.includes("not a verified current system status"));
  const payload = JSON.parse(requests[0]!.messages.find(row => row.role === "user")!.content);
  assert(system.includes("compare only the paired previous and current versions of the same record"));
  assert(system.includes("An empty history means no supported pair was supplied"));
  assert.deepEqual(payload.selfUnderstanding, { ...historicalView,
    evidence: view.evidence.map(row => ({ ...row, updatedAt: "2026-11-18 08:00:00" })),
    history: historicalView.history.map(row => ({ ...row, current: { ...row.current, recordedAt: "2026-11-18 08:00:00" } })),
  });
  assert(!JSON.stringify(payload.selfUnderstanding).includes(input.characterPrompt));
  await generateConversationReply({ ...input, currentMessage: "你好" });
  assert(!requests[1]!.messages.find(row => row.role === "system")!.content.includes("selfUnderstanding is a bounded view"));
  assert.equal(JSON.parse(requests[1]!.messages.find(row => row.role === "user")!.content).selfUnderstanding, undefined);
  assert.equal(requests.length, 2, "One main model request per reply; no separate cognition model");
  console.log("Self-understanding prompt: optional evidence, first-person evidence rules, no appearance identity inference, provisional interpretation and no extra model calls passed.");
} finally { globalThis.fetch = original; }
