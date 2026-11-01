import assert from "node:assert/strict";
import { connectOnebot } from "../server/utils/channel-adapter/onebot/client";
import type { OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
import { createOnebotRunner } from "../server/utils/channel-adapter/onebot/runner";
import { superviseOnebotConnection } from "../server/utils/channel-adapter/onebot/supervise";

const base: OnebotConnectionRecord = {
  id: "test", platform: "qq-onebot", accountQq: "10000",
  config: { wsUrl: "ws://localhost:1", httpUrl: "http://localhost:2" },
  replyOnlyWhenMentioned: false, bindings: [], reloadRequestedAt: "2026-10-29T00:00:00.000Z",
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const timeout = async (promise: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("shutdown timed out")), 1000);
    })]);
  } finally { clearTimeout(timer!); }
};

// Config/request changes serialize stop -> closed -> re-read -> start; new/disabled/deleted rows reconcile too.
{
  let rows = [structuredClone(base)];
  const events: string[] = [];
  const started: OnebotConnectionRecord[] = [];
  let live = 0;
  let onStop = () => {};
  const runner = createOnebotRunner({
    load: async () => structuredClone(rows), shouldStop: () => false,
    start(record) {
      assert.equal(live++, 0, "replacement cannot overlap the previous socket");
      started.push(record);
      events.push("start");
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      return { done, stop() {
        events.push("stop");
        onStop();
        setImmediate(() => { live--; events.push("closed"); finish(); });
      } };
    },
  });
  await runner.reconcile();
  await runner.reconcile();
  assert.equal(started.length, 1, "unchanged snapshot must not reconnect");
  rows[0]!.reloadRequestedAt = "2026-10-29T00:00:01.000Z";
  onStop = () => { rows[0]!.config.httpToken = "newest-secret"; };
  await runner.reconcile();
  assert.deepEqual(events, ["start", "stop", "closed", "start"]);
  assert.equal(started[1]!.config.httpToken, "newest-secret", "reload re-reads after close");
  onStop = () => {};
  rows[0]!.replyOnlyWhenMentioned = true;
  await runner.reconcile();
  assert.equal(started.length, 3, "configuration changes reload without a request");
  rows[0]!.bindings.push({ id: "b", characterId: "c", routingKey: "g:1" });
  await runner.reconcile();
  assert.equal(started.length, 4, "binding changes reload");
  rows = [];
  await runner.reconcile();
  assert.equal(live, 0, "disabled/deleted connections close");
  rows = [structuredClone(base)];
  await runner.reconcile();
  await runner.stop();
  assert.equal(live, 0);
}

// Ready sockets close on abort, and supervisor awaits the asynchronous close.
{
  const controller = new AbortController();
  let closed = false;
  const loop = superviseOnebotConnection({
    record: base, signal: controller.signal, log: () => {}, handleEvent: async () => ({}),
    connect: async (_config, handlers) => {
      handlers.onStatus?.("ready");
      return async () => { await tick(); closed = true; };
    },
  });
  await tick(); controller.abort(); await timeout(loop);
  assert(closed);
}

// Abort interrupts the real 30s backoff timer.
{
  const controller = new AbortController();
  let calls = 0;
  const loop = superviseOnebotConnection({
    record: base, signal: controller.signal, log: () => {}, handleEvent: async () => ({}),
    connect: async () => { calls++; throw new Error("secret must not be logged"); },
  });
  await tick(); controller.abort(); await timeout(loop);
  assert.equal(calls, 1);
}

// Real client contract: pending handshake is cancellable and close resolves only after onclose.
{
  const Original = globalThis.WebSocket;
  let socket!: FakeSocket;
  class FakeSocket {
    onopen?: () => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;
    onmessage?: () => void;
    closes = 0;
    constructor(_url: string) { void _url; socket = this; }
    close() { this.closes++; setImmediate(() => this.onclose?.({ code: 1000, reason: "secret" })); }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const abort = new AbortController();
    const pending = connectOnebot(base.config, { onMessage: () => {} }, abort.signal);
    abort.abort();
    await assert.rejects(pending, /ONEBOT_WS_CLOSED/);
    assert.equal(socket.closes, 1);
    const opened = connectOnebot(base.config, { onMessage: () => {} });
    socket.onopen?.();
    const close = await opened;
    let finished = false;
    const closing = close().then(() => { finished = true; });
    assert.equal(finished, false);
    await timeout(closing);
    assert(finished);
  } finally { globalThis.WebSocket = Original; }
}

console.log("OneBot runner tests passed: serial reload, latest config, request/config/binding changes, removal, abort, WS close and backoff cancellation.");
