import fs from "node:fs/promises";
import path from "node:path";
import { loadOnebotConnections, requestOnebotReload, updateOnebotConnectionCredentials } from "./configure";
import { readOnebotAccountPresence } from "./account-availability";
import {
  panelListProcesses,
  panelLoadHook,
  panelLogin,
  panelRefreshHook,
  pickQqProcess,
  provisionOnebotNodes,
  type PanelFailureReason,
} from "./panel";
import {
  launchOnebotAdapter,
  launchSnowluma,
  parseWsEndpoint,
  probeTcp,
  readOnebotAdapterStatus,
  readSnowlumaStatus,
} from "./runtime";

/**
 * 「装了就该在跑」。
 *
 * 别人的鱼是宿主里的插件：宿主启动时把它加载进来，宿主活着它就活着，用户从来不用管进程。
 * 我们是两个独立进程（协议端 + 适配器），以前只能靠人点「启动」。这个模块把那一步补上 ——
 * server 起来、或者打开 QQ 渠道页时，发现链路没通就自己补一遍。
 *
 * 但有一个必须留的口子：**人点了「停止」就得是真停**。
 * 自动补起最难受的形态是「我明明关了它又自己回来」。所以停止会落一个开关文件，
 * 之后不管重启 server 还是刷新页面都不再自动补，直到人重新点启动/重连。
 */

/** 自动补起的总开关：点过「停止」就写它 */
function pauseFile(): string {
  return path.join(process.cwd(), ".data", "onebot-autostart.json");
}

export async function readAutoStartPause(): Promise<{ paused: boolean; at?: string }> {
  try {
    const raw = await fs.readFile(pauseFile(), "utf8");
    const parsed = JSON.parse(raw) as { paused?: unknown; at?: unknown };
    return {
      paused: parsed.paused === true,
      at: typeof parsed.at === "string" ? parsed.at : undefined,
    };
  } catch {
    // 没有这个文件 = 没停过 = 可以补
    return { paused: false };
  }
}

/**
 * 记下「人是想让它跑，还是想让它停」。
 *
 * 单独一个文件而不是塞进数据库：它描述的是**这台机器上这两个进程**的状态，
 * 换台机器、换个数据库都该重新判断，不该跟着环境走。
 */
