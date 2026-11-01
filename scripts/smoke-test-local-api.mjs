import { randomBytes, scryptSync } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getJson(response) {
  return response.json().catch(() => null);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await getJson(response);
  if (!response.ok) {
    const message = payload && typeof payload === "object"
      ? payload.statusMessage || payload.message
      : undefined;
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${message || JSON.stringify(payload)}`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  let lastError = "Nuxt dev server did not become ready.";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    let response;
    try {
      response = await fetch(new URL("/api/characters", baseUrl));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
      continue;
    }

    if (response.status === 200) return;
    lastError = `API returned HTTP ${response.status}: ${await response.text()}`;
    if (response.status === 403) throw new Error(`Local API guard rejected the smoke test: ${lastError}`);
    await sleep(500);
  }
  throw new Error(`Nuxt server readiness timed out: ${lastError}`);
}

await waitForServer();

const databaseUrl = process.env.DATABASE_URL;
assert(typeof databaseUrl === "string" && databaseUrl.length > 0, "DATABASE_URL is required for scope-isolation smoke coverage.");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const sameOriginResponse = await fetch(new URL("/api/characters", baseUrl), {
  headers: { origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" },
});
assert(sameOriginResponse.status === 200, "Local API should continue to accept a matching same-origin browser request.");
await sameOriginResponse.arrayBuffer();
const crossOriginResponse = await fetch(new URL("/api/characters", baseUrl), {
  headers: { origin: "https://attacker.example" },
});
assert(crossOriginResponse.status === 403, "Local API must reject browser requests whose Origin does not match the loopback host.");
await crossOriginResponse.arrayBuffer();
const crossSiteResponse = await fetch(new URL("/api/characters", baseUrl), {
  headers: { "sec-fetch-site": "cross-site" },
});
assert(crossSiteResponse.status === 403, "Local API must reject browser requests marked as cross-site.");
await crossSiteResponse.arrayBuffer();

// --- Admin login, server-side session and logout coverage ---
const writeHeaders = { "content-type": "application/json", origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" };
const anonymousSession = await (await fetch(new URL("/api/auth/session", baseUrl))).json();
assert(anonymousSession.mode === "local-dev" && anonymousSession.user, "Without a session the local development identity should be reported.");

const loginResponse = await fetch(new URL("/api/auth/login", baseUrl), {
  method: "POST",
  headers: writeHeaders,
  body: JSON.stringify({ username: process.env.DEV_OWNER_USERNAME, password: process.env.DEV_OWNER_PASSWORD }),
});
const loginPayload = await loginResponse.json().catch(() => null);
assert(loginResponse.status === 200, `POST /api/auth/login failed (${loginResponse.status}): ${JSON.stringify(loginPayload)}`);
assert(loginPayload.user?.id === process.env.DEV_OWNER_ID, "Login must return the seeded administrator.");
const sessionSetCookie = loginResponse.headers.get("set-cookie") || "";
assert(/HttpOnly/i.test(sessionSetCookie), "The session cookie must be HttpOnly.");
assert(/SameSite=Strict/i.test(sessionSetCookie), "The session cookie must be SameSite=Strict.");
assert(/Max-Age=\d+/i.test(sessionSetCookie), "The session cookie must carry an expiry.");
const sessionCookie = sessionSetCookie.split(";")[0];
assert(sessionCookie.startsWith("yiling_session="), "The session cookie name must match the server contract.");

const cookieSession = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie } })).json();
assert(cookieSession.mode === "session" && cookieSession.user?.id === process.env.DEV_OWNER_ID, "A valid session cookie must resolve to the logged-in administrator.");

// --- Device list, session revocation and password change (throwaway account) ---
// Runs against its own account so a failing assertion can never leave the developer owner with an
// unknown password.
async function loginAs(username, password) {
  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ username, password }),
  });
  return {
    status: response.status,
    cookie: (response.headers.get("set-cookie") || "").split(";")[0],
    payload: await getJson(response),
  };
}

function scryptHashOf(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 64).toString("base64url")}`;
}

const passwordAccount = `ci-password-${Date.now().toString()}`;
const initialPassword = "ci-initial-password-1";
const rotatedPassword = "ci-updated-password-2";
const passwordUserId = (await prisma.user.create({
  data: { username: passwordAccount, passwordHash: scryptHashOf(initialPassword), displayName: "CI 改密测试" },
  select: { id: true },
})).id;

try {
  const firstLogin = await loginAs(passwordAccount, initialPassword);
  assert(firstLogin.status === 200, `The throwaway account must be able to log in (${firstLogin.status}).`);
  const tempCookie = firstLogin.cookie;

  // The device list reports the current session and never leaks token hashes.
  const listResponse = await fetch(new URL("/api/auth/sessions", baseUrl), { headers: { cookie: tempCookie } });
  assert(listResponse.status === 200, `GET /api/auth/sessions failed (${listResponse.status}).`);
  const deviceList = await listResponse.json();
  assert(Array.isArray(deviceList.sessions) && deviceList.sessions.length === 1, "A fresh login must produce exactly one listed session.");
  assert(deviceList.sessions[0].current === true, "The requesting session must be flagged as current.");
  assert(!("tokenHash" in deviceList.sessions[0]), "The device list must not expose session token hashes.");
  assert(typeof deviceList.sessions[0].device?.label === "string", "Each session must carry a derived device label.");

  // Cross-site revocation is refused by the origin guard even though the cookie is valid.
  const crossSiteRevoke = await fetch(new URL(`/api/auth/sessions/${deviceList.sessions[0].id}`, baseUrl), {
    method: "DELETE",
    headers: { cookie: tempCookie, "sec-fetch-site": "cross-site" },
  });
  assert(crossSiteRevoke.status === 403, "Cross-site session revocation must be rejected.");
  await crossSiteRevoke.arrayBuffer();

  async function changePassword(cookie, currentPassword, newPassword) {
    const response = await fetch(new URL("/api/auth/password", baseUrl), {
      method: "POST",
      headers: { ...writeHeaders, cookie },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return { status: response.status, payload: await getJson(response) };
  }

  const wrongCurrent = await changePassword(tempCookie, "definitely-the-wrong-one", rotatedPassword);
  assert(wrongCurrent.status === 400, "A wrong current password must be rejected with 400.");
  const tooShort = await changePassword(tempCookie, initialPassword, "short1");
  assert(tooShort.status === 400, "A too-short new password must be rejected with 400.");
  const noDigit = await changePassword(tempCookie, initialPassword, "alllettersonly");
  assert(noDigit.status === 400, "A new password without a digit must be rejected with 400.");

  const changed = await changePassword(tempCookie, initialPassword, rotatedPassword);
  assert(changed.status === 200 && changed.payload?.changed === true, `POST /api/auth/password failed (${changed.status}).`);

  const oldPasswordLogin = await loginAs(passwordAccount, initialPassword);
  assert(oldPasswordLogin.status === 401, "The old password must stop working immediately after a change.");
  const rotatedLogin = await loginAs(passwordAccount, rotatedPassword);
  assert(rotatedLogin.status === 200, "The new password must work immediately after a change.");

  // The session that changed the password survives; the newly created one joins the list.
  const survivorSession = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: tempCookie } })).json();
  assert(survivorSession.mode === "session", "The session that changed the password must stay valid.");
  const twoSessions = await (await fetch(new URL("/api/auth/sessions", baseUrl), { headers: { cookie: tempCookie } })).json();
  assert(twoSessions.sessions.length === 2, "Both active sessions must be listed after the second login.");

  // "Sign out other devices" keeps the caller and kills the rest.
  const revokeOthers = await fetch(new URL("/api/auth/sessions/revoke-others", baseUrl), {
    method: "POST",
    headers: { cookie: tempCookie, origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" },
  });
  assert(revokeOthers.status === 200, `POST /api/auth/sessions/revoke-others failed (${revokeOthers.status}).`);
  const revokeOthersPayload = await revokeOthers.json();
  assert(revokeOthersPayload.revoked === 1, `Revoking other sessions must report one revocation, got ${revokeOthersPayload.revoked}.`);
  const rotatedAfterRevoke = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: rotatedLogin.cookie } })).json();
  assert(rotatedAfterRevoke.mode === "anonymous", "The other device must be signed out.");
  const survivorAfterRevoke = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: tempCookie } })).json();
  assert(survivorAfterRevoke.mode === "session", "The device that requested the sign-out must stay logged in.");

  // Revoking your own session clears the cookie.
  const currentSessionId = twoSessions.sessions.find((entry) => entry.current)?.id;
  const selfRevoke = await fetch(new URL(`/api/auth/sessions/${currentSessionId}`, baseUrl), {
    method: "DELETE",
    headers: { cookie: tempCookie, origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" },
  });
  assert(selfRevoke.status === 200, `DELETE /api/auth/sessions/{id} failed (${selfRevoke.status}).`);
  const selfRevokePayload = await selfRevoke.json();
  assert(selfRevokePayload.currentRevoked === true, "Revoking the calling session must be reported as such.");
  assert(/Max-Age=0/i.test(selfRevoke.headers.get("set-cookie") || ""), "Revoking the calling session must clear the cookie.");
  const afterSelfRevoke = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: tempCookie } })).json();
  assert(afterSelfRevoke.mode === "anonymous", "A self-revoked session must stop authenticating.");
} finally {
  await prisma.loginAttempt.deleteMany({ where: { username: passwordAccount } });
  await prisma.user.deleteMany({ where: { id: passwordUserId } });
}

