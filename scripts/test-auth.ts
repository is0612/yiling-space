import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  canAdminister,
  checkPasswordPolicy,
  createSessionToken,
  DEFAULT_SESSION_TTL_HOURS,
  describeUserAgent,
  hashPassword,
  hashSessionToken,
  isLoginThrottled,
  isRegistrationEnabled,
  passwordPolicyMessage,
  readPasswordField,
  resolveActor,
  sessionTtlMs,
  verifyPassword,
} from "../server/utils/auth";
import { checkSameOrigin } from "../server/utils/local-api";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "admin", displayName: "管理员", role: "ADMIN" as const };

// 1. Password hashing round-trips and rejects wrong input.
const stored = await hashPassword("correct horse battery staple");
assert(stored.startsWith("scrypt$"), "New hashes must use the scrypt format.");
assert.equal(await verifyPassword("correct horse battery staple", stored), true);
assert.equal(await verifyPassword("wrong password", stored), false);
assert.equal(await verifyPassword("correct horse battery staple", "not-a-hash"), false);
assert.equal(await verifyPassword("correct horse battery staple", "scrypt$short$a"), false);
assert.equal(await verifyPassword("", stored), false);

// 2. Hashes produced by scripts/seed-dev-user.ts remain verifiable.
const seedSalt = randomBytes(16);
const seedHash = `scrypt$${seedSalt.toString("base64url")}$${scryptSync("local-dev-password", seedSalt, 64).toString("base64url")}`;
assert.equal(await verifyPassword("local-dev-password", seedHash), true, "Seed-script hashes must keep working.");
assert.equal(await verifyPassword("local-dev-passwore", seedHash), false);

// 3. Session tokens are opaque, unique and stored only as a hash.
const tokens = new Set(Array.from({ length: 50 }, () => createSessionToken()));
assert.equal(tokens.size, 50, "Session tokens must not repeat.");
for (const token of tokens) {
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/, "Session tokens must be base64url strings.");
}
const firstToken = [...tokens][0] ?? "";
assert.equal(hashSessionToken(firstToken), hashSessionToken(firstToken));
assert.match(hashSessionToken(firstToken), /^[0-9a-f]{64}$/, "Stored token hashes must be SHA-256 hex.");
assert.notEqual(hashSessionToken(firstToken), firstToken, "The stored hash must differ from the browser token.");

// 4. Cookie attributes.
const cookie = buildSessionCookie(firstToken, 12 * 60 * 60 * 1000, false);
assert(cookie.includes("yiling_session=" + firstToken));
assert(cookie.includes("HttpOnly"), "Session cookie must be HttpOnly.");
assert(cookie.includes("SameSite=Strict"), "Session cookie must be SameSite=Strict.");
assert(cookie.includes("Path=/"));
assert(cookie.includes("Max-Age=43200"));
assert(!cookie.includes("Secure"), "Local HTTP development must not force Secure.");
assert(buildSessionCookie(firstToken, 60_000, true).includes("Secure"), "Secure must be set when requested.");
const cleared = buildClearSessionCookie(false);
assert(cleared.includes("Max-Age=0") && cleared.includes("yiling_session="), "Logout must expire the cookie.");

// 5. Session TTL is bounded by configuration.
const originalTtl = process.env.AUTH_SESSION_TTL_HOURS;
try {
  process.env.AUTH_SESSION_TTL_HOURS = "30";
  assert.equal(sessionTtlMs(), 30 * 60 * 60 * 1000);
  process.env.AUTH_SESSION_TTL_HOURS = "0";
  assert.equal(sessionTtlMs(), DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000, "Out-of-range TTL falls back to the default.");
  process.env.AUTH_SESSION_TTL_HOURS = "abc";
  assert.equal(sessionTtlMs(), DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000);
} finally {
  if (originalTtl === undefined) delete process.env.AUTH_SESSION_TTL_HOURS;
  else process.env.AUTH_SESSION_TTL_HOURS = originalTtl;
}

// 6. CSRF / same-origin decision matrix.
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000", secFetchSite: "same-origin" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", secFetchSite: "none" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000" }), { ok: true }, "Non-browser clients send neither header.");
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "https://attacker.example" }),
  { ok: false, reason: "host_mismatch" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost.evil.test:3000" }),
  { ok: false, reason: "host_mismatch" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000.evil.test" }),
  { ok: false, reason: "invalid_origin" },
  "A malformed port must be rejected rather than normalised.",
);
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "null" }), { ok: false, reason: "invalid_origin" });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "ftp://localhost:3000" }), { ok: false, reason: "invalid_origin" });
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000", secFetchSite: "cross-site" }),
  { ok: false, reason: "cross_site" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", secFetchSite: "same-site" }),
  { ok: false, reason: "cross_site" },
);

