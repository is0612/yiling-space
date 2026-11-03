import { requireAdminActor } from "../../../utils/auth";
import { readBiliAdapterStatus } from "../../../utils/channel-adapter/bili/runtime";

/**
 * 值班适配器死活 —— B站 值班的第三层开关。
 *
 * 另外两层（perDay、peakValley）都在库里，dashboard 读得到；这一层只在进程里。
 * 页面上不把它摆出来，就会出现「开关都开着、三天没跑、点去处理又没东西可处理」的死角。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return await readBiliAdapterStatus();
});
