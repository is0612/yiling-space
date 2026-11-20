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
  requests = 0;
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests++;
    if (requests === 1) {
      assert.equal(body.response_format.type, "json_object");
      return response({ content: "   " });
    }
    assert.equal(body.response_format, undefined);
    if (requests === 2) return response({ content: null, tool_calls: [{ id: "write-1", type: "function", function: {
      name: "propose_file_write", arguments: '{"root":"test","path":"list.txt","content":"Milk","reason":"test"}',
    } }] });
    assert.match(body.messages.at(-1).content, /PENDING_APPROVAL/);
    return response({ content: "" });
  };
  const repaired = await generateConversationReply({ ...base, readOnlyTools: { proposeFileWrite: async () => {
    writes++;
    return { status: "PENDING_APPROVAL", requestId: "fixture" };
  } } });
  assert.equal(writes, 1);
  assert.equal(requests, 3);
  assert.match(repaired.reply, /申请已提交，文件还没有写入/);
  requests = 0;
  writes = 0;
  const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="propose_file_write">'
    + Object.entries({ root: "test", path: "role.txt", content: "角色互动说明", reason: "test" }).map(([key, value]) =>
      `<｜｜DSML｜｜ parameter name="${key}" string="true">${value}</｜｜DSML｜｜ parameter>`).join("\n")
    + '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (requests === 1) return response({ content: dsml });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages.at(-2).content, null);
    assert.match(body.messages.at(-1).content, /PENDING_APPROVAL/);
    return response({ content: "" });
  };
  const dsmlReply = await generateConversationReply({ ...base, readOnlyTools: { proposeFileWrite: async (root, file, text) => {
    writes++;
    assert.deepEqual([root, file, text], ["test", "role.txt", "角色互动说明"]);
    return { status: "PENDING_APPROVAL", requestId: "fixture" };
  } } });
  assert.equal(writes, 1);
  assert.equal(requests, 2);
  assert.match(dsmlReply.reply, /申请已提交，文件还没有写入/);
  globalThis.fetch = async () => response({ content: dsml });
  await assert.rejects(() => generateConversationReply({ ...base, readOnlyTools: {} }), /LLM_INVALID_RESPONSE/);
  requests = 0;
  writes = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests++;
    if (requests <= 3) {
      assert.equal(body.tool_choice, "auto", "Third tool round must still allow the write proposal");
      const sequence = [
        { name: "list_local_roots", arguments: "{}" },
        { name: "list_local_directory", arguments: '{"root":"test"}' },
        { name: "propose_file_write", arguments: '{"root":"test","path":"list.txt","content":"Milk","reason":"test"}' },
      ];
      return response({ content: null, tool_calls: [{ id: `seq-${requests}`, type: "function", function: sequence[requests - 1] }] });
    }
    return response({ content: '{"reply":"申请已提交，请批准。"}' });
  };
  await generateConversationReply({ ...base, readOnlyTools: {
    localRoots: async () => [{ id: "test", mode: "READ_WRITE" }],
    listLocalFiles: async () => ({ entries: [] }),
    proposeFileWrite: async () => { writes++; return { status: "PENDING_APPROVAL", requestId: "sequence-fixture" }; },
  } });
  assert.equal(requests, 4);
  assert.equal(writes, 1);
  const localTools = createReadOnlyChatTools({
    localRoots: async () => [{ id: "project", label: "项目目录" }],
    listLocalFiles: async (root, path) => ({ root, path, entries: [] }),
    readLocalFile: async () => ({ content: "x" }),
    searchLocalFiles: async () => ({ matches: [] }),
    proposeFileWrite: async () => ({ status: "PENDING_APPROVAL" }),
  });
  assert.equal(localTools.definitions.length, 6);
  assert.match(await localTools.call("list_local_directory", '{"root":"project"}'), /untrustedEvidence/);
  assert.match(await localTools.call("read_local_file", '{"root":"project"}'), /invalid_arguments/);
  assert.match(await localTools.call("list_local_roots", '{"extra":"x"}'), /invalid_arguments/);
  assert.match(await localTools.call("propose_file_write", '{"root":"project","path":"a.txt","content":"x","reason":"test"}'), /PENDING_APPROVAL/);
  const resumeTools = createReadOnlyChatTools({ readLocalTask: async () => ({ id: "current", status: "RUNNING", completed: ["write"] }) });
  assert.match(await resumeTools.call("read_current_local_task", "{}"), /current/);
  assert.match(await resumeTools.call("read_current_local_task", '{"taskId":"another"}'), /invalid_arguments/);
  assert.match(await createReadOnlyChatTools({}).call("read_current_local_task", "{}"), /invalid_tool_call/);
  const taskTools = createReadOnlyChatTools({ createLocalTask: async () => ({ taskId: "t1" }) });
  assert.equal(taskTools.definitions.length, 2);
  assert.match(await taskTools.call("create_local_task", '{"title":"t","goal":"g","plan":"p"}'), /t1/);
  const commandTools = createReadOnlyChatTools({ proposeCommand: async () => ({ status: "PENDING_APPROVAL" }) });
  assert.equal(commandTools.definitions.length, 2);
  assert.match(await commandTools.call("propose_terminal_command", '{"root":"project","command":"node","args":"[]","reason":"test"}'), /PENDING_APPROVAL/);
  const gitTools = createReadOnlyChatTools({
    inspectGit: async (root, cwd) => ({ root, cwd, branch: "main" }),
    proposeGitBranch: async () => ({ status: "PENDING_APPROVAL" }),
  });
  assert.match(await gitTools.call("inspect_local_git", '{"root":"project"}'), /main/);
  assert.match(await gitTools.call("inspect_local_git", '{"root":"project","file":"notes.txt"}'), /invalid_arguments/);
  assert.match(await gitTools.call("propose_git_branch", '{"root":"project","branch":"work/notes","reason":"test"}'), /PENDING_APPROVAL/);
  assert.match(await createReadOnlyChatTools({}).call("inspect_local_git", '{"root":"project"}'), /invalid_tool_call/);
  let observed = 0;
  const browserTools = createReadOnlyChatTools({ observeBrowser: async url => { observed++; return { url, text: "rendered fixture" }; } }, "请观察 https://example.com/read");
  assert.match(await browserTools.call("observe_public_browser", '{"url":"https://example.com/read?secret=private"}'), /tool_unavailable/);
  assert.equal(observed, 0);
  assert.match(await browserTools.call("observe_public_browser", '{"url":"https://example.com/read"}'), /rendered fixture/);
  assert.equal(observed, 1);
  assert.match(await createReadOnlyChatTools({}).call("observe_public_browser", '{"url":"https://example.com/read"}'), /invalid_tool_call/);
  console.log("Read-only tools: whitelist, argument validation, budgets, cached queries, native continuation, reasoning, usage, unsupported-provider fallback and local tools passed (mock only).");
} finally { globalThis.fetch = original; }
