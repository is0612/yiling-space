import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import ipc from "./desktop-auth-ipc.cjs";
function wire() {
  const left = new EventEmitter(), right = new EventEmitter();
  const messages = [];
  for (const [from, to] of [[left, right], [right, left]]) {
    from.connected = true;
    from.send = (message, callback) => { const copy = JSON.parse(JSON.stringify(message)); messages.push({ from, message: copy }); queueMicrotask(() => to.emit("message", copy)); callback?.(null); };
  }
  return { left, right, messages };
}
const a = wire(); let handled = 0;
const parent = ipc.createDesktopAuthPeer(a.left, { role: "parent", timeoutMs: 1000, handle: async method => ({ from: "parent", method }) });
const child = ipc.createDesktopAuthPeer(a.right, { role: "child", timeoutMs: 1000, handle: async method => { handled++; if (method === "refused") throw new Error("sensitive synthetic value must never cross error response"); return { from: "child", method }; } });
const b = wire(); let crossed = 0;
const otherParent = ipc.createDesktopAuthPeer(b.left, { role: "parent", timeoutMs: 1000 });
const otherChild = ipc.createDesktopAuthPeer(b.right, { role: "child", timeoutMs: 1000, handle: async () => { crossed++; } });
try {
  assert((await Promise.all([parent.ready, child.ready, otherParent.ready, otherChild.ready])).every(Boolean));
  assert.deepEqual(await parent.request("status"), { from: "child", method: "status" });
  assert.deepEqual(await child.request("status"), { from: "parent", method: "status" });
  const first = a.messages.find(entry => entry.from === a.left && entry.message.body?.kind === "request").message;
  a.right.emit("message", first);
  b.right.emit("message", first);
  const bad = JSON.parse(JSON.stringify(first)); bad.body.seq = 100;
  a.right.emit("message", bad);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 1, "replay and tampered packets cannot re-execute handlers");
  assert.equal(crossed, 0, "captured requests do not authenticate a different boot/channel");
  await assert.rejects(() => parent.request("refused"), error => error.code === "desktop_identity_refused" && !error.message.includes("synthetic"));
  assert(!a.messages.some(entry => entry.message.code?.includes("sensitive")));
  assert.equal((await parent.request("status")).from, "child", "failed or rejected traffic must not reset the channel");
  child.dispose(); parent.dispose();
  await assert.rejects(() => parent.request("status"), /channel_closed/u);
  console.log("Private desktop IPC passed: inherited-peer handshake, boot-bound MAC, duplex requests, replay/tamper/cross-boot refusal, sanitized errors and closed-channel refusal; no HTTP endpoint, database or real credentials used.");
} finally { parent.dispose(); child.dispose(); otherParent.dispose(); otherChild.dispose(); }
