import assert from "node:assert/strict";
import { generateConversationReply, type ConversationReplyInput } from "../server/utils/chat-reply";
import { pickLatestJournalTexts, dropDuplicateJournalQuote } from "../server/utils/journal-service";

const originalFetch = globalThis.fetch;
let captured: { messages: Array<{ role: string; content: string }> };
globalThis.fetch = async (_url, init) => {
  captured = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "嗯，我记得那篇。" }) } }] }), { status: 200 });
};
const base: ConversationReplyInput = {
  characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test", apiBaseUrl: "https://mock.example/v1",
  currentMessage: "你日记里写了什么", recentMessages: [], memories: [], snapshots: [],
};
function payload() { return JSON.parse(captured.messages.find(message => message.role === "user")!.content); }
function system() { return captured.messages[0]!.content; }

try {
  // 同一份文本只取最新一版：旧版的「我还没有 X」不能和新版一起进提示词。
  const picked = pickLatestJournalTexts([
    { journalId: "j1", kind: "DIARY", content: "新版日记" },
    { journalId: "j1", kind: "DIARY", content: "旧版日记" },
    { journalId: "j1", kind: "HANDBOOK", content: "今天的片段", thought: "想法", quote: "一句" },
    { journalId: "j2", kind: "DIARY", content: "   " },
  ]);
  assert.equal(picked.get("j1")?.diary, "新版日记");
  assert.deepEqual(picked.get("j1")?.handbook, { notes: "今天的片段", thought: "想法", quote: "一句" });
  assert.equal(picked.has("j2"), false, "空正文不该占一个位置");

  // 与 journalLine 重复的那一句不再重复进正文：同一句一轮出现两次既费预算也容易复读。
  const deduped = dropDuplicateJournalQuote([
    { dayKey: "2026-11-14", diary: "正文", handbook: { notes: "片段", quote: "同一句" } },
    { dayKey: "2026-11-13", diary: "另一篇", handbook: { quote: "同一句" } },
  ], { dayKey: "2026-11-14", quote: "同一句" });
  assert.deepEqual(deduped[0], { dayKey: "2026-11-14", diary: "正文", handbook: { notes: "片段" } });
  assert.deepEqual(deduped[1]?.handbook, { quote: "同一句" }, "只去掉同一天那一句");
  assert.deepEqual(dropDuplicateJournalQuote(deduped, null), deduped, "没有那一句时原样返回");

  const journalRecent = [
    { dayKey: "2026-11-14", diary: "字".repeat(2000), handbook: { notes: "字".repeat(900), thought: "字".repeat(600), quote: "字".repeat(400) } },
    { dayKey: "2026-11-13", diary: "昨天那篇" },
    { dayKey: "2026-11-12", diary: "前天那篇" },
    { dayKey: "2026-11-11", diary: "不该出现" },
  ];
  await generateConversationReply({ ...base, journalRecent });
  const body = payload();
  assert.equal(body.journalRecent.length, 3, "最多三篇，更旧的不进提示词");
  assert.equal(body.journalRecent[0].dayKey, "2026-11-14");
  assert.equal(body.journalRecent[0].diary.length, 800);
  assert.equal(body.journalRecent[0].handbook.notes.length, 500);
  assert.equal(body.journalRecent[0].handbook.thought.length, 300);
  assert.equal(body.journalRecent[0].handbook.quote.length, 200);
  assert(body.journalRecent[0].diary.endsWith("…（后面还有）"), "截断要留痕");
  assert(body.journalRecent[0].handbook.notes.endsWith("…（后面还有）"));
  assert.match(system(), /journalRecent are entries you wrote yourself/);
  assert.match(system(), /never the user's/);
  assert.match(system(), /do not recite an entry in full/);

  // 群聊永远不给：手账是写给她自己的，群里复述就是泄露。
  await generateConversationReply({ ...base, groupChat: true, journalRecent });
  assert.equal(payload().journalRecent, undefined);
  assert(!system().includes("journalRecent are"), "群聊提示词不该出现这段说明");

  // 没有日记时不注入，也不多写一句提示词。
  await generateConversationReply(base);
  assert.equal(payload().journalRecent, undefined);
  assert(!system().includes("journalRecent are"));
} finally { globalThis.fetch = originalFetch; }
console.log("Journal recent prompt: latest revision, truncation, owner-only and group exclusion passed.");
