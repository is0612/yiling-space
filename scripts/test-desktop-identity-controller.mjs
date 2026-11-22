"use strict";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopIdentityController } = require("../desktop/identity.cjs");

const ORIGIN = "http://127.0.0.1:43123";
const COOKIE = "yiling_desktop_identity";
const token = () => randomBytes(32).toString("base64url");
const future = () => Date.now() + 3600_000;

function fakeSession(initial = {}) {
  const jar = new Map(Object.entries(initial));
  const ops = [];
  return {
    jar,
    ops,
    cookies: {
      async set(options) {
        ops.push(["set", options.name]);
        jar.set(options.name, { ...options });
      },
      async get({ name }) {
        const cookie = jar.get(name);
        return cookie ? [{ ...cookie }] : [];
      },
      async remove(_url, name) {
        ops.push(["remove", name]);
        jar.delete(name);
      },
    },
  };
}

function fakeDialog(response) {
  const calls = [];
  return {
    calls,
    async showMessageBox(_win, options) {
      calls.push(options);
      return { response: typeof response === "function" ? response(options) : response };
    },
  };
}

function fakePeer(table, delay = 0) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    ready: Promise.resolve(),
    async request(method, value) {
      calls.push({ method, value });
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const entry = table[method];
        if (typeof entry === "function") return entry(value);
        if (entry === undefined) throw Object.assign(new Error("unknown_method"), { code: "unknown_method" });
        return entry;
      } finally {
        active -= 1;
      }
    },
  };
}

function fakeWindow(frameUrl = `${ORIGIN}/login`) {
  const mainFrame = { url: frameUrl };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };
  return { win, mainFrame, webContents, event: () => ({ sender: webContents, senderFrame: mainFrame }) };
}

function boundTable(overrides = {}) {
  return {
    status: { state: "bound", cookieName: COOKIE },
    issue: () => ({ token: token(), expiresAt: future(), secure: true, cookieName: COOKIE }),
    bind: { ok: true },
    unbind: { ok: true },
    ...overrides,
  };
}

function make(options = {}) {
  const session = options.session ?? fakeSession(options.jar ?? {});
  const dialog = options.dialog ?? fakeDialog(1);
  const peer = options.peer ?? fakePeer(options.table ?? boundTable(), options.delay ?? 0);
  const window = options.window ?? fakeWindow();
  const controller = createDesktopIdentityController({
    peer,
    session,
    dialog,
    getWindow: () => window.win,
    getOrigin: () => (options.origin ?? ORIGIN),
  });
  return { controller, peer, session, dialog, window };
}

async function testInjectionBeforeInitialize() {
  const { controller, peer, session } = make();
  const result = await controller.initialize();
  assert.deepEqual(result, { enabled: true, state: "bound" });
  assert.equal(session.jar.has(COOKIE), true, "cookie must be injected before initialize resolves");
  assert.deepEqual(peer.calls.map(call => call.method), ["status", "issue"]);
  const cookie = session.jar.get(COOKIE);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "strict");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, "/");
  assert(!JSON.stringify(result).includes(cookie.value), "token must never reach renderer");
}

async function testUnboundDoesNotIssue() {
  const { controller, peer } = make({ table: { status: { state: "unbound", cookieName: COOKIE } } });
  const result = await controller.initialize();
  assert.deepEqual(result, { enabled: true, state: "unbound" });
  assert.deepEqual(peer.calls.map(call => call.method), ["status"]);
}

async function testBlockedClearsOnlyNamedCookie() {
  const session = fakeSession({ [COOKIE]: { name: COOKIE, value: "stale", httpOnly: true }, other: { name: "other", value: "keep" } });
  const { controller } = make({
    session,
    table: { status: { state: "blocked", cookieName: COOKIE, code: "identity_revoked" } },
  });
  const result = await controller.initialize();
  assert.deepEqual(result, { enabled: true, state: "blocked", code: "identity_revoked" });
  assert.equal(session.jar.has(COOKIE), false);
  assert.equal(session.jar.has("other"), true, "must not touch cookies outside the named identity cookie");
}

