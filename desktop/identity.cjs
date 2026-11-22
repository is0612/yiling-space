"use strict";

/**
 * 桌面临时身份控制器：只跑在 Electron 主进程。
 *
 * 输入：已握手的私有 Node RPC、专用 persist Session、原生对话框、窗口与已登记 origin。
 * 约束：renderer 不能传 token/userId；所有操作串行；返回给 renderer 的只有公开状态。
 * 本文件不读取 env、不打印 secret、不发起 HTTP。
 */

const STATES = new Set(["bound", "unbound", "revoked", "blocked"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const COOKIE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail("desktop_identity_origin_invalid");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw fail("desktop_identity_origin_invalid");
  }
  if (parsed.origin !== value) throw fail("desktop_identity_origin_invalid");
  return value;
}

function readState(value) {
  if (!value || !STATES.has(value.state)) throw fail("desktop_identity_status_invalid");
  if (!COOKIE_NAME.test(value.cookieName ?? "")) throw fail("desktop_identity_cookie_name_invalid");
  const code = typeof value.code === "string" && CODE.test(value.code) ? value.code : undefined;
  return { state: value.state, cookieName: value.cookieName, code };
}

function readDescriptor(value, expectedName) {
  if (!value || !TOKEN.test(value.token ?? "")) throw fail("desktop_identity_token_invalid");
  if (!COOKIE_NAME.test(value.cookieName ?? "") || value.cookieName !== expectedName) throw fail("desktop_identity_cookie_name_invalid");
  if (typeof value.secure !== "boolean") throw fail("desktop_identity_secure_invalid");
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw fail("desktop_identity_expiry_invalid");
  return { token: value.token, cookieName: value.cookieName, secure: value.secure, expiresAt };
}

