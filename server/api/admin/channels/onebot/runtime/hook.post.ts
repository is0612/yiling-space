import { createError } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { attachQqSession } from "../../../../../utils/channel-adapter/onebot/autostart";
import { loadOnebotConnections } from "../../../../../utils/channel-adapter/onebot/configure";
import { parseWsEndpoint, probeTcp, readSnowlumaStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 把 QQ 号挂到 SnowLuma 面板上（注入 hook）。
 *
 * 解决的是「面板在跑、节点也配好了，但 3001 就是没人听」：面板的 OneBot 节点只在
 * 这个号的会话建立之后才 listen，而会话来自注入进 QQ 客户端的 hook。QQ 客户端比面板后启动时
 * 它不会自己去挂（`config/runtime.json` 里的 `hookAutoLoad` 默认是关的），
 * 页面以前只能让人去面板里手点 —— 而面板还要再输一次密码。
 *
 * 密码已经存在连接凭据里了，所以这里直接用它登录、挑出这个号的那个进程、注入。
 * **只挑账号对得上的进程**：多开时往别的 QQ 里注入比不回复严重得多（`pickQqProcess`）。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const status = await readSnowlumaStatus();
  if (!status.installed) {
    throw createError({ statusCode: 400, statusMessage: `在 ${status.home} 没找到 start.bat，先确认协议端目录。` });
  }
  if (!status.running) {
    throw createError({ statusCode: 409, statusMessage: `面板 ${status.panelPort} 还没应答，等 SnowLuma 起来再挂。` });
  }

  const connections = await loadOnebotConnections();
  const primary = connections[0];
  if (!primary) {
    throw createError({ statusCode: 400, statusMessage: "还没有接进来的 QQ 小号，没有可挂的号。" });
  }
  if (!primary.accountQq) {
    throw createError({ statusCode: 400, statusMessage: "这条连接没填 QQ 号，不知道要挂哪个号。" });
  }

  const result = await attachQqSession({
    password: primary.snowlumaPassword,
    accountQq: primary.accountQq,
    panelPort: status.panelPort,
    wsUrl: primary.config.wsUrl,
  });

  // 没填密码 / 密码不对都不该是 4xx：前端要拿 message 原样显示，再自己决定要不要停自动重试。
  const endpoint = parseWsEndpoint(primary.config.wsUrl);
  return {
    ...result,
    uin: primary.accountQq,
    panelPort: status.panelPort,
    wsPort: endpoint?.port ?? null,
    reachable: endpoint ? await probeTcp(endpoint.host, endpoint.port) : false,
  };
});
