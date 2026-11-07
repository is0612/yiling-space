/**
 * 安全媒体下载的重定向上限回归测试。
 *
 * 全程用 mock fetch，不建立任何网络连接。
 * 跑法：npx tsx scripts/test-media-redirect-limit.ts
 */
import assert from "node:assert/strict";

import { downloadImage } from "../server/utils/image-understanding";
import { setMediaFetchForTest } from "../server/utils/safe-media-download";

const originalFetch = globalThis.fetch;
let requests = 0;
const redirectModes: Array<RequestRedirect | undefined> = [];

const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  requests += 1;
  redirectModes.push(init?.redirect);

  // 永远返回下一跳重定向。达到上限后，生产逻辑必须停止，不能请求第 7 次。
  return new Response(null, {
    status: 302,
    headers: { location: `/redirect-${requests}` },
  });
}) as typeof fetch;

globalThis.fetch = mockFetch;
// 下载器直连 undici 的 fetch：只换全局变量拦不住，用例会真的出网并超时。
setMediaFetchForTest(mockFetch as unknown as Parameters<typeof setMediaFetchForTest>[0]);

try {
  await assert.rejects(
    () => downloadImage("http://8.8.8.8/start.png"),
    (error: unknown) => error instanceof Error && error.message === "IMAGE_REDIRECT_LIMIT",
  );

  assert.equal(requests, 6, "最多允许 5 次重定向，因此最多发起 6 次请求");
  assert.deepEqual(redirectModes, Array.from({ length: 6 }, () => "manual"));
  console.log("media redirect limit: 1/1 PASS");
} finally {
  globalThis.fetch = originalFetch;
  setMediaFetchForTest(null);
}
