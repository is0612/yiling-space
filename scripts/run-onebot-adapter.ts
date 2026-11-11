import "dotenv/config";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOnebotAccountPresence } from "../server/utils/channel-adapter/onebot/account-availability";
import { readSnowlumaStatus } from "../server/utils/channel-adapter/onebot/runtime";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { markOnebotReloadApplied } from "../server/utils/channel-adapter/onebot/runtime";
import { createOnebotRunner } from "../server/utils/channel-adapter/onebot/runner";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { superviseOnebotConnection, waitOnebot } from "../server/utils/channel-adapter/onebot/supervise";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
const shutdown = new AbortController();

/**
 * 「我在跑」的标记文件。网页上的「启动适配器」靠它判断要不要再拉一个，
 * 也靠它告诉用户到底起没起来 —— 否则只能靠猜为什么状态一直没变。
 * 放在 .data/（已在 .gitignore 里，且不会被 nuxt 重启清空）。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(REPO_ROOT, ".data", "onebot-adapter.json");
const LOG_FILE = path.join(REPO_ROOT, ".data", "onebot-adapter.log");

/**
 * 把 stdout 和 stderr 再各写一份到文件。
 *
 * 为什么非要有这个：适配器跑在一个 cmd 窗口里，出问题（比如「四段全通但没人回」）
 * 时那扇窗口的滚动缓冲区就是唯一的证据，关掉窗口或滚动过去就没了 —— 事后只能靠猜。
 * 每次启动清空：这里要看的是「这一轮为什么不动」，不是长期审计。
 *
 * ⚠️ 必须同时 tee stderr：`console.error`（ASR 解码/请求失败、channel 报错等）都走 stderr，
 * 只 tee stdout 的话这些错误只在控制台一闪而过，落不进日志文件 —— 排查时就像「日志无痕」。
 */
async function teeOutputToFile() {
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.writeFile(LOG_FILE, "", "utf8");
    const stream = createWriteStream(LOG_FILE, { flags: "a" });

    const tee = (original: (...args: unknown[]) => boolean, prefix: string) =>
      ((chunk: unknown, ...rest: unknown[]) => {
        try {
          stream.write(prefix);
          stream.write(chunk as string | Uint8Array);
        } catch {
          // 写日志失败绝不能影响适配器本身
        }
        return original(chunk, ...rest);
      }) as typeof process.stdout.write;

    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = tee(originalOut, "");
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = tee(originalErr, "[stderr] ");
  } catch {
    // 落不了盘就退化成只有窗口输出
  }
}

/**
 * 认领「我在跑」的标记。已经有实例在跑就把它的 pid 返回，调用方直接退出。
 *
 * 为什么必须拦：网关的 WS 是**广播**的 —— 两个适配器同时连着，同一条群消息两边都收到、
 * 都想落库，后到的那个撞 `messages(conversationId, externalMessageId)` 唯一约束，
 * 整轮事务回滚，于是那一轮谁也没回（日志里只有一行「群聊批次处理失败」）。
 * 用户看到的就是「不是每条都回」。今天的两个实例分别是面板自动拉起和手动启动的。
 *
 * 用 `flag: "wx"` 抢占（不存在才创建），而不是「先读再写」：两个进程同时启动时，
 * 先读再写会双双读到空、双双启动。标记里的 pid 已经不在（上次被 kill 掉）就算陈旧，删掉重来。
 */
async function claimRunning(): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(
        STATE_FILE,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: REPO_ROOT }),
        { encoding: "utf8", flag: "wx" },
      );
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null; // 写不了就照常跑，别把适配器卡死
      const pid = await runningPid();
      if (pid) return pid;
      await fs.rm(STATE_FILE, { force: true });
    }
  }
  return null;
}

/** 标记文件里的 pid 还活着吗。活着返回它，陈旧或读不动返回 null。 */
async function runningPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function markStopped() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    // 别的实例接管了这个文件时不要误删
    if (parsed.pid === process.pid) await fs.rm(STATE_FILE, { force: true });
  } catch {
    // 文件不在或读不动都无所谓
  }
}
/**
 * 掉线多久才写「连接异常」。
 * 重连本身通常一两秒就完成（保存设置触发的重启、网关短暂抖动），
 * 第一时间把状态标红，页面就会停在「连接异常」上 —— 其实早就连回去了。
 * 这段时间里先写「未连接」（如实反映 socket 断了），超过阈值才升级成异常。
 */
