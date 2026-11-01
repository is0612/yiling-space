import { createError, getHeader } from "h3";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SameOriginInput = {
  origin?: string | null;
  host?: string | null;
  secFetchSite?: string | null;
};

export type SameOriginDecision = { ok: true } | { ok: false; reason: "invalid_origin" | "host_mismatch" | "cross_site" };

/**
 * CSRF defence for cookie-authenticated state changes.
 *
 * A browser always attaches `Origin` to cross-origin requests and, for fetch/XHR, also
 * `Sec-Fetch-Site`. Both must agree with the request Host. Requests without either header are
 * treated as non-browser clients (curl, server-to-server, tests) and pass through: they still need
 * a valid session cookie, which a cross-site attacker cannot read.
 */
export function checkSameOrigin(input: SameOriginInput): SameOriginDecision {
  const host = (input.host ?? "").trim().toLowerCase();
  const fetchSite = (input.secFetchSite ?? "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, reason: "cross_site" };
  }

  const origin = (input.origin ?? "").trim();
  if (!origin) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Opaque origins such as "null" are never trusted.
    return { ok: false, reason: "invalid_origin" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "invalid_origin" };
  if (!host || parsed.host.toLowerCase() !== host) return { ok: false, reason: "host_mismatch" };
  return { ok: true };
}

export function requireSameOrigin(event: Parameters<typeof getHeader>[0]): void {
  const decision = checkSameOrigin({
    origin: getHeader(event, "origin"),
    host: getHeader(event, "host"),
    secFetchSite: getHeader(event, "sec-fetch-site"),
  });
  if (decision.ok) return;
  if (decision.reason === "cross_site") {
    throw createError({ statusCode: 403, statusMessage: "服务端拒绝跨站请求。" });
  }
  throw createError({ statusCode: 403, statusMessage: "服务端拒绝来自未知来源的请求。" });
}

export function requireUuid(value: string, label = "资源 ID"): string {
  if (!UUID_PATTERN.test(value)) {
    throw createError({ statusCode: 404, statusMessage: `${label}不存在。` });
  }
  return value;
}

export function readTrimmedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { required?: boolean } = {},
): string {
  if (typeof value !== "string") {
    if (options.required) {
      throw createError({ statusCode: 400, statusMessage: `${label}不能为空。` });
    }
    return "";
  }

  const trimmed = value.trim();
  if (options.required && !trimmed) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空。` });
  }
  if (trimmed.length > maxLength) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能超过 ${maxLength} 个字符。` });
  }
  return trimmed;
}