// 7. Actor resolution: a broken session never falls back to the development owner.
assert.deepEqual(
  resolveActor({ hasSessionCookie: true, sessionUser: user, localDevUser: null }),
  { mode: "session", user },
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: true, sessionUser: null, localDevUser: user }),
  { mode: "anonymous", reason: "invalid_session", user: null },
  "An expired or revoked cookie must require a fresh login, not a silent dev fallback.",
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: false, sessionUser: null, localDevUser: user }),
  { mode: "local-dev", user },
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: false, sessionUser: null, localDevUser: null }),
  { mode: "anonymous", reason: "missing_session", user: null },
);

// 8. Login throttling thresholds.
assert.equal(isLoginThrottled({ userFailures: 4, ipFailures: 0 }), false);
assert.equal(isLoginThrottled({ userFailures: 5, ipFailures: 0 }), true);
assert.equal(isLoginThrottled({ userFailures: 0, ipFailures: 20 }), true);
assert.equal(isLoginThrottled({ userFailures: 0, ipFailures: 19 }), false);

// 9. Password policy for new passwords (existing passwords are never re-validated).
assert.deepEqual(checkPasswordPolicy("Abc12345"), { ok: false, reason: "too_short" });
assert.deepEqual(checkPasswordPolicy("A1" + "b".repeat(127)), { ok: false, reason: "too_long" });
assert.deepEqual(checkPasswordPolicy("1234567890"), { ok: false, reason: "needs_letter" });
assert.deepEqual(checkPasswordPolicy("abcdefghij"), { ok: false, reason: "needs_digit" });
assert.deepEqual(checkPasswordPolicy("Abcdefgh12", "Abcdefgh12"), { ok: false, reason: "reused" });
assert.deepEqual(checkPasswordPolicy("Abcdefgh12"), { ok: true });
assert.deepEqual(checkPasswordPolicy("abcdefghij1"), { ok: true }, "Symbols stay optional so the rule is not a barrier.");
assert(checkPasswordPolicy("Abcdefgh12", "Different99").ok, "A different password is never reported as reused.");
assert(passwordPolicyMessage("too_short").includes("10"), "The too-short message must state the minimum length.");

// 9b. Password fields are read defensively.
function expectStatus(fn: () => unknown, statusCode: number) {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { statusCode?: number }).statusCode, statusCode);
    return;
  }
  assert.fail("Expected the call to throw status " + statusCode + ".");
}
expectStatus(() => readPasswordField("", "密码"), 400);
expectStatus(() => readPasswordField(undefined, "密码"), 400);
expectStatus(() => readPasswordField(1234, "密码"), 400);
expectStatus(() => readPasswordField("x".repeat(4097), "密码"), 400);
assert.equal(readPasswordField("correct horse battery staple", "密码"), "correct horse battery staple");

// 10. Device labels are derived from the User-Agent and never leak the raw string.
assert.deepEqual(describeUserAgent(""), { label: "未知设备", kind: "unknown" });
assert.deepEqual(describeUserAgent(null), { label: "未知设备", kind: "unknown" });
assert.deepEqual(
  describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"),
  { label: "Windows · Edge", kind: "desktop" },
  "Edge must not be reported as Chrome.",
);
assert.deepEqual(
  describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
  { label: "macOS · Safari", kind: "desktop" },
  "Desktop Safari reports Macintosh without Mobile.",
);
assert.deepEqual(
  describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
  { label: "iOS · Safari", kind: "mobile" },
);
assert.deepEqual(
  describeUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
  { label: "iOS · Safari", kind: "tablet" },
  "iPad also reports Mobile, so the tablet check must win.",
);
assert.deepEqual(
  describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"),
  { label: "Android · Chrome", kind: "mobile" },
);
assert.deepEqual(describeUserAgent("curl/8.4.0"), { label: "未知设备", kind: "desktop" });

// 11. Administrator gate: only the ADMIN role may administer accounts.
assert.equal(canAdminister("ADMIN"), true);
assert.equal(canAdminister("USER"), false);
assert.equal(canAdminister(null), false, "An absent role must never grant administration.");
assert.equal(canAdminister(undefined), false);

// 12. Self-registration is opt-in: closed by default, only "true" opens it.
const originalRegistration = process.env.YILING_ALLOW_REGISTRATION;
try {
  delete process.env.YILING_ALLOW_REGISTRATION;
  assert.equal(isRegistrationEnabled(), false, "An unset flag must keep registration closed.");
  process.env.YILING_ALLOW_REGISTRATION = "false";
  assert.equal(isRegistrationEnabled(), false);
  process.env.YILING_ALLOW_REGISTRATION = "true";
  assert.equal(isRegistrationEnabled(), true, "Only an explicit true may open registration.");
} finally {
  if (originalRegistration === undefined) delete process.env.YILING_ALLOW_REGISTRATION;
  else process.env.YILING_ALLOW_REGISTRATION = originalRegistration;
}

console.log("Auth unit tests passed: scrypt hashing and seed compatibility, token hashing, cookie attributes, TTL bounds, same-origin/CSRF matrix, actor fallback refusal, login throttling thresholds, password policy, device-label derivation, the administrator gate, and opt-in registration.");
