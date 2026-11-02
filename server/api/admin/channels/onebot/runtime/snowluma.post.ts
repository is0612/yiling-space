import { requireAdminActor } from "../../../../../utils/auth";
import { setAutoStartPaused } from "../../../../../utils/channel-adapter/onebot/autostart";
import { launchSnowluma, readSnowlumaStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 在网页上启动 SnowLuma —— 也就是双击 start.bat 想达到的那个效果。
 *
 * 只负责「把进程拉起来」，不接管：它和适配器一样是独立进程，nuxt 重启不影响它，
 * 停要走页面上的「停止」。所以这里不返回「已连接」，只返回「已经发出去了」，
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

  /*
   * 三种收尾，说清楚人还要不要动手：
   * ① 接管了面板密码（全新安装）→ 已经写进连接凭据，人什么都不用填；
   * ② 没接管、面板也没初始化 → 初始密码只在控制台里，这次接到了文件上，指给人看；
   * ③ 其余 → 普通启动成功。
   */
  let message = `已把 SnowLuma 拉起来，等它加载完（面板 ${status.panelPort} 起来就算好了）。`;
  if (result.panelPassword) {
    message = result.panelPasswordSaved
      ? `已把 SnowLuma 拉起来，面板密码由忆灵空间生成并写进了连接设置（不用手填）。等面板 ${status.panelPort} 应答就会自动配节点、挂 QQ。`
      : `已把 SnowLuma 拉起来，但面板密码没能写进连接设置 —— 密码记在 ${result.consoleLog ?? "SnowLuma 目录的 logs 里"}，登录面板后改掉它，再填进连接设置。`;
  } else if (result.consoleLog) {
    message = `已把 SnowLuma 拉起来。面板还没设过密码，初始密码只打印在控制台 —— 这次已接进 ${result.consoleLog}，去里面搜「初始登录凭据」。`;
  }

  return {
    message,
    pid: result.pid,
    consoleLog: result.consoleLog,
    panelPasswordSaved: result.panelPasswordSaved,
    /*
     * 这次刚播种的密码（只在「全新安装、我们接管了」时非空）。
     * 以前这里只回一句「写进连接设置了」，人回页面还得自己找那一格 ——
     * 明明是我们替他生成的，就该当场摊开给他看、能复制。
     */
    panelPassword: result.panelPassword ?? null,
  };
});
