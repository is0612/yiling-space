import { requireAdminActor } from "../../../../../utils/auth";
import { setAutoStartPaused } from "../../../../../utils/channel-adapter/onebot/autostart";
import { launchOnebotAdapter, readOnebotAdapterStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 打开一个命令行窗口跑 `yarn onebot:run`。
 *
 * 和 SnowLuma 那个接口一样，只负责开窗口，不 kill、不 supervise ——
 * 适配器的生命周期归那个窗口管（关窗口就是停），网页只记录 pid 和「在不在跑」。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  // 人主动点了启动 = 撤销「停止」那把自动补起的开关，否则下次重启 server 又不会补
  await setAutoStartPaused(false);

  const status = await readOnebotAdapterStatus();
  if (status.running) {
    throw createError({
      statusCode: 409,
      statusMessage: `适配器已经在运行（PID ${status.pid}），不用再开一个 —— 两个会抢同一条连接。`,
    });
  }

  const result = await launchOnebotAdapter();
  if (!result.ok) {
    throw createError({ statusCode: 500, statusMessage: result.message ?? "启动适配器失败。" });
  }
  return { message: "已打开终端，正在启动适配器，等窗口里出现 onebot-connected。", pid: result.pid };
});
