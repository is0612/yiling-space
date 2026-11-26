import { readModelUsage, type ModelUsageTokens } from "./model-usage";
export type AssistantRequestDiagnostic = {
  status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated";
  durationMs: number;
  usageReported: boolean;
  finishReason?: "stop" | "length" | "content_filter" | "unknown";
  /** 响应自报的模型标识；只保留短 ASCII 标识，绝不复制 provider 原文。 */
  model?: string;
  /** 供应商回传的 token 计数；缺失留空，不用估算值冒充。 */
  usage?: ModelUsageTokens;
};
export type AssistantRequestObserver = (entry: AssistantRequestDiagnostic) => void;
const MODEL_ID = /^[\w.:/-]{1,120}$/;
/** One terminal event per actual request. No prompt, identity, provider error or reasoning text. */
export function startAssistantRequest(observer?: AssistantRequestObserver) {
  const start = Date.now(); let completed = false;
  return {
    complete(status: AssistantRequestDiagnostic["status"], payload?: unknown) {
      if (completed) return; completed = true;
      if (!observer) return;
      try {
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
        observer({ status: finishReason === "length" && (status === "success" || status === "invalid_response") ? "truncated" : status, durationMs: Math.max(0, Date.now() - start), usageReported,
          ...(finishReason ? { finishReason } : {}), ...(reportedModel ? { model: reportedModel } : {}), ...(reportedUsage ? { usage: reportedUsage } : {}) });
      } catch { /* Diagnostics never change a request result or retry policy. */ }
    },
  };
}