// --- Multi-user: open registration, role isolation, admin-only endpoints ---
const adminLogin = await loginAs(process.env.DEV_OWNER_USERNAME, process.env.DEV_OWNER_PASSWORD);
assert(adminLogin.status === 200, "The administrator must be able to log in for the multi-user checks.");
assert(adminLogin.payload.user.role === "ADMIN", "The developer owner must be reported as ADMIN.");
const adminCookie = adminLogin.cookie;

const userEmail = `ci-user-${Date.now().toString()}@example.com`;
const userPassword = "ci-user-password-1";

const registerResponse = await fetch(new URL("/api/auth/register", baseUrl), {
  method: "POST",
  headers: writeHeaders,
  body: JSON.stringify({ email: userEmail, password: userPassword }),
});
const registerPayload = await registerResponse.json().catch(() => null);
assert(registerResponse.status === 200, `POST /api/auth/register failed (${registerResponse.status}): ${JSON.stringify(registerPayload)}`);
assert(registerPayload.user?.role === "USER", "Self-registered accounts must default to USER.");
const userCookie = (registerResponse.headers.get("set-cookie") || "").split(";")[0];
const registeredUserId = registerPayload.user.id;

// A duplicate email is rejected.
const duplicateRegister = await fetch(new URL("/api/auth/register", baseUrl), {
  method: "POST",
  headers: writeHeaders,
  body: JSON.stringify({ email: userEmail, password: userPassword }),
});
assert(duplicateRegister.status === 409, "Registering the same email twice must be rejected.");
await duplicateRegister.arrayBuffer();

try {
  // A normal user owns nothing and sees none of the administrator's characters.
  const userCharacters = await (await fetch(new URL("/api/characters", baseUrl), { headers: { cookie: userCookie } })).json();
  assert(Array.isArray(userCharacters) && userCharacters.length === 0, "A new user must start with an empty character list, not the admin's.");

  // The same user is refused the admin endpoints.
  const forbiddenList = await fetch(new URL("/api/admin/users", baseUrl), { headers: { cookie: userCookie } });
  assert(forbiddenList.status === 403, "A normal user must not list accounts.");
  await forbiddenList.arrayBuffer();
  const forbiddenPatch = await fetch(new URL(`/api/admin/users/${registeredUserId}`, baseUrl), {
    method: "PATCH",
    headers: { ...writeHeaders, cookie: userCookie },
    body: JSON.stringify({ displayName: "hacked" }),
  });
  assert(forbiddenPatch.status === 403, "A normal user must not modify accounts.");
  await forbiddenPatch.arrayBuffer();

  // Audit log: login and registration are recorded, and only administrators can read them.
  const auditResponse = await fetch(new URL("/api/admin/audit?limit=50", baseUrl), { headers: { cookie: adminCookie } });
  assert(auditResponse.status === 200, "The administrator must be able to read the audit log.");
  const auditPayload = await auditResponse.json();
  assert(Array.isArray(auditPayload.items) && auditPayload.items.length > 0, "The audit log must contain recent auth events.");
  assert(auditPayload.items.some((item) => item.action === "auth.login"), "A login must be recorded as auth.login.");
  assert(auditPayload.items.some((item) => item.action === "auth.register"), "A registration must be recorded as auth.register.");
  const forbiddenAudit = await fetch(new URL("/api/admin/audit", baseUrl), { headers: { cookie: userCookie } });
  assert(forbiddenAudit.status === 403, "A normal user must not read the audit log.");
  await forbiddenAudit.arrayBuffer();

  // The administrator can list accounts and see only identity and statistics.
  const adminList = await (await fetch(new URL("/api/admin/users", baseUrl), { headers: { cookie: adminCookie } })).json();
  const listedUser = adminList.users.find((entry) => entry.id === registeredUserId);
  assert(listedUser, "The administrator list must include the newly registered user.");
  assert(listedUser.role === "USER", "The registered user must be listed with role USER.");
  assert(listedUser.email === userEmail, "The registered user must be listed under their email.");
  assert("characterCount" in listedUser, "The list must include per-account statistics.");
  assert(!("conversations" in listedUser), "The account list must not leak conversation data.");
  assert(!("memories" in listedUser), "The account list must not leak memory data.");

  // The administrator cannot disable their own account.
  const selfDisable = await fetch(new URL(`/api/admin/users/${process.env.DEV_OWNER_ID}`, baseUrl), {
    method: "PATCH",
    headers: { ...writeHeaders, cookie: adminCookie },
    body: JSON.stringify({ status: "DISABLED" }),
  });
  assert(selfDisable.status === 400, "An administrator must not be able to disable their own account.");
  await selfDisable.arrayBuffer();

  // Disabling a user immediately invalidates their session.
  const disable = await fetch(new URL(`/api/admin/users/${registeredUserId}`, baseUrl), {
    method: "PATCH",
    headers: { ...writeHeaders, cookie: adminCookie },
    body: JSON.stringify({ status: "DISABLED" }),
  });
  assert(disable.status === 200, `Disabling a user failed (${disable.status}).`);
  await disable.arrayBuffer();
  const afterDisable = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: userCookie } })).json();
  assert(afterDisable.mode === "anonymous" && afterDisable.user === null, "A disabled user's session must stop authenticating.");
} finally {
  await prisma.session.deleteMany({ where: { userId: registeredUserId } });
  await prisma.loginAttempt.deleteMany({ where: { username: userEmail } });
  await prisma.auditLog.deleteMany({ where: { actorId: registeredUserId } });
  await prisma.user.deleteMany({ where: { id: registeredUserId } });
}

