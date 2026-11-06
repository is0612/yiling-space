/**
 * 媒体下载的三道安全闸：重定向 SSRF、DNS 重绑定、超大响应。
 *
 * 全程不联网：
 *  - `fetch` 被换成本地模拟传输（`createTransport`），每个 hop 都记录在案 ——
 *    这样才能回答「被禁止的地址到底有没有收到请求」，而不是只看最后有没有抛错；
 *  - `node:dns/promises` 的 `lookup` 被换成可控桩，用来模拟「预检查解析为公网、
 *    建连时再解析为内网」这种重绑定时序。
 * 初始 URL 用真实公网地址 `8.8.8.8` / `1.1.1.1`：它们能过生产代码的公网白名单
 * （文档保留段 203.0.113.x 按「非全球单播」一律拦掉），但请求全被截住，一个字节都不会真的发出去。
 *
 * 跑法：`npx tsx scripts/test-media-fetch-guards.ts`
 */

import { createRequire } from "node:module";

/**
 * 顺序很关键：先换掉 `dns` 的 `lookup` 与 `undici` 的 `Agent`，再动态导入生产模块，
 * 这样生产模块拿到的就是被替换后的实现 —— 否则静态 import 会先绑定到原始版本。
 */
const requireCjs = createRequire(import.meta.url);
const dnsModule = requireCjs("node:dns/promises") as {
  lookup: (hostname: string, options?: unknown) => Promise<Array<{ address: string; family: number }>>;
};
const undiciModule = requireCjs("undici") as { Agent: new (options: unknown) => { close: () => Promise<void> } };

type IpRecord = { address: string; family: number };
const PUBLIC_DNS: IpRecord = { address: "8.8.8.8", family: 4 };

/** 依次消费的 DNS 脚本；只剩最后一条时一直返回它。空 = 默认公网。 */
const dnsQueue: IpRecord[][] = [];
const dnsCalls: string[] = [];
const originalLookup = dnsModule.lookup;
dnsModule.lookup = async (hostname: string) => {
  dnsCalls.push(hostname);
  const next = dnsQueue.length > 1 ? dnsQueue.shift()! : dnsQueue[0];
  return next ?? [PUBLIC_DNS];
};

/** 捕获生产代码交给 undici 的 Agent 选项，从而拿到它自己那条「校验 + 固定 IP」的 lookup。 */
const agentOptions: Array<{ connect?: { lookup?: Function } }> = [];
const OriginalAgent = undiciModule.Agent;
undiciModule.Agent = class SpyAgent extends OriginalAgent {
  constructor(options: unknown) {
    super(options);
    agentOptions.push(options as { connect?: { lookup?: Function } });
  }
} as unknown as typeof undiciModule.Agent;

const { downloadImage } = await import("../server/utils/image-understanding");
const { downloadVoice } = await import("../server/utils/voice");

// ── 极简用例运行器 ────────────────────────────────────────────────
type CaseResult = { name: string; ok: boolean; detail: string };
const results: CaseResult[] = [];
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    results.push({ name, ok: true, detail: "" });
    console.log(`  PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL ${name}\n       ${detail.replaceAll("\n", "\n       ")}`);
  }
}
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── 模拟传输：可记录 hop、按需跟随重定向、按需造流 ─────────────────
type Body = {
  stream: ReadableStream<Uint8Array>;
  readAll: () => Promise<Uint8Array>;
  bytesPulled: () => number;
  wasCancelled: () => boolean;
};

/** 造一个「一共 total 字节、按 chunk 吐」的响应体，并记录被拉走多少、有没有被 cancel。 */
function chunkedBody(total: number, chunk = 64 * 1024): Body {
  let pulled = 0;
  let cancelled = false;
  let consumed = false;
  const makeStream = () => new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - pulled);
      pulled += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  // body 与 arrayBuffer 共享同一个流：走哪条路都会累计 pulled。
  const stream = makeStream();
  return {
    stream,
    async readAll() {
      if (consumed) return new Uint8Array(0);
      consumed = true;
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const piece of chunks) {
        merged.set(piece, offset);
        offset += piece.byteLength;
      }
      return merged;
    },
    bytesPulled: () => pulled,
    wasCancelled: () => cancelled,
  };
}
const emptyBody = () => chunkedBody(0);

