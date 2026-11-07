import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import {
  createSessionForVerifiedPassword,
  hashClientAddress,
  hashPassword,
  hashSessionToken,
  resolveSessionUser,
} from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";

/**
 * 注册安全 + 会话管理的 HTTP 级验收。
 *
 * 每一条都打真实接口：真实的 Cookie、真实的会话表、真实的限流计数。
 * 覆盖：注册开关、重复邮箱、并发重复注册、注册失败限流、旧密码并发登录窗口、
 * 单设备退出、退出其他设备、注销当前设备、跨账号撤销、过期会话。
 */

const connectionString = process.env.DATABASE_URL;
assert(connectionString, "缺少 DATABASE_URL，注册与会话验收无法运行。");

// h3 会把 statusMessage 的迁移提示打到 stderr，这里只静音它，真正的断言失败照常抛出。
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[h3]")) return;
  rawConsoleError(...args);
};
const rawConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[h3]")) return;
  rawConsoleWarn(...args);
};

(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;
const { default: registerHandler } = await import("../server/api/auth/register.post");
const { default: loginHandler } = await import("../server/api/auth/login.post");
const { default: logoutHandler } = await import("../server/api/auth/logout.post");
const { default: sessionHandler } = await import("../server/api/auth/session.get");
const { default: sessionsHandler } = await import("../server/api/auth/sessions/index.get");
const { default: revokeOthersHandler } = await import("../server/api/auth/sessions/revoke-others.post");
const { default: revokeOneHandler } = await import("../server/api/auth/sessions/[id].delete");
const { default: adminPatchHandler } = await import("../server/api/admin/users/[id].patch");

const app = createApp({ onError: () => undefined });
const router = createRouter();
router.post("/api/auth/register", registerHandler);
router.post("/api/auth/login", loginHandler);
router.post("/api/auth/logout", logoutHandler);
router.get("/api/auth/session", sessionHandler);
router.get("/api/auth/sessions", sessionsHandler);
router.post("/api/auth/sessions/revoke-others", revokeOthersHandler);
router.delete("/api/auth/sessions/:id", revokeOneHandler);
router.patch("/api/admin/users/:id", adminPatchHandler);
app.use(router);

const api = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const prisma = getPrisma();
const suffix = randomUUID().slice(0, 8);
const password = "flow-test-pass-1";
const nextPassword = "flow-test-pass-2";
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
const createdUsernames: string[] = [];
const ip = "127.0.0.1";
const ipHash = hashClientAddress(ip);

type ApiResponse = { status: number; body: Record<string, unknown> | null; token: string; setCookie: string };

async function request(
  pathname: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResponse> {
  const response = await fetch(baseUrl + pathname, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { cookie: "yiling_session=" + init.token } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  const raw = response.headers.getSetCookie?.()
    ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") ?? ""] : []);
  const sessionCookie = raw.find((entry) => entry.startsWith("yiling_session=")) ?? "";
  const token = sessionCookie ? (sessionCookie.slice("yiling_session=".length).split(";")[0] ?? "") : "";
  return { status: response.status, body, token, setCookie: sessionCookie };
}

function errorMessage(body: Record<string, unknown> | null): string {
  if (!body) return "";
  return String(body.statusMessage ?? body.message ?? "");
}

function emailFor(label: string): string {
  const email = `auth-flow-${label}-${suffix}@example.test`;
  createdEmails.push(email);
  createdUsernames.push(email);
  return email;
}

async function register(email: string, pwd = password): Promise<ApiResponse> {
  return request("/api/auth/register", { method: "POST", body: { email, password: pwd } });
}

async function login(username: string, pwd: string): Promise<ApiResponse> {
  return request("/api/auth/login", { method: "POST", body: { username, password: pwd } });
}

async function userIdOf(email: string): Promise<string> {
  const user = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  assert(user, "前置条件：账号应当存在：" + email);
  createdUserIds.push(user.id);
  return user.id;
}

async function sessionIdOf(token: string): Promise<string> {
  const row = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true },
  });
  assert(row, "前置条件：会话应当存在于数据库。");
  return row.id;
}

async function createAccount(label: string): Promise<{ email: string; id: string; token: string }> {
  const email = emailFor(label);
  const created = await register(email);
  assert.equal(created.status, 200, "前置账号注册应当成功：" + errorMessage(created.body));
  const id = await userIdOf(email);
  return { email, id, token: created.token };
}