const noSuchAccount = "ci-no-such-user-" + Date.now().toString();
const badLogin = await fetch(new URL("/api/auth/login", baseUrl), {
  method: "POST",
  headers: writeHeaders,
  body: JSON.stringify({ username: noSuchAccount, password: "definitely-the-wrong-password" }),
});
assert(badLogin.status === 401, "A wrong password must be rejected with 401.");
await badLogin.arrayBuffer();

let throttleStatus = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ username: noSuchAccount, password: "definitely-the-wrong-password" }),
  });
  throttleStatus = response.status;
  await response.arrayBuffer();
  if (throttleStatus === 429) break;
}
assert(throttleStatus === 429, "Repeated failed logins must be throttled.");
await prisma.loginAttempt.deleteMany({ where: { username: noSuchAccount } });

const logoutResponse = await fetch(new URL("/api/auth/logout", baseUrl), {
  method: "POST",
  headers: { cookie: sessionCookie, origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" },
});
assert(logoutResponse.status === 204, "Logout must succeed with 204.");
assert(/Max-Age=0/i.test(logoutResponse.headers.get("set-cookie") || ""), "Logout must expire the session cookie.");
await logoutResponse.arrayBuffer();

const afterLogoutSession = await (await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie } })).json();
assert(
  afterLogoutSession.mode === "anonymous" && afterLogoutSession.user === null,
  "A revoked cookie must not authenticate and must not silently fall back to the development owner.",
);

const firstList = await request("/api/characters");
assert(Array.isArray(firstList), "GET /api/characters must return a list.");

const unique = Date.now().toString();
const created = await request("/api/characters", {
  method: "POST",
  body: {
    name: `CI 持久化测试角色 ${unique}`,
    alias: "CI 验收",
    description: "用于验证数据库持久化的临时角色。",
    personality: "请保持语气清晰、温和。",
  },
});
assert(typeof created.id === "string" && created.id.length > 0, "POST must return the created character id.");
assert(created.name === `CI 持久化测试角色 ${unique}`, "Created character name did not round-trip.");
assert(Array.isArray(created.channels), "Character DTO must include a channels array.");

const loaded = await request(`/api/characters/${created.id}`);
assert(loaded.name === created.name, "GET by id did not return the new character.");

const initialTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(Array.isArray(initialTimeline) && initialTimeline.length === 0, "A new character should have an empty real timeline.");

const memoryContent = `CI 长期记忆 ${unique}：用户偏好简洁回答。`;
const createdMemory = await request(`/api/characters/${created.id}/memories`, {
  method: "POST",
  body: { category: "PREFERENCE", content: memoryContent },
});
assert(typeof createdMemory.id === "string", "POST memories must return the persisted memory id.");
assert(createdMemory.category === "PREFERENCE" && createdMemory.status === "ACTIVE", "Created memory should preserve its category and active status.");
const memoryDetail = await request(`/api/memories/${createdMemory.id}`);
assert(memoryDetail.content === memoryContent, "GET memory detail should return the full persisted content.");
const revisedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { category: "FACT", content: `CI 已修改记忆 ${unique}` },
});
assert(revisedMemory.category === "FACT" && revisedMemory.content === `CI 已修改记忆 ${unique}`, "PATCH should persist memory content and category.");
const archivedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "archived" },
});
assert(archivedMemory.status === "ARCHIVED", "Memory should support the archived status.");
const archivedTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(archivedTimeline.some((entry) => entry.id === `memory:${createdMemory.id}` && entry.tag === "已归档"), "Archived memory should remain in the timeline with its status.");
const invalidatedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "invalidated" },
});
assert(invalidatedMemory.status === "INVALIDATED", "Memory should support the invalidated status.");
const reactivatedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "active" },
});
assert(reactivatedMemory.status === "ACTIVE", "Archived or invalidated memory should be recoverable.");

const importedConversation = await request(`/api/characters/${created.id}/conversations/import`, {
  method: "POST",
  body: {
    title: `CI 对话导入 ${unique}`,
    messages: [
      { role: "USER", content: `用户问题 ${unique}` },
      { role: "ASSISTANT", content: `角色回复 ${unique}` },
      { role: "USER", content: `用户补充 ${unique}` },
    ],
  },
});
assert(typeof importedConversation.conversationId === "string", "Transcript import must return a conversation id.");
assert(importedConversation.messageCount === 3, "Transcript import must persist all messages in a transaction.");
assert(importedConversation.timestampsEstimated === true, "Plain transcript imports must disclose estimated timestamps.");

const importedTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(importedTimeline.length === 4, "The timeline should include one memory and all three imported messages.");
assert(importedTimeline.some((entry) => entry.id === `memory:${createdMemory.id}` && entry.title === "事实记忆" && entry.summary.includes(`CI 已修改记忆 ${unique}`)), "Timeline must show the updated memory content and category.");
assert(importedTimeline.filter((entry) => entry.type === "message").length === 3, "Timeline must include all imported conversation messages.");
assert(importedTimeline.some((entry) => entry.summary.includes(`角色回复 ${unique}`)), "Timeline must include imported assistant content.");

const edited = await request(`/api/characters/${created.id}`, {
  method: "PATCH",
  body: {
    name: `CI 持久化测试角色 ${unique}（已编辑）`,
    personality: "角色人设已持久化更新。",
  },
});
assert(edited.name.endsWith("（已编辑）"), "PATCH did not update the character name.");
assert(edited.personality === "角色人设已持久化更新。", "PATCH did not update the character personality.");

const savedChatSettings = await request(`/api/characters/${created.id}`, {
  method: "PATCH",
  body: {
    chatApiBaseUrl: "http://127.0.0.1:4010/v1",
    chatApiKey: "ci-only",
    chatModel: "ci-character-model",
    chatTemperature: 0.4,
    chatMaxTokens: 1024,
  },
});
assert(savedChatSettings.chatModel === "ci-character-model", "Character model override did not round-trip.");
assert(savedChatSettings.chatTemperature === 0.4 && savedChatSettings.chatMaxTokens === 1024, "Character temperature/token settings did not round-trip.");
assert(savedChatSettings.chatApiBaseUrl === "http://127.0.0.1:4010/v1", "Character API Base URL did not round-trip.");
assert(savedChatSettings.chatApiKeyConfigured === true && savedChatSettings.chatApiKeySource === "character", "The character should report its encrypted API key as configured.");
assert(!Object.prototype.hasOwnProperty.call(savedChatSettings, "chatApiKey"), "The character DTO must never return an API key.");
const reloadedChatSettings = await request(`/api/characters/${created.id}`);
assert(reloadedChatSettings.chatModel === "ci-character-model" && reloadedChatSettings.chatMaxTokens === 1024, "Character-specific chat settings did not persist after reloading.");
assert(reloadedChatSettings.chatApiKeyConfigured === true && !Object.prototype.hasOwnProperty.call(reloadedChatSettings, "chatApiKey"), "The encrypted API Key must remain configured but never be returned.");
const apiTest = await request(`/api/characters/${created.id}/chat/test-connection`, { method: "POST" });
assert(apiTest.ok === true && apiTest.provider === "127.0.0.1", "API connection test should use the saved URL and decrypted API Key.");

const initialSettings = await request(`/api/characters/${created.id}/memory-settings`);
assert(initialSettings.snapshotIntervalDays === 8 && initialSettings.activeSnapshotIntervalDays === 8 && initialSettings.pendingSnapshotIntervalDays === null, "New character should get an 8-day default interval with no pending change.");
assert(initialSettings.changePolicy === "NEXT_CYCLE", "New character should use NEXT_CYCLE by default.");
assert(initialSettings.rawMessageRetentionDays === 0, "New characters should preserve raw messages permanently until the user opts into cleanup.");
assert(initialSettings.rawMessageCleanupEnabled === false, "New characters should require an explicit cleanup opt-in.");

const schedulerAnchorAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const savedSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 3,
    timezone: "America/Los_Angeles",
    anchorAt: schedulerAnchorAt.toISOString(),
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: true,
    changePolicy: "IMMEDIATE_RECALC",
  },
});
assert(savedSettings.snapshotIntervalDays === 3, "Memory interval was not saved.");
assert(savedSettings.timezone === "America/Los_Angeles", "Timezone was not saved.");
assert(savedSettings.rawMessageRetentionDays === 30, "Message retention was not saved.");
assert(savedSettings.changePolicy === "IMMEDIATE_RECALC", "Change policy was not saved.");

const pendingCycleSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 5,
    timezone: savedSettings.timezone,
    anchorAt: savedSettings.anchorAt,
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: true,
    changePolicy: "NEXT_CYCLE",
  },
});
assert(pendingCycleSettings.snapshotIntervalDays === 5, "The API should return the requested pending interval.");
assert(pendingCycleSettings.activeSnapshotIntervalDays === 3, "The active interval must remain unchanged before the current cycle ends.");
assert(pendingCycleSettings.pendingSnapshotIntervalDays === 5, "NEXT_CYCLE should persist the selected interval as pending.");
assert(pendingCycleSettings.nextSnapshotAt === savedSettings.nextSnapshotAt, "NEXT_CYCLE must keep the existing cycle boundary.");

const cancelledPendingCycleSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 3,
    timezone: savedSettings.timezone,
    anchorAt: savedSettings.anchorAt,
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: true,
    changePolicy: "NEXT_CYCLE",
  },
});
assert(cancelledPendingCycleSettings.activeSnapshotIntervalDays === 3, "Cancelling a pending interval must leave the active interval unchanged.");
assert(cancelledPendingCycleSettings.pendingSnapshotIntervalDays === null, "Selecting the current interval should cancel the pending change.");
assert(cancelledPendingCycleSettings.nextSnapshotAt === savedSettings.nextSnapshotAt, "Cancelling a pending change must not reset the current boundary.");

const immediateRecalcSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 4,
    timezone: savedSettings.timezone,
    anchorAt: savedSettings.anchorAt,
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: true,
    changePolicy: "IMMEDIATE_RECALC",
  },
});
assert(immediateRecalcSettings.activeSnapshotIntervalDays === 4, "IMMEDIATE_RECALC must apply the selected interval immediately.");
assert(immediateRecalcSettings.pendingSnapshotIntervalDays === null, "IMMEDIATE_RECALC must clear any pending interval.");
assert(
  immediateRecalcSettings.nextSnapshotAt === new Date(new Date(savedSettings.anchorAt).getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
  "IMMEDIATE_RECALC must recompute the next boundary from the current anchor and selected interval.",
);
const restoredThreeDaySettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 3,
    timezone: savedSettings.timezone,
    anchorAt: savedSettings.anchorAt,
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: true,
    changePolicy: "IMMEDIATE_RECALC",
  },
});
assert(restoredThreeDaySettings.activeSnapshotIntervalDays === 3 && restoredThreeDaySettings.pendingSnapshotIntervalDays === null, "The smoke test should restore its original active interval before testing backfill.");
assert(restoredThreeDaySettings.nextSnapshotAt === savedSettings.nextSnapshotAt, "Restoring the original interval should restore the original immediate-recalculation boundary.");

const invalidRetentionResponse = await fetch(
  new URL(`/api/characters/${created.id}/memory-settings`, baseUrl),
  {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snapshotIntervalDays: 3,
      timezone: "America/Los_Angeles",
      anchorAt: schedulerAnchorAt.toISOString(),
      rawMessageRetentionDays: 45,
      rawMessageCleanupEnabled: true,
      autoSnapshotEnabled: true,
      changePolicy: "IMMEDIATE_RECALC",
    }),
  }
);
assert(invalidRetentionResponse.status === 400, "Unsupported retention durations such as 45 days must be rejected.");
const invalidPermanentCleanupResponse = await fetch(
  new URL(`/api/characters/${created.id}/memory-settings`, baseUrl),
  {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snapshotIntervalDays: 3,
      timezone: "America/Los_Angeles",
      anchorAt: schedulerAnchorAt.toISOString(),
      rawMessageRetentionDays: 0,
      rawMessageCleanupEnabled: true,
      autoSnapshotEnabled: true,
      changePolicy: "IMMEDIATE_RECALC",
    }),
  }
);
assert(
  invalidPermanentCleanupResponse.status === 400,
  "Permanent retention and enabled raw-message cleanup must be rejected as a contradictory policy.",
);
await invalidPermanentCleanupResponse.text();
const settingsAfterInvalidRetention = await request(`/api/characters/${created.id}/memory-settings`);
assert(settingsAfterInvalidRetention.rawMessageRetentionDays === 30 && settingsAfterInvalidRetention.rawMessageCleanupEnabled === true, "Rejected retention updates must not change the saved value or its authorization state.");

const reloadedSettings = await request(`/api/characters/${created.id}/memory-settings`);
assert(reloadedSettings.snapshotIntervalDays === 3, "Memory interval did not persist after a new read.");
assert(reloadedSettings.autoSnapshotEnabled === true, "Auto-snapshot switch did not persist.");
assert(reloadedSettings.changePolicy === "IMMEDIATE_RECALC", "Change policy did not persist after a new read.");
assert(reloadedSettings.nextSnapshotAt && new Date(reloadedSettings.nextSnapshotAt).getTime() < Date.now(), "An old anchor should preserve the first overdue cycle boundary for scheduler backfill.");

const schedulerRun = await request("/api/tasks/scheduler/run", { method: "POST" });
assert(schedulerRun.settingsChecked >= 1, "Scheduler should discover the enabled overdue character.");
assert(schedulerRun.jobsQueued >= 3 && schedulerRun.periodsConsidered >= 3, "Scheduler should enqueue missed 3-day periods after downtime.");
const taskList = await request("/api/tasks");
assert(taskList.total >= 3 && taskList.items.filter((task) => task.characterId === created.id && task.type === "GENERATE_SNAPSHOT" && task.status === "QUEUED").length >= 3, "Task API should expose the persisted scheduled jobs.");
const repeatedSchedulerRun = await request("/api/tasks/scheduler/run", { method: "POST" });
assert(repeatedSchedulerRun.jobsQueued === 0, "A repeated scheduler scan should not enqueue duplicate work.");
const scheduledNextSnapshotAt = (await request(`/api/characters/${created.id}/memory-settings`)).nextSnapshotAt;

const createdSnapshot = await request(`/api/characters/${created.id}/snapshots`, { method: "POST" });
assert(typeof createdSnapshot.id === "string", "POST snapshots must return the persisted snapshot id.");
assert(createdSnapshot.version === 1, "The first manual snapshot must be version 1.");
const settingsAfterManualSnapshot = await request(`/api/characters/${created.id}/memory-settings`);
assert(settingsAfterManualSnapshot.nextSnapshotAt === scheduledNextSnapshotAt, "Manual snapshots must not reset the automatic schedule.");

const snapshotList = await request(`/api/characters/${created.id}/snapshots`);
assert(Array.isArray(snapshotList) && snapshotList.length === 1, "GET snapshots must return the created snapshot.");
assert(snapshotList[0].id === createdSnapshot.id, "Snapshot list did not return the created snapshot.");
assert(snapshotList[0].status === "当前版本", "The first snapshot should be current.");
assert(snapshotList[0].messages === 3, "A manual snapshot should link the three persisted messages in its time range.");

