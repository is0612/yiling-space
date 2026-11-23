import assert from "node:assert/strict";
import http from "node:http";
import { probeDesktopWeb, waitDesktopWeb, desktopWebFailure } from "./desktop-web-readiness.mjs";
let status = 503, body = "Nuxt starting", type = "text/html";
const server = http.createServer((_req, response) => { response.writeHead(status, { "content-type": type }); response.end(body); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  assert.deepEqual(await probeDesktopWeb(url), { ready: false, status: 503, reason: "http_error" });
  status = 500; type = "application/json"; body = JSON.stringify({ message: "private database password and stack" });
  const events = [];
  const failed = await waitDesktopWeb(url, { totalMs: 70, intervalMs: 10, onProbe: result => events.push(result) });
  assert.equal(failed.status, 500);
  assert.equal(events.length, 1, "identical failures should not flood startup logs");
  const diagnostic = desktopWebFailure(failed, 70) + JSON.stringify(events);
  assert(diagnostic.includes("HTTP 500"));
  assert(!diagnostic.includes("private database"), "response body must not leak into diagnostics");
  status = 200; type = "text/html"; body = "Nuxt loading";
  assert.equal((await probeDesktopWeb(url)).reason, "unexpected_content");
  type = "application/json"; body = JSON.stringify({ ok: true, service: "another-service" });
  assert.equal((await probeDesktopWeb(url)).reason, "invalid_health");
  body = JSON.stringify({ ok: true, service: "yiling-space" });
  assert.equal((await waitDesktopWeb(url, { totalMs: 1000 })).ready, true);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
assert.equal((await probeDesktopWeb(url)).reason, "request_failed");
console.log("Desktop readiness passed: 503 startup, 500 diagnostics without secrets, HTML/wrong service rejection, real JSON readiness and closed port.");
