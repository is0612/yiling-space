import { createError, getRouterParam, setResponseStatus } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { setAutoStartPaused } from "../../../../utils/channel-adapter/onebot/autostart";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/** 只提交重载请求，由独立运行的 OneBot runner 消费，不执行系统命令。 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "渠道连接");

  // 「重连」的意思就是「我要它跑」：撤销停止留下的自动补起开关。
  // 两个进程都已经在跑时，页面的重连只会走到这里、不走启动接口 —— 不在这儿清就永远清不掉。
  await setAutoStartPaused(false);

  const prisma = getPrisma();
  const requestedAt = new Date().toISOString();
  const count = await prisma.$executeRaw`
    UPDATE platform_connections
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('onebotReloadRequestedAt', ${requestedAt}::text),
      "updatedAt" = NOW()
    WHERE id = ${id}::uuid AND platform = 'qq-onebot' AND status <> 'DISABLED'
  `;
  if (!count) throw createError({ statusCode: 404, statusMessage: "QQ 连接不存在或已停用。" });
  setResponseStatus(event, 202);
  return { requestedAt, message: "已提交重新连接请求，等待运行中的 QQ 适配器处理。" };
});