const regeneratedSnapshot = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: createdSnapshot.id },
});
assert(typeof regeneratedSnapshot.id === "string" && regeneratedSnapshot.id !== createdSnapshot.id, "Regeneration must create a new snapshot version.");

const snapshotHistory = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotHistory.length === 2, "Regeneration must preserve the old snapshot version.");
assert(snapshotHistory.some((snapshot) => snapshot.id === createdSnapshot.id && snapshot.status === "已被替代"), "The previous snapshot must be marked as superseded.");
assert(snapshotHistory.some((snapshot) => snapshot.id === regeneratedSnapshot.id && snapshot.version === 2 && snapshot.status === "当前版本"), "The regenerated version must be current and increment to version 2.");

const timelineAfterSnapshots = await request(`/api/characters/${created.id}/timeline`);
assert(Array.isArray(timelineAfterSnapshots) && timelineAfterSnapshots.length === 6, "The real timeline should include the saved memory, three messages, and both snapshot versions.");
assert(timelineAfterSnapshots.some((entry) => entry.id === `snapshot:${createdSnapshot.id}` && entry.type === "snapshot" && entry.tag === "已被替代"), "The timeline should show superseded snapshot versions.");
assert(timelineAfterSnapshots.some((entry) => entry.id === `snapshot:${regeneratedSnapshot.id}` && entry.type === "snapshot" && entry.tag === "当前版本"), "The timeline should show the current snapshot version.");

const trashedMemory = await request(`/api/memories/${createdMemory.id}/trash`, { method: "POST" });
assert(trashedMemory.status === "TRASHED" && trashedMemory.statusBeforeTrash === "ACTIVE", "Moving a memory to trash should retain its prior status.");
assert(typeof trashedMemory.deletedAt === "string", "Trashed memory should record its deletion time.");
const trashList = await request(`/api/characters/${created.id}/memories/trash`);
assert(trashList.some((memory) => memory.id === createdMemory.id && memory.content === `CI 已修改记忆 ${unique}`), "Recycle-bin API should return the soft-deleted memory.");
const timelineWithoutTrashedMemory = await request(`/api/characters/${created.id}/timeline`);
assert(!timelineWithoutTrashedMemory.some((entry) => entry.id === `memory:${createdMemory.id}`), "Trashed memories must not appear in the active timeline.");
assert(timelineWithoutTrashedMemory.length === 5, "Moving a memory to trash should preserve messages and both snapshot versions.");

const restoredFromTrash = await request(`/api/memories/${createdMemory.id}/restore`, { method: "POST" });
assert(restoredFromTrash.status === "ACTIVE" && restoredFromTrash.statusBeforeTrash === null && restoredFromTrash.deletedAt === null, "Restoring a memory should return it to its prior status and clear trash metadata.");
assert((await request(`/api/characters/${created.id}/memories/trash`)).every((memory) => memory.id !== createdMemory.id), "Restored memory should disappear from the recycle bin.");
assert((await request(`/api/characters/${created.id}/timeline`)).some((entry) => entry.id === `memory:${createdMemory.id}`), "Restored memory should return to the timeline.");

await request(`/api/memories/${createdMemory.id}/trash`, { method: "POST" });
const permanentDelete = await request(`/api/memories/${createdMemory.id}`, { method: "DELETE" });
assert(permanentDelete.permanentlyDeleted === true, "Permanent deletion should remove the current memory item.");
assert(permanentDelete.snapshotsPreserved === true && permanentDelete.preservedSnapshotReferences >= 2, "Permanent deletion must preserve historical snapshot source records.");
const finalTrashList = await request(`/api/characters/${created.id}/memories/trash`);
assert(finalTrashList.every((memory) => memory.id !== createdMemory.id), "Permanently deleted memory should no longer exist in the recycle bin.");
const timelineAfterPermanentDelete = await request(`/api/characters/${created.id}/timeline`);
assert(!timelineAfterPermanentDelete.some((entry) => entry.id === `memory:${createdMemory.id}`), "Permanently deleted memory should not appear in the timeline.");
const snapshotsAfterPermanentDelete = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotsAfterPermanentDelete.length === 2, "Permanent deletion must not rewrite or remove existing snapshot versions.");
const missingMemoryResponse = await fetch(new URL(`/api/memories/${createdMemory.id}`, baseUrl));
assert(missingMemoryResponse.status === 404, "Permanently deleted memory should no longer be addressable.");

const historicalStart = new Date(schedulerAnchorAt.getTime() + 60 * 60 * 1000);
const historicalConversation = await request(`/api/characters/${created.id}/conversations/import`, {
  method: "POST",
  body: {
    title: `CI 历史周期对话 ${unique}`,
    messages: [
      { role: "USER", content: `历史周期用户消息 ${unique}`, occurredAt: historicalStart.toISOString() },
      { role: "ASSISTANT", content: `历史周期角色回复 ${unique}`, occurredAt: new Date(historicalStart.getTime() + 60 * 60 * 1000).toISOString() },
    ],
  },
});
assert(historicalConversation.timestampsEstimated === false, "Explicit historical timestamps should be preserved for the worker test.");

const workerResults = [];
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (!result.processed) break;
  workerResults.push(result);
}
assert(workerResults.some((result) => result.status === "SUCCEEDED" && typeof result.snapshotId === "string"), "Worker should generate a persisted structured snapshot for a period with messages.");
assert(workerResults.some((result) => result.status === "SKIPPED"), "Worker should skip empty overdue periods.");
const workerTaskList = await request("/api/tasks");
assert(workerTaskList.items.some((task) => task.status === "SUCCEEDED"), "Task API should show worker-completed tasks.");
assert(workerTaskList.items.some((task) => task.status === "SKIPPED"), "Task API should show skipped empty-period tasks.");
const snapshotsAfterWorker = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotsAfterWorker.length === 3, "Worker should add one automatic snapshot without rewriting the two manual snapshot versions.");
const aiSnapshot = snapshotsAfterWorker.find((snapshot) => snapshot.generatedBy === "llm");
assert(aiSnapshot && typeof aiSnapshot.id === "string", "Worker should create an AI-generated snapshot through the configured local model endpoint.");
assert(aiSnapshot.summary.includes("CI 模拟模型已分析"), "The saved snapshot should contain the model-generated period summary.");
assert(Array.isArray(aiSnapshot.analysis?.importantEvents) && aiSnapshot.analysis.importantEvents.length === 1, "The snapshot should persist structured AI event extraction and its evidence.");
const appliedAiMemory = aiSnapshot.analysis?.memoryChangesApplied.find((change) => change.result === "CREATED" && typeof change.memoryItemId === "string");
assert(appliedAiMemory?.memoryItemId, "The AI snapshot should report its persisted long-term memory change.");
const tracedAiMemory = await request(`/api/memories/${appliedAiMemory.memoryItemId}`);
assert(tracedAiMemory.sourceMessageId === tracedAiMemory.sourceMessage?.id, "Each AI-created memory should expose its direct original-message reference.");
assert(tracedAiMemory.sourceMessage?.role === "USER" && tracedAiMemory.sourceMessage.content.startsWith(`历史周期用户消息 ${unique}`), "The memory source should be the actual original dialogue, not an invented source ID.");
assert(tracedAiMemory.sourceSnapshotId === aiSnapshot.id && tracedAiMemory.sourceSnapshot?.id === aiSnapshot.id, "The AI memory should link back to the snapshot that produced it.");


const queuedAiRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: aiSnapshot.id, mode: "ai" },
});
assert(queuedAiRegeneration.queued === true && queuedAiRegeneration.status === "QUEUED", "AI regeneration should create a persisted queued worker task.");
const duplicateAiRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: aiSnapshot.id, mode: "ai" },
});
assert(duplicateAiRegeneration.jobId === queuedAiRegeneration.jobId && duplicateAiRegeneration.duplicate === true, "Repeated regeneration clicks should reuse the queued task.");

let aiRegenerationResult = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === queuedAiRegeneration.jobId) {
    aiRegenerationResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(aiRegenerationResult?.status === "SUCCEEDED" && typeof aiRegenerationResult.snapshotId === "string", "Worker should process the AI regeneration job.");
const snapshotsAfterAiRegeneration = await request(`/api/characters/${created.id}/snapshots`);
const regeneratedAiSnapshot = snapshotsAfterAiRegeneration.find((snapshot) => snapshot.id === aiRegenerationResult.snapshotId);
assert(regeneratedAiSnapshot?.kind === "AUTOMATIC" && regeneratedAiSnapshot.version === 2 && regeneratedAiSnapshot.status === "当前版本", "AI regeneration should create version 2 as the current automatic snapshot.");
assert(snapshotsAfterAiRegeneration.some((snapshot) => snapshot.id === aiSnapshot.id && snapshot.status === "已被替代"), "AI regeneration must preserve and supersede the original version.");
assert(regeneratedAiSnapshot.analysis?.memoryChangesApplied.some((change) => change.result === "NOT_APPLIED_REGENERATION"), "Regeneration should disclose proposed memory changes without silently applying them to current long-term memory.");
// 审核清单是最需要人判断的一份数据，证据 ID 必须能在本快照的来源消息里逐条对上。
const regeneratedSourceIds = new Set((regeneratedAiSnapshot.sourceMessages || []).map((source) => source.id));
assert(
  (regeneratedAiSnapshot.analysis?.memoryChangesApplied || [])
    .filter((change) => change.result === "NOT_APPLIED_REGENERATION")
    .every((change) => (change.evidenceMessageIds || []).every((messageId) => regeneratedSourceIds.has(messageId))),
  "Regeneration review entries must only keep evidence IDs present in the snapshot's own source messages.",
);

const queuedCancelableRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: regeneratedAiSnapshot.id, mode: "ai" },
});
const canceledTask = await request(`/api/tasks/${queuedCancelableRegeneration.jobId}/cancel`, { method: "POST" });
assert(canceledTask.status === "CANCELLED", "Waiting tasks should be manually cancellable.");
const retriedTask = await request(`/api/tasks/${queuedCancelableRegeneration.jobId}/retry`, { method: "POST" });
assert(retriedTask.status === "QUEUED", "Cancelled snapshot tasks should be manually re-queued with attempts reset.");
let retriedRegenerationResult = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === queuedCancelableRegeneration.jobId) {
    retriedRegenerationResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(retriedRegenerationResult?.status === "SUCCEEDED", "Worker should process a manually re-queued regeneration task.");
const finalSnapshotHistory = await request(`/api/characters/${created.id}/snapshots`);
assert(finalSnapshotHistory.some((snapshot) => snapshot.id === retriedRegenerationResult.snapshotId && snapshot.version === 3 && snapshot.status === "当前版本"), "Retried regeneration should advance the same logical snapshot to version 3.");

const latestList = await request("/api/characters");
assert(latestList.some((character) => character.id === created.id && character.name === edited.name), "Character changes did not appear in the list.");

// Scope isolation over real HTTP. Another user's private memory must never reach the prompt, while
// the acting user's own private memory must be retrievable and labelled as private.
const characterForPrivateScope = await prisma.character.findUnique({
  where: { id: created.id },
  select: { ownerId: true },
});
assert(characterForPrivateScope?.ownerId, "The smoke-test character should have an owner for private-scope isolation coverage.");
const foreignUser = await prisma.user.create({
  data: { username: `ci-private-other-${unique}`, passwordHash: "ci-only" },
});
const foreignPrivateScope = await prisma.memoryScope.create({
  data: {
    characterId: created.id,
    scopeType: "USER_PRIVATE",
    scopeKey: `ci-private-isolation:${created.id}:${unique}`,
    userId: foreignUser.id,
  },
});
await prisma.memoryItem.create({
  data: {
    memoryScopeId: foreignPrivateScope.id,
    category: "PREFERENCE",
    content: `YILING_PRIVATE_SCOPE_ONLY_SENTINEL_${unique}: must not enter another user's chat context.`,
    confidence: 1,
  },
});
const ownPrivateScope = await prisma.memoryScope.create({
  data: {
    characterId: created.id,
    scopeType: "USER_PRIVATE",
    scopeKey: `character:${created.id}:user:${characterForPrivateScope.ownerId}`,
    userId: characterForPrivateScope.ownerId,
  },
});
const ownPrivateMarker = `柠檬气泡水-${unique}`;
await prisma.memoryItem.create({
  data: {
    memoryScopeId: ownPrivateScope.id,
    category: "PREFERENCE",
    content: `我的私人口味：${ownPrivateMarker}。`,
    confidence: 1,
  },
});
let chatReply;
try {
  chatReply = await request("/api/characters/" + created.id + "/chat", {
    method: "POST",
    body: { message: `请回忆一下历史周期用户消息：我的私人口味 ${ownPrivateMarker} 是什么？` },
  });
} finally {
  await prisma.memoryScope.delete({ where: { id: foreignPrivateScope.id } });
  await prisma.memoryScope.delete({ where: { id: ownPrivateScope.id } });
  await prisma.user.delete({ where: { id: foreignUser.id } });
}
assert(chatReply.retrieval?.privateScopeActive === true, "The chat should report that the acting user's private scope is active.");
assert(
  chatReply.assistantMessage.sources.memories.some((memory) => memory.scope === "private" && memory.content.includes(ownPrivateMarker)),
  "The acting user's own private memory must be retrievable and labelled as private.",
);
assert(
  chatReply.assistantMessage.sources.memories.every((memory) => !memory.content.includes("YILING_PRIVATE_SCOPE_ONLY_SENTINEL_")),
  "Another user's private memory must never be cited.",
);
assert(typeof chatReply.conversationId === "string", "AI chat should persist a conversation.");
assert(chatReply.assistantMessage?.content?.includes("CI 模拟模型回复"), "Chat API should return the local mock model response.");
assert(Array.isArray(chatReply.assistantMessage?.sources?.memories), "Chat reply should expose validated memory source references.");
assert(chatReply.assistantMessage.sources.memories.length <= chatReply.retrieval.memoriesAvailable, "The chat should not cite more memory items than were retrieved.");
assert(chatReply.assistantMessage.sources.snapshots.length <= chatReply.retrieval.snapshotsAvailable, "The chat should not cite more snapshots than were retrieved.");
const chatHistory = await request("/api/characters/" + created.id + "/chat?conversationId=" + chatReply.conversationId);
assert(chatHistory.selectedConversationId === chatReply.conversationId, "GET chat should reopen the selected conversation.");
assert(chatHistory.messages.length === 2, "A new chat should persist one user message and one assistant reply.");
assert(chatHistory.messages[0].role === "USER" && chatHistory.messages[1].role === "ASSISTANT", "Persisted chat messages should keep their speaker roles.");
assert(chatHistory.messages[1].content === chatReply.assistantMessage.content, "Reopened chat should preserve the assistant reply.");
assert(
  chatHistory.messages[1].sources.memories.every((memory) => memory.scope === "character" || memory.scope === "private"),
  "Stored chat sources should keep an explicit scope label.",
);

const renamedTitle = "CI 重命名会话 " + unique;
const renamedConversation = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { title: renamedTitle },
});
assert(renamedConversation.title === renamedTitle, "Conversation title PATCH should persist a renamed title.");
const renamedHistory = await request("/api/characters/" + created.id + "/chat?status=ACTIVE&q=" + encodeURIComponent(renamedTitle));
assert(renamedHistory.conversations.some((item) => item.id === chatReply.conversationId && item.title === renamedTitle), "Renamed title should be visible in history search.");

