import { requireAdminActor } from "../../../../../utils/auth";
import { setAutoStartPaused } from "../../../../../utils/channel-adapter/onebot/autostart";
import { launchSnowluma, readSnowlumaStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 在网页上启动 SnowLuma —— 也就是双击 start.bat 那个动作。
 *
 * 只负责「把窗口拉起来」，不接管进程：它和适配器一样是独立控制台窗口，
 * nuxt 重启不影响它，关掉窗口就是停。所以这里不返回「已连接」，只返回「窗口开出去了」，
 * 起来没起来交给下一次 GET /runtime 用面板端口探活来回答。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  // 人主动点了启动 = 撤销「停止」那把自动补起的开关
  await setAutoStartPaused(false);

  const status = await readSnowlumaStatus();
  if (!status.installed) {
    throw createError({
      statusCode: 400,
      statusMessage: `${status.home} 里没有 start.bat，先在页面上把 SnowLuma 目录填对。`,
    });
  }
  if (status.running) {
    throw createError({
      statusCode: 409,
      statusMessage: `SnowLuma 已经在运行（面板 ${status.panelPort} 在听），不用再开一个。`,
    });
  }

  const result = await launchSnowluma();
  if (!result.ok) {
    throw createError({ statusCode: 500, statusMessage: result.message ?? "启动 SnowLuma 失败。" });
  }
  return {
    message: `已打开 SnowLuma 的窗口，等它加载完（面板 ${status.panelPort} 起来就算好了）。`,
    pid: result.pid,
  };
});
