/**
 * 媒体下载的两道安全闸：重定向 SSRF 与超大响应（第二轮复现测试，只新增测试）。
 *
 * 全程不联网：`fetch` 被换成本地模拟传输（`createTransport`），
 * 每个 hop 都记录在案 —— 这样才能回答「被禁止的地址到底有没有收到请求」，
 * 而不是只看最后有没有抛错。初始 URL 使用公网字面量测试地址 `8.8.8.8` / `1.1.1.1`；
 * 全部请求仍由 mock fetch 截获，不会建立真实连接。
 *
 * 跑法：`npx tsx scripts/test-media-fetch-guards.ts`
 */

import { downloadImage } from "../server/utils/image-understanding";
import { downloadVoice } from "../server/utils/voice";
import { createPinnedLookup, setMediaFetchForTest } from "../server/utils/safe-media-download";

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
  const redirectModes: string[] = [];
  const fetchImpl = async (input: unknown, init?: { redirect?: string }): Promise<unknown> => {
    redirectModes.push(init?.redirect ?? "follow");
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
  return { fetchImpl, hops, redirectModes };
}

async function withTransport(
  routes: Record<string, Route>,
  run: (transport: { fetchImpl: typeof fetch; hops: string[]; redirectModes: string[] }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const transport = createTransport(routes);
  // 下载器直连 undici 的 fetch，只换 `globalThis.fetch` 拦不住它 —— 用例会真的出网、
  // 然后统一超时成 `*_DOWNLOAD_FAILED (23)`。两处都要装，别只装一半。
  globalThis.fetch = transport.fetchImpl as unknown as typeof fetch;
  setMediaFetchForTest(transport.fetchImpl as unknown as Parameters<typeof setMediaFetchForTest>[0]);
  try {
    await run(transport as unknown as { fetchImpl: typeof fetch; hops: string[]; redirectModes: string[] });
  } finally {
    globalThis.fetch = original;
    setMediaFetchForTest(null);
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

// 1.3 显式检查图片链路每一跳都使用 manual，不能依赖 fetch 自动跟随。
await check("每一跳重定向都必须使用 manual", async () => {
  await withTransport({
    [PUBLIC_A]: { redirectTo: PUBLIC_B },
    [PUBLIC_B]: {
      status: 200,
      headers: { "content-type": "image/png" },
      body: chunkedBody(1024),
    },
  }, async ({ redirectModes, hops }) => {
    const result = await downloadImage(PUBLIC_A);
    expect(result.buffer.byteLength === 1024, "重定向后的正常图片应成功读取");
    expect(hops.length === 2, `预期两跳，实际 ${hops.length} 跳`);
    expect(
      redirectModes.length === 2 && redirectModes.every((mode) => mode === "manual"),
      `每一跳都必须 redirect: manual，实际为 ${redirectModes.join(", ")}`,
    );
  });
});

// 1.4 DNS 重绑定：预检查得到公网 IP，真实连接阶段重新解析却变成内网，必须阻断。
await check("DNS 重绑定：连接阶段解析到内网时不给 socket 地址", async () => {
  const queue = [
    [{ address: "8.8.8.8", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }],
  ];
  let lookups = 0;
  let blocked = 0;
  const resolveAll = async (_hostname: string) => {
    lookups += 1;
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra DNS lookup");
    return next;
  };

  // 第一次模拟下载前的 DNS 预检查：公网地址通过。
  const preflight = await resolveAll("media.example.test");
  expect(preflight[0]?.address === "8.8.8.8", "预检查应先得到公网 IP");

  const lookup = createPinnedLookup(() => { blocked += 1; }, resolveAll);
  const callbackArgs: unknown[][] = [];
  await new Promise<void>((resolve) => {
    lookup("media.example.test", { all: true }, (...args) => {
      callbackArgs.push(args);
      resolve();
    });
  });

  const error = callbackArgs[0]?.[0] as (Error & { code?: string }) | undefined;
  expect(blocked === 1, `DNS 内网地址必须触发阻断，实际 blocked=${blocked}`);
  expect(error?.code === "EACCES", `socket lookup 应返回 EACCES，实际 ${error?.code}`);
  expect(callbackArgs[0]?.length === 1, "被阻断时不得向 socket 交付任何地址");
  expect(lookups === 2, `应恰好预检查+建连两次解析，实际 ${lookups} 次`);
});

// 1.5 DNS 固定：连接回调直接交付刚校验的 IP，不再让 socket 第三次解析。
await check("DNS 固定：校验后的 IP 直接交付 socket", async () => {
  const queue = [
    [{ address: "8.8.8.8", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }],
  ];
  let lookups = 0;
  const resolveAll = async (_hostname: string) => {
    lookups += 1;
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra DNS lookup");
    return next;
  };
  await resolveAll("media.example.test"); // 模拟预检查。

  const lookup = createPinnedLookup(() => undefined, resolveAll);
  const callbackArgs: unknown[][] = [];
  await new Promise<void>((resolve) => {
    lookup("media.example.test", { family: 4 }, (...args) => {
      callbackArgs.push(args);
      resolve();
    });
  });

  expect(callbackArgs[0]?.[0] === null, "公网 DNS 结果应通过");
  expect(callbackArgs[0]?.[1] === "8.8.8.8", "socket 收到的地址必须是已校验 IP");
  expect(callbackArgs[0]?.[2] === 4, "socket 收到的地址族必须是 IPv4");
  expect(lookups === 2, `不允许第三次独立解析，实际 ${lookups} 次`);
});

// 1.6 语音走同一套白名单，必须同样安全。
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

// ── 二、超大响应：超限要提前中止，不能先读完再判 ──────────────────
console.log("\n[2] 超大响应");

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

await check("语音：Content-Length 谎报偏小（1KB）时仍按实际字节数中止", async () => {
  const body = chunkedBody(10 * 1024 * 1024);
  await withTransport({
    [PUBLIC_A]: { status: 200, headers: { "content-length": "1024" }, body },
  }, async () => {
    await assertThrowsCode(() => downloadVoice(PUBLIC_A), "VOICE_TOO_LARGE");
    expect(
      body.bytesPulled() <= VOICE_LIMIT + 64 * 1024,
      `语音 Content-Length 谎报后仍拉取了 ${body.bytesPulled()} 字节`,
    );
  });
});

await check("语音：Content-Length 诚实偏大时零字节读取", async () => {
  const body = chunkedBody(10 * 1024 * 1024);
  await withTransport({
    [PUBLIC_A]: { status: 200, headers: { "content-length": String(10 * 1024 * 1024) }, body },
  }, async () => {
    await assertThrowsCode(() => downloadVoice(PUBLIC_A), "VOICE_TOO_LARGE");
    expect(body.bytesPulled() === 0, `声明超过 6MB 时不该读取 body，实际拉取 ${body.bytesPulled()} 字节`);
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

const failed = results.filter((item) => !item.ok);
console.log(`\nmedia fetch guards: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("\n未通过：");
  for (const item of failed) console.log(`- ${item.name}：${item.detail}`);
}
process.exit(failed.length ? 1 : 0);
