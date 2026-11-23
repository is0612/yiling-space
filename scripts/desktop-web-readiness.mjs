import { setTimeout as sleep } from "node:timers/promises";

/** Probe the real API, not Nuxt's startup HTML. Never log response bodies or errors with credentials. */
export async function probeDesktopWeb(url, requestMs = 1500) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(requestMs), redirect: "manual" });
    const status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      return { ready: false, status, reason: "http_error" };
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return { ready: false, status, reason: "unexpected_content" };
    }
    const health = await response.json();
    return health?.ok === true && health?.service === "yiling-space"
      ? { ready: true, status, reason: "ready" }
      : { ready: false, status, reason: "invalid_health" };
  } catch {
    return { ready: false, reason: "request_failed" };
  }
}

export async function waitDesktopWeb(url, { totalMs, requestMs = 1500, intervalMs = 500, cancelled = () => false, onProbe = () => {} }) {
  const deadline = Date.now() + totalMs;
  let last = { ready: false, reason: "request_failed" };
  let signature = "";
  while (Date.now() < deadline && !cancelled()) {
    last = await probeDesktopWeb(url, Math.max(1, Math.min(requestMs, deadline - Date.now())));
    const nextSignature = `${last.status || 0}:${last.reason}`;
    if (nextSignature !== signature) { onProbe(last); signature = nextSignature; }
    if (last.ready) return last;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return last;
}

export function desktopWebFailure(result, totalMs) {
  return `网页服务没有在 ${Math.round(totalMs / 1000)} 秒内就绪。健康检查 /api/health：${result.status ? `HTTP ${result.status}` : "连接失败或请求超时"}（${result.reason}）。请查看 desktop-supervisor.log 中 nitro 的启动错误。`;
}
