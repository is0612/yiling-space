import { setHeader } from "h3";
import { pingComfy } from "../../utils/comfyui-image";

/**
 * 引擎在不在。前端拿它决定「画图」按钮是否可点，省得点下去才报错。
 * GET /api/local/draw  →  { ok: true, running: true }
 */
export default defineEventHandler(async event => {
  setHeader(event, "Cache-Control", "no-store");
  const running = await pingComfy();
  return {
    ok: true,
    running,
    hint: running ? "本机 Anima 引擎已就绪" : "连不上引擎，先双击 D:\\AI\\Anima\\启动Anima.bat",
  };
});
