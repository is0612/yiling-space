import { requireAdminActor } from "../../../../../utils/auth";
import { stopSnowluma } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 停掉 SnowLuma。
 *
 * 它的 start.bat 结尾有 `pause`，所以关窗口之后那串 node 有时会挂着不走 ——
 * 端口还在听、消息还在收，页面显示「运行中」反而是对的。想真停就别靠关窗口。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const result = await stopSnowluma();
  if (!result.ok) {
    throw createError({ statusCode: 500, statusMessage: result.message });
  }
  return result;
});
