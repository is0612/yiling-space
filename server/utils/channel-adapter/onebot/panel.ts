/**
 * SnowLuma 面板客户端：登录一次，然后读写 OneBot 节点配置、把 QQ 客户端挂上 hook。
 *
 * 为什么需要它：面板里的 WS/HTTP 节点和连接里填的地址、Token 是两套东西，
 * 对不上适配器就连不上。以前这一步全靠人去面板里肉眼核对 —— 而进面板要先输密码，
 * 密码忘了就彻底卡住（面板只存 hash+salt，反推不回来）。
 * 现在把密码存在连接凭据里，启动后自动登录、把两个节点对齐。
 *
 * 2026-10-31 补：**节点配好了不等于端口在听**。面板只有 WebUI 的时候（QQ 客户端后启动、
 * hook 没挂上），3001/3002 一个都不 listen，适配器只能一直刷 `code=1006`。
 * 所以除了节点，这里还负责「找到这个号对应的 QQ 进程 → 把 hook 挂进去」。
 *
 * 接口来自 SnowLuma v2.2.1 的 index.mjs（未混淆，可直接读）：
 *   POST /api/login        { password }                → { success, token, mustChangePassword }
 *   GET  /api/config/:uin                              → { config }
 *   POST /api/config/:uin  <整个 config>                → { success, saved, applied }
 *   GET  /api/processes                                → { list: [{ pid, injected, connected, account }] }
 *   POST /api/processes/:pid/load                      → { success, process }
 * 鉴权头：`x-snowluma-token: <token>`（或 `Authorization: Bearer`），除 login 外全部要带。
 */

const PANEL_TIMEOUT_MS = 8_000;

/** 一次面板会话。调用方负责用完即弃，不要缓存 token（面板重启即失效）。 */
export type PanelSession = { port: number; token: string };

/** 登录失败的分类。前端只对 `bad-password` / `rate-limited` 做「别再自动试」的特殊处理。 */
export type PanelFailureReason =
  | "no-password"
  | "unreachable"
  | "bad-password"
  | "totp"
  | "rate-limited"
  | "error";

export type PanelLoginResult =
  | { ok: true; session: PanelSession; mustChangePassword: boolean }
  | { ok: false; reason: PanelFailureReason; message: string };

type Json = Record<string, unknown>;

async function panelFetch(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<{ status: number; json: Json | null }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers["x-snowluma-token"] = init.token;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs ?? PANEL_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => null) as Json | null;
  return { status: response.status, json };
}

/**
 * 登录面板。
 *
 * 面板按 IP 计失败次数：5 次锁定 15 分钟，成功才清零。所以这里**只试一次**，
 * 失败就把原因交回去让人改密码 —— 自动重试会把管理员自己锁在门外。
 */
