import { requireAdminActor } from "../../../../../utils/auth";
import { stopOnebotAdapter } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 停掉适配器。
 *
 * 加这个接口是因为「关窗口」这个动作靠不住：点一次「启动适配器」会在 nuxt 底下套出
 * `cmd /k yarn onebot:run` → `yarn` → `cmd /c tsx …` → `node` 四层，关掉看到的那个窗口
 * 不一定把整串收干净，而用户分辨不出残留的是哪一层 —— 表现就是「明明关了，页面还说在跑」。
 *
 * 所以停止由服务端按 pid 树 /T 收，和启动对称：页面点什么，页面就能收回什么。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const result = await stopOnebotAdapter();
  if (!result.ok) {
    throw createError({ statusCode: 500, statusMessage: result.message });
  }
  return result;
});