async function testSenderValidation() {
  for (const build of [
    () => ({ sender: {}, senderFrame: fakeWindow().mainFrame }),
    () => ({ sender: fakeWindow().webContents, senderFrame: { url: `${ORIGIN}/login` } }),
    () => ({ sender: fakeWindow().webContents, senderFrame: { url: "http://127.0.0.1:43123.evil.test/login" } }),
  ]) {
    const { controller, peer } = make();
    const event = build();
    await assert.rejects(() => controller.status(event), error => ["desktop_identity_untrusted_sender", "desktop_identity_untrusted_frame"].includes(error.code));
    assert.equal(peer.calls.length, 0, "untrusted sender must not reach the private peer");
  }
  const foreign = make({ window: fakeWindow("http://127.0.0.1:43124/login") });
  await assert.rejects(() => foreign.controller.status(foreign.window.event()), error => error.code === "desktop_identity_untrusted_frame");
}

async function testSubframeRejected() {
  const { controller, window, mainFrame } = make();
  const childFrame = { url: `${ORIGIN}/login` };
  await assert.rejects(() => controller.status({ sender: window.webContents, senderFrame: childFrame }), error => error.code === "desktop_identity_untrusted_frame");
  assert.notEqual(childFrame, mainFrame);
}

async function testBindUsesJarProofOnly() {
  const jar = { [COOKIE]: { name: COOKIE, value: "real-http-only-proof", httpOnly: true } };
  const { controller, peer, session, window } = make({
    jar,
    table: boundTable({ status: { state: "unbound", cookieName: COOKIE } }),
  });
  await controller.initialize();
  // renderer 传入的额外字段必须被忽略。
  const result = await controller.bindCurrentAccount({ ...window.event(), token: "attacker-value", userId: "attacker" });
  assert.deepEqual(result, { ok: true });
  const bindCall = peer.calls.find(call => call.method === "bind");
  assert.deepEqual(bindCall.value, { token: "real-http-only-proof" });
  assert.equal(session.jar.get(COOKIE).value !== "attacker-value", true);
  assert(!JSON.stringify(result).includes("proof"), "bind result must not echo the cookie value");
}

async function testBindCancelKeepsState() {
  const { controller, peer, session, window } = make({
    jar: { [COOKIE]: { name: COOKIE, value: "proof", httpOnly: true } },
    table: { status: { state: "unbound", cookieName: COOKIE } },
    dialog: fakeDialog(0),
  });
  await controller.initialize();
  const result = await controller.bindCurrentAccount(window.event());
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(peer.calls.some(call => call.method === "bind"), false);
  assert.equal(session.ops.some(op => op[0] === "set"), false);
  const status = await controller.status(window.event());
  assert.deepEqual(status, { enabled: true, state: "unbound" });
}

async function testBindRequiresProof() {
  const { controller, peer, window } = make({
    table: { status: { state: "unbound", cookieName: COOKIE }, issue: boundTable().issue },
  });
  await controller.initialize();
  await assert.rejects(() => controller.bindCurrentAccount(window.event()), error => error.code === "desktop_identity_proof_missing");
  assert.equal(peer.calls.some(call => call.method === "bind"), false);
}

async function testReconnect() {
  const { controller, peer, session, window } = make();
  await controller.initialize();
  const first = session.jar.get(COOKIE).value;
  const result = await controller.reconnect(window.event());
  assert.deepEqual(result, { ok: true });
  assert.equal(session.jar.get(COOKIE).value !== first, true, "reconnect issues a fresh token");
  assert.equal(peer.calls.filter(call => call.method === "issue").length, 2);
}

async function testUnbind() {
  const { controller, peer, session } = make();
  await controller.initialize();
  const result = await controller.unbindFromMenu();
  assert.deepEqual(result, { ok: true });
  assert.equal(peer.calls.some(call => call.method === "unbind"), true);
  assert.equal(session.jar.has(COOKIE), false);
}

