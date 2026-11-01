import http from "node:http";

const host = "127.0.0.1";
const portInput = Number(process.env.LLM_MOCK_PORT ?? 4010);
const port = Number.isInteger(portInput) && portInput >= 1024 && portInput <= 65535 ? portInput : 4010;
const expectedApiKey = process.env.LLM_MOCK_API_KEY ?? "ci-only";

if (process.env.NODE_ENV === "production") {
  throw new Error("The CI mock LLM server must never run in production.");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 1_000_000) throw new Error("Request body exceeds mock server limit.");
  }
  return JSON.parse(body);
}

function plainCompletion(body, content) {
  return {
    id: "chatcmpl-ci-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "ci-memory-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
  };
}

/**
 * 忆泡（事件层）自检用：按 `origin`（会话来源）各造一条事件。
 *
 * 只在 `LLM_MOCK_EVENTS=1` 时启用，默认关闭 —— 其它 e2e 场景里多出一批事件会
 * 干扰「快照只写记忆」这类断言。证据消息刻意只取**同一个会话**里的用户消息
 * 与助手消息，模拟真实模型的正常行为，好让参与者引用（participantRefs）
 * 能按会话分辨。
 */
function mockEvents(messages) {
  if (process.env.LLM_MOCK_EVENTS !== "1") return undefined;
  const byOrigin = new Map();
  for (const message of messages) {
    if (!message || typeof message.id !== "string") continue;
    const origin = typeof message.origin === "string" ? message.origin : "未知来源";
    const bucket = byOrigin.get(origin) ?? { user: [], assistant: [] };
    if (message.role === "ASSISTANT") bucket.assistant.push(message);
    else bucket.user.push(message);
    byOrigin.set(origin, bucket);
  }
  const events = [];
  for (const [origin, bucket] of byOrigin) {
    const firstUser = bucket.user[0];
    if (!firstUser) continue;
    const evidence = [firstUser.id, ...(bucket.assistant[0] ? [bucket.assistant[0].id] : [])];
    events.push({
      occurredAt: firstUser.occurredAt,
      title: "CI 忆泡：" + origin,
      detail: "CI 模拟模型按会话来源生成的事件，证据只来自同一个会话。",
      keywords: ["CI", "忆泡", origin],
      participants: [origin],
      confidence: 0.9,
      evidenceMessageIds: evidence,
    });
  }
  if (process.env.LLM_MOCK_EVENTS_MIX === "1") {
    const groupUser = messages.find((message) => message?.role !== "ASSISTANT" && String(message?.origin ?? "").startsWith("QQ群"));
    const desktopAssistant = messages.find((message) => message?.role === "ASSISTANT" && message?.origin === "本地对话");
    if (groupUser && desktopAssistant) {
      events.push({
        occurredAt: groupUser.occurredAt,
        title: "CI 混源事件：群里问话与桌面回复混在一起",
        detail: "故意让一条事件的证据跨两个会话，用来验证参与者引用不会被别的会话污染。",
        keywords: ["CI", "混源"],
        participants: ["群友甲", "本地对话"],
        confidence: 0.9,
        evidenceMessageIds: [groupUser.id, desktopAssistant.id],
      });
    }
  }
  return events;
}