const searchedChats = await request("/api/characters/" + created.id + "/chat?status=ACTIVE&q=" + encodeURIComponent("历史周期用户消息"));
assert(searchedChats.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Chat history search should match message text, not only the conversation title.");
const archiveResult = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { status: "ARCHIVED" },
});
assert(archiveResult.status === "ARCHIVED", "Archiving a conversation should retain it with ARCHIVED status.");
const activeChatsAfterArchive = await request("/api/characters/" + created.id + "/chat");
assert(!activeChatsAfterArchive.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Archived conversations must be hidden from the active history list.");
const archivedChats = await request("/api/characters/" + created.id + "/chat?status=ARCHIVED&q=" + encodeURIComponent("历史周期用户消息"));
assert(archivedChats.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Archived conversations should remain searchable and recoverable.");
const archivedHistory = await request("/api/characters/" + created.id + "/chat?status=ARCHIVED&conversationId=" + chatReply.conversationId);
assert(archivedHistory.selectedConversationId === chatReply.conversationId && archivedHistory.messages.length === 2, "Archived conversation history and messages must remain readable.");
const firstExportPage = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId + "?page=1&pageSize=1");
const secondExportPage = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId + "?page=2&pageSize=1");
assert(firstExportPage.total === 2 && firstExportPage.messages.length === 1 && firstExportPage.page === 1, "Transcript export should paginate the full conversation.");
assert(secondExportPage.total === 2 && secondExportPage.messages.length === 1 && secondExportPage.page === 2, "Transcript export should return subsequent messages with the total count.");
assert(firstExportPage.messages[0].role === "USER" && secondExportPage.messages[0].role === "ASSISTANT", "Transcript export pages should preserve chronological speaker order.");
const archivedSendResponse = await fetch(new URL("/api/characters/" + created.id + "/chat", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "不应写入归档会话", conversationId: chatReply.conversationId }),
});
assert(archivedSendResponse.status === 404, "Archived conversations must not accept new chat messages.");
const restoreResult = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { status: "ACTIVE" },
});
assert(restoreResult.status === "ACTIVE", "Restoring an archived conversation should make it active again.");
const restoredChat = await request("/api/characters/" + created.id + "/chat?conversationId=" + chatReply.conversationId);
assert(restoredChat.selectedConversationId === chatReply.conversationId && restoredChat.messages.length === 2, "Restored chat history must preserve its messages.");

// Isolated end-to-end retention check: only the expired message should be deleted.
const retentionCharacter = await request("/api/characters", {
  method: "POST",
  body: {
    name: "CI 消息保留策略测试 " + unique,
    alias: "CI 保留测试",
    description: "用于端到端验证过期原始消息清理。",
    personality: "仅用于自动化测试。",
  },
});
const dayMs = 24 * 60 * 60 * 1000;
const expiredAt = new Date(Date.now() - 60 * dayMs);
const retainedAt = new Date(Date.now() - 2 * dayMs);
const retentionConversation = await request(`/api/characters/${retentionCharacter.id}/conversations/import`, {
  method: "POST",
  body: {
    title: "CI 原始消息清理验收 " + unique,
    messages: [
      { role: "USER", content: "CI 过期原始消息 " + unique, occurredAt: expiredAt.toISOString() },
      { role: "ASSISTANT", content: "CI 应保留的近期消息 " + unique, occurredAt: retainedAt.toISOString() },
    ],
  },
});
const retentionSettings = await request(`/api/characters/${retentionCharacter.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 8,
    timezone: "America/Los_Angeles",
    anchorAt: new Date(Date.now() - 90 * dayMs).toISOString(),
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: false,
    changePolicy: "NEXT_CYCLE",
  },
});
assert(retentionSettings.rawMessageRetentionDays === 30 && retentionSettings.autoSnapshotEnabled === false, "Retention-only test character settings should persist without enabling automatic snapshots.");

await request("/api/tasks/scheduler/run", { method: "POST" });
const tasksBeforeCleanup = await request("/api/tasks?limit=100");
const retentionCleanupTask = tasksBeforeCleanup.items.find((task) =>
  task.characterId === retentionCharacter.id &&
  task.type === "CLEAN_EXPIRED_MESSAGES" &&
  task.status === "QUEUED"
);
assert(retentionCleanupTask && typeof retentionCleanupTask.id === "string", "Scheduler should enqueue a retention cleanup task for the isolated character.");

const cancelledCleanupTask = await request(`/api/tasks/${retentionCleanupTask.id}/cancel`, { method: "POST" });
assert(cancelledCleanupTask.status === "CANCELLED", "Queued cleanup tasks should support safe manual cancellation.");

const disableCleanupAuthorization = await request(
  `/api/characters/${retentionCharacter.id}/memory-settings`,
  {
    method: "PATCH",
    body: {
      snapshotIntervalDays: 8,
      timezone: "America/Los_Angeles",
      anchorAt: retentionSettings.anchorAt,
      rawMessageRetentionDays: 30,
      rawMessageCleanupEnabled: false,
      autoSnapshotEnabled: false,
      changePolicy: "NEXT_CYCLE",
    },
  }
);
assert(disableCleanupAuthorization.rawMessageCleanupEnabled === false, "Cleanup authorization should be revocable.");
const rejectedCleanupRetry = await fetch(
  new URL(`/api/tasks/${retentionCleanupTask.id}/retry`, baseUrl),
  { method: "POST" }
);
assert(rejectedCleanupRetry.status === 409, "Manual cleanup retry must be rejected while authorization is disabled.");
await rejectedCleanupRetry.text();
const taskAfterRejectedRetry = (await request("/api/tasks?limit=100")).items.find((task) => task.id === retentionCleanupTask.id);
assert(taskAfterRejectedRetry?.status === "CANCELLED", "Rejected cleanup retry must leave the task cancelled.");

await request(`/api/characters/${retentionCharacter.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 8,
    timezone: "America/Los_Angeles",
    anchorAt: retentionSettings.anchorAt,
    rawMessageRetentionDays: 30,
    rawMessageCleanupEnabled: true,
    autoSnapshotEnabled: false,
    changePolicy: "NEXT_CYCLE",
  },
});
const retriedCleanupTask = await request(`/api/tasks/${retentionCleanupTask.id}/retry`, { method: "POST" });
assert(retriedCleanupTask.status === "QUEUED", "Cleanup tasks can be re-queued again after authorization is explicitly restored.");

