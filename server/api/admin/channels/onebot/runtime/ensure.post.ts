import { requireAdminActor } from "../../../../../utils/auth";
import { ensureOnebotStack } from "../../../../../utils/channel-adapter/onebot/autostart";

/** 补齐要等 SnowLuma 面板应答（最多 40 秒），这次请求不能跟着一直挂 */
const FAST_REPLY_MS = 3_000;

/**
 * 「链路齐了吗？没齐就补上」。
 *
 * 页面打开时问一句就够 —— server 启动时 nitro plugin 已经补过一次，这里兜的是
 * 「适配器中途崩了」「手动杀过一个进程」这类运行期间掉线。重复调用是安全的：
 * `ensureOnebotStack` 有并发锁，而且本来就在跑时它会直接短路。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  return Promise.race([
    ensureOnebotStack(),
    new Promise<{ action: "starting"; steps: string[]; message: string }>((resolve) => {
      // 等不到就先撒手：页面自己有轮询，不该被这一句锁在 loading 里
      setTimeout(() => resolve({ action: "starting", steps: [], message: "正在补齐链路…" }), FAST_REPLY_MS);
    }),
  ]);
});
