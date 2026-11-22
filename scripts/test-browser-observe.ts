import assert from "node:assert/strict";
import { Response, fetch as undiciFetch } from "undici";
import { setMediaFetchForTest } from "../server/utils/safe-media-download";
import { authorizeBrowserUrl, buildHostResolverRules, observePublicBrowser } from "../server/utils/browser-observe";

// The confirmed form POST bypasses the pinned downloader, so Chromium itself must be pinned.
// A rebinding DNS answer cannot win if the only mapping is the address validated at launch.
assert.equal(
  buildHostResolverRules("example.com", "93.184.216.34", 4),
  "MAP example.com 93.184.216.34, MAP * ~NOTFOUND",
);
assert.equal(
  buildHostResolverRules("example.com", "2606:2800:220:1:248:1893:25c8:1946", 6),
  "MAP example.com [2606:2800:220:1:248:1893:25c8:1946], MAP * ~NOTFOUND",
  "IPv6 pins must be bracketed for Chromium",
);

for (const url of ["http://localhost", "http://127.0.0.1", "http://10.0.0.1", "file:///secret", "https://user:pass@8.8.8.8", "https://8.8.8.8:8443"]) {
  assert.throws(() => authorizeBrowserUrl(url, "https://8.8.8.8"));
}
assert.throws(() => authorizeBrowserUrl("https://1.1.1.1", "https://8.8.8.8"), /ORIGIN_NOT_AUTHORIZED/);
const requested: string[] = [];
const html = `<!doctype html><meta charset="utf-8"><title>Browser fixture</title>
<body><h1>只读观察</h1><div id="dynamic"></div><script>
document.getElementById('dynamic').textContent = 'Rendered by JavaScript';
fetch('/submit', {method:'POST',body:'not allowed'}).catch(()=>{});
fetch('http://127.0.0.1/secret').catch(()=>{});
fetch('https://1.1.1.1/cross-site').catch(()=>{});
</script><iframe src="http://127.0.0.1/frame"></iframe><a href="/next">next</a><a href="https://1.1.1.1/">external</a></body>`;
setMediaFetchForTest((async (url, init) => {
  const parsed = new URL(String(url));
  requested.push(parsed.toString());
  const headers = init?.headers as Record<string, string> | undefined;
  assert(!headers?.Cookie && !headers?.Authorization, "No browser credentials reach downloader");
  if (parsed.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "https://1.1.1.1/" } });
  assert.equal(parsed.origin, "https://8.8.8.8");
  assert.notEqual(parsed.pathname, "/submit");
  return new Response(html, { headers: { "content-type": "text/html", "set-cookie": "private=fixture" } });
}) as typeof undiciFetch);
try {
  const result = await observePublicBrowser("https://8.8.8.8/");
  assert.equal(result.title, "Browser fixture");
  assert.match(result.text, /Rendered by JavaScript/);
  assert.match(result.text, /只读观察/);
  assert.deepEqual(result.links, ["https://8.8.8.8/next"]);
  assert.match(result.screenshot, /^data:image\/png;base64,/);
  assert(result.blockedRequests >= 2);
  assert(requested.every(url => url === "https://8.8.8.8/"));
  await assert.rejects(() => observePublicBrowser("https://8.8.8.8/redirect"), /BROWSER_ORIGIN_NOT_AUTHORIZED/);
  console.log("Browser observation passed: real Chromium DOM/render/screenshot; only fixture transport; private hosts, cross-origin redirects, POST and iframe blocked.");
} finally { setMediaFetchForTest(null); }
