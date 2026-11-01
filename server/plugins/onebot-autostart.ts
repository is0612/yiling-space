import { ensureOnebotStack } from "../utils/channel-adapter/onebot/autostart";

/**
 * server 一启动就把 QQ 链路补起来 —— 相当于「装了插件就在跑」。
 *
 * 之前这两个进程只能靠人点按钮，结果就是「dev 重启之后鱼不说话」这种无解现象：
 * 页面上四段都断，但没人知道要先点哪里。现在把这一步交出去。
 *
 * 四条实测下来的处理：
 *
 * 1. **不 await**。补齐要等 SnowLuma 起来（最多 40 秒），await 会把 server 启动整个拖住 ——
 *    网页打不开，人也看不到「正在补」这件事本身。
 * 2. **延后 2.5 秒**。启动那一瞬间 prisma 还没热，读连接会抛错；以前这个错被吞成
 *    「没有连接」，于是静默不补 —— 自动补起看着就像没生效（2026-10-30 踩到）。
 * 3. **只在没在跑时动手**。`ensureOnebotStack` 自己会短路，这里不做任何判断，
 *    免得把「该不该补」的规则写两遍、将来跑岔。
 * 4. 改 `server/` 下的文件只是 HMR，**不会重跑这个 plugin**（实测过）。
 *    日常不受影响 —— HMR 不会带走那两个 detached 进程，断的不是它们。
 */
export default defineNitroPlugin(() => {
  // 先让 server 落定两秒：启动那一瞬间 prisma 还没热、SnowLuma 的目录发现也没缓存，
  // 这时候去判断「链路通没通」容易得出错误结论，白补一次或者干脆不补。
  setTimeout(() => {
    void ensureOnebotStack()
      .then((result) => {
        // 启动时留一条记录：出问题时能直接看到「它到底有没有试过」
        if (result.action !== "already-running") {
          console.log("[onebot-autostart]", result.action, result.message);
        }
        return result;
      })
      .catch((error: unknown) => {
        console.error("[onebot-autostart]", error instanceof Error ? error.message : String(error));
      });
  }, 2_500);
});