let retentionCleanupResult = null;
for (let attempt = 0; attempt < 10; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === retentionCleanupTask.id) {
    retentionCleanupResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(retentionCleanupResult?.status === "SUCCEEDED", "Worker should execute the isolated raw-message retention cleanup.");

const retentionHistory = await request(
  `/api/characters/${retentionCharacter.id}/chat?conversationId=${retentionConversation.conversationId}`
);
assert(retentionHistory.messages.length === 1, "Cleanup should remove only the expired message from the imported conversation.");
assert(
  retentionHistory.messages[0].content === "CI 应保留的近期消息 " + unique,
  "Cleanup must preserve the recent message after removing the expired one."
);

const tasksAfterCleanup = await request("/api/tasks?limit=100");
const visibleCleanupTask = tasksAfterCleanup.items.find((task) => task.id === retentionCleanupTask.id);
assert(visibleCleanupTask?.status === "SUCCEEDED", "Task API should expose the completed cleanup state.");
assert(
  visibleCleanupTask.cleanupResult?.deletedMessageCount === 1,
  "Task API should read the actual deleted-message count from the cleanup audit record."
);
assert(
  typeof visibleCleanupTask.cleanupResult.cutoff === "string" &&
  Date.parse(visibleCleanupTask.cleanupResult.cutoff) > expiredAt.getTime() &&
  Date.parse(visibleCleanupTask.cleanupResult.cutoff) < retainedAt.getTime(),
  "Task API should expose the exact cutoff between the expired and retained messages."
);

// Extending retention must cancel a previously queued, more aggressive cleanup job.
const widenedRetentionCharacter = await request("/api/characters", {
  method: "POST",
  body: {
    name: "CI 延长保留期限测试 " + unique,
    alias: "CI 延长期限",
    description: "确认延长保留期限后旧清理任务不会误删原始消息。",
    personality: "仅用于自动化测试。",
  },
});
const widenedExpiredAt = new Date(Date.now() - 60 * dayMs);
const widenedConversation = await request(
  `/api/characters/${widenedRetentionCharacter.id}/conversations/import`,
  {
    method: "POST",
    body: {
      title: "CI 保留期限延长测试 " + unique,
      messages: [
        { role: "USER", content: "延长保留期后必须保留的原文 " + unique, occurredAt: widenedExpiredAt.toISOString() },
      ],
    },
  }
);
const widenedSettingsBase = {
  snapshotIntervalDays: 8,
  timezone: "America/Los_Angeles",
  anchorAt: new Date(Date.now() - 90 * dayMs).toISOString(),
  rawMessageCleanupEnabled: true,
  autoSnapshotEnabled: false,
  changePolicy: "NEXT_CYCLE",
};
await request(`/api/characters/${widenedRetentionCharacter.id}/memory-settings`, {
  method: "PATCH",
  body: { ...widenedSettingsBase, rawMessageRetentionDays: 30 },
});
await request("/api/tasks/scheduler/run", { method: "POST" });
const tasksBeforeWidening = await request("/api/tasks?limit=100");
const staleWidenedCleanupTask = tasksBeforeWidening.items.find((task) =>
  task.characterId === widenedRetentionCharacter.id &&
  task.type === "CLEAN_EXPIRED_MESSAGES" &&
  task.status === "QUEUED"
);
assert(staleWidenedCleanupTask, "A 30-day retention policy should queue the initial cleanup task.");
await request(`/api/characters/${widenedRetentionCharacter.id}/memory-settings`, {
  method: "PATCH",
  body: { ...widenedSettingsBase, rawMessageRetentionDays: 90 },
});
let widenedCleanupResult = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === staleWidenedCleanupTask.id) {
    widenedCleanupResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(widenedCleanupResult?.status === "CANCELLED", "The worker must cancel an old 30-day cleanup after retention is widened to 90 days.");
const widenedHistory = await request(
  `/api/characters/${widenedRetentionCharacter.id}/chat?conversationId=${widenedConversation.conversationId}`
);
assert(
  widenedHistory.messages.length === 1 &&
  widenedHistory.messages[0].content === "延长保留期后必须保留的原文 " + unique,
  "A message still inside the widened 90-day retention window must remain readable.",
);
const widenedTaskAfterRun = (await request("/api/tasks?limit=100")).items.find((task) => task.id === staleWidenedCleanupTask.id);
assert(widenedTaskAfterRun?.status === "CANCELLED", "Task API should expose cancellation of the stale cleanup job.");

// A finite retention value is not consent by itself (covers legacy settings after upgrade).
const unoptedRetentionCharacter = await request("/api/characters", {
  method: "POST",
  body: {
    name: "CI 未授权清理测试 " + unique,
    alias: "CI 未授权清理",
    description: "确保有限保留天数本身不会自动授权删除。",
    personality: "仅用于自动化测试。",
  },
});
const unoptedSettings = await request(
  `/api/characters/${unoptedRetentionCharacter.id}/memory-settings`,
  {
    method: "PATCH",
    body: {
      snapshotIntervalDays: 8,
      timezone: "America/Los_Angeles",
      anchorAt: new Date(Date.now() - 90 * dayMs).toISOString(),
      rawMessageRetentionDays: 90,
      rawMessageCleanupEnabled: false,
      autoSnapshotEnabled: false,
      changePolicy: "NEXT_CYCLE",
    },
  }
);
assert(unoptedSettings.rawMessageRetentionDays === 90 && unoptedSettings.rawMessageCleanupEnabled === false, "Finite retention can be configured without authorizing cleanup.");
await request("/api/tasks/scheduler/run", { method: "POST" });
const tasksWithUnoptedRetention = await request("/api/tasks?limit=100");
assert(
  !tasksWithUnoptedRetention.items.some((task) =>
    task.characterId === unoptedRetentionCharacter.id && task.type === "CLEAN_EXPIRED_MESSAGES"
  ),
  "A finite retention setting without explicit opt-in must not queue cleanup."
);

// Permanent retention is a safety mode: scheduler must never enqueue cleanup for it.
const permanentRetentionCharacter = await request("/api/characters", {
  method: "POST",
  body: {
    name: "CI 永久保留测试 " + unique,
    alias: "CI 永久保留",
    description: "用于确认永久保留不会排入清理任务。",
    personality: "仅用于自动化测试。",
  },
});
const permanentSettings = await request(
  `/api/characters/${permanentRetentionCharacter.id}/memory-settings`,
  {
    method: "PATCH",
    body: {
      snapshotIntervalDays: 8,
      timezone: "America/Los_Angeles",
      anchorAt: new Date().toISOString(),
      rawMessageRetentionDays: 0,
      rawMessageCleanupEnabled: false,
      autoSnapshotEnabled: false,
      changePolicy: "NEXT_CYCLE",
    },
  }
);
assert(permanentSettings.rawMessageRetentionDays === 0, "Permanent retention should round-trip through the API as zero.");
await request("/api/tasks/scheduler/run", { method: "POST" });
const tasksWithPermanentRetention = await request("/api/tasks?limit=100");
assert(
  !tasksWithPermanentRetention.items.some((task) =>
    task.characterId === permanentRetentionCharacter.id && task.type === "CLEAN_EXPIRED_MESSAGES"
  ),
  "Permanent retention must not enqueue raw-message cleanup work."
);

console.log("Local API smoke test passed: character CRUD, encrypted per-character API settings and connection test, memory settings including deferred changes, pending-change cancellation and immediate recalculation, transcript import, scheduler backfill, local-mock AI extraction, source-ID validation, persisted provenance, manual and AI snapshot versions, safe AI regeneration, task cancel/requeue, recycle-bin lifecycle, context-aware AI chat with private-scope isolation, conversation search/rename, archive/restore, archived write protection, end-to-end raw-message retention cleanup with audit-result visibility, cleanup-task cancel/retry, retention-widening protection, permanent-retention safety, login/logout with throttling, login-logout audit trail, device listing, cross-site revocation refusal, sign-out-others, password policy plus rotation with session invalidation, and open email registration with role isolation and admin-only account management.");

await prisma.$disconnect();
