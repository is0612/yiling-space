import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { createReadOnlyChatTools } from "../server/utils/readonly-chat-tools";
const original = globalThis.fetch;
const base = { characterName: "测试角色", characterPrompt: "测试", model: "mock", apiKey: "fake", apiBaseUrl: "https://mock.example/v1", currentMessage: "查一下之前的约定", recentMessages: [], memories: [], snapshots: [] };
const response = (message: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status });
let lookups = 0;
try {
  const tools = createReadOnlyChatTools({ searchMemory: async () => { lookups++; return [{ content: "授权证据" }]; } });
  assert.match(await tools.call("unknown", "{}"), /invalid_tool/);
  assert.match(await tools.call("search_memory", '{"query":"约定","scope":"private"}'), /invalid_arguments/);
  await tools.call("search_memory", '{"query":"约定"}');
  await tools.call("search_memory", '{"query":"约定"}');
  assert.equal(lookups, 1);
  assert.match(await tools.call("search_memory", '{"query":"其他"}'), /budget/);
  const webpageTools = createReadOnlyChatTools({}, "读取 https://example.com/readme");
  assert.match(await webpageTools.call("read_public_webpage", '{"url":"https://example.com/readme?secret=private"}'), /url_not_in_current_task/);
  let requests = 0;
  lookups = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools.length, 3);
    if (requests === 1) return response({ content: null, reasoning_content: "temporary reasoning", tool_calls: [{ id: "call-1", type: "function", function: { name: "search_memory", arguments: '{"query":"约定"}' } }] });
    assert.equal(body.messages.at(-1).role, "tool");
    assert.equal(body.messages.at(-2).reasoning_content, "temporary reasoning");
    assert.match(body.messages.at(-1).content, /授权证据/);
    return response({ content: JSON.stringify({ reply: "找到了之前的约定。", usedMemoryIds: [], usedSnapshotIds: [] }) });
  };
  const result = await generateConversationReply({ ...base, readOnlyTools: { searchMemory: async () => { lookups++; return [{ content: "授权证据" }]; }, searchKnowledge: async () => [] } });
  assert.equal(requests, 2); assert.equal(lookups, 1); assert.equal(result.usage?.totalTokens, 24);
  requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++; const body = JSON.parse(String(init?.body));
    if (requests === 1) { assert(body.tools); return response({}, 422); }
    assert(!body.tools); return response({ content: '{"reply":"正常回复","usedMemoryIds":[],"usedSnapshotIds":[]}' });
  };
  assert.equal((await generateConversationReply({ ...base, readOnlyTools: {} })).reply, "正常回复");
  console.log("Read-only tools: whitelist, argument validation, budgets, cached queries, native continuation, reasoning, usage and unsupported-provider fallback passed (mock only).");
} finally { globalThis.fetch = original; }