const ERROR_AFTER_MS = 4000;
function log(entry: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
const waitingAccounts = new Set<string>();
let presenceCheckedAt = 0;
let cachedPresence = new Map<string, import("../server/utils/channel-adapter/onebot/account-availability").OnebotAccountPresence>();
let presenceSignature = "";
async function loadAvailableConnections() {
  const records = await loadOnebotConnections();
  const panel = await readSnowlumaStatus();
  if (!panel.running) return records;
  const signature = JSON.stringify(records.map(record => [record.id, record.accountQq, record.reloadRequestedAt]));
  if (Date.now() - presenceCheckedAt >= 30_000 || signature !== presenceSignature) {
    cachedPresence = await readOnebotAccountPresence(records, panel.panelPort);
    presenceCheckedAt = Date.now(); presenceSignature = signature;
  }
  const presence = cachedPresence;
  const available = [];
  for (const record of records) {
    if (presence.get(record.id) === "waiting_login") {
      if (!waitingAccounts.has(record.id)) {
        waitingAccounts.add(record.id);
        log({ event: "onebot-account-waiting-login", connectionId: record.id });
        await prisma.platformConnection.updateMany({ where: { id: record.id, status: { not: "DISABLED" } }, data: { status: "DISCONNECTED" } }).catch(() => undefined);
      }
      continue;
    }
    waitingAccounts.delete(record.id);
    available.push(record);
  }
  return available;
}
const runner = createOnebotRunner({
  load: loadAvailableConnections,
  shouldStop: () => shutdown.signal.aborted,
  start(record) {
    const controller = new AbortController();
    let applied = false;
    /** 连续失败的起点；连上一次就清空。用来判断「掉线多久了」而不是「失败了几次」 */
    let failingSince: number | null = null;
    let escalateTimer: ReturnType<typeof setTimeout> | null = null;
    // Serialize writes so shutdown can drain them and old status cannot race the new run.
    let writes = Promise.resolve();

    /** 上一次真正写下去的状态：重试循环里同样的值不必反复写库 */
    let lastStatus: string | null = null;
    const queueStatus = (next: "CONNECTED" | "DISCONNECTED" | "ERROR") => {
      if (next === lastStatus) return;
      lastStatus = next;
      writes = writes.then(async () => {
        if (controller.signal.aborted) return;
        await prisma.platformConnection.updateMany({
          where: { id: record.id, status: { not: "DISABLED" } },
          data: { status: next },
        });
      }).catch(() => log({ event: "onebot-status-write-failed", connectionId: record.id }));
    };

    /**
     * 掉线先写「未连接」，超过 ERROR_AFTER_MS 再升级成「连接异常」。
     *
     * 升级必须靠定时器而不是等下一个失败事件：连不上时 connectOnebot 是直接 reject 的，
     * 之后每轮重试都不会再触发 onStatus —— 只按事件算的话状态会永远停在未连接。
     */
    const beginFailing = () => {
      const now = Date.now();
      failingSince ??= now;
      const elapsed = now - failingSince;
      // 已经超过阈值就直接记异常，别再从「未连接」重来 —— 否则每轮重试都在两个状态之间来回跳
      if (elapsed >= ERROR_AFTER_MS) {
        queueStatus("ERROR");
        return;
      }
      queueStatus("DISCONNECTED");
      if (escalateTimer) return;
      escalateTimer = setTimeout(() => {
        escalateTimer = null;
        if (failingSince !== null && !controller.signal.aborted) queueStatus("ERROR");
      }, ERROR_AFTER_MS - elapsed);
    };

    const supervised = superviseOnebotConnection({
      record,
      handleEvent: createOnebotMessageHandler(record),
      log,
      signal: controller.signal,
      onStatusChange(status) {
        if (status !== "ready") {
          beginFailing();
          return;
        }
        failingSince = null;
        if (escalateTimer) {
          clearTimeout(escalateTimer);
          escalateTimer = null;
        }
        queueStatus("CONNECTED");
        if (!applied && record.reloadRequestedAt) {
          // Merge only our key into the current row. Never write stale metadata back.
          writes = writes
            .then(() => (controller.signal.aborted ? undefined : markOnebotReloadApplied(record.id, record.reloadRequestedAt!)))
            .then(() => { applied = true; })
            .catch(() => log({ event: "onebot-reload-apply-failed", connectionId: record.id }));
        }
      },
    });
    return {
      stop: () => {
        if (escalateTimer) {
          clearTimeout(escalateTimer);
          escalateTimer = null;
        }
        controller.abort();
      },
      done: supervised.finally(() => writes),
    };
  },
});
const stop = () => {
  shutdown.abort();
  void runner.stop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function main() {
  /**
   * 先认领，再开日志。
   *
   * 顺序不能反：`teeOutputToFile` 会**清空**日志文件，跑了第二个实例的话，
   * 第一个实例的日志会当场消失 —— 那正是排查这类问题时唯一的证据。
   */
  const existing = await claimRunning();
  if (existing) {
    log({ event: "onebot-adapter-already-running", pid: existing });
    await prisma.$disconnect();
    return;
  }
  await teeOutputToFile();
  try {
    while (!shutdown.signal.aborted) {
      try {
        await runner.reconcile();
      } catch {
        log({ event: "onebot-config-poll-failed" });
      }
      await waitOnebot(1000, shutdown.signal);
    }
  } finally {
    await runner.stop();
    await prisma.$disconnect();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await markStopped();
  }
}

main().catch(() => {
  log({ event: "onebot-runner-failed" });
  process.exitCode = 1;
});
