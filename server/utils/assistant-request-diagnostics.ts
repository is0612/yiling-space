import { readModelUsage, type ModelUsageTokens } from "./model-usage";
/**
 * 单次模型请求的墙钟计时（全部为同一时钟的毫秒差值，不与别的字段累加）。
 *
 * 首 Token 口径：本系统请求是非流式（一次性读完整 JSON body），因此没有真正的
 * 流式首 token 时间。`firstByteAt` 记录的是「首个有效响应 body 到达」的时刻——
 * 也就是 `response.json()` 成功 resolve 的点。它 ≥ 真实 TTFB，但在非流式协议下
 * 是能诚实测得、且能区分「等首字节」与「读完整响应」这两个阶段的最佳代理。
 * 拿不到时 `firstByteAt` 与派生的 `ttfbMs` / `tailMs` 都留 undefined，不伪造。
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
  /** 首个有效响应 body 到达时刻（epoch ms）。无法测量时不写。 */
  firstByteAt?: number;
  /** 请求结束时刻（epoch ms）。 */
  endedAt?: number;
  /** 首字节等待时间 = firstByteAt - startedAt；无法测量时不写。 */
  ttfbMs?: number;
  /** 首字节之后的剩余响应时间 = endedAt - firstByteAt；无法测量时不写。 */
  tailMs?: number;
};
export type AssistantRequestObserver = (entry: AssistantRequestDiagnostic) => void;
const MODEL_ID = /^[\w.:/-]{1,120}$/;
const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, Math.round(value)));
/** One terminal event per actual request. No prompt, identity, provider error or reasoning text. */
export function startAssistantRequest(observer?: AssistantRequestObserver) {
  const start = Date.now(); let completed = false;
  let firstByteAt: number | undefined;
  return {
    /** 首个有效响应数据到达时调用一次；重复调用只记第一次，异常调用被吞掉。 */
    markFirstByte() {
      if (firstByteAt === undefined) firstByteAt = Date.now();
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
        // 只有真的测到了首字节才派生 ttfb / tail；首字节在结束之后（时钟跳变）也视为不可用。
        const hasFirstByte = firstByteAt !== undefined && firstByteAt <= endedAt;
        observer({ status: finishReason === "length" && (status === "success" || status === "invalid_response") ? "truncated" : status,
          durationMs: clamp(endedAt - start, 3_600_000), usageReported,
          startedAt: clamp(start, 4_102_444_800_000), endedAt: clamp(endedAt, 4_102_444_800_000),
          ...(finishReason ? { finishReason } : {}), ...(reportedModel ? { model: reportedModel } : {}), ...(reportedUsage ? { usage: reportedUsage } : {}),
          ...(hasFirstByte ? { firstByteAt: clamp(firstByteAt!, 4_102_444_800_000), ttfbMs: clamp(firstByteAt! - start, 3_600_000), tailMs: clamp(endedAt - firstByteAt!, 3_600_000) } : {}) });
      } catch { /* Diagnostics never change a request result or retry policy. */ }
    },
  };
}