export async function setAutoStartPaused(paused: boolean): Promise<void> {
  try {
    await fs.mkdir(path.dirname(pauseFile()), { recursive: true });
    const payload = paused ? { paused: true, at: new Date().toISOString() } : { paused: false };
    await fs.writeFile(pauseFile(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // 写不进去只影响「下次还会不会自动补」，不该让停止/启动本身失败
  }
}

export type EnsureResult = {
  /** already-running=本来就在跑；started=补了；partial=补了一半；skipped=不该补 */
  action: "already-running" | "started" | "partial" | "skipped";
  reason?: string;
  steps: string[];
  message: string;
};

/**
 * 读「主连接」，读不到就退几步再试。
 *
 * 这个函数大概率是在 server 刚起来的那一秒被调用的 —— 那时 prisma 的连接池可能还没热，
 * 第一次查询会直接抛错。抛错和「表里没有连接」是两件事：前者该重试，后者才是真的没配。
 * 以前一律 `.catch(() => [])`，结果就是启动时静默退化成「没有可补的连接」，自动补起看着像没生效。
 */
async function loadConfiguredConnections(): Promise<
  { ok: true; connections: Awaited<ReturnType<typeof loadOnebotConnections>> } | { ok: false; message: string }
> {
  let lastMessage = "读不到渠道连接。";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const connections = await loadOnebotConnections();
      return { ok: true, connections };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return { ok: false, message: lastMessage };
}

/**
 * 补起的轨迹落在 `.data/onebot-autostart.log`。
 *
 * 要它而不是只靠终端输出，是因为「自动补起没生效」最难判定的恰是「它到底有没有试过」——
 * 没起来、起来了又被杀、根本没跑，三种情况在页面上长得一模一样。留一条带时间的记录，
 * 事后能直接分辨。
 */
async function trace(action: string, message: string): Promise<void> {
  try {
    const line = `${new Date().toISOString()} ${action} ${message}\n`;
    await fs.appendFile(path.join(process.cwd(), ".data", "onebot-autostart.log"), line, "utf8");
  } catch {
    // 记不下来不影响补起本身
  }
}

/** 同一时刻只允许一次补齐：server 启动和页面打开可能同时触发，不能让两边各起一套进程 */
let inFlight: Promise<EnsureResult> | null = null;

export function ensureOnebotStack(): Promise<EnsureResult> {
  if (inFlight) return inFlight;
  inFlight = runEnsure()
    .then((result) => {
      void trace(result.action, result.message);
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function waitForPanel(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp("127.0.0.1", port, 800)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

// ── 把 QQ 挂上面板（hook）────────────────────────────────
/**
 * 「面板起来了」和「节点在听」是两件事。
 *
 * 面板的 OneBot 节点只在**这个号的会话建立之后**才开始 listen，而会话来自注入进 QQ 客户端的 hook。
 * 所以下面这个顺序会让人彻底卡住：先开 QQ → 再点「启动 SnowLuma」（此刻 hook 没注入）→
 * 面板只有 WebUI、3001 没人听 → 适配器每 30 秒刷一次 `code=1006`，
 * 页面上写的是「节点没开」，去面板里看节点却明明配着 —— 2026-10-31 就是这么被卡住的。
 *
 * 面板留了两个接口正好补这一步：`GET /api/processes` 列出发现到的 QQ 进程，
 * `POST /api/processes/:pid/load` 把 hook 注入进去。用同一个面板密码就能调，不用人进面板点。
 */
export type AttachResult = {
  ok: boolean;
  /** already=本来就在听；attached=这次挂上了；failed=没挂上 */
  action: "already" | "attached" | "waiting-login" | "failed";
  message: string;
  /**
   * 失败分类。页面要拿它决定「该不该把面板开给用户」：
   * 密码类的（没填 / 填错 / 两步验证 / 被锁）人必须进面板，其余（面板里没这个号的进程）
   * 开面板也解决不了，不如只把原话说明白。
   */
  reason?: PanelFailureReason | "no-process" | "account-not-logged-in" | "load-failed";
};

export async function attachQqSession(options: {
  password: string;
  accountQq: string;
  panelPort: number;
  wsUrl: string;
  /** 挂上之后等端口起来的时间：注入通常 1~3 秒，留点余量给刚登录的平均号 */
  waitMs?: number;
}): Promise<AttachResult> {
  const endpoint = parseWsEndpoint(options.wsUrl);
  if (!endpoint) {
    return { ok: false, action: "failed", message: `连接里的 WS 地址「${options.wsUrl}」解析不出端口。` };
  }
  // 端口已经在听 = 会话早就建立好了，不用为它再登录一次面板（面板按 IP 计失败次数）
  if (await probeTcp(endpoint.host, endpoint.port)) {
    return { ok: true, action: "already", message: `${endpoint.port} 已经在听。` };
  }

  const login = await panelLogin(options.panelPort, options.password);
  if (!login.ok) return { ok: false, action: "failed", reason: login.reason, message: login.message };

  try {
    const processes = await panelListProcesses(login.session);
    const target = pickQqProcess(processes, options.accountQq);
    if (!target) {
      return {
        ok: true,
        action: "waiting-login",
        reason: "account-not-logged-in",
        message: "这个 QQ 尚未登录，已跳过；其他已登录账号可继续使用。",
      };
    }

    if (!target.injected) {
      const loaded = await panelLoadHook(login.session, target.pid);
      if (!loaded.ok) return { ok: false, action: "failed", reason: "load-failed", message: loaded.message };
    } else if (!target.connected) {
      // 注入过但会话掉了（QQ 重登过）：再 load 会被当成重复挂载，该 refresh
      const refreshed = await panelRefreshHook(login.session, target.pid);
      if (!refreshed.ok) return { ok: false, action: "failed", reason: "load-failed", message: refreshed.message };
    }

    const deadline = Date.now() + (options.waitMs ?? 20_000);
    while (Date.now() < deadline) {
      if (await probeTcp(endpoint.host, endpoint.port, 600)) {
        return {
          ok: true,
          action: "attached",
          message: `已把 QQ ${options.accountQq} 挂上面板，${endpoint.port} 起来了。`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return {
      ok: false,
      action: "failed",
      message: `QQ ${options.accountQq} 挂上了，但 ${endpoint.port} 20 秒内没起来 —— 去面板看一眼这个号的节点是不是被关掉了。`,
    };
  } catch (error) {
    return {
      ok: false,
      action: "failed",
      message: `挂 QQ 上去失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 补齐整条链路，顺序和页面上的「重连」一致：协议端 → 节点 → 适配器。
 *
 * 只补缺的那一段：SnowLuma 在跑就不动它（重启一次要等 40 秒，白白让鱼掉线），
 * 适配器在跑就不重开（新进程会重新建 WS，等于白白断一次）。
 */
async function runEnsure(): Promise<EnsureResult> {
  const steps: string[] = [];

  const pause = await readAutoStartPause();
  if (pause.paused) {
    return {
      action: "skipped",
      reason: "paused",
      steps,
      message: "之前点过停止，这次不自动补 —— 需要时点「重连」。",
    };
  }

  const loaded = await loadConfiguredConnections();
  if (!loaded.ok) {
    return {
      action: "skipped",
      reason: "db-unavailable",
      steps,
      message: `读不到渠道连接，这次不补：${loaded.message}`,
    };
  }
  const connections = loaded.connections;
  if (!connections.length) {
    return { action: "skipped", reason: "no-connection", steps, message: "还没有接进来的 QQ 小号，不用补。" };
  }

  const [snowlumaBefore, adapterBefore] = await Promise.all([
    readSnowlumaStatus(),
    readOnebotAdapterStatus(),
  ]);
  const gatewayStates = await Promise.all(connections.map(async connection => {
    const endpoint = parseWsEndpoint(connection.config.wsUrl);
    return endpoint ? probeTcp(endpoint.host, endpoint.port) : false;
  }));
  // Every configured endpoint must be ready before skipping account-specific repair.
  if (snowlumaBefore.running && adapterBefore.running && gatewayStates.every(Boolean)) {
    return { action: "already-running", steps, message: "已配置的链路本来就在跑。" };
  }

  // Already usable endpoints remain usable even if this machine cannot start a local panel.
  const keepAvailableGateways = async (): Promise<EnsureResult | null> => {
    if (!gatewayStates.some(Boolean)) return null;
    if (!adapterBefore.running) {
      const launched = await launchOnebotAdapter();
      if (!launched.ok) return { action: "partial", reason: "adapter-launch-failed", steps, message: launched.message ?? "适配器启动失败。" };
      steps.push("启动适配器");
    }
    return { action: "started", steps, message: "已就绪的网关可继续使用，其他账号等待登录或网关就绪。" };
  };
  // ① 协议端。没装就别假装能补 —— 那是「去第 2 步填目录」的事，不是自动化能解决的。
  if (!snowlumaBefore.installed) {
    const available = await keepAvailableGateways();
    if (available) return available;
    return {
      action: "skipped",
      reason: "not-installed",
      steps,
      message: `没找到 SnowLuma（找的是 ${snowlumaBefore.home}），补不了。`,
    };
  }

  if (!snowlumaBefore.running) {
    steps.push("启动 SnowLuma");
    const launched = await launchSnowluma();
    if (!launched.ok) {
      const available = await keepAvailableGateways();
      if (available) return available;
      return { action: "partial", reason: "gateway-launch-failed", steps, message: launched.message ?? "SnowLuma 启动失败。" };
    }
    if (!(await waitForPanel(snowlumaBefore.panelPort, 40_000))) {
      const available = await keepAvailableGateways();
      if (available) return available;
      // 它挂在 QQ 客户端上，客户端没登录时就是这个结果 —— 这不是「重试能好」的故障
      return {
        action: "partial",
        reason: "gateway-timeout",
        steps,
        message: "SnowLuma 40 秒内没应答面板，先确认 QQ 已经登录。",
      };
    }
  }

  // Account presence is exact-match and read-only. An unlogged optional account is not a failure.
  const snowlumaNow = await readSnowlumaStatus();
  const presence = await readOnebotAccountPresence(connections, snowlumaNow.panelPort);
  const outcome = await ensureAvailableOnebotAccounts(connections, {
    gatewayReady: async connection => {
      const endpoint = parseWsEndpoint(connection.config.wsUrl);
      return endpoint ? probeTcp(endpoint.host, endpoint.port) : false;
    },
    accountState: connection => presence.get(connection.id) ?? "unknown",
    ensure: async connection => {
      const endpoint = parseWsEndpoint(connection.config.wsUrl);
      if (!endpoint) return { ready: false, steps: ["连接的 WS 地址无效。"] };
      // The local panel may never be used to attach a remote gateway's account.
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.host)) {
        return { ready: false, steps: ["远程网关尚未就绪，请在网关所在机器检查登录状态。"] };
      }
      const accountSteps: string[] = [];
      let tokensAdopted = false;
      const provision = await provisionOnebotNodes({
        password: connection.snowlumaPassword, uin: connection.accountQq,
        wsUrl: connection.config.wsUrl, httpUrl: connection.config.httpUrl,
        wsToken: connection.config.accessToken ?? "", httpToken: connection.config.httpToken ?? "",
        wsPortFallback: 3001, httpPortFallback: 3002, panelPort: snowlumaNow.panelPort,
      });
      if (provision.ok) {
        if (provision.adopted && (provision.adopted.wsToken || provision.adopted.httpToken)) {
          tokensAdopted = await updateOnebotConnectionCredentials(connection.id, {
            accessToken: provision.adopted.wsToken, httpToken: provision.adopted.httpToken,
          }).catch(() => false);
          if (!tokensAdopted) accountSteps.push("面板令牌未能写入对应连接，请检查连接设置。");
        }
        if (provision.changes.length) accountSteps.push("对齐节点：" + provision.changes.join("；"));
      } else accountSteps.push("节点未对齐：" + provision.message);
      const attached = await attachQqSession({ password: connection.snowlumaPassword,
        accountQq: connection.accountQq, panelPort: snowlumaNow.panelPort, wsUrl: connection.config.wsUrl });
      if (attached.action === "waiting-login") return { ready: false, waiting: true, steps: accountSteps, tokensAdopted };
      if (attached.action === "attached") accountSteps.push(attached.message);
      if (!attached.ok) accountSteps.push(attached.message);
      return { ready: attached.ok, steps: accountSteps, tokensAdopted };
    },
  });
  steps.push(...outcome.steps);
  if (!outcome.ready.length) {
    return { action: outcome.failed.length ? "partial" : "skipped",
      reason: outcome.failed.length ? "hook-failed" : "account-not-logged-in", steps,
      message: outcome.failed.length ? "当前没有已就绪的网关，请检查对应账号的链路。" : "QQ 账号尚未登录，等待登录后再连接；无需同时登录全部账号。" };
  }
  const adapterNow = await readOnebotAdapterStatus();
  if (!adapterNow.running) {
    steps.push("启动适配器");
    const launched = await launchOnebotAdapter();
    if (!launched.ok) return { action: "partial", reason: "adapter-launch-failed", steps, message: launched.message ?? "适配器启动失败。" };
  } else {
    for (const connectionId of outcome.reload) await requestOnebotReload(connectionId).catch(() => false);
    if (outcome.reload.length) steps.push("通知适配器按对应连接的新令牌重连");
  }
  return { action: outcome.failed.length ? "partial" : "started", steps,
    reason: outcome.waiting.length ? "account-not-logged-in" : undefined,
    message: "已就绪 " + outcome.ready.length + " 条链路"
      + (outcome.waiting.length ? "，另有 " + outcome.waiting.length + " 个账号等待登录（不影响已登录账号）" : "")
      + (outcome.failed.length ? "，" + outcome.failed.length + " 条链路需检查" : "") + "。" };
}

/** Injected account iteration: one optional/unavailable QQ must not block later usable accounts. */
export async function ensureAvailableOnebotAccounts<T extends { id: string }>(connections: readonly T[], deps: {
  gatewayReady(connection: T): Promise<boolean>;
  accountState(connection: T): "logged_in" | "waiting_login" | "unknown";
  ensure(connection: T): Promise<{ ready: boolean; waiting?: boolean; tokensAdopted?: boolean; steps: string[] }>;
}) {
  const result = { ready: [] as string[], waiting: [] as string[], failed: [] as string[], reload: [] as string[], steps: [] as string[] };
  for (const connection of connections) {
    try {
      if (await deps.gatewayReady(connection)) { result.ready.push(connection.id); continue; }
      const state = deps.accountState(connection);
      if (state === "waiting_login") { result.waiting.push(connection.id); continue; }
      if (state !== "logged_in") { result.failed.push(connection.id); result.steps.push("尚未确认账号登录状态，未改动其节点或会话。"); continue; }
      const account = await deps.ensure(connection);
      result.steps.push(...account.steps);
      if (account.tokensAdopted) result.reload.push(connection.id);
      if (account.ready) result.ready.push(connection.id);
      else if (account.waiting) result.waiting.push(connection.id);
      else result.failed.push(connection.id);
    } catch { result.failed.push(connection.id); result.steps.push("一条账号链路补起失败，已继续检查其他账号。"); }
  }
  return result;
}
