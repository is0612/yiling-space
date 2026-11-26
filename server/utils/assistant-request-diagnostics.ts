import { readModelUsage, type ModelUsageTokens } from "./model-usage";
/**
 * 单次模型请求的墙钟计时（全部为同一时钟的毫秒差值，不与别的字段累加）。
 *
 * 计时口径（重要）：本系统请求是非流式（`fetch` 一次性拿 body，再 `response.json()`）。
 * 因此**无法测得真正的流式首 Token 时间**。这里只能精确拆分三个可观测的墙钟阶段：
 *
 * - `headersMs`：请求发出到「响应头到达」（fetch resolve）的等待，近似 TTFB，但**不是**首 Token；
 * - `bodyMs`：响应头到达后，「完整 Body 读取 + JSON 解析」完成（`response.json()` resolve）的耗时；
 * - `durationMs`：总请求耗时 = headersMs + bodyMs。
 *
 * 阶段标记：`markHeaders()` 在 fetch resolve 时调用，`markBody()` 在 `response.json()`
 * resolve 时调用。任一阶段拿不到（异常、HTTP 错误、非 JSON、超时、取消、时钟回跳）
 * 时，对应字段与派生耗时留 undefined，明确按 unavailable 处理，绝不伪造。
 */
export type AssistantRequestDiagnostic = {
  status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated";
  durationMs: number;
  usageReported: boolean;
  finishReason?: "stop" | "length" | "content_filter" | "unknown";
  /** 响应自报的模型标识；只保留短 ASCII 标识，绝不复制 provider 原文。 */
  model?: string;
  /** 供应商回传的 token 计数；缺失留空，不用估算值冒充。 */
  usage?: ModelUsageTokens;
  /** 请求发出时刻（epoch ms）。 */
  startedAt?: number;
  /** 响应头到达时刻（fetch resolve，epoch ms）。无法测量时不写。 */
  headersAt?: number;
  /** Body 读取 + JSON 解析完成时刻（response.json resolve，epoch ms）。无法测量时不写。 */
  bodyAt?: number;
  /** 请求结束时刻（epoch ms）。 */
  endedAt?: number;
  /** 响应头等待耗时 = headersAt - startedAt；无法测量时不写。近似 TTFB，不是首 Token。 */
  headersMs?: number;
  /** Body 读取 + JSON 解析耗时 = bodyAt - headersAt；无法测量时不写。 */
  bodyMs?: number;
};
export type AssistantRequestObserver = (entry: AssistantRequestDiagnostic) => void;
const MODEL_ID = /^[\w.:/-]{1,120}$/;
const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, Math.round(value)));
const epoch = (value: number): number => clamp(value, 4_102_444_800_000);
const wall = (value: number): number => clamp(value, 3_600_000);
/** One terminal event per actual request. No prompt, identity, provider error or reasoning text. */
export function startAssistantRequest(observer?: AssistantRequestObserver) {
  const start = Date.now(); let completed = false;
  let headersAt: number | undefined;
  let bodyAt: number | undefined;
  return {
    /** 响应头到达（fetch resolve）时调用一次；重复调用只记第一次。 */
    markHeaders() {
      if (headersAt === undefined) headersAt = Date.now();
    },
    /** Body 读取 + JSON 解析完成（response.json resolve）时调用一次；重复调用只记第一次。 */
    markBody() {
      if (bodyAt === undefined) bodyAt = Date.now();
    },
    complete(status: AssistantRequestDiagnostic["status"], payload?: unknown) {
      if (completed) return; completed = true;
      if (!observer) return;
      try {
        const endedAt = Date.now();
        const root = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const choices = Array.isArray(root.choices) ? root.choices : [];
        const first = choices[0] !== null && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
        const finish = first.finish_reason;
        const finishReason = typeof finish === "string" && ["stop", "length", "content_filter"].includes(finish)
          ? finish as "stop" | "length" | "content_filter" : payload === undefined ? undefined : "unknown";
        const usage = root.usage !== null && typeof root.usage === "object" && !Array.isArray(root.usage) ? root.usage as Record<string, unknown> : null;
        const usageReported = Boolean(usage && ["prompt_tokens", "completion_tokens", "total_tokens"].some(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && Number(usage[key]) >= 0));
        const reportedUsage = usageReported ? readModelUsage(payload) : null;
        const reportedModel = typeof root.model === "string" && MODEL_ID.test(root.model.trim()) ? root.model.trim() : undefined;
        // 阶段标记必须满足「start ≤ headers ≤ body ≤ ended」，时钟回跳（乱序）则视为不可用。
        const validHeaders = headersAt !== undefined && headersAt >= start && headersAt <= endedAt;
        const validBody = bodyAt !== undefined && bodyAt >= (validHeaders ? headersAt! : start) && bodyAt <= endedAt;
        observer({ status: finishReason === "length" && (status === "success" || status === "invalid_response") ? "truncated" : status,
          durationMs: wall(endedAt - start), usageReported,
          startedAt: epoch(start), endedAt: epoch(endedAt),
          ...(finishReason ? { finishReason } : {}), ...(reportedModel ? { model: reportedModel } : {}), ...(reportedUsage ? { usage: reportedUsage } : {}),
          ...(validHeaders ? { headersAt: epoch(headersAt!), headersMs: wall(headersAt! - start) } : {}),
          ...(validBody ? { bodyAt: epoch(bodyAt!), bodyMs: wall(bodyAt! - (validHeaders ? headersAt! : start)) } : {}) });
      } catch { /* Diagnostics never change a request result or retry policy. */ }
    },
  };
}