type Route = { status?: number; headers?: Record<string, string>; body?: Body; redirectTo?: string };

function makeResponse(input: { url: string; status: number; headers: Record<string, string>; body: Body }) {
  const headerMap = new Map(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    url: input.url,
    status: input.status,
    ok: input.status >= 200 && input.status < 300,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body: input.body.stream,
    arrayBuffer: () => input.body.readAll(),
  };
}

/**
 * 把「服务端」写成一跳一跳的路由表。
 * `redirect: "follow"` 时由这里自己走下一跳（等价于 undici 内部的行为），
 * `redirect: "manual"` 时把 302 原样交回 —— 这样「有没有真的打到内网」才可观测。
 */
function createTransport(routes: Record<string, Route>) {
  const hops: string[] = [];
  const fetchImpl = async (input: unknown, init?: { redirect?: string }): Promise<unknown> => {
    // 生产代码传进来的可能是字符串，也可能是 URL 对象（`fetch(url, …)` 里 url 是 URL）。
    const url = input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : String((input as { url?: string }).url ?? "");
    hops.push(url);
    const route = routes[url];
    if (!route) return makeResponse({ url, status: 404, headers: {}, body: emptyBody() });
    if (route.redirectTo) {
      const mode = init?.redirect ?? "follow";
      if (mode === "manual") {
        return makeResponse({ url, status: 302, headers: { location: route.redirectTo }, body: emptyBody() });
      }
      return fetchImpl(route.redirectTo, init);
    }
    return makeResponse({
      url,
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body: route.body ?? emptyBody(),
    });
  };
  return { fetchImpl, hops };
}

async function withTransport(
  routes: Record<string, Route>,
  run: (transport: { fetchImpl: typeof fetch; hops: string[] }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const transport = createTransport(routes);
  globalThis.fetch = transport.fetchImpl as unknown as typeof fetch;
  try {
    await run(transport as unknown as { fetchImpl: typeof fetch; hops: string[] });
  } finally {
    globalThis.fetch = original;
  }
}

const isInternal = (url: string) => {
  const host = new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, "");
  return /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || host === "::1" || host === "localhost";
};

const PUBLIC_A = "http://8.8.8.8/a.png";
const PUBLIC_B = "http://1.1.1.1/b.png";

// ── 一、重定向 SSRF：被禁止的目标不能收到请求 ─────────────────────
console.log("\n[1] 重定向 SSRF");

const redirectTargets: Array<{ label: string; target: string }> = [
  { label: "127.0.0.1", target: "http://127.0.0.1:8080/secret.png" },
  { label: "10.1.2.3", target: "http://10.1.2.3/intranet.png" },
  { label: "192.168.1.5", target: "http://192.168.1.5/router.png" },
  { label: "IPv6 [::1]", target: "http://[::1]:8080/local.png" },
];

// 1.0 前提守卫：直连内网字面量本来就该在发起请求前就被拒。
await check("直连内网字面量：一次请求都不该发出（现状守卫）", async () => {
  await withTransport({}, async ({ hops }) => {
    await assertThrowsCode(() => downloadImage("http://10.1.2.3/a.png"), "IMAGE_BLOCKED_HOST");
    expect(hops.length === 0, `被拒的地址不该收到请求，实际发生 ${hops.length} 次：${hops.join(", ")}`);
  });
});

