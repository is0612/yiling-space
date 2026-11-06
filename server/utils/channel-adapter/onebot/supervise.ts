import type { OnebotConnectionConfig, OnebotHandlers, OnebotResolvedEvent } from "./client";
import { connectOnebot } from "./client";
import type { OnebotConnectionRecord } from "./configure";

export type OnebotConnectFn = (
  config: OnebotConnectionConfig,
  handlers: OnebotHandlers,
  signal?: AbortSignal,
) => Promise<() => void | Promise<void>>;

export type OnebotSuperviseOptions = {
  record: OnebotConnectionRecord;
  handleEvent: (event: OnebotResolvedEvent) => Promise<Record<string, unknown>>;
  log: (entry: Record<string, unknown>) => void;
  onStatusChange?: (status: "ready" | "error") => void;
  shouldStop?: () => boolean;
  signal?: AbortSignal;
  connect?: OnebotConnectFn;
  sleep?: (ms: number) => Promise<void>;
};

export function onebotBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * 把「处理这一条消息时抛的异常」压成一行可以落进日志的原因。
 *
 * 为什么不直接打 `error.message`：这里的异常几乎都来自下载和模型请求，而下载用的
 * 是 QQ 的临时直链 —— 整条 URL 里带着 `rkey`，写进日志等于把别人的图片地址抄了一份。
 * 所以只留「什么错、错在哪个主机」，够定位，不够泄露。
 *
 * 也不留 6 位以上的数字串：QQ 号、群号、消息 id 都在那个形状里，而排查从来不需要
 * 具体是谁 —— 需要的时候按时间点回去查库就行。
 */
export function describeHandlerError(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string" ? error : "";
  const cleaned = raw
    // 直链只保留到主机名，查询串（rkey/appid）整段吞掉。
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?<…>")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <…>")
    .replace(/\b(api[-_]?key|access_token|rkey|token)\s*=\s*[^\s&,;"']+/gi, "$1=<…>")
    .replace(/\b\d{6,}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200) || "unknown";
}

/** One timer, cancelled on abort: neither an online socket nor backoff delays shutdown. */
export function waitOnebot(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function superviseOnebotConnection(options: OnebotSuperviseOptions): Promise<void> {
  const { record, handleEvent, log, signal } = options;
  const connect = options.connect ?? connectOnebot;
  const stopped = () => !!signal?.aborted || !!options.shouldStop?.();
  let attempt = 0;
  while (!stopped()) {
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    signal?.addEventListener("abort", abort, { once: true });
    // Backwards-compatible shouldStop callers also get active socket cancellation.
    const stopTimer = options.shouldStop ? setInterval(() => {
      if (stopped()) lifetime.abort();
    }, 25) : undefined;
    let close: (() => void | Promise<void>) | undefined;
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    lifetime.signal.addEventListener("abort", finish, { once: true });
    try {
      close = await connect(record.config, {
        onMessage: async (event) => {
          if (lifetime.signal.aborted) return;
          /**
           * 处理失败必须在这里就地接住。
           *
           * 以前它一路冒到 `client.ts` 的 `onStatus("error")`，而 supervisor 收到 error
           * 就 `finish()` —— 整条 WS 被拆掉重连。于是「某一条消息处理不动」的表现变成
           * 了两件事：这条不回，后面几条也一起掉线；日志里只剩一个没有正文的
           * `onebot-error`，连抛的是什么都不知道（2026-11-07 私聊带图那两条就这样丢了）。
           *
           * 一条消息处理失败不等于连接坏了：连接好坏由 socket 自己汇报，这里只记一行
           * 原因，然后接着处理下一条。
           */
          try {
            const result = await handleEvent(event);
            log({ event: "onebot-message-handled", connectionId: record.id, ...result });
          } catch (error) {
            log({
              event: "onebot-message-failed",
              connectionId: record.id,
              messageType: event.messageType,
              reason: describeHandlerError(error),
            });
          }
        },
        onStatus: (status, detail) => {
          if (lifetime.signal.aborted) return;
          if (status === "ready") {
            attempt = 0;
            options.onStatusChange?.("ready");
            log({ event: "onebot-connected", connectionId: record.id });
          } else if (status === "error" || status === "disconnected") {
            if (status === "error") options.onStatusChange?.("error");
            // Gateway-provided reasons / exception messages may contain credentials.
            const code = /^code=(\d{4})\b/.exec(detail ?? "")?.[1];
            log({ event: "onebot-" + status, connectionId: record.id, ...(code ? { detail: `code=${code}` } : {}) });
            finish();
          }
        },
      }, lifetime.signal);
      await ended;
    } catch {
      if (!stopped()) log({ event: "onebot-connect-failed", connectionId: record.id });
    } finally {
      lifetime.abort();
      await close?.();
      if (stopTimer) clearInterval(stopTimer);
      signal?.removeEventListener("abort", abort);
    }
    if (stopped()) break;
    const wait = onebotBackoffMs(attempt++);
    await (options.sleep ? options.sleep(wait) : waitOnebot(wait, signal));
  }
}