export async function panelLogin(port: number, password: string): Promise<PanelLoginResult> {
  if (!password) {
    return {
      ok: false,
      reason: "no-password",
      message: "还没填 SnowLuma 面板密码，没法自动配节点（连接设置 → 协议端地址与 Token）。",
    };
  }
  let response;
  try {
    response = await panelFetch(port, "/api/login", { method: "POST", body: { password } });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: "unreachable",
      message: aborted
        ? `面板 ${port} 在 ${PANEL_TIMEOUT_MS / 1000} 秒内没应答。`
        : `连不上面板 ${port}：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 429) {
    return { ok: false, reason: "rate-limited", message: "面板登录尝试过多，已锁定 15 分钟。" };
  }
  if (response.json?.success === true && typeof response.json.token === "string") {
    return {
      ok: true,
      session: { port, token: response.json.token },
      mustChangePassword: response.json.mustChangePassword === true,
    };
  }
  if (response.json?.needsTotp === true) {
    return { ok: false, reason: "totp", message: "面板开了两步验证，自动登录做不了。" };
  }
  if (response.status === 401) {
    return { ok: false, reason: "bad-password", message: "面板密码不对。" };
  }
  return {
    ok: false,
    reason: "error",
    message: typeof response.json?.message === "string" ? response.json.message : `面板返回 ${response.status}。`,
  };
}

// ── 节点配置 ─────────────────────────────────────────────

/** OneBot 配置里我们关心的那一小块；其余字段原样带走，不做「清理」。 */
export type AdapterNode = {
  name?: string;
  host?: string;
  port?: number;
  path?: string;
  accessToken?: string;
  messageFormat?: string;
  reportSelfMessage?: boolean;
  role?: string;
  enableWebSocket?: boolean;
  [key: string]: unknown;
};

type OneBotNetworks = {
  httpServers?: AdapterNode[];
  httpClients?: AdapterNode[];
  wsServers?: AdapterNode[];
  wsClients?: AdapterNode[];
  [key: string]: unknown;
};

class PanelRequestError extends Error {}

async function readConfig(session: PanelSession, uin: string): Promise<Json> {
  const response = await panelFetch(session.port, `/api/config/${encodeURIComponent(uin)}`, { token: session.token });
  if (response.status === 401) throw new PanelRequestError("面板会话已失效。");
  if (response.status !== 200 || !response.json?.config) {
    throw new PanelRequestError(`读不到 ${uin} 的节点配置（面板返回 ${response.status}）。`);
  }
  return response.json.config as Json;
}

async function writeConfig(session: PanelSession, uin: string, config: Json): Promise<void> {
  const response = await panelFetch(session.port, `/api/config/${encodeURIComponent(uin)}`, {
    method: "POST",
    token: session.token,
    body: config,
  });
  if (response.status === 401) throw new PanelRequestError("面板会话已失效。");
  if (response.json?.success === false || response.status >= 400) {
    const message = typeof response.json?.message === "string" ? response.json.message : `面板返回 ${response.status}。`;
    throw new PanelRequestError(message);
  }
}

/** 端口号从连接里填的地址取；取不到就用默认值。 */
export function portFromUrl(url: string, fallback: number): number {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    return parsed.protocol === "wss:" || parsed.protocol === "https:" ? 443 : fallback;
  } catch {
    return fallback;
  }
}

/** 令牌要够长、够随机，面板才让存（少于 16 位直接拒绝整份配置）。 */
const MIN_TOKEN_LENGTH = 16;

export type NodePlan = {
  /** ws=收消息，http=发消息 */
  kind: "ws" | "http";
  port: number;
  token: string;
};

export type ProvisionResult = {
  ok: boolean;
  /** 没成功时的分类，前端据此决定要不要再自动试（密码错就别连着试，面板会锁 IP） */
  reason?: PanelFailureReason;
  /** 做了什么，一句话一条；空数组 = 本来就对，什么都没改 */
  changes: string[];
  /** 改了但没法保证生效的，比如令牌不一致 */
  warnings: string[];
  message: string;
};

/**
 * 把面板里的节点对齐到连接里填的那份配置。
 *
 * 三种情况分别处理：
 * - 已经有同端口的节点 → 就地补齐 messageFormat / reportSelfMessage / host，令牌不同则覆盖；
 * - 没有同端口、但只有**一个**同类节点 → 改它的端口（人手动做也是这一步，不会留下废弃节点）；
 * - 一个都没有 / 有多个 → 新加一个，名字带上端口，避免撞名。
 */
export function alignNode(
  list: AdapterNode[],
  plan: NodePlan,
  changes: string[],
  warnings: string[],
): AdapterNode[] {
  const label = plan.kind === "ws" ? "WS 节点" : "HTTP 节点";
  const tokenUsable = plan.token.length >= MIN_TOKEN_LENGTH;

  const finish = (node: AdapterNode, renamedFrom?: number): AdapterNode => {
    const next: AdapterNode = { ...node };
    if (renamedFrom !== undefined && renamedFrom !== plan.port) {
      next.port = plan.port;
      changes.push(`${label}端口 ${renamedFrom} → ${plan.port}`);
    } else {
      next.port = plan.port;
    }
    if (next.messageFormat !== "array") {
      next.messageFormat = "array";
      changes.push(`${label}消息格式改为 array`);
    }
    if (next.reportSelfMessage !== false) {
      next.reportSelfMessage = false;
      changes.push(`${label}关掉「上报自己发的消息」`);
    }
    if (plan.kind === "ws" && next.role !== "Universal") {
      next.role = "Universal";
      changes.push("WS 节点角色改为 Universal（收发共用一条连接）");
    }
    const current = typeof next.accessToken === "string" ? next.accessToken : "";
    if (tokenUsable) {
      if (current !== plan.token) {
        next.accessToken = plan.token;
        changes.push(`${label}令牌改成连接里填的那个`);
      }
    } else if (current !== plan.token) {
      warnings.push(plan.token
        ? `${label}在连接里填的令牌太短（少于 ${MIN_TOKEN_LENGTH} 位），面板不让存，仍用面板原来那个；两边的令牌对不上适配器就连不上。`
        : `${label}在连接里没填令牌，用的是面板原来那个；如果适配器连不上，把这个令牌填进连接设置。`);
    }
    return next;
  };

  const samePort = list.find((node) => Number(node.port) === plan.port);
  if (samePort) {
    return list.map((node) => (Number(node.port) === plan.port ? finish(node) : node));
  }
  if (list.length === 1) {
    const only = list[0]!;
    return [finish(only, Number(only.port) || plan.port)];
  }

  // 名字撞了面板会当成两个同名节点，加后缀避开。
  const taken = new Set(list.map((node) => String(node.name ?? "")));
  let name = `${plan.kind}-${plan.port}`;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${plan.kind}-${plan.port}-${suffix}`;
    suffix += 1;
  }
  // 新建时就把令牌带上：否则 finish 会当成「改令牌」，报一句对全新节点没意义的话。
  const created = finish({
    name,
    host: "127.0.0.1",
    path: "/",
    port: plan.port,
    ...(tokenUsable ? { accessToken: plan.token } : {}),
  });
  changes.push(`新建${label}（端口 ${plan.port}）`);
  return [...list, created];
}

