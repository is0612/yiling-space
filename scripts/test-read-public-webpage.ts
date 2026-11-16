import assert from "node:assert/strict";
import { fetch as undiciFetch, Response } from "undici";
import { setMediaFetchForTest } from "../server/utils/safe-media-download";
import { extractPublicWebpage, readPublicWebpage, validatePublicWebpageUrl } from "../server/utils/read-public-webpage";

for (const url of ["file:///tmp/a", "ftp://example.com", "http://localhost", "http://127.1", "http://10.0.0.1", "http://[::1]", "https://user:pass@example.com", "https://example.com:8443", "http://example.local", "invalid"]) {
  assert.throws(() => validatePublicWebpageUrl(url), /WEB_INVALID_URL/u);
}
assert.equal(validatePublicWebpageUrl("https://example.com:443/a#b").toString(), "https://example.com/a");
const html = '<html><head><title>A &amp; B</title><style>HIDDEN_STYLE</style></head><body><script>HIDDEN_SCRIPT</script><p>Hello &lt;world&gt;</p><div>Next &#x1F41F;</div><noscript>HIDDEN_FALLBACK</noscript><a href="/next">read</a><a href="http://127.0.0.1">private</a><a href="javascript:alert(1)">bad</a></body></html>';
const page = extractPublicWebpage(html, "text/html", "https://example.com/start");
assert.equal(page.title, "A & B");
assert(page.text.includes("Hello <world>"));
assert(page.text.includes("Next 🐟"));
assert(!page.text.includes("HIDDEN"));
assert.deepEqual(page.links, ["https://example.com/next"]);
const long = extractPublicWebpage("字".repeat(6001), "text/plain", "https://example.com");
assert.equal(long.text.length, 6000); assert(long.truncated);
assert.equal(extractPublicWebpage("# Heading\nText", "text/markdown", "https://example.com").title, "Heading");
assert.equal(extractPublicWebpage('{"x":"<script>literal</script>"}', "application/json", "https://example.com").text, '{"x":"<script>literal</script>"}');
assert.equal(extractPublicWebpage(Array.from({ length: 12 }, (_, n) => `<a href="/${n}">x</a>`).join(""), "text/html", "https://example.com").links.length, 8);
let calls = 0;
const mock = (handler: (url: URL, init: Parameters<typeof undiciFetch>[1]) => Response) => setMediaFetchForTest((async (url, init) => {
  calls++; return handler(new URL(String(url)), init);
}) as typeof undiciFetch);
try {
  mock((_url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert(!("Cookie" in headers)); assert(!("Authorization" in headers));
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const result = await readPublicWebpage("https://8.8.8.8/start");
  assert.equal(result.url, "https://8.8.8.8/start"); assert.equal(result.title, "A & B");
  mock(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
  await assert.rejects(readPublicWebpage("https://8.8.8.8"), /WEB_BLOCKED_HOST/u);
  mock(() => new Response(null, { status: 302, headers: { location: "https://8.8.8.8:8443/secret" } }));
  await assert.rejects(readPublicWebpage("https://8.8.8.8"), /WEB_INVALID_URL/u);
  mock(() => new Response("x", { headers: { "content-type": "image/png" } }));
  await assert.rejects(readPublicWebpage("https://8.8.8.8"), /WEB_UNSUPPORTED_CONTENT_TYPE/u);
  mock(() => new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/plain" } }));
  await assert.rejects(readPublicWebpage("https://8.8.8.8"), /WEB_TOO_LARGE/u);
  setMediaFetchForTest((async () => { throw new Error("sensitive token SECRET"); }) as typeof undiciFetch);
  await assert.rejects(readPublicWebpage("https://8.8.8.8"), error => error instanceof Error && error.message === "WEB_READ_FAILED" && !error.cause);
  const before = calls;
  await assert.rejects(readPublicWebpage("http://localhost"), /WEB_INVALID_URL/u);
  assert.equal(calls, before);
  console.log("Public webpage offline tests passed: URL restrictions, extraction, links, byte/text limits, redirects, credentials and sanitized failures. No network.");
} finally { setMediaFetchForTest(null); }