async function testUnbindCancel() {
  const { controller, peer } = make({ dialog: fakeDialog(0) });
  await controller.initialize();
  const result = await controller.unbindFromMenu();
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(peer.calls.some(call => call.method === "unbind"), false);
}

async function testSerialQueue() {
  const { controller, peer, window } = make({ delay: 15 });
  const first = controller.initialize();
  const second = controller.status(window.event());
  const third = controller.status(window.event());
  await Promise.all([first, second, third]);
  assert.equal(peer.maxActive, 1, "identity operations must be serialized");
}

async function testDescriptorRejected() {
  const cases = [
    { issue: { token: "short", expiresAt: future(), secure: true, cookieName: COOKIE }, code: "desktop_identity_token_invalid" },
    { issue: { token: token(), expiresAt: Date.now() - 1000, secure: true, cookieName: COOKIE }, code: "desktop_identity_expiry_invalid" },
    { issue: { token: token(), expiresAt: future(), secure: true, cookieName: "other_cookie" }, code: "desktop_identity_cookie_name_invalid" },
    { issue: { token: token(), expiresAt: future(), secure: "true", cookieName: COOKIE }, code: "desktop_identity_secure_invalid" },
    { status: { state: "owner", cookieName: COOKIE }, code: "desktop_identity_status_invalid" },
    { status: { state: "bound", cookieName: "bad name" }, code: "desktop_identity_cookie_name_invalid" },
  ];
  for (const item of cases) {
    const { controller, session } = make({ table: boundTable(item) });
    await assert.rejects(() => controller.initialize(), error => error.code === item.code);
    assert.equal(session.ops.length, 0, "invalid descriptor must not write a cookie");
  }
}

async function testOwnerUnavailableCanUnbind() {
  const confirmed = make({
    jar: { [COOKIE]: { name: COOKIE, value: "stale", httpOnly: true } },
    table: { status: { state: "blocked", cookieName: COOKIE, code: "desktop_owner_unavailable" }, unbind: { ok: true } },
    dialog: fakeDialog(1),
  });
  const init = await confirmed.controller.initialize();
  assert.deepEqual(init, { enabled: true, state: "blocked", code: "desktop_owner_unavailable" });
  const result = await confirmed.controller.unbindFromMenu();
  assert.deepEqual(result, { ok: true });
  assert.equal(confirmed.peer.calls.filter(call => call.method === "unbind").length, 1);
  assert.equal(confirmed.session.jar.has(COOKIE), false);

  const cancelled = make({
    table: { status: { state: "blocked", cookieName: COOKIE, code: "desktop_owner_unavailable" }, unbind: { ok: true } },
    dialog: fakeDialog(0),
  });
  await cancelled.controller.initialize();
  const cancelledResult = await cancelled.controller.unbindFromMenu();
  assert.deepEqual(cancelledResult, { ok: false, cancelled: true });
  assert.equal(cancelled.peer.calls.some(call => call.method === "unbind"), false, "cancel must not call the private unbind");
}

async function testOtherBlockedCannotUnbind() {
  const { controller, peer, dialog } = make({
    table: { status: { state: "blocked", cookieName: COOKIE, code: "desktop_identity_context_invalid" }, unbind: { ok: true } },
    dialog: fakeDialog(1),
  });
  await controller.initialize();
  const result = await controller.unbindFromMenu();
  assert.deepEqual(result, { ok: false, code: "desktop_identity_blocked" });
  assert.equal(peer.calls.some(call => call.method === "unbind"), false);
  assert.equal(dialog.calls.length, 0, "invalid blocked state must not prompt or change cookies");
}

async function testStatusRefreshesFromServer() {
  let reads = 0;
  const { controller, peer, window } = make({
    table: boundTable({
      status: () => (++reads === 1
        ? { state: "bound", cookieName: COOKIE }
        : { state: "blocked", cookieName: COOKIE, code: "desktop_owner_unavailable" }),
    }),
  });
  await controller.initialize();
  assert.equal(peer.calls.filter(call => call.method === "issue").length, 1);
  const status = await controller.status(window.event());
  assert.deepEqual(status, { enabled: true, state: "blocked", code: "desktop_owner_unavailable" });
  assert.equal(peer.calls.filter(call => call.method === "issue").length, 1, "blocked status must not issue a token");
}