// 1.0b 重定向必须自己跟：交给 undici 自动跟随就失去了「下一跳之前拦住」的机会。
await check("图片与语音都使用 redirect: \"manual\"", async () => {
  const modes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { redirect?: string }) => {
    modes.push(String(init?.redirect));
    return makeResponse({
      url: String(input), status: 200, headers: { "content-type": "image/png" }, body: chunkedBody(1024),
    });
  }) as unknown as typeof fetch;
  try {
    await downloadImage(PUBLIC_A);
    await downloadVoice(PUBLIC_A);
  } finally {
    globalThis.fetch = original;
  }
  expect(modes.length === 2, `图片、语音各应发一次请求，实际 ${modes.length} 次`);
  expect(modes.every((mode) => mode === "manual"), `实际 redirect 模式：${modes.join(", ")}；必须是 manual`);
});

for (const { label, target } of redirectTargets) {
  // 1.1 单跳：公网 → 内网
  await check(`公网 302 → ${label}：内网不能收到请求`, async () => {
    await withTransport({
      [PUBLIC_A]: { redirectTo: target },
      [target]: { status: 200, headers: { "content-type": "image/png" }, body: chunkedBody(1024) },
    }, async ({ hops }) => {
      await assertThrowsCode(() => downloadImage(PUBLIC_A), "IMAGE_BLOCKED_HOST");
      const internalHops = hops.filter(isInternal);
      expect(
        internalHops.length === 0,
        `重定向目标 ${target} 已收到真实请求（hop 序列：${hops.join(" → ")}）—— 盲 SSRF，校验发生在请求之后`,
      );
    });
  });
}

// 1.2 多跳：公网 → 公网 → 内网（只校验最终地址的实现会漏掉中间那一跳）
await check("多跳 公网 → 公网 → 内网：中间那一跳也不能打到内网", async () => {
  await withTransport(
    {
      [PUBLIC_A]: { redirectTo: PUBLIC_B },
      [PUBLIC_B]: { redirectTo: "http://10.1.2.3/deep.png" },
      "http://10.1.2.3/deep.png": { status: 200, headers: { "content-type": "image/png" }, body: chunkedBody(1024) },
    },
    async ({ hops }) => {
      await assertThrowsCode(() => downloadImage(PUBLIC_A), "IMAGE_BLOCKED_HOST");
      const internalHops = hops.filter(isInternal);
      expect(internalHops.length === 0, `多跳链路上内网被访问了（hop 序列：${hops.join(" → ")}）`);
    },
  );
});

// 1.3 语音走同一套白名单，必须同样安全。
for (const { label, target } of [redirectTargets[0]!, redirectTargets[1]!]) {
  await check(`语音 公网 302 → ${label}：内网不能收到请求`, async () => {
    await withTransport({
      [PUBLIC_A]: { redirectTo: target },
      [target]: { status: 200, headers: {}, body: chunkedBody(1024) },
    }, async ({ hops }) => {
      await assertThrowsCode(() => downloadVoice(PUBLIC_A), "VOICE_BLOCKED_HOST");
      const internalHops = hops.filter(isInternal);
      expect(internalHops.length === 0, `语音下载把请求打到了 ${internalHops.join(", ")}（hop 序列：${hops.join(" → ")}）`);
    });
  });
}

// ── 二、DNS 重绑定：预检查与建连必须用同一份解析结果 ───────────────
console.log("\n[2] DNS 重绑定");

/**
 * 这里的模拟方式：`fetch` 被 stub 掉，但**不假装自己没连过**。
 * 它在「建连」这一步调用生产代码交给 undici 的那条 `connect.lookup`，
 * 于是断言可以精确到：那条 lookup 到底把什么地址交给了 socket。
 */
