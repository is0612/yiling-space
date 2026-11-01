import { getRequestURL } from "h3";
import { requireSameOrigin } from "../utils/local-api";

/**
 * Rejects browser requests whose Origin / Sec-Fetch-Site does not match this host for every /api
 * route, independent of which authentication path (session cookie or local development fallback)
 * the request ends up using. Reads are included so a cross-site page cannot probe the API, and
 * writes additionally rely on SameSite=Strict plus this check for CSRF defence.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/api/")) return;
  requireSameOrigin(event);
});
