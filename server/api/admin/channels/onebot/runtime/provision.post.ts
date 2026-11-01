import { createError } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { loadOnebotConnections } from "../../../../../utils/channel-adapter/onebot/configure";
import { portFromUrl, provisionOnebotNodes } from "../../../../../utils/channel-adapter/onebot/panel";
import { readSnowlumaStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 用存下的面板密码登录 SnowLuma，把 WS/HTTP 节点对齐成连接设置里的那份。
 *
 * 解决的是「一键启动之后仍然要人肉进面板」：面板要密码才能进，而密码只存 hash，
 * 忘了就再也进不去 —— 节点配不了，适配器永远连不上 3001。
 *
 * 主动性划在这里：**只对齐端口 / 消息格式 / 角色 / 令牌**，不碰状态指令、通知、历史同步等其他设置，
 * 也不新建第二套节点。面板没起来、密码没填、密码不对，都如实返回，不做重试（面板按 IP 锁 5 次）。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const status = await readSnowlumaStatus();
  if (!status.installed) {
    throw createError({
      statusCode: 400,
      statusMessage: `在 ${status.home} 没找到 start.bat，先确认协议端目录。`,
    });
  }
  if (!status.running) {
    throw createError({
      statusCode: 409,
      statusMessage: `面板 ${status.panelPort} 还没应答，等 SnowLuma 起来再配节点。`,
    });
  }

  const connections = await loadOnebotConnections();
  const primary = connections[0];
  if (!primary) {
    throw createError({ statusCode: 400, statusMessage: "还没有接进来的 QQ 小号，没有可对齐的节点。" });
  }
  // 面板节点是按 QQ 号存的文件（config/onebot_<uin>.json），没有号就无从下手。
  if (!primary.accountQq) {
    throw createError({ statusCode: 400, statusMessage: "这条连接没填 QQ 号，不知道要配哪个号的节点。" });
  }

  const result = await provisionOnebotNodes({
    password: primary.snowlumaPassword,
    uin: primary.accountQq,
    wsUrl: primary.config.wsUrl,
    httpUrl: primary.config.httpUrl,
    wsToken: primary.config.accessToken ?? "",
    httpToken: primary.config.httpToken ?? "",
    wsPortFallback: 3001,
    httpPortFallback: 3002,
    panelPort: status.panelPort,
  });

  // 没密码是最常见的一种：这时不该 4xx/5xx（前端会当成弹错），而是把话说清楚。
  return {
    ...result,
    uin: primary.accountQq,
    panelPort: status.panelPort,
    ports: {
      ws: portFromUrl(primary.config.wsUrl, 3001),
      http: portFromUrl(primary.config.httpUrl, 3002),
    },
  };
});
