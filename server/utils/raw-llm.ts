/**
 * 裸文本模型调用 —— 直接打 chat/completions，**不套**聊天回复那套 JSON 契约。
 *
 * 原来的名字是 `callBiliModel`（B站值班专用），主动机制也要同一套重试与预算逻辑，
 * 所以抽到这里；`channel-adapter/bili/llm.ts` 只留一层兼容导出。
 *
 * 为什么不能复用 `generateConversationReply`（踩过的坑，2026-10-28）：
 *   它是给「聊天」写的：强制 `response_format: json_object`，并要求模型返回
 *   `{ reply, usedMemoryIds, usedSnapshotIds }`，拿不到非空 `reply` 就抛 LLM_INVALID_RESPONSE。
 *   而值班要的是「给个 BV 号的 JSON 数组」「按三行回答」——
 *   模型看到题目要数组就直接回数组，wrapper 解不出 `reply` 字段：
 *   粗筛整轮返回空 ⇒ 所有候选都被记成「粗筛没留」⇒ 报告里 0 条挑中，看起来像「全跳过了」。
 *   实测：人设 + 刷站口味（system 约 3400 字）时必现；只放人设（2000 字）时侥幸能过 ——
 *   所以这是个「内容一变长就爆」的脆弱依赖，不是偶发。
 *
 * 第二个坑（同一天，紧接着踩到）：**思考型模型会把 max_tokens 先花在思考上**。
 *   给 800 的预算，实测 25 条候选时 `finish_reason=length`、`reasoning_tokens=800`、正文是空的 ——
 *   因为思考过程本身就要 1300~1500 tokens。表现是 LLM_EMPTY_REPLY，看起来像「模型什么都没说」。
 *   所以这里做了三件事：
 *     1. 默认预算给足（`RAW_MODEL_MIN_TOKENS`），别拿聊天回复的 800 去套；
 *     2. 正文为空且是 `length` 截断时，自动把预算翻倍重试一次（最多 8192）；
 *     3. 仍然空就把 `finish_reason` / 思考 token 数写进错误里，一眼能看出是「预算不够」而不是「内容被过滤」。
 *
 * 值班的每一步都是「判断 + 摘录」，用裸文本更稳：
 *   - 粗筛：只输出 BV 数组（裸数组也认，`parseJsonLoose` 能解）
 *   - 终判：三行「判断 / 理由 / 评论」，本来就是纯文本格式，包在 JSON 里纯属浪费 token
 */

import { buildChatCompletionsEndpoint } from "./chat-model-config";
import { readModelUsage, type ModelUsageTokens } from "./model-usage";

export type RawModelCall = {
  /** 人设 + 值班章程（同一个角色三端共用的那份，加上这台账号的口味）。 */
  systemPrompt: string;
  /** 这一轮的具体任务（候选列表 / 看懂的正文 + 判断要求）。 */
  userPrompt: string;
  model: string;
  apiKey: string;
  apiBaseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * 每次 HTTP 请求的用量回调（重试会调两次）。
   * 用回调而不是改返回值：调用点有粗筛/终判/写评论三处，改返回类型会波及全部解析逻辑。
   */
  onUsage?: (usage: ModelUsageTokens) => void;
};

/**
 * 思考型模型的默认预算。
 * 实测同一批 25 条候选，思考 token 在 1500~2150 之间浮动（同一模型两次跑都不一样），
 * 所以按 4096 起步 —— max_tokens 只有在真的用到时才计费，给宽不会变贵，给窄会直接空正文。
 */
export const RAW_MODEL_MIN_TOKENS = 4096;
const RETRY_CEILING = 8192;
const DEFAULT_TIMEOUT_MS = 90_000;

type Attempt = {
  content: string;
  finishReason: string;
  reasoningTokens: number;
  reasoningChars: number;
  usage: ModelUsageTokens | null;
};

function readAttempt(payload: unknown): Attempt {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
  const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return {
    content: typeof message.content === "string" ? message.content.trim() : "",
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : "",
    reasoningTokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0,
    reasoningChars: reasoning.length,
    usage: readModelUsage(payload),
  };
}

export async function callRawModel(input: RawModelCall): Promise<string> {
  const apiKey = input.apiKey?.trim() || process.env.LLM_API_KEY?.trim();
  const model = input.model?.trim() || process.env.LLM_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("LLM_NOT_CONFIGURED: 角色未配置模型或 API Key。");
  }

  const baseUrl = input.apiBaseUrl?.trim() || process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(baseUrl);
  } catch (error) {
    throw new Error("LLM_INVALID_BASE_URL: " + (error instanceof Error ? error.message : String(error)));
  }

  const timeoutRaw = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 5_000 && timeoutRaw <= 180_000
    ? Math.max(timeoutRaw, input.timeoutMs ?? 0)
    : input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const temperature = typeof input.temperature === "number" ? input.temperature : 0.3;
  const budget = Math.max(input.maxTokens ?? RAW_MODEL_MIN_TOKENS, 256);

  const postOnce = async (maxTokens: number): Promise<Attempt> => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("LLM_TIMEOUT: 模型请求超时，请检查 LLM_TIMEOUT_MS 或模型服务状态。");
      }
      throw new Error("LLM_NETWORK_ERROR: " + (error instanceof Error ? error.message : String(error)));
    }

    if (!response.ok) {
      throw new Error(`LLM_HTTP_ERROR: 模型服务返回 HTTP ${response.status}。请检查 API 地址、Key 和模型权限。`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("LLM_INVALID_RESPONSE: 模型服务没有返回有效的 JSON 响应。");
    }
    const attempt = readAttempt(payload);
    // 每次请求都记账：被截断后重试的那一次同样花了 token，漏记会让额度偏低。
    if (attempt.usage) input.onUsage?.(attempt.usage);
    return attempt;
  };

  let attempt = await postOnce(budget);
  // 思考型模型被 token 上限截断时，正文整个是空的 —— 翻倍再来一次，别让一整轮白跑。
  if (!attempt.content && attempt.finishReason === "length" && budget < RETRY_CEILING) {
    const retryBudget = Math.min(budget * 3, RETRY_CEILING);
    const retried = await postOnce(retryBudget);
    if (retried.content) return retried.content.slice(0, 12_000);
    attempt = retried;
  }

  if (attempt.content) return attempt.content.slice(0, 12_000);

  const spent = attempt.reasoningTokens
    ? `思考已用 ${attempt.reasoningTokens} tokens`
    : `思考内容 ${attempt.reasoningChars} 字`;
  if (attempt.finishReason === "length") {
    throw new Error(
      `LLM_EMPTY_REPLY: 模型的思考过程把 token 用光了，正文还没来得及输出（finish_reason=length，${spent}）。`
      + "这是思考型模型的常见行为：调大 max_tokens，或换一个非思考模型。",
    );
  }
  throw new Error(
    `LLM_EMPTY_REPLY: 模型没有返回正文（finish_reason=${attempt.finishReason || "未知"}，${spent}）。`,
  );
}