function rebindingTransport(hostname: string, hops: string[], connections: Array<{ ok: boolean; address?: string }>) {
  return async (input: unknown, init?: { dispatcher?: unknown }) => {
    const url = input instanceof URL ? input.href : String(input);
    hops.push(url);
    const lookup = agentOptions.at(-1)?.connect?.lookup;
    if (typeof lookup !== "function") throw new Error("生产代码没有给连接器传 lookup，无法固定 IP");
    const outcome = await new Promise<{ ok: boolean; address?: string }>((resolve) => {
      lookup(hostname, {}, (error: unknown, address?: unknown) => {
        // 回调带 error = 连接器拒绝解析结果；带 address = 这个地址会被真的 connect()。
        resolve(error ? { ok: false } : { ok: true, address: String(address) });
      });
    });
    connections.push(outcome);
    if (!outcome.ok) throw new Error(`connect ECONNREFUSED ${hostname}`);
    return makeResponse({ url, status: 200, headers: { "content-type": "image/png" }, body: chunkedBody(1024) });
  };
}

await check("重绑定：预检查解析为公网、建连时解析为内网 —— 内网不能收到连接", async () => {
  const host = "rebind.example";
  dnsQueue.length = 0;
  dnsCalls.length = 0;
  dnsQueue.push([{ address: "8.8.8.8", family: 4 }]);   // 第一次（预检查）：公网 → 放行
  dnsQueue.push([{ address: "127.0.0.1", family: 4 }]); // 第二次（建连）：内网 → 必须拒绝

  const hops: string[] = [];
  const connections: Array<{ ok: boolean; address?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = rebindingTransport(host, hops, connections) as unknown as typeof fetch;
  try {
    await assertThrowsCode(() => downloadImage(`http://${host}/a.png`), "IMAGE_BLOCKED_HOST");
  } finally {
    globalThis.fetch = original;
    dnsQueue.length = 0;
  }

  expect(dnsCalls.length >= 2, `预检查与建连各应解析一次，实际只解析了 ${dnsCalls.length} 次`);
  expect(
    connections.every((item) => !item.ok),
    `连接器把内网地址交给了 socket：${JSON.stringify(connections)}`,
  );
  expect(hops.length === 1, `拒绝发生在建连阶段，不该再发出额外请求，实际 hop：${hops.join(" → ")}`);
});

await check("重绑定：建连解析结果就是实际使用的地址（不会第三次解析）", async () => {
  const host = "pin.example";
  dnsQueue.length = 0;
  dnsCalls.length = 0;
  dnsQueue.push([{ address: "8.8.8.8", family: 4 }]);
  dnsQueue.push([{ address: "8.8.8.8", family: 4 }]);

  const hops: string[] = [];
  const connections: Array<{ ok: boolean; address?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = rebindingTransport(host, hops, connections) as unknown as typeof fetch;
  try {
    const result = await downloadImage(`http://${host}/a.png`);
    expect(result.buffer.byteLength === 1024, "正常下载不该被 DNS 桩影响");
  } finally {
    globalThis.fetch = original;
    dnsQueue.length = 0;
  }

  expect(connections.length === 1 && connections[0]!.ok, "建连应当成功");
  expect(connections[0]!.address === "8.8.8.8", `交给 socket 的地址必须是校验过的那个，实际 ${connections[0]!.address}`);
  // 预检查 1 次 + 建连 1 次；出现第 3 次就说明「校验用一份、连接另解析一份」。
  expect(dnsCalls.length === 2, `解析次数应为 2（预检查 + 建连），实际 ${dnsCalls.length} 次：${dnsCalls.join(", ")}`);
});

// ── 三、超大响应：超限要提前中止，不能先读完再判 ──────────────────
console.log("\n[3] 超大响应");

const IMAGE_LIMIT = 4 * 1024 * 1024;
const VOICE_LIMIT = 6 * 1024 * 1024;

await check("图片：无 Content-Length 的 8MB 响应必须提前中止", async () => {
  const body = chunkedBody(8 * 1024 * 1024);
  await withTransport({ [PUBLIC_A]: { status: 200, headers: { "content-type": "image/png" }, body } }, async () => {
    await assertThrowsCode(() => downloadImage(PUBLIC_A), "IMAGE_TOO_LARGE");
    expect(
      body.bytesPulled() <= IMAGE_LIMIT + 64 * 1024,
      `已经把 ${(body.bytesPulled() / 1024 / 1024).toFixed(1)}MB 全部读进内存才报错（上限 ${IMAGE_LIMIT / 1024 / 1024}MB）—— arrayBuffer() 先读后判`,
    );
  });
});

await check("图片：Content-Length 谎报偏小（1KB）时也要提前中止", async () => {
  const body = chunkedBody(8 * 1024 * 1024);
  await withTransport({
    [PUBLIC_A]: { status: 200, headers: { "content-type": "image/png", "content-length": "1024" }, body },
  }, async () => {
    await assertThrowsCode(() => downloadImage(PUBLIC_A), "IMAGE_TOO_LARGE");
    expect(
      body.bytesPulled() <= IMAGE_LIMIT + 64 * 1024,
      `Content-Length 谎报后仍然读了 ${(body.bytesPulled() / 1024 / 1024).toFixed(1)}MB 才判超限`,
    );
  });
});

await check("图片：Content-Length 诚实偏大时不读 body（现状守卫）", async () => {
  const body = chunkedBody(8 * 1024 * 1024);
  await withTransport({
    [PUBLIC_A]: { status: 200, headers: { "content-type": "image/png", "content-length": String(8 * 1024 * 1024) }, body },
  }, async () => {
    await assertThrowsCode(() => downloadImage(PUBLIC_A), "IMAGE_TOO_LARGE");
    expect(body.bytesPulled() === 0, `声明 8MB 时不该再拉 body，实际拉了 ${body.bytesPulled()} 字节`);
  });
});

await check("图片：正常 1MB 响应照常返回", async () => {
  await withTransport({ [PUBLIC_A]: { status: 200, headers: { "content-type": "image/png" }, body: chunkedBody(1024 * 1024) } }, async () => {
    const result = await downloadImage(PUBLIC_A);
    expect(result.buffer.byteLength === 1024 * 1024, `正常响应不该被误杀，实际 ${result.buffer.byteLength} 字节`);
    expect(result.mime === "image/png", `mime 应原样带出，实际 ${result.mime}`);
  });
});

await check("语音：无 Content-Length 的 10MB 响应必须提前中止", async () => {
  const body = chunkedBody(10 * 1024 * 1024);
  await withTransport({ [PUBLIC_A]: { status: 200, headers: {}, body } }, async () => {
    await assertThrowsCode(() => downloadVoice(PUBLIC_A), "VOICE_TOO_LARGE");
    expect(
      body.bytesPulled() <= VOICE_LIMIT + 64 * 1024,
      `已经把 ${(body.bytesPulled() / 1024 / 1024).toFixed(1)}MB 全部读进内存才报错（上限 ${VOICE_LIMIT / 1024 / 1024}MB）`,
    );
  });
});

await check("语音：正常 2MB 响应照常返回", async () => {
  await withTransport({ [PUBLIC_A]: { status: 200, headers: {}, body: chunkedBody(2 * 1024 * 1024) } }, async () => {
    const buffer = await downloadVoice(PUBLIC_A);
    expect(buffer.byteLength === 2 * 1024 * 1024, `正常语音不该被误杀，实际 ${buffer.byteLength} 字节`);
  });
});

// ── 工具 ─────────────────────────────────────────────────────────
/** 断言抛出的是指定机器码；错误码对不上要单独报出来，别让「抛了别的错」也算通过。 */
async function assertThrowsCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === code) return;
    throw new Error(`期望抛出 ${code}，实际抛出 ${message}`);
  }
  throw new Error(`期望抛出 ${code}，实际没有抛错`);
}

// 收尾：把 DNS 桩还原，避免影响同一进程里后续可能追加的检查。
dnsModule.lookup = originalLookup;

const failed = results.filter((item) => !item.ok);
console.log(`\nmedia fetch guards: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("\n未通过：");
  for (const item of failed) console.log(`- ${item.name}：${item.detail}`);
}
process.exit(failed.length ? 1 : 0);
