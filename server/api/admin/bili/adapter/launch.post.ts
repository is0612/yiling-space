import { requireAdminActor } from "../../../../utils/auth";
import { launchBiliAdapter } from "../../../../utils/channel-adapter/bili/runtime";

/**
 * 在项目根目录开一个终端跑 `yarn bili:run`。
 *
 * 只做「拉起来」，不接管生命周期：值班窗口、风控、额度这些判断都在适配器自己那边。
 * 已经在跑就直接返回它的 pid —— 两个实例会重复刷、重复私信。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return await launchBiliAdapter();
});
