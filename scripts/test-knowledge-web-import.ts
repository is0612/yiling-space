import assert from "node:assert/strict";
import {
  KNOWLEDGE_WEB_MAX_BYTES,
  fetchKnowledgeWebPage,
  parseKnowledgeWebContent,
} from "../server/utils/knowledge-web-import";
import { setMediaFetchForTest } from "../server/utils/safe-media-download";

const html = `<!doctype html><html><head><title>鲸类知识 &amp; 海洋</title><script>bad script</script><style>.x{display:none}</style></head><body>
<nav>网站导航</nav><main><h1>蓝鲸</h1><p>蓝鲸是现存体型最大的动物，属于须鲸类。成年蓝鲸通常以磷虾为主要食物来源，并通过鲸须板过滤海水来摄取大量小型甲壳类生物。</p><p>它们会随季节迁徙，在不同海域觅食和繁殖；研究人员也会结合声学记录、卫星标记与海洋观测来了解蓝鲸的活动规律。</p></main>
<footer>版权和页脚噪音</footer><script>ignore()</script></body></html>`;

function response(body: string | Uint8Array, status = 200, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }) {
  return new Response(body, { status, headers });
}

const parsed = parseKnowledgeWebContent({
  url: "https://example.com/article",
  finalUrl: "https://example.com/final",
  mediaType: "text/html",
  status: 200,
  data: Buffer.from(html),
});
assert.equal(parsed.title, "鲸类知识 & 海洋");
assert.equal(parsed.originalUrl, "https://example.com/article");
assert.equal(parsed.finalUrl, "https://example.com/final");
assert.match(parsed.rawContent, /蓝鲸是现存体型最大的动物/);
assert.doesNotMatch(parsed.rawContent, /网站导航|版权和页脚|bad script|ignore\(\)/);
assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
assert.equal(parsed.httpStatus, 200);

const plain = parseKnowledgeWebContent({
  url: "https://example.com/plain",
  mediaType: "text/plain",
  status: 200,
  data: Buffer.from("这是一段足够长、可以进入知识候选的纯文本正文。它描述了一个可复用的知识主题，并补充了足够的细节，不会被当成导航或错误页。"),
});
assert.match(plain.rawContent, /可复用的知识主题/);

assert.throws(() => parseKnowledgeWebContent({
  url: "http://127.0.0.1/private",
  mediaType: "text/html",
  status: 200,
  data: Buffer.from(html),
}), /BLOCKED_HOST/);
assert.throws(() => parseKnowledgeWebContent({
  url: "https://example.com/file",
  mediaType: "application/pdf",
  status: 200,
  data: Buffer.from("pdf"),
}), /HTML 或纯文本/);
assert.throws(() => parseKnowledgeWebContent({
  url: "https://example.com/empty",
  mediaType: "text/html",
  status: 200,
  data: Buffer.from("<html><body><nav>仅导航</nav></body></html>"),
}), /正文|过短/);
assert.throws(() => parseKnowledgeWebContent({
  url: "https://example.com/invalid",
  mediaType: "text/html",
  status: 200,
  data: Uint8Array.from([0xc3, 0x28]),
}), /UTF-8/);
assert.throws(() => parseKnowledgeWebContent({
  url: "https://example.com/large",
  mediaType: "text/html",
  status: 200,
  data: Buffer.alloc(KNOWLEDGE_WEB_MAX_BYTES + 1, 65),
}), /1.5 MB/);

const originalFetch = globalThis.fetch;
let requests: string[] = [];
try {
  setMediaFetchForTest((async (input: unknown) => {
    const url = input instanceof URL ? input.href : String(input);
    requests.push(url);
    if (url === "https://8.8.8.8/article") return response(html);
    if (url === "https://8.8.8.8/redirect") return response("", 302, { location: "https://127.0.0.1/private" });
    if (url === "https://1.1.1.1/start") return response("", 302, { location: "https://8.8.4.4/final" });
    if (url === "https://8.8.4.4/final") return response(html);
    if (url === "https://8.8.8.8/wrong-type") return response("nope", 200, { "content-type": "application/pdf" });
    if (url === "https://8.8.8.8/too-large") return new Response(Buffer.alloc(KNOWLEDGE_WEB_MAX_BYTES + 1, 65), { headers: { "content-type": "text/html" } });
    return response("not found", 404, { "content-type": "text/plain" });
  }) as never);

  const fetched = await fetchKnowledgeWebPage("https://8.8.8.8/article");
  assert.equal(fetched.finalUrl, "https://8.8.8.8/article");
  assert.match(fetched.rawContent, /蓝鲸/);

  requests = [];
  await assert.rejects(() => fetchKnowledgeWebPage("https://8.8.8.8/redirect"), /阻止访问/);
  assert.deepEqual(requests, ["https://8.8.8.8/redirect"], "重定向到 loopback 必须在发出第二次请求前拦截");

  requests = [];
  const redirected = await fetchKnowledgeWebPage("https://1.1.1.1/start");
  assert.equal(redirected.finalUrl, "https://8.8.4.4/final");
  assert.deepEqual(requests, ["https://1.1.1.1/start", "https://8.8.4.4/final"]);

  await assert.rejects(() => fetchKnowledgeWebPage("https://8.8.8.8/wrong-type"), /只支持/);
  await assert.rejects(() => fetchKnowledgeWebPage("https://8.8.8.8/too-large"), /超过 1.5 MB/);
  await assert.rejects(() => fetchKnowledgeWebPage("file:///etc/passwd"), /HTTP 或 HTTPS/);
} finally {
  setMediaFetchForTest(null);
  globalThis.fetch = originalFetch;
}

console.log("Knowledge webpage import: parser, metadata, content filtering, SSRF and redirects passed.");
