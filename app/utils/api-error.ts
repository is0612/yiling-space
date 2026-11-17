/**
 * 把 $fetch / useRequestFetch 抛出的错误翻成一句能展示的话。
 *
 * Nuxt 的 FetchError 把服务端 createError 的正文放在 data 里：
 * - 4xx / 自定义错误：data.statusMessage 是给人看的原因
 * - 未捕获的 500：statusMessage 往往只是 "Internal Server Error"，
 *   真正原因在 data.message / message（例如模型输出校验失败）
 */
const IGNORED = new Set(["Internal Server Error", "fetch failed", "Failed to fetch"]);

export function readApiErrorMessage(
  error: unknown,
  fallback = "操作失败，请检查本地开发服务器日志。",
): string {
  if (error && typeof error === "object") {
    const e = error as {
      statusMessage?: unknown;
      message?: unknown;
      data?: { statusMessage?: unknown; message?: unknown };
    };
    const candidates = [e.data?.statusMessage, e.statusMessage, e.data?.message, e.message];
    for (const candidate of candidates) {
      const message = typeof candidate === "string" ? candidate.trim() : "";
      if (message && !IGNORED.has(message)) return message;
    }
  }
  return fallback;
}
