import assert from "node:assert/strict";
import { Response, fetch as undiciFetch } from "undici";
import { setMediaFetchForTest } from "../server/utils/safe-media-download";
import { parseBrowserActions, parseBrowserProposal } from "../server/utils/browser-actions";
import { executeBrowserActions } from "../server/utils/browser-actions";

assert.throws(() => parseBrowserActions([]));
assert.throws(() => parseBrowserActions([{ kind: "click", selector: "a".repeat(201) }]));
assert.throws(() => parseBrowserActions([{ kind: "click", selector: "div{color:red}" }]));
assert.throws(() => parseBrowserActions([{ kind: "fill", selector: "#a", value: "x".repeat(2001) }]));
assert.throws(() => parseBrowserActions([{ kind: "scroll", y: 10_000_000 }]));
assert.deepEqual(parseBrowserActions([{ kind: "scroll", direction: "down" }]), [{ kind: "scroll", direction: "down" }]);
assert.deepEqual(parseBrowserProposal([{ kind: "fill", selector: "#a", value: "x" }, { kind: "submit", selector: "#go" }]),
  { actions: [{ kind: "fill", selector: "#a", value: "x" }], submitSelector: "#go" });
assert.throws(() => parseBrowserProposal([{ kind: "submit", selector: "#go" }, { kind: "fill", selector: "#a", value: "x" }]), /submit 只能是最后一步/);
assert.throws(() => parseBrowserProposal([{ kind: "submit" }]), /submit 需要 selector/);
assert.throws(() => parseBrowserActions([{ kind: "scroll", direction: "sideways" }]), /direction 只能是/);
assert.throws(() => parseBrowserActions([{ kind: "press", key: "Enter" }]));
assert.throws(() => parseBrowserActions(Array.from({ length: 11 }, () => ({ kind: "scroll", y: 1 }))));
assert.deepEqual(parseBrowserActions([{ kind: "click", selector: "#x" }, { kind: "scroll", y: 10 }]),
  [{ kind: "click", selector: "#x" }, { kind: "scroll", y: 10 }]);
assert.deepEqual(parseBrowserActions([{ kind: "scroll", y: "600" }]), [{ kind: "scroll", y: 600 }], "Quoted numbers are accepted");
assert.throws(() => parseBrowserActions([{ kind: "click", selector: "#x" }, { kind: "scroll", y: "down" }]), /第 2 步的 y 必须是/);
assert.throws(() => parseBrowserActions([{ kind: "type", text: "a" }]), /第 1 步的 kind 只能是/);

const html = `<!doctype html><meta charset="utf-8"><title>Action fixture</title>
<body>
  <input id="name" type="text">
  <input id="secret" type="password">
  <input id="upload" type="file">
  <button id="copy" type="button">复制到页面</button>
  <button id="submit" type="submit">提交</button>
  <p id="out">未填写</p>
  <a href="/elsewhere">跳到别处</a>
  <a href="https://1.1.1.1/">外部</a>
  <div style="height:3000px"></div>
  <script>
    document.getElementById('copy').addEventListener('click', () => {
      document.getElementById('out').textContent = '已复制：' + document.getElementById('name').value;
    });
  </script>
</body>`;
setMediaFetchForTest((async (url) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, "https://8.8.8.8");
  return new Response(html, { headers: { "content-type": "text/html" } });
}) as typeof undiciFetch);
try {
  const filled = await executeBrowserActions("https://8.8.8.8/", [
    { kind: "fill", selector: "#name", value: "只在这里填写" },
    { kind: "click", selector: "#copy" },
    { kind: "scroll", y: 500 },
  ]);
  assert.deepEqual(filled.steps.map(step => step.ok), [true, true, true]);
  assert.match(filled.text, /已复制：只在这里填写/);
  assert.match(filled.screenshot, /^data:image\/png;base64,/);

  const submit = await executeBrowserActions("https://8.8.8.8/", [{ kind: "click", selector: "#submit" }]);
  assert.equal(submit.steps[0]?.ok, false);
  assert.match(submit.steps[0]?.detail ?? "", /提交按钮/);

  const password = await executeBrowserActions("https://8.8.8.8/", [{ kind: "fill", selector: "#secret", value: "hunter2" }]);
  assert.equal(password.steps[0]?.ok, false);
  assert.match(password.steps[0]?.detail ?? "", /密码/);

  const upload = await executeBrowserActions("https://8.8.8.8/", [{ kind: "fill", selector: "#upload", value: "x" }]);
  assert.equal(upload.steps[0]?.ok, false);

  const missing = await executeBrowserActions("https://8.8.8.8/", [{ kind: "click", selector: "#nope" }, { kind: "scroll", y: 1 }]);
  assert.equal(missing.steps.length, 1, "A failed step stops the run instead of acting on an unexpected page");
  assert.equal(missing.steps[0]?.ok, false);

  const text = await executeBrowserActions("https://8.8.8.8/", [{ kind: "click_text", text: "复制到页面" }]);
  assert.equal(text.steps[0]?.ok, true);

  await assert.rejects(() => executeBrowserActions("http://127.0.0.1/", [{ kind: "scroll", y: 1 }]), /WEB_INVALID_URL/);
  console.log("Browser actions passed: click/fill/scroll on a real isolated browser; submit button, password, upload, missing selector and private host refused.");
} finally { setMediaFetchForTest(null); }