async function testReconnectRefreshesFromServer() {
  let reads = 0;
  const { controller, peer, window } = make({
    table: boundTable({
      status: () => (++reads === 1 ? { state: "bound", cookieName: COOKIE } : { state: "blocked", cookieName: COOKIE, code: "desktop_owner_unavailable" }),
    }),
  });
  await controller.initialize();
  const issuedBefore = peer.calls.filter(call => call.method === "issue").length;
  await assert.rejects(() => controller.reconnect(window.event()), error => error.code === "desktop_identity_not_bound");
  assert.equal(peer.calls.filter(call => call.method === "issue").length, issuedBefore, "stale bound cache must not trigger another issue");
}

async function testBindRefreshesFromServer() {
  let reads = 0;
  const { controller, dialog, window } = make({
    table: boundTable({
      status: () => (++reads === 1 ? { state: "bound", cookieName: COOKIE } : { state: "blocked", cookieName: COOKIE, code: "desktop_owner_unavailable" }),
    }),
  });
  await controller.initialize();
  await assert.rejects(() => controller.bindCurrentAccount(window.event()), error => error.code === "desktop_identity_blocked");
  assert.equal(dialog.calls.length, 0, "blocked state must not prompt for binding");
}

async function testNativeCookieErrorsAreStatic() {
  for (const mode of ["set", "get"]) {
    const secret = token();
    const session = fakeSession();
    if (mode === "set") {
      session.cookies.set = async () => { throw new Error(`native failure with ${secret}`); };
    } else {
      session.cookies.get = async () => { throw new Error(`native failure with ${secret}`); };
    }
    const { controller } = make({
      session,
      table: boundTable({ issue: () => ({ token: secret, expiresAt: future(), secure: true, cookieName: COOKIE }) }),
    });
    await assert.rejects(() => controller.initialize(), error => {
      assert.equal(error.code, "desktop_identity_cookie_injection_failed");
      assert.equal(error.message, "desktop_identity_cookie_injection_failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
}

async function testReadbackDegradationRejected() {
  const degradations = [
    cookie => ({ ...cookie, value: "different" }),
    cookie => ({ ...cookie, httpOnly: false }),
    cookie => ({ ...cookie, sameSite: "lax" }),
    cookie => ({ ...cookie, secure: false }),
  ];
  for (const degrade of degradations) {
    const session = fakeSession();
    const original = session.cookies.get.bind(session.cookies);
    session.cookies.get = async query => (await original(query)).map(degrade);
    const { controller } = make({ session });
    await assert.rejects(() => controller.initialize(), error => error.code === "desktop_identity_cookie_injection_failed");
  }
}

(async () => {
  await testInjectionBeforeInitialize();
  await testUnboundDoesNotIssue();
  await testBlockedClearsOnlyNamedCookie();
  await testSenderValidation();
  await testSubframeRejected();
  await testBindUsesJarProofOnly();
  await testBindCancelKeepsState();
  await testBindRequiresProof();
  await testReconnect();
  await testUnbind();
  await testUnbindCancel();
  await testSerialQueue();
  await testStatusRefreshesFromServer();
  await testReconnectRefreshesFromServer();
  await testBindRefreshesFromServer();
  await testNativeCookieErrorsAreStatic();
  await testReadbackDegradationRejected();
  await testOwnerUnavailableCanUnbind();
  await testOtherBlockedCannotUnbind();
  await testDescriptorRejected();
  console.log("Desktop identity controller passed: inject-before-load, secret never returned, sender/frame/origin checks, unbound no-issue, jar-only bind proof, cancel no-op, serial queue, descriptor refusal; no GUI, database or network.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