try {
  const originalRegistrationFlag = process.env.YILING_ALLOW_REGISTRATION;

  // ── 1. 注册开关关闭时不能注册 ────────────────────────────────────────────
  process.env.YILING_ALLOW_REGISTRATION = "false";
  const closedEmail = emailFor("closed");
  const closed = await register(closedEmail);
  assert.equal(closed.status, 403, "注册开关关闭时必须拒绝注册。");
  assert.equal(closed.token, "", "拒绝注册不得下发会话 Cookie。");
  assert.equal(await prisma.user.count({ where: { email: closedEmail } }), 0, "拒绝注册不得落库。");

  // ── 2. 打开开关后可以注册，并直接拿到可用的会话 ──────────────────────────
  process.env.YILING_ALLOW_REGISTRATION = "true";
  const primary = await createAccount("primary");
  assert(primary.token.length > 0, "注册成功必须下发会话 Cookie。");
  const registeredSession = await request("/api/auth/session", { token: primary.token });
  assert.equal((registeredSession.body?.user as { id?: string } | null)?.id, primary.id, "注册后的会话必须立即可用。");
  const registeredRow = await prisma.user.findFirst({
    where: { id: primary.id },
    select: { role: true, email: true, username: true },
  });
  assert.equal(registeredRow?.role, "USER", "自助注册只能创建普通用户。");
  assert.equal(registeredRow?.email, primary.email.toLowerCase(), "邮箱必须规范化为小写存储。");

  // ── 3. 重复邮箱不能创建第二个账号（大小写不同也视为同一邮箱）────────────
  const duplicate = await register(primary.email.toUpperCase());
  assert.equal(duplicate.status, 409, "重复邮箱必须返回 409。");
  assert.equal(duplicate.token, "", "重复注册不得下发会话 Cookie。");
  assert.equal(await prisma.user.count({ where: { email: primary.email } }), 1, "数据库里只能有一个该邮箱的账号。");

  // ── 4. 并发提交相同邮箱只能产生一个账号 ──────────────────────────────────
  const raceEmail = emailFor("race");
  const raceResponses = await Promise.all(Array.from({ length: 6 }, () => register(raceEmail)));
  const raceWinners = raceResponses.filter((response) => response.status === 200);
  assert.equal(raceWinners.length, 1, "并发注册同一邮箱只能有一个成功。");
  const raceFailures = raceResponses.filter((response) => response.status !== 200);
  assert.equal(raceFailures.length, 5, "其余并发请求都应当失败。");
  for (const failure of raceFailures) {
    assert(
      failure.status === 409 || failure.status === 429,
      "并发注册冲突必须落成 409/429，而不是 500：" + failure.status + " " + errorMessage(failure.body),
    );
  }
  assert.equal(await prisma.user.count({ where: { email: raceEmail } }), 1, "并发注册不得产生重复账号。");

  // ── 5. 注册失败会被记录，并触发限流 ──────────────────────────────────────
  // 前面几节也在这个 IP 上留下了失败记录，先把计数清掉，让这一节只看它自己要验证的部分。
  await prisma.loginAttempt.deleteMany({ where: { ipHash } });
  const limitedEmail = emailFor("limited");
  const seeded = await register(limitedEmail);
  assert.equal(seeded.status, 200, "前置账号注册应当成功：" + errorMessage(seeded.body));
  await userIdOf(limitedEmail);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await register(limitedEmail);
    statuses.push(response.status);
  }
  assert.deepEqual(
    statuses.slice(0, 5),
    [409, 409, 409, 409, 409],
    "前 5 次重复注册应各自返回 409，而不是被静默吞掉：" + statuses.join(","),
  );
  assert.equal(statuses[5], 429, "第 6 次重复注册必须被限流拦下：" + statuses.join(","));

  const recordedFailures = await prisma.loginAttempt.count({
    where: { username: limitedEmail, succeeded: false },
  });
  assert.equal(recordedFailures, 5, "每次失败的注册都必须写入失败记录，否则限流永远不会触发。");

  // ── 6. 旧密码通过与管理员重置并发时，不得开出新会话 ──────────────────────
  const raceUserEmail = emailFor("login-race");
  const raceUser = await prisma.user.create({
    data: { username: raceUserEmail, email: raceUserEmail, passwordHash: await hashPassword(password), role: "USER" },
    select: { id: true, passwordHash: true },
  });
  createdUserIds.push(raceUser.id);
  // 登录流程刚用这个哈希校验通过，但管理员的重置已经提交。
  await prisma.user.update({
    where: { id: raceUser.id },
    data: { passwordHash: await hashPassword(nextPassword) },
  });
  assert.equal(
    await createSessionForVerifiedPassword({
      userId: raceUser.id,
      expectedPasswordHash: raceUser.passwordHash,
      ip,
    }),
    null,
    "重置完成后，用旧哈希校验通过的登录不得再开出会话。",
  );
  assert.equal(
    await prisma.session.count({ where: { userId: raceUser.id, revokedAt: null } }),
    0,
    "被拒绝的登录不得留下会话行。",
  );
  const staleLogin = await login(raceUserEmail, password);
  assert.equal(staleLogin.status, 401, "重置后旧密码必须登录失败。");
  const currentLogin = await login(raceUserEmail, nextPassword);
  assert.equal(currentLogin.status, 200, "重置后新密码必须可以登录：" + errorMessage(currentLogin.body));

  // ── 7. 管理员重置密码会吊销目标账号的会话，管理员自己不受影响 ────────────
  const adminEmail = emailFor("admin");
  const adminUser = await prisma.user.create({
    data: {
      username: adminEmail,
      email: adminEmail,
      passwordHash: await hashPassword(password),
      role: "ADMIN",
    },
    select: { id: true },
  });
  createdUserIds.push(adminUser.id);
  const adminLogin = await login(adminEmail, password);
  assert.equal(adminLogin.status, 200, "管理员登录应当成功：" + errorMessage(adminLogin.body));
  const target = await createAccount("reset-target");
  const reset = await request(`/api/admin/users/${target.id}`, {
    method: "PATCH",
    body: { password: nextPassword },
    token: adminLogin.token,
  });
  assert.equal(reset.status, 200, "管理员重置密码应当成功：" + errorMessage(reset.body));
  assert.equal(await resolveSessionUser(target.token), null, "重置后目标账号的旧会话必须失效。");
  const targetAfterReset = await request("/api/auth/sessions", { token: target.token });
  assert.equal(targetAfterReset.status, 401, "目标账号的旧 Cookie 访问受保护接口必须返回 401。");
  const adminAfterReset = await request("/api/auth/sessions", { token: adminLogin.token });
  assert.equal(adminAfterReset.status, 200, "管理员自己的会话不得被牵连。");

  // ── 7b. 真并发：旧密码登录与管理员重置同时发出 ───────────────────────────
  // 窗口很窄，不保证每轮都撞上；这里断言的是不变式 —— 重置结束后不可能存在有效会话。
  for (let round = 0; round < 3; round += 1) {
    const concurrentEmail = emailFor(`live-race-${round}`);
    const account = await prisma.user.create({
      data: {
        username: concurrentEmail,
        email: concurrentEmail,
        passwordHash: await hashPassword(password),
        role: "USER",
      },
      select: { id: true },
    });
    createdUserIds.push(account.id);

    const [raceLogin, raceReset] = await Promise.all([
      login(concurrentEmail, password),
      request(`/api/admin/users/${account.id}`, {
        method: "PATCH",
        body: { password: nextPassword },
        token: adminLogin.token,
      }),
    ]);
    assert.equal(raceReset.status, 200, "并发重置应当成功：" + errorMessage(raceReset.body));
    assert.equal(
      await prisma.session.count({
        where: { userId: account.id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      0,
      "重置结束后该账号不得残留任何有效会话。",
    );
    if (raceLogin.status === 200) {
      assert.equal(await resolveSessionUser(raceLogin.token), null, "登录即使先返回成功，重置后它的 Cookie 也必须失效。");
    } else {
      assert.equal(raceLogin.status, 401, "并发重置已经生效时，旧密码登录必须 401：" + raceLogin.status);
    }
  }

  // ── 8. 单设备退出：只影响被点掉的那台 ────────────────────────────────────
  const multi = await createAccount("multi");
  const secondLogin = await login(multi.email, password);
  assert.equal(secondLogin.status, 200, "同一账号第二台设备应当可以登录。");
  const listed = await request("/api/auth/sessions", { token: multi.token });
  assert.equal(listed.status, 200, "会话列表应当可读。");
  const sessions = (listed.body?.sessions ?? []) as Array<{ id: string; current: boolean }>;
  assert.equal(sessions.length, 2, "两台设备都应出现在会话列表里。");
  assert.equal(sessions.filter((entry) => entry.current).length, 1, "只有一台设备被标记为当前设备。");
  for (const entry of sessions) {
    assert.equal("tokenHash" in entry, false, "会话列表不得回传令牌哈希。");
  }

  const secondSessionId = await sessionIdOf(secondLogin.token);
  const revokedOne = await request(`/api/auth/sessions/${secondSessionId}`, {
    method: "DELETE",
    token: multi.token,
  });
  assert.equal(revokedOne.status, 200, "退出指定设备应当成功：" + errorMessage(revokedOne.body));
  assert.equal(revokedOne.body?.currentRevoked, false, "退出其他设备不应被标记为退出当前设备。");
  assert.equal(await resolveSessionUser(secondLogin.token), null, "被退出的设备必须立即失效。");
  const afterKick = await request("/api/auth/sessions", { token: secondLogin.token });
  assert.equal(afterKick.status, 401, "被退出的设备访问受保护接口必须返回 401。");
  assert.equal(
    (await request("/api/auth/sessions", { token: multi.token })).status,
    200,
    "发起退出的设备必须保持登录。",
  );

  // ── 9. 已撤销的会话不能恢复 ──────────────────────────────────────────────
  const revokedList = await request("/api/auth/sessions", { token: multi.token });
  const remaining = (revokedList.body?.sessions ?? []) as Array<{ id: string }>;
  assert.equal(remaining.length, 1, "撤销后列表只剩当前设备。");
  const revokeAgain = await request(`/api/auth/sessions/${secondSessionId}`, {
    method: "DELETE",
    token: multi.token,
  });
  assert.equal(revokeAgain.status, 404, "重复撤销同一会话应当返回 404。");

  // ── 10. 其他用户不能撤销不属于自己的会话 ─────────────────────────────────
  const intruder = await createAccount("intruder");
  const multiSessionId = await sessionIdOf(multi.token);
  const foreignRevoke = await request(`/api/auth/sessions/${multiSessionId}`, {
    method: "DELETE",
    token: intruder.token,
  });
  assert.equal(foreignRevoke.status, 404, "别人的会话必须表现得像不存在。");
  assert.equal(
    (await request("/api/auth/sessions", { token: multi.token })).status,
    200,
    "跨账号撤销尝试不得影响真正的会话所有者。",
  );

  // ── 11. 退出其他设备 ─────────────────────────────────────────────────────
  const extraLogin = await login(multi.email, password);
  assert.equal(extraLogin.status, 200);
  const revokeOthers = await request("/api/auth/sessions/revoke-others", {
    method: "POST",
    token: multi.token,
  });
  assert.equal(revokeOthers.status, 200, "退出其他设备应当成功：" + errorMessage(revokeOthers.body));
  assert.equal(await resolveSessionUser(extraLogin.token), null, "其他设备必须失效。");
  assert.equal(
    (await resolveSessionUser(intruder.token))?.id,
    intruder.id,
    "退出其他设备只作用于自己的账号，不得波及别人的会话。",
  );
  assert.equal(
    (await request("/api/auth/sessions", { token: multi.token })).status,
    200,
    "当前设备必须保持登录。",
  );
  assert.equal(
    (await request("/api/auth/sessions", { token: intruder.token })).status,
    200,
    "退出其他设备不得波及别的账号。",
  );

  // ── 12. 注销当前设备 ─────────────────────────────────────────────────────
  const logout = await request("/api/auth/logout", { method: "POST", token: multi.token });
  assert.equal(logout.status, 204, "注销应当返回 204。");
  assert.match(logout.setCookie, /Max-Age=0/, "注销必须清除 Cookie。");
  const afterLogout = await request("/api/auth/sessions", { token: multi.token });
  assert.equal(afterLogout.status, 401, "注销后旧 Cookie 访问受保护接口必须返回 401。");
  const sessionView = await request("/api/auth/session", { token: multi.token });
  assert.equal(sessionView.body?.user, null, "注销后当前用户必须为空。");
  assert.equal(sessionView.body?.reason, "invalid_session", "注销后的 Cookie 应判定为会话失效。");

  // ── 13. 会话过期 ─────────────────────────────────────────────────────────
  const expiring = await login(multi.email, password);
  assert.equal(expiring.status, 200, "重新登录应当成功：" + errorMessage(expiring.body));
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(expiring.token) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expiredView = await request("/api/auth/sessions", { token: expiring.token });
  assert.equal(expiredView.status, 401, "过期会话访问受保护接口必须返回 401。");
  assert.equal(await resolveSessionUser(expiring.token), null, "过期会话不得再解析出用户。");
  const expiredLogin = await login(multi.email, password);
  assert.equal(expiredLogin.status, 200, "过期只影响那一台设备，重新登录仍然可用。");

  if (originalRegistrationFlag === undefined) delete process.env.YILING_ALLOW_REGISTRATION;
  else process.env.YILING_ALLOW_REGISTRATION = originalRegistrationFlag;

  console.log(
    "注册与会话验收通过：注册开关、重复邮箱、并发重复注册、注册失败记录与限流、重置后旧密码失效、旧哈希不得开出会话、单设备退出、跨账号撤销拒绝、退出其他设备、注销当前设备、过期会话。",
  );
} finally {
  if (process.env.YILING_ALLOW_REGISTRATION === "true") delete process.env.YILING_ALLOW_REGISTRATION;
  const leftover = await prisma.user
    .findMany({
      where: { OR: [{ email: { in: createdEmails } }, { username: { in: createdUsernames } }] },
      select: { id: true },
    })
    .catch(() => [] as Array<{ id: string }>);
  const ids = [...new Set([...createdUserIds, ...leftover.map((user) => user.id)].filter(Boolean))];
  if (ids.length > 0) {
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (createdUsernames.length > 0) {
    await prisma.loginAttempt.deleteMany({ where: { username: { in: createdUsernames } } });
  }
  await prisma.$disconnect();
  api.close();
}
