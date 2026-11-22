const { randomBytes, randomUUID, createHmac, timingSafeEqual } = require("node:crypto");
const PROTOCOL = "yiling-desktop-private-auth-v1";
const UUID = /^[a-f0-9-]{36}$/iu;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const codeOf = error => /^desktop_[a-z0-9_]{1,90}$/u.test(error?.code || error?.message || "") ? (error.code || error.message) : "desktop_identity_refused";
const failure = code => Object.assign(new Error(code), { code });
/** Authenticated, boot-bound duplex RPC over an inherited Node IPC handle. Never logs payloads. */
function createDesktopAuthPeer(peer, { role, handle = async () => { throw failure("desktop_identity_method_refused"); }, timeoutMs = 15_000 } = {}) {
  if (!["parent", "child"].includes(role) || typeof peer?.send !== "function" || typeof peer?.on !== "function") throw failure("desktop_identity_private_handle_required");
  const boot = randomUUID();
  let remoteBoot = "", secret = role === "parent" ? randomBytes(32).toString("base64url") : "";
  let readyFlag = false, closed = false, outgoing = 0, incoming = 0, queue = Promise.resolve();
  const pending = new Map();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const send = message => {
    if (closed || peer.connected === false) throw failure("desktop_identity_channel_closed");
    peer.send({ protocol: PROTOCOL, ...message }, error => { if (error) dispose(); });
  };
  const sign = body => createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
  const authenticatedSend = body => {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > 16 * 1024) throw failure("desktop_identity_message_too_large");
    send({ kind: "packet", body, mac: sign(body) });
  };
  function dispose() {
    if (closed) return;
    closed = true; secret = "";
    clearTimeout(startupTimeout); clearInterval(probe);
    peer.removeListener("message", receive); peer.removeListener("disconnect", dispose); peer.removeListener("exit", dispose);
    resolveReady(false);
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(failure("desktop_identity_channel_closed")); }
    pending.clear();
  }
  const startupTimeout = setTimeout(dispose, timeoutMs);
  const probe = setInterval(() => { if (!readyFlag && !closed) { try { send({ kind: "hello-request" }); } catch { dispose(); } } }, 200);
  function connected() { readyFlag = true; clearTimeout(startupTimeout); clearInterval(probe); resolveReady(true); }
  function receive(message) {
    if (closed || message?.protocol !== PROTOCOL || !message || typeof message !== "object") return;
    try {
      if (message.kind === "hello-request" && role === "child") { send({ kind: "hello", boot }); return; }
      if (message.kind === "hello" && role === "parent" && !readyFlag && UUID.test(message.boot || "")) {
        remoteBoot = message.boot; send({ kind: "init", boot, childBoot: remoteBoot, secret }); return;
      }
      if (message.kind === "init" && role === "child" && !readyFlag && message.childBoot === boot && UUID.test(message.boot || "") && SECRET.test(message.secret || "")) {
        remoteBoot = message.boot; secret = message.secret;
        send({ kind: "ack", boot, parentBoot: remoteBoot, proof: sign({ kind: "ack", from: boot, to: remoteBoot }) }); connected(); return;
      }
      if (message.kind === "ack" && role === "parent" && !readyFlag && message.boot === remoteBoot && message.parentBoot === boot) {
        const expected = sign({ kind: "ack", from: remoteBoot, to: boot });
        if (typeof message.proof === "string" && /^[a-f0-9]{64}$/u.test(message.proof) && timingSafeEqual(Buffer.from(expected), Buffer.from(message.proof))) connected();
        return;
      }
      if (!readyFlag || message.kind !== "packet" || !message.body || typeof message.mac !== "string" || !/^[a-f0-9]{64}$/u.test(message.mac)) return;
      const body = message.body, serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > 16 * 1024 || body.from !== remoteBoot || body.to !== boot
        || !Number.isSafeInteger(body.seq) || body.seq <= 0 || !timingSafeEqual(Buffer.from(sign(body)), Buffer.from(message.mac))) return;
      if (body.kind === "response") {
        const task = pending.get(body.seq); if (!task) return;
        pending.delete(body.seq); clearTimeout(task.timer);
        if (body.ok === true) task.resolve(body.value);
        else task.reject(failure(/^desktop_[a-z0-9_]{1,90}$/u.test(body.code || "") ? body.code : "desktop_identity_refused"));
        return;
      }
      if (body.kind !== "request" || typeof body.method !== "string" || !/^[a-z][a-z.-]{0,40}$/u.test(body.method)) return;
      if (body.seq <= incoming) { authenticatedSend({ kind: "response", from: boot, to: remoteBoot, seq: body.seq, ok: false, code: "desktop_identity_replay_refused" }); return; }
      incoming = body.seq;
      queue = queue.then(async () => {
        if (closed) return;
        let response;
        try { response = { ok: true, value: await handle(body.method, body.value) }; }
        catch (error) { response = { ok: false, code: codeOf(error) }; }
        if (!closed) authenticatedSend({ kind: "response", from: boot, to: remoteBoot, seq: body.seq, ...response });
      }).catch(() => dispose());
    } catch { dispose(); }
  }
  peer.on("message", receive); peer.once("disconnect", dispose); peer.once("exit", dispose);
  if (role === "child") { try { send({ kind: "hello", boot }); } catch { dispose(); } }
  return {
    ready,
    async request(method, value = null) {
      if (!await ready || closed) throw failure("desktop_identity_channel_closed");
      const seq = ++outgoing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(seq); reject(failure("desktop_identity_request_timeout")); }, timeoutMs);
        pending.set(seq, { resolve, reject, timer });
        try { authenticatedSend({ kind: "request", from: boot, to: remoteBoot, seq, method, value }); }
        catch { clearTimeout(timer); pending.delete(seq); reject(failure("desktop_identity_channel_closed")); }
      });
    },
    dispose,
  };
}
module.exports = { createDesktopAuthPeer };
