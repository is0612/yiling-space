import "dotenv/config";
import { runGroupInitiativeTick } from "../server/utils/group-initiative";
import { runProactiveTick } from "../server/utils/proactive";
import { getPrisma } from "../server/utils/prisma";

/**
 * 主动开口的后台 tick：私聊「主动找话」+ 群聊「冷场了自己找话题」。
 *
 * 60 秒一轮，每轮只判「现在该不该开口」—— 判定不花 token，真正调模型只发生在闸门放行之后。
 * 不用长定时器（比如 setTimeout 三小时后）：进程重启、系统时钟跳变都会让它失效，
 * 而「重新算一遍现在该不该发」永远是对的。
 */

const INTERVAL_MS = 60_000;
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log({ event: "proactive-start", intervalMs: INTERVAL_MS });
  while (running) {
    try {
      const results = await runProactiveTick();
      for (const result of results) {
        // 静默跳过不刷屏：绝大多数 tick 本来就该是 skipped。
        if (result.status === "skipped") continue;
        log({ event: "proactive", ...result });
      }
    } catch (error) {
      log({ event: "proactive-error", error: error instanceof Error ? error.message : String(error) });
    }
    try {
      // 群聊那条单独跑、单独报错：一条链路挂了不该把另一条也停掉。
      const groupResults = await runGroupInitiativeTick();
      for (const result of groupResults) {
        if (result.status === "skipped") continue;
        log({ event: "group-initiative", ...result });
      }
    } catch (error) {
      log({ event: "group-initiative-error", error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(INTERVAL_MS);
  }
  await getPrisma().$disconnect().catch(() => undefined);
  log({ event: "proactive-stop" });
}

void main();
