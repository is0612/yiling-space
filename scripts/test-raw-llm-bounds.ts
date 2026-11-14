import assert from "node:assert/strict";
import { callRawModel, type RawModelCall } from "../server/utils/raw-llm";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalJob = process.env.LLM_JOB_TIMEOUT_MS;
const originalShared = process.env.LLM_TIMEOUT_MS;
const bodies: Array<Record<string, unknown>> = [];
const timeouts: number[] = [];
let calls = 0;
let mode: "success" | "truncated" | "network" = "success";
const base: RawModelCall = { model: "deepseek-flash", apiKey: "mock-key", apiBaseUrl: "https://api.deepseek.com/v1", systemPrompt: "Return a short summary", userPrompt: "Mock evidence" };
AbortSignal.timeout = (ms: number) => { timeouts.push(ms); return new AbortController().signal; };
globalThis.fetch = async (_url, init) => {
  calls++;
  bodies.push(JSON.parse(String(init?.body)));
  if (mode === "network" && calls === 1) throw new TypeError("fetch failed");
  const truncated = mode === "truncated" && calls === 1;
  return new Response(JSON.stringify({ choices: [{ message: { content: truncated ? "" : "summary", reasoning_content: truncated ? "thinking" : "" }, finish_reason: truncated ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: truncated ? 4096 : 5, total_tokens: truncated ? 4106 : 15 } }), { status: 200 });
};
const reset = (next: typeof mode = "success") => { mode = next; calls = 0; bodies.length = 0; timeouts.length = 0; };
try {
  delete process.env.LLM_JOB_TIMEOUT_MS;
  delete process.env.LLM_TIMEOUT_MS;
  reset();
  assert.equal(await callRawModel(base), "summary");
  assert.equal(bodies[0]!.max_tokens, 4096);
  assert.equal(bodies[0]!.thinking, undefined, "默认不改变供应商思考模式");
  assert.deepEqual(timeouts, [90_000]);
  reset("truncated");
  let usageCalls = 0;
  assert.equal(await callRawModel({ ...base, onUsage: () => { usageCalls++; } }), "summary");
  assert.equal(calls, 2);
  assert.deepEqual(bodies.map(body => body.max_tokens), [4096, 8192]);
  assert.equal(usageCalls, 2, "默认重试仍逐次记账");
  reset("network");
  assert.equal(await callRawModel(base), "summary");
  assert.equal(calls, 2, "默认保留网络重试");
  reset("truncated");
  await assert.rejects(callRawModel({ ...base, retry: false }), /LLM_EMPTY_REPLY/);
  assert.equal(calls, 1, "retry:false 禁止增预算重试");
  reset("network");
  await assert.rejects(callRawModel({ ...base, retry: false }), /LLM_NETWORK_ERROR/);
  assert.equal(calls, 1, "retry:false 禁止网络重试");
  reset();
  await callRawModel({ ...base, thinking: false });
  assert.deepEqual(bodies[0]!.thinking, { type: "disabled" });
  for (const apiBaseUrl of ["https://proxy.example/v1", "https://api.deepseek.com.evil.example/v1", "https://deepseek-proxy.example/v1"]) {
    reset();
    await callRawModel({ ...base, apiBaseUrl, thinking: false });
    assert.equal(bodies[0]!.thinking, undefined, "非官方域名不能收到私有字段");
  }
  reset();
  await callRawModel({ ...base, thinking: true });
  assert.equal(bodies[0]!.thinking, undefined);
  process.env.LLM_JOB_TIMEOUT_MS = "180000";
  reset();
  await callRawModel({ ...base, timeoutMs: 15000 });
  assert.deepEqual(timeouts, [180000], "未传硬上限保留旧配置优先行为");
  reset();
  await callRawModel({ ...base, timeoutMs: 15000, timeoutCapMs: 15000, retry: false });
  assert.deepEqual(timeouts, [15000], "硬上限必须覆盖更长环境配置");
  reset();
  await callRawModel({ ...base, timeoutCapMs: 200000 });
  assert.deepEqual(timeouts, [180000], "硬上限不能拉长原超时");
  reset();
  await callRawModel({ ...base, timeoutCapMs: Number.NaN });
  assert.deepEqual(timeouts, [180000], "无效硬上限不改变旧行为");
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  if (originalJob === undefined) delete process.env.LLM_JOB_TIMEOUT_MS; else process.env.LLM_JOB_TIMEOUT_MS = originalJob;
  if (originalShared === undefined) delete process.env.LLM_TIMEOUT_MS; else process.env.LLM_TIMEOUT_MS = originalShared;
}
console.log("Raw model bounds: defaults, single-attempt mode, official-only thinking control and timeout caps passed (mock only).");
