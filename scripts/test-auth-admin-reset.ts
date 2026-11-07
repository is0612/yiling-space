import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import {
  createSession,
  hashPassword,
  hashSessionToken,
  resolveSessionUser,
  verifyPassword,
} from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";

/**
 * 管理员重置密码 / 停用账号 的验收测试。
 *
 * 六条验收对应六个断言块，全部走真实 HTTP：真正的登录接口、真正的 Cookie、真正的会话表。
 * 事务那一项用 PostgreSQL 触发器制造「会话吊销失败」，验证密码与会话是同生共死的。
 */

const connectionString = process.env.DATABASE_URL;
assert(connectionString, "缺少 DATABASE_URL，管理员重置密码验收无法运行。");

// 第 3 条会故意让一次请求以 500 结束，h3 会把它打到 stderr。只吞掉 h3 自己的前缀，
// 真正的断言失败和数据库错误照常输出。
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[h3]")) return;
  rawConsoleError(...args);
};
const rawConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  // 登录失败用 statusMessage 是项目现有约定，h3 的迁移提示在测试里没有意义。
  if (typeof args[0] === "string" && args[0].startsWith("[h3]")) return;
  rawConsoleWarn(...args);
};

// handler 依赖 Nuxt 的自动导入，脚本里先把符号挂到 globalThis 再动态加载。
(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;
const { default: loginHandler } = await import("../server/api/auth/login.post");
const { default: sessionHandler } = await import("../server/api/auth/session.get");
const { default: adminPatchHandler } = await import("../server/api/admin/users/[id].patch");

const prisma = getPrisma();
const suffix = randomUUID();
const adminUsername = `admin-reset-${suffix}`;
const targetUsername = `user-reset-${suffix}`;
const adminPassword = "admin-pass-1";
const initialPassword = "target-pass-1";
const resetPassword = "target-pass-2";
const blockedPassword = "target-pass-3";
const ip = "127.0.0.1";

let createdAdminId = "";
let createdTargetId = "";

// 第 3 条会故意制造一次 500，别让 h3 把它打到日志里冒充真故障。
const app = createApp({ onError: () => undefined });
const router = createRouter();
router.post("/api/auth/login", loginHandler);
router.get("/api/auth/session", sessionHandler);
router.patch("/api/admin/users/:id", adminPatchHandler);
app.use(router);
const api = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

type ApiResponse = { status: number; body: Record<string, unknown> | null; token: string };

function cookieOf(token: string): string {
  return "yiling_session=" + token;
}

async function request(
  pathname: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResponse> {
  const response = await fetch(baseUrl + pathname, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { cookie: cookieOf(init.token) } : {}),
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
  const raw = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") ?? ""] : []);
  const sessionCookie = raw.find((entry) => entry.startsWith("yiling_session=")) ?? "";
  const token = sessionCookie ? sessionCookie.slice("yiling_session=".length).split(";")[0] ?? "" : "";
  return { status: response.status, body, token };
}

function errorMessage(body: Record<string, unknown> | null): string {
  if (!body) return "";
  return String(body.statusMessage ?? body.message ?? "");
}

async function login(username: string, password: string): Promise<ApiResponse> {
  return request("/api/auth/login", { method: "POST", body: { username, password } });
}

async function activeSessionCount(userId: string): Promise<number> {
  return prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
}

/** 让这张会话表在吊销指定用户时抛错 —— 用来模拟事务中第二步失败。 */
async function installFailingRevokeTrigger(userId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION yiling_test_block_session_revoke() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."revokedAt" IS NOT NULL
         AND OLD."revokedAt" IS NULL
         AND NEW."userId" = '${userId}'::uuid THEN
        RAISE EXCEPTION 'simulated session revocation failure';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS yiling_test_block_session_revoke ON "sessions"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER yiling_test_block_session_revoke BEFORE UPDATE ON "sessions" FOR EACH ROW EXECUTE FUNCTION yiling_test_block_session_revoke()`,
  );
}

async function dropFailingRevokeTrigger(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS yiling_test_block_session_revoke ON "sessions"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS yiling_test_block_session_revoke()`);
}

try {
  const admin = await prisma.user.create({
    data: { username: adminUsername, passwordHash: await hashPassword(adminPassword), displayName: "验收管理员", role: "ADMIN" },
    select: { id: true },
  });
  createdAdminId = admin.id;
  const target = await prisma.user.create({
    data: { username: targetUsername, passwordHash: await hashPassword(initialPassword), displayName: "验收用户", role: "USER" },
    select: { id: true },
  });
  createdTargetId = target.id;

  const adminSession = await createSession({ userId: admin.id, ip, userAgent: "admin-workstation" });
  const deviceA = await createSession({ userId: target.id, ip, userAgent: "target-phone" });
  const deviceB = await createSession({ userId: target.id, ip, userAgent: "target-laptop" });
  assert.equal(await activeSessionCount(target.id), 2, "前置条件：目标账号有两台设备在线。");

  // ── 1. 管理员重置密码后，旧设备 Cookie 全部失效 ──────────────────────────
  for (const device of [deviceA, deviceB]) {
    const before = await request("/api/auth/session", { token: device.token });
    assert.equal((before.body?.user as { id?: string } | null)?.id, target.id, "重置前旧设备应处于已登录状态。");
  }

  const reset = await request(`/api/admin/users/${target.id}`, {
    method: "PATCH",
    body: { password: resetPassword },
    token: adminSession.token,
  });
  assert.equal(reset.status, 200, "管理员重置密码应当成功：" + errorMessage(reset.body));
  assert.equal(reset.body?.revokedSessions, 2, "重置密码必须吊销该账号全部在线会话。");

  for (const device of [deviceA, deviceB]) {
    assert.equal(await resolveSessionUser(device.token), null, "重置后旧会话不得再解析出用户。");
    const after = await request("/api/auth/session", { token: device.token });
    assert.equal(after.body?.user, null, "重置后旧设备访问会话接口应得到未登录。");
    assert.equal(after.body?.reason, "invalid_session", "旧 Cookie 应被判定为会话失效，而不是缺少会话。");
  }
  const revokedRows = await prisma.session.findMany({
    where: { tokenHash: { in: [hashSessionToken(deviceA.token), hashSessionToken(deviceB.token)] } },
    select: { revokedAt: true },
  });
  assert.equal(revokedRows.length, 2);
  for (const row of revokedRows) {
    assert(row.revokedAt instanceof Date, "数据库里旧会话应写入撤销时间，而不是只靠前端清 Cookie。");
  }

  // ── 6. 管理员自己的会话不受影响（与上一条同一请求之后立即核对） ──────────
  const adminStillValid = await request("/api/auth/session", { token: adminSession.token });
  assert.equal(
    (adminStillValid.body?.user as { id?: string } | null)?.id,
    admin.id,
    "重置其他用户密码时，管理员自己的会话必须保持有效。",
  );
  assert.equal(adminStillValid.body?.reason, null);

  // ── 2. 旧密码无法登录，新密码可以正常登录 ────────────────────────────────
  const oldLogin = await login(targetUsername, initialPassword);
  assert.equal(oldLogin.status, 401, "旧密码必须立即失效。");
  assert.equal(errorMessage(oldLogin.body), "用户名或密码不正确。");
  assert.equal(oldLogin.token, "", "登录失败不得下发会话 Cookie。");

  const newLogin = await login(targetUsername, resetPassword);
  assert.equal(newLogin.status, 200, "新密码必须可以登录：" + errorMessage(newLogin.body));
  assert.equal((newLogin.body?.user as { id?: string } | null)?.id, target.id);
  assert(newLogin.token.length > 0, "登录成功必须下发会话 Cookie。");
  const freshSession = await request("/api/auth/session", { token: newLogin.token });
  assert.equal((freshSession.body?.user as { id?: string } | null)?.id, target.id, "新会话应立即可用。");

  // ── 3. 事务失败时，密码与会话不会只更新一半 ──────────────────────────────
  const hashBefore = (await prisma.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } }))?.passwordHash ?? "";
  const sessionsBefore = await activeSessionCount(target.id);
  assert.equal(sessionsBefore, 1, "前置条件：此时目标账号只剩新登录这一台设备。");

  await installFailingRevokeTrigger(target.id);
  let failedStatus = 0;
  try {
    const failed = await request(`/api/admin/users/${target.id}`, {
      method: "PATCH",
      body: { password: blockedPassword },
      token: adminSession.token,
    });
    failedStatus = failed.status;
  } finally {
    await dropFailingRevokeTrigger();
  }
  assert.equal(failedStatus, 500, "吊销环节抛错时，接口应整体失败而不是返回成功。");

  const hashAfterFailure = (await prisma.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } }))?.passwordHash ?? "";
  assert.equal(hashAfterFailure, hashBefore, "事务回滚：密码哈希不得被写入。");
  assert.equal(await verifyPassword(resetPassword, hashAfterFailure), true, "回滚后当前密码仍然有效。");
  assert.equal(await verifyPassword(blockedPassword, hashAfterFailure), false, "失败的重置不得生效。");
  assert.equal(await activeSessionCount(target.id), sessionsBefore, "事务回滚：会话不得被吊销。");
  assert.equal((await resolveSessionUser(newLogin.token))?.id, target.id, "回滚后原会话仍然可用。");

  // ── 4. 停用账号后，所有旧会话失效 ────────────────────────────────────────
  const disable = await request(`/api/admin/users/${target.id}`, {
    method: "PATCH",
    body: { status: "DISABLED" },
    token: adminSession.token,
  });
  assert.equal(disable.status, 200, "停用账号应当成功：" + errorMessage(disable.body));
  assert.equal(disable.body?.revokedSessions, 1, "停用必须吊销该账号全部在线会话。");
  assert.equal(await resolveSessionUser(newLogin.token), null, "停用后旧会话不得再解析出用户。");
  const disabledSession = await request("/api/auth/session", { token: newLogin.token });
  assert.equal(disabledSession.body?.user, null, "停用后旧设备访问会话接口应得到未登录。");
  const disabledLogin = await login(targetUsername, resetPassword);
  assert.equal(disabledLogin.status, 401, "停用期间任何密码都不允许登录。");

  // ── 5. 重新启用后，必须重新登录 ──────────────────────────────────────────
  const enable = await request(`/api/admin/users/${target.id}`, {
    method: "PATCH",
    body: { status: "ACTIVE" },
    token: adminSession.token,
  });
  assert.equal(enable.status, 200, "重新启用账号应当成功：" + errorMessage(enable.body));
  assert.equal(enable.body?.revokedSessions, 0, "启用不做吊销 —— 停用时已经吊销过了。");
  assert.equal(await resolveSessionUser(newLogin.token), null, "启用不得让已吊销的会话复活。");
  const revived = await request("/api/auth/session", { token: newLogin.token });
  assert.equal(revived.body?.user, null, "启用后旧设备 Cookie 仍然无效。");

  const relogin = await login(targetUsername, resetPassword);
  assert.equal(relogin.status, 200, "启用后必须能用密码重新登录：" + errorMessage(relogin.body));
  const reloginSession = await request("/api/auth/session", { token: relogin.token });
  assert.equal((reloginSession.body?.user as { id?: string } | null)?.id, target.id, "重新登录后会话生效。");

  // ── 6b. 管理员重置自己的密码，保留当前这台设备的会话 ─────────────────────
  const selfSession = await createSession({ userId: admin.id, ip, userAgent: "admin-second" });
  const selfReset = await request(`/api/admin/users/${admin.id}`, {
    method: "PATCH",
    body: { password: "admin-pass-2" },
    token: adminSession.token,
  });
  assert.equal(selfReset.status, 200, "管理员重置自己的密码应当成功：" + errorMessage(selfReset.body));
  assert.equal(selfReset.body?.revokedSessions, 1, "重置自己的密码应只踢掉其他设备（这里恰好一台）。");
  assert.equal(await resolveSessionUser(selfSession.token), null, "管理员的其他设备应被踢下线。");
  assert.equal((await resolveSessionUser(adminSession.token))?.id, admin.id, "发起操作的这台设备必须留在登录状态。");
  assert.equal(await verifyPassword("admin-pass-2", (await prisma.user.findUnique({ where: { id: admin.id }, select: { passwordHash: true } }))?.passwordHash ?? ""), true);

  console.log(
    "管理员重置密码验收通过：旧设备 Cookie 全部失效、旧密码拒绝且新密码可登录、事务失败时密码与会话同回滚、停用即吊销全部会话、启用后必须重新登录、管理员自身会话不受影响。",
  );
} finally {
  await dropFailingRevokeTrigger().catch(() => undefined);
  const ids = [createdAdminId, createdTargetId].filter(Boolean);
  if (ids.length > 0) {
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.loginAttempt.deleteMany({ where: { username: { in: [adminUsername, targetUsername] } } });
  api.close();
  await prisma.$disconnect();
}
