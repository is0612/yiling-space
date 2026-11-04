/**
 * 桌宠接入层：把 OpenAI Chat Completions 协议翻译成忆灵空间的角色对话接口。
 *
 * 为什么是一个独立进程而不是 Nuxt 里的路由：
 *   1. 桌宠只认 `/v1/chat/completions`，而 `server/api/characters/[id]/chat.post.ts`
 *      是自定义请求体（message / conversationId / requestKey），两边协议对不上；
 *   2. 主仓库的鉴权只认 session cookie，为桌宠加 Bearer 通道要动 `auth.ts` 的语义；
 *   3. 这一层随时可能因为桌宠升级而调整，放在主仓库外，删掉即回滚。
 *
 * 所以它只做协议翻译，人设、记忆检索、prompt 组装、落库、记忆提炼全部交给原接口——
 * 聊天记录会正常写进 Conversation，后续 scheduler 照常提炼成忆泡与快照。
 *
 * 用法：node scripts/pet-bridge/server.mjs
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_PATH = resolve(ROOT, ".data/pet-bridge-state.json");

/** 忆灵空间主服务。只允许回环地址——免登录鉴权依赖 Host 头是 localhost/127.0.0.1。 */
const UPSTREAM = (process.env.YILING_PET_UPSTREAM || "http://127.0.0.1:3000").replace(/\/+$/, "");
const LISTEN_PORT = Number(process.env.YILING_PET_PORT || 3179);
/** 当桌宠传来的 model 既不是角色 uuid 也匹配不到名字时的兜底角色。 */
const DEFAULT_CHARACTER = process.env.YILING_PET_CHARACTER || "";

/** 模型可能要想很久，超时给足；桌宠那边超时是它自己的设置。 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.YILING_PET_TIMEOUT_MS || 180_000);

// ---------------------------------------------------------------------------
// 状态：每个角色记住自己那条会话，避免每次新建
// ---------------------------------------------------------------------------

/**
 * 会话必须复用。忆泡是按记忆范围+时间提炼的，如果每句话都新开一条会话，
 * 桌面上聊的东西在库里就是一堆孤立片段，提炼出来的事件接不上前因后果。
 */
