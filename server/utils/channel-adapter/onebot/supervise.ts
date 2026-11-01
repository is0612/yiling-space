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
          const result = await handleEvent(event);
          log({ event: "onebot-message-handled", connectionId: record.id, ...result });
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