function createDesktopIdentityController({ peer, session, dialog, getWindow, getOrigin }) {
  if (!peer || typeof peer.request !== "function" || !peer.ready || typeof peer.ready.then !== "function") {
    throw fail("desktop_identity_peer_invalid");
  }
  if (!session?.cookies || typeof session.cookies.set !== "function") throw fail("desktop_identity_session_invalid");
  if (!dialog || typeof dialog.showMessageBox !== "function") throw fail("desktop_identity_dialog_invalid");
  if (typeof getWindow !== "function" || typeof getOrigin !== "function") throw fail("desktop_identity_window_invalid");

  let queue = Promise.resolve();
  let state = null;
  let cookieName = null;
  let code = null;
  let disposed = false;

  function enqueue(operation) {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function assertAlive() {
    if (disposed) throw fail("desktop_identity_disposed");
  }

  function origin() {
    return normalizeOrigin(getOrigin());
  }

  function assertTrustedSender(event) {
    assertAlive();
    const win = getWindow();
    if (!win || win.isDestroyed?.()) throw fail("desktop_identity_window_unavailable");
    const webContents = win.webContents;
    if (!event || !webContents || event.sender !== webContents) throw fail("desktop_identity_untrusted_sender");
    const frame = event.senderFrame;
    if (!frame || !webContents.mainFrame || frame !== webContents.mainFrame) throw fail("desktop_identity_untrusted_frame");
    const expected = origin();
    let actual;
    try {
      actual = new URL(frame.url).origin;
    } catch {
      throw fail("desktop_identity_untrusted_frame");
    }
    if (actual !== expected) throw fail("desktop_identity_untrusted_frame");
  }

  function publicStatus() {
    return { enabled: true, state: state ?? "unbound", ...(code ? { code } : {}) };
  }

  async function readStatus() {
    const raw = await peer.request("status");
    const next = readState(raw);
    state = next.state;
    cookieName = next.cookieName;
    code = next.code ?? null;
    return next;
  }

  async function inject() {
    const expected = origin();
    if (!cookieName) throw fail("desktop_identity_cookie_name_invalid");
    const raw = await peer.request("issue");
    const descriptor = readDescriptor(raw, cookieName);
    let stored;
    try {
      await session.cookies.set({
        url: expected,
        name: descriptor.cookieName,
        value: descriptor.token,
        httpOnly: true,
        sameSite: "strict",
        secure: descriptor.secure,
        path: "/",
        expirationDate: Math.floor(descriptor.expiresAt / 1000),
      });
      stored = await session.cookies.get({ url: expected, name: descriptor.cookieName });
    } catch {
      // 原生错误文本可能包含值或底层细节，只向调用方暴露静态 code。
      throw fail("desktop_identity_cookie_injection_failed");
    }
    const cookie = Array.isArray(stored) ? stored.find(item => item?.name === descriptor.cookieName) : null;
    const confirmed = Boolean(cookie)
      && cookie.value === descriptor.token
      && cookie.httpOnly === true
      && cookie.sameSite === "strict"
      && cookie.secure === descriptor.secure;
    if (!confirmed) throw fail("desktop_identity_cookie_injection_failed");
    state = "bound";
    code = null;
    return true;
  }

  async function initialize() {
    return enqueue(async () => {
      assertAlive();
      await peer.ready;
      await readStatus();
      if (state === "bound") {
        await inject();
      } else if (state === "blocked") {
        // 只清 peer 明确给出的那一个 cookie；不猜 owner、不碰其它数据。
        await session.cookies.remove(origin(), cookieName);
      }
      return publicStatus();
    });
  }

  async function status(event) {
    return enqueue(async () => {
      assertTrustedSender(event);
      // 每次以服务端为准：账号停用或解绑后不能因缓存继续显示 bound。
      await readStatus();
      return publicStatus();
    });
  }

  async function confirm(title, message, detail) {
    const win = getWindow();
    if (!win || win.isDestroyed?.()) throw fail("desktop_identity_window_unavailable");
    const result = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["取消", "确认"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title,
      message,
      detail,
    });
    return result?.response === 1;
  }

  async function bindCurrentAccount(event) {
    return enqueue(async () => {
      assertTrustedSender(event);
      // 绑定前刷新：缓存 bound 可能是账号已停用/已解绑后的过期状态。
      await readStatus();
      if (state === "bound") return { ok: true };
      if (state === "blocked") throw fail("desktop_identity_blocked");
      const approved = await confirm(
        "绑定本机主人",
        "把这台电脑绑定为当前账号的自动登录设备？",
        "绑定后，在这台电脑启动忆灵空间将自动以该账号进入，无需再次输入密码。请只在确认这是你自己的 Windows 用户与电脑时继续。",
      );
      if (!approved) return { ok: false, cancelled: true };

      const expected = origin();
      let cookies;
      try {
        cookies = await session.cookies.get({ url: expected, name: cookieName });
      } catch {
        throw fail("desktop_identity_cookie_injection_failed");
      }
      const proof = Array.isArray(cookies) ? cookies.find(cookie => cookie?.name === cookieName && cookie.httpOnly === true && typeof cookie.value === "string" && cookie.value) : null;
      if (!proof) throw fail("desktop_identity_proof_missing");

      // 证明来自本 Session 的真实 HttpOnly Cookie；renderer 传入的任何值都不使用。
      const bound = await peer.request("bind", { token: proof.value });
      if (!bound || bound.ok !== true) throw fail("desktop_identity_bind_rejected");
      await inject();
      return { ok: true };
    });
  }

  async function reconnect(event) {
    return enqueue(async () => {
      assertTrustedSender(event);
      // 同样先读服务端：停用/解绑后不应因缓存 bound 误提示"重新连接"。
      await readStatus();
      if (state !== "bound") throw fail("desktop_identity_not_bound");
      await inject();
      return { ok: true };
    });
  }

  async function unbindFromMenu() {
    return enqueue(async () => {
      assertAlive();
      await readStatus();
      // 合法绑定但账号已删除/停用：允许用户明确解除本机绑定；其它 blocked 状态不动。
      const ownerUnavailable = state === "blocked" && code === "desktop_owner_unavailable";
      if (state !== "bound" && !ownerUnavailable) {
        return { ok: false, code: state === "blocked" ? "desktop_identity_blocked" : "desktop_identity_not_bound" };
      }
      const approved = await confirm(
        "解除本机绑定",
        "解除这台电脑的自动登录绑定？",
        "解除后下次启动需要重新输入密码。聊天记录、记忆和数据库都不会被删除。",
      );
      if (!approved) return { ok: false, cancelled: true };
      const result = await peer.request("unbind");
      if (!result || result.ok !== true) throw fail("desktop_identity_unbind_rejected");
      await session.cookies.remove(origin(), cookieName);
      state = "unbound";
      code = null;
      return { ok: true };
    });
  }

  function dispose() {
    disposed = true;
  }

  return {
    initialize,
    status,
    bindCurrentAccount,
    reconnect,
    unbindFromMenu,
    dispose,
  };
}

module.exports = { createDesktopIdentityController };