function chatCompletion(body, content) {
  return {
    id: "chatcmpl-ci-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "ci-memory-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(content) },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 },
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, service: "ci-mock-llm" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }
  if (request.headers.authorization !== "Bearer " + expectedApiKey) {
    sendJson(response, 401, { error: { message: "Invalid CI test key" } });
    return;
  }

  try {
    const body = await readJson(request);
    const systemMessage = Array.isArray(body.messages)
      ? body.messages.find((message) => message && message.role === "system" && typeof message.content === "string")
      : undefined;
    const userMessage = Array.isArray(body.messages)
      ? body.messages.find((message) => message && message.role === "user" && typeof message.content === "string")
      : undefined;
    if (!userMessage) {
      sendJson(response, 400, { error: { message: "Missing structured input" } });
      return;
    }

    // 群公告走裸文本调用，userPrompt 不是 JSON；用系统提示里的标记区分。
    if (typeof systemMessage?.content === "string" && systemMessage.content.includes("YILING_GROUP_ANNOUNCEMENT_V1")) {
      sendJson(response, 200, plainCompletion(
        body,
        "【CI 公告草稿】本周六晚八点群活动，欢迎大家参加；有想聊的话题可以直接在群里说。",
      ));
      return;
    }

    const input = JSON.parse(userMessage.content);
    if (typeof systemMessage?.content === "string" && /YILING_CONVERSATION_REPLY_V\d/.test(systemMessage.content)) {
      const forbiddenPromptKeys = ["apiKey", "apiBaseUrl", "model", "temperature", "maxTokens"];
      const leakedSetting = forbiddenPromptKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (leakedSetting) {
        sendJson(response, 400, { error: { message: "Chat prompt must not contain provider connection settings." } });
        return;
      }
      const memories = Array.isArray(input.memories) ? input.memories : [];
      const snapshots = Array.isArray(input.snapshots) ? input.snapshots : [];
      const privateScopeSentinel = "YILING_PRIVATE_SCOPE_ONLY_SENTINEL_";
      if (JSON.stringify({ memories, snapshots }).includes(privateScopeSentinel)) {
        sendJson(response, 400, { error: { message: "Another user's private-scope memory must never enter this user's chat prompt." } });
        return;
      }
      const firstMemory = memories[0] && typeof memories[0].id === "string" ? memories[0].id : null;
      const firstSnapshot = snapshots[0] && typeof snapshots[0].id === "string" ? snapshots[0].id : null;
      // 只在给了清单时才挑一张 —— 用来验证「模型选表情 → 渠道发出去」这条链路。
      // 真实模型大多数时候会返回空数组，这里恒定挑第一张只是为了测试能断言。
      const availableFaces = Array.isArray(input.availableFaces) ? input.availableFaces : [];
      const pickedFace = availableFaces[0] && typeof availableFaces[0].id === "string" ? availableFaces[0].id : null;
      // 「引用」「点名」两条路径都要能端到端验：带哨兵的那条就是她要接/要叫的人，
      // 与真实模型回填 replyToMessageId / atMessageId 是同一个字段。
      const transcript = Array.isArray(input.transcript) ? input.transcript : [];
      const lineWith = (token) => transcript.find(
        (line) => line && typeof line.id === "string" && String(line.content ?? "").includes(token),
      );
      const quoteLine = lineWith("CI_QUOTE_REPLY");
      const atLine = lineWith("CI_AT_REPLY");
      /**
       * 模型答对了，只是套了层 ```json 围栏。
       *
       * 这是 `response_format: json_object` 下最常见的坏输出，也是最容易被我们自己判死的：
       * 内容完全正确，只是 `JSON.parse` 解不动。走 `plainCompletion` 才能原样吐围栏文本
       * （`chatCompletion` 会替我们 stringify，那就永远构造不出这个场景）。
       */
      const fencedLine = lineWith("CI_FENCED_JSON");
      if (fencedLine) {
        sendJson(response, 200, plainCompletion(body, "```json\n" + JSON.stringify({
          reply: "CI 围栏里的模型回复",
          usedMemoryIds: firstMemory ? [firstMemory] : [],
          usedSnapshotIds: firstSnapshot ? [firstSnapshot] : [],
        }) + "\n```"));
        return;
      }
      /**
       * 让她这一轮闭嘴。
       *
       * 用来验「被澄清的 @ 允许沉默」：这一轮 `mustReply` 是不是 false 由闸门决定，
       * 假模型这里只负责把它演出来 —— 真正的分叉点在 at 段 + 正文像不像澄清。
       */
      if (lineWith("CI_SILENT")) {
        sendJson(response, 200, chatCompletion(body, {
          action: "silent",
          reply: "",
          usedMemoryIds: [],
          usedSnapshotIds: [],
        }));
        return;
      }
      const groupDecision = quoteLine || atLine
        ? {
            relation: "direct",
            ...(quoteLine ? { replyToMessageId: quoteLine.id } : {}),
            ...(atLine ? { atMessageId: atLine.id } : {}),
            evidenceMessageIds: [(quoteLine || atLine).id],
          }
        : undefined;
      sendJson(response, 200, chatCompletion(body, {
        reply: "CI 模拟模型回复：" + String(input.currentMessage ?? "").slice(0, 150),
        usedMemoryIds: firstMemory ? [firstMemory] : [],
        usedSnapshotIds: firstSnapshot ? [firstSnapshot] : [],
        faces: pickedFace ? [pickedFace] : [],
        ...(groupDecision ? { groupDecision } : {}),
      }));
      return;
    }

    const sourceMessages = Array.isArray(input.messages) ? input.messages : [];
    const source = sourceMessages.find((message) => message && message.role === "USER" && typeof message.id === "string")
      || sourceMessages.find((message) => message && typeof message.id === "string");
    const evidenceMessageIds = source ? [source.id] : [];
    const memoryContent = source ? "CI AI 提炼记忆：" + String(source.content ?? "").slice(0, 500) : "";
    const analysis = {
      summary: "CI 模拟模型已分析当前周期的 " + sourceMessages.length + " 条抽样对话。",
      importantEvents: source ? [{
        title: "周期对话来源验证",
        detail: "CI 模拟模型依据真实消息 ID 生成结构化分析。",
        evidenceMessageIds,
      }] : [],
      factAndPreferenceChanges: source ? [{
        description: "CI 模拟模型产出的记忆必须保留原始消息证据。",
        changeType: "新增",
        evidenceMessageIds,
      }] : [],
      relationshipChanges: [],
      goalsAndCommitments: [],
      unresolvedTopics: [],
      differencesFromPrevious: ["CI 本地模拟模型已完成一次周期提炼。"],
      memoryChanges: source ? [{
        action: "ADD",
        category: "PREFERENCE",
        content: memoryContent,
        confidence: 0.99,
        evidenceMessageIds,
      }] : [],
    };
    const events = mockEvents(sourceMessages);
    if (events) analysis.events = events;
    sendJson(response, 200, chatCompletion(body, analysis));
  } catch (error) {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request" } });
  }
});

server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "mock-llm-ready", host, port }) + "\n");
});
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