function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return raw && typeof raw === "object" && raw.conversations ? raw : { conversations: {} };
  } catch {
    return { conversations: {} };
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, STATE_PATH);
  } catch (error) {
    // 状态写不进去只影响「这次新建了会话、下次再新建」，不该让对话失败。
    log(`[warn] 会话状态写入失败：${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

const log = (message) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);

async function fetchUpstream(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(`${UPSTREAM}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 角色列表缓存：桌宠拉模型列表、以及按名字反查 id 都会用到。 */
let characterCache = { at: 0, items: [] };

async function listCharacters() {
  if (Date.now() - characterCache.at < 5_000) return characterCache.items;
  const response = await fetchUpstream("/api/characters");
  if (!response.ok) throw new Error(`读取角色列表失败：HTTP ${response.status}`);
  const items = await response.json();
  characterCache = { at: Date.now(), items: Array.isArray(items) ? items : [] };
  return characterCache.items;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 桌宠里「模型」那一栏就是角色选择器。
 *
 * 桌宠本身支持多角色且每个角色有独立配置，所以让它填 uuid 是最直接的对应关系；
 * 填角色名也认，省得去数据库里翻 id。
 */
async function resolveCharacterId(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  if (UUID_PATTERN.test(raw)) return raw;
  if (DEFAULT_CHARACTER && (!raw || raw === "default")) return DEFAULT_CHARACTER;

  const characters = await listCharacters();
  if (raw) {
    const hit = characters.find((item) => item.name === raw || item.alias === raw || item.id === raw);
    if (hit) return hit.id;
  }
  if (DEFAULT_CHARACTER && characters.some((item) => item.id === DEFAULT_CHARACTER)) return DEFAULT_CHARACTER;
  const firstActive = characters.find((item) => item.status === "运行中");
  if (firstActive) return firstActive.id;
  throw new Error(`认不出要跟哪个角色对话：model=${raw || "(空)"}。请把桌宠的模型名填成角色名或角色 uuid。`);
}

/**
 * 忆灵空间只接受纯文本 `message`。桌宠可能发 content 数组（多模态），
 * 这里把文本片段拼起来，非文本片段直接标注丢弃，而不是静默当成空字符串。
 */
function extractUserMessage(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("请求里没有 messages。");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || item.role !== "user") continue;
    if (typeof item.content === "string") return item.content.trim();
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
    throw new Error("最后一条 user 消息里没有可用的文本内容（图片等富媒体暂不支持）。");
  }
  throw new Error("messages 里没有 role=user 的消息。");
}

/** 走一次真实对话：人设 + 记忆检索 + 落库全在服务端完成。 */
async function requestReply(characterId, message) {
  const state = readState();
  const knownConversationId = state.conversations[characterId];
  const body = { message, requestKey: randomUUID() };
  if (knownConversationId) body.conversationId = knownConversationId;

  let response = await fetchUpstream(`/api/characters/${encodeURIComponent(characterId)}/chat`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  // 会话被删掉了（404）：丢掉旧 id 重开一条，而不是让桌宠一直报错。
  if (response.status === 404 && knownConversationId) {
    delete state.conversations[characterId];
    writeState(state);
    log(`[info] 角色 ${characterId} 的旧会话已不存在，重新建立。`);
    response = await fetchUpstream(`/api/characters/${encodeURIComponent(characterId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ message, requestKey: randomUUID() }),
    });
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 600);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.statusMessage || parsed?.message || detail;
    } catch {
      // 非 JSON 错误体，保留原文前 600 字。
    }
    throw new Error(`忆灵空间返回 ${response.status}：${detail}`);
  }

  const payload = JSON.parse(text);
  const reply = payload?.assistantMessage?.content;
  if (typeof reply !== "string" || !reply) throw new Error("忆灵空间没有返回回复内容。");

  if (payload.conversationId && state.conversations[characterId] !== payload.conversationId) {
    state.conversations[characterId] = payload.conversationId;
    writeState(state);
  }

  return {
    reply,
    conversationId: payload.conversationId,
    model: payload?.model?.name ?? "",
    // 记忆召回情况对排查「她为什么记不住」很有用，打到日志里。
    retrieval: payload?.retrieval ?? null,
  };
}

// ---------------------------------------------------------------------------
// OpenAI 协议外壳
// ---------------------------------------------------------------------------

const sse = (res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
};

const chunkEvent = (id, model, delta, finishReason = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

/**
 * 伪流式：服务端是一次性出完整回复的，这里拿到结果再切片吐出去。
 *
 * 视觉上桌宠会「一段段冒出来」而不是逐字，但没有打字机的等待感；
 * 真正的逐字流式要改 `chat-reply.ts` 内部的 fetch，风险远大于收益，先不做。
 */
async function streamReply(res, { reply, model }) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  sse(res);
  res.write(chunkEvent(id, model, { role: "assistant" }));

  const step = reply.length > 400 ? 12 : 6;
  for (let index = 0; index < reply.length; index += step) {
    res.write(chunkEvent(id, model, { content: reply.slice(index, index + step) }));
    // 让出事件循环，否则所有 chunk 会挤在同一个 TCP 包里，前端看起来仍是一次性到达。
    await new Promise((done) => setTimeout(done, 16));
  }

  res.write(chunkEvent(id, model, {}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendOpenAiError(res, status, message) {
  sendJson(res, status, { error: { message, type: "upstream_error", code: null } });
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // 桌宠会把整段历史塞进来，给 4MB 足够；超过说明不是正常请求。
      if (size > 4 * 1024 * 1024) {
        fail(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return done({});
      try {
        done(JSON.parse(raw));
      } catch {
        fail(new Error("请求体不是合法 JSON。"));
      }
    });
    req.on("error", fail);
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${LISTEN_PORT}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    return sendJson(res, 200, { ok: true, service: "yiling-pet-bridge", upstream: UPSTREAM });
  }

  // 桌宠拉模型列表时，直接把角色名报上去，选模型等于选角色。
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    try {
      const characters = await listCharacters();
      return sendJson(res, 200, {
        object: "list",
        data: characters.map((item) => ({
          id: item.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "yiling-space",
          name: item.name,
          description: item.description ?? "",
        })),
      });
    } catch (error) {
      return sendOpenAiError(res, 502, error instanceof Error ? error.message : String(error));
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendOpenAiError(res, 400, error instanceof Error ? error.message : String(error));
    }

    try {
      const characterId = await resolveCharacterId(body?.model);
      const message = extractUserMessage(body?.messages);
      log(`[chat] 角色 ${characterId} ← ${message.slice(0, 40).replace(/\s+/g, " ")}`);

      const result = await requestReply(characterId, message);
      if (result.retrieval) {
        const { memoriesAvailable, snapshotsAvailable, memoryTokens } = result.retrieval;
        log(`[chat] 召回 记忆${memoriesAvailable ?? 0}条 / 快照${snapshotsAvailable ?? 0}篇 / ${memoryTokens ?? 0} tokens`);
      }

      if (body?.stream === true) return void (await streamReply(res, result));

      return sendJson(res, 200, {
        id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model || characterId,
        choices: [{ index: 0, message: { role: "assistant", content: result.reply }, finish_reason: "stop" }],
        // token 记账在忆灵空间服务端完成（recordModelUsage），这里不回填，
        // 免得报一个自己算出来的假数字。
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        yiling: { conversationId: result.conversationId, characterId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[error] ${message}`);
      return sendOpenAiError(res, 502, message);
    }
  }

  sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: "not_found" } });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  log(`桌宠接入层已就绪：http://127.0.0.1:${LISTEN_PORT}/v1`);
  log(`上游忆灵空间：${UPSTREAM}`);
  log(`兜底角色：${DEFAULT_CHARACTER || "(未设置，取第一个运行中角色)"}`);
});