/**
 * 登录 → 读配置 → 对齐节点 → 写回。幂等：本来就对的时候 changes 是空的，不会白写一遍。
 */
export async function provisionOnebotNodes(options: {
  password: string;
  uin: string;
  wsUrl: string;
  httpUrl: string;
  wsToken: string;
  httpToken: string;
  wsPortFallback: number;
  httpPortFallback: number;
  panelPort: number;
}): Promise<ProvisionResult> {
  const login = await panelLogin(options.panelPort, options.password);
  if (!login.ok) {
    return { ok: false, reason: login.reason, changes: [], warnings: [], message: login.message };
  }
  if (login.mustChangePassword) {
    return {
      ok: false,
      reason: "bad-password",
      changes: [],
      warnings: [],
      message: "面板还在「必须先改密码」的状态，先去面板改一次密码再回来。",
    };
  }

  try {
    const config = await readConfig(login.session, options.uin);
    const networks = (config.networks ?? {}) as OneBotNetworks;
    const changes: string[] = [];
    const warnings: string[] = [];

    const wsPlan: NodePlan = {
      kind: "ws",
      port: portFromUrl(options.wsUrl, options.wsPortFallback),
      token: options.wsToken,
    };
    const httpPlan: NodePlan = {
      kind: "http",
      port: portFromUrl(options.httpUrl, options.httpPortFallback),
      token: options.httpToken,
    };

    networks.wsServers = alignNode(Array.isArray(networks.wsServers) ? networks.wsServers : [], wsPlan, changes, warnings);
    networks.httpServers = alignNode(
      Array.isArray(networks.httpServers) ? networks.httpServers : [],
      httpPlan,
      changes,
      warnings,
    );

    if (!changes.length) {
      return { ok: true, changes, warnings, message: "面板里的节点和连接设置一致，没动它。" };
    }

    await writeConfig(login.session, options.uin, { ...config, networks });
    return {
      ok: true,
      changes,
      warnings,
      message: `已按连接设置改好面板节点：${changes.join("、")}。`,
    };
  } catch (error) {
    if (error instanceof PanelRequestError) {
      return { ok: false, changes: [], warnings: [], message: error.message };
    }
    return {
      ok: false,
      changes: [],
      warnings: [],
      message: `改面板配置失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── QQ 进程与 hook ───────────────────────────────────────
/**
 * 面板眼里的一个 QQ 客户端进程。
 *
 * `account.uin` 是**客户端自己登着的号** —— 没挂 hook 时它也有值（客户端知道自己是哪个号），
 * 所以「该往哪个进程注入」靠它判断，不能靠 `uin`（那个字段在注入前是 "0"）。
 */
export type PanelQqProcess = {
  pid: number;
  name: string;
  /** hook 有没有注入进去；注入后才有 OneBot 会话 */
  injected: boolean;
  connected: boolean;
  uin: string;
  status: string;
};

function readProcesses(json: Json | null): PanelQqProcess[] {
  const list = json?.list;
  if (!Array.isArray(list)) return [];
  const out: PanelQqProcess[] = [];
  for (const raw of list) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const pid = Number(item.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const account = (item.account ?? {}) as Record<string, unknown>;
    const accountUin = typeof account.uin === "string" ? account.uin : "";
    const sessionUin = typeof item.uin === "string" ? item.uin : "";
    const uin = accountUin && accountUin !== "0" ? accountUin : sessionUin === "0" ? "" : sessionUin;
    out.push({
      pid,
      name: typeof item.name === "string" ? item.name : "QQ.exe",
      injected: item.injected === true,
      connected: item.connected === true,
      uin,
      status: typeof item.status === "string" ? item.status : "",
    });
  }
  return out;
}

/** 面板发现的所有 QQ 客户端进程（含没挂 hook 的）。 */
export async function panelListProcesses(session: PanelSession): Promise<PanelQqProcess[]> {
  const response = await panelFetch(session.port, "/api/processes", { token: session.token });
  if (response.status === 401) throw new PanelRequestError("面板会话已失效。");
  if (response.status !== 200) {
    throw new PanelRequestError(`读不到 QQ 进程列表（面板返回 ${response.status}）。`);
  }
  return readProcesses(response.json);
}

/**
 * 挑出「就是这个号」的进程。
 *
 * 挑不到就返回 null，**不许退化成「随便挑一个」** —— 往别人的 QQ 里注入模块，
 * 比这条鱼一时不说话严重得多；多开时（用户自己还有个小号在跑）尤其不能猜。
 */
export function pickQqProcess(list: PanelQqProcess[], uin: string): PanelQqProcess | null {
  const target = uin.trim();
  if (!target) return null;
  const matched = list.filter((item) => item.uin === target);
  if (!matched.length) return null;
  // 同一个号开了两次客户端时优先已经连上的那个，免得往一个已经废弃的进程里再注入一遍
  return matched.find((item) => item.connected) ?? matched[0]!;
}

/**
 * 把 hook 注入这个 QQ 进程 —— 注入成功之后面板才会建 OneBot 会话，3001/3002 才开始 listen。
 *
 * 注入本身要往目标进程里加载模块，面板那边可能要几秒；给它 20 秒，别用默认的 8 秒
 * 把「成功但慢」报成失败（真失败时面板也是立刻回 success:false）。
 */
export async function panelLoadHook(
  session: PanelSession,
  pid: number,
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: "进程号无效。" };
  const response = await panelFetch(session.port, `/api/processes/${pid}/load`, {
    method: "POST",
    token: session.token,
    timeoutMs: 20_000,
  });
  if (response.status === 401) return { ok: false, message: "面板会话已失效。" };
  if (response.json?.success === true) return { ok: true, message: "已挂上面板。" };
  const detail = response.json?.message;
  return {
    ok: false,
    message: typeof detail === "string" && detail
      ? `面板拒绝挂载：${detail}`
      : `挂载失败（面板返回 ${response.status}）。`,
  };
}

/**
 * 让面板重连这个已经注入过的进程。
 *
 * 「注入了」和「会话连着」是两件事：hook 加载成功但 QQ 那边会话掉了（重登、网络断一下）时，
 * 再 `load` 一遍会被面板当成重复挂载拒掉 —— 这种情况该 refresh。
 */
export async function panelRefreshHook(
  session: PanelSession,
  pid: number,
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: "进程号无效。" };
  const response = await panelFetch(session.port, `/api/processes/${pid}/refresh`, {
    method: "POST",
    token: session.token,
    timeoutMs: 20_000,
  });
  if (response.status === 401) return { ok: false, message: "面板会话已失效。" };
  if (response.json?.success === true) return { ok: true, message: "已让面板重新连这个号。" };
  const detail = response.json?.message;
  return {
    ok: false,
    message: typeof detail === "string" && detail
      ? `面板拒绝重连：${detail}`
      : `重连失败（面板返回 ${response.status}）。`,
  };
}

