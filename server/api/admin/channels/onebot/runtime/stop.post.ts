import { requireAdminActor } from "../../../../../utils/auth";
import { setAutoStartPaused } from "../../../../../utils/channel-adapter/onebot/autostart";
import { stopOnebotAdapter, stopSnowluma } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 停整条链路：先适配器、后协议端。
 *
 * 为什么不合成这个接口、让页面连着发两个 DELETE —— 试过，第二个会跟着页面一起消失：
 * 点完「停止」顺手切个页签，第一条停成功了、第二条根本没发出去，
 * 回头看到网关还在跑，还以为是停止不灵。停一半比没停更难解释。
 *
 * 顺序不能反：先断适配器再断网关。反过来的话 SnowLuma 一死，
 * 适配器立刻开始刷 code=1006 重连日志，看着像又出了个新故障。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const adapter = await stopOnebotAdapter();
  const snowluma = await stopSnowluma();
  // 落了这把开关，重启 server / 刷新页面都不会把刚停的东西又拉起来
  await setAutoStartPaused(true);
  const stopped = adapter.stopped || snowluma.stopped;

  return {
    ok: adapter.ok && snowluma.ok,
    stopped,
    adapter,
    snowluma,
    message: stopped ? "已停止。" : "本来就没在跑。",
  };
});
