/** Read explicit API messages, never ofetch's method/URL wrapper or generic HTTP labels. */
const GENERIC = /^(?:bad request|unauthorized|forbidden|not found|method not allowed|conflict|too many requests|internal server error|bad gateway|service unavailable|gateway timeout|fetch failed|failed to fetch|network error|request failed|request timeout)$/iu;
function displayMessage(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && !GENERIC.test(text) && !/^\[(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\]/iu.test(text)
    && !/^(?:TypeError|FetchError|Error):/u.test(text) ? text : "";
}
export function readApiErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  if (error && typeof error === "object") {
    const e = error as { statusMessage?: unknown; message?: unknown; data?: { statusMessage?: unknown; message?: unknown } };
    for (const candidate of [e.data?.message, e.data?.statusMessage, e.statusMessage]) {
      const message = displayMessage(candidate);
      if (message) return message;
    }
    // Local/native Error text may contain URLs or internal details; only server business fields are public.
  }
  return fallback;
}
