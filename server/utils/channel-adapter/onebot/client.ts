/**
 * OneBot v11 forward-WebSocket client. yiling-space connects to a third-party QQ gateway
 * (e.g. SnowLuma) as a WS *client* and receives message events, then calls the gateway's
 * HTTP API to send replies.
 *
 * - Reconnect with exponential backoff (1s → 30s cap).
 * - Liveness probe every 30s (calls get_status); a failed probe triggers a reconnect.
 * - 只把 `post_type === "message"`（私聊/群聊）与「戳一戳」通知往上抛，
 *   其余 notice / request / meta_event 一律忽略。
 */

import {
  onebotConversationKey,
  readOnebotDisplayName,
  readOnebotGroupId,
  readOnebotGroupRole,
  readOnebotImages,
  readOnebotMessageId,
  readOnebotMessageText,
  readOnebotUserId,
  readOnebotVoices,
  type OnebotGroupRole,
  type OnebotImageRef,
  type OnebotMessageType,
  type OnebotSegment,
  type OnebotVoiceRef,
} from "./types";
import { inspectOnebotRedPacket } from "./red-packet-diagnostics";

/** 出站消息：纯文本，或段数组（表情、图片、@）。 */
export type OnebotOutgoingMessage = string | OnebotSegment[];

export type OnebotConnectionConfig = {
  wsUrl: string;
  httpUrl: string;
  /** WS 鉴权 token，连接时拼成 `?access_token=`；SnowLuma 的 WS token 与 HTTP token 是两个不同的值。 */
  accessToken?: string;
  /** HTTP API auth token. */
  httpToken?: string;
};

export type OnebotResolvedEvent = {
  messageType: OnebotMessageType;
  data: unknown;
  messageId: string;
  userId: string;
  groupId: string;
  /**
   * 临时会话的来源群（`message_type: "private"` + 带 `group_id`）。
   *
   * QQ 里「通过某个群发起临时会话」对 OneBot 也是一条私聊消息，但**回复时必须带上
   * 来源群号**，否则协议端会拒绝（SnowLuma 报「临时会话需要 group_id」一类）。
   * 表现是：她生成了回复、也落了库，消息却发不出去 —— 对方只看到自己说的话。
   * 普通好友私聊这里为空。
   */
  tempGroupId: string;
  conversationKey: string;
  displayName: string;
  content: string;
  /** 这一条消息里带的图。正文里只有 `[图片]`，直链在这里等「看图」旁路来取。 */
  images: OnebotImageRef[];
  /** 这一条消息里带的语音。正文里只有 `[语音]`，直链在这里等「听懂语音」旁路来取。 */
  voices: OnebotVoiceRef[];
  selfId: string;
  /** 群成员身份；私聊或网关未提供时为 member。 */
  senderRole: OnebotGroupRole;
  /**
   * 这条是「戳一戳」而不是一句话。
   *
   * 只有戳的是**她本人**时才会往上抛（别人互戳在解析这一步就丢掉了），
   * 所以下游可以把它当成「有人叫了她一声」，等同于被 @。
   * 正文被统一成 {@link POKE_CONTENT}，模型看到的是一个人做出的动作。
   */
  poke?: OnebotPokeInfo;
};

export type OnebotPokeInfo = {
  /** 被戳的人；解析侧已经确认这就是她自己。 */
  targetId: string;
  /** 网关给的原始动作文案（「拍了拍」/「我的脑袋」），只用来写日志。 */
  action: string;
  suffix: string;
};

export type OnebotHandlers = {
  onMessage: (event: OnebotResolvedEvent) => void | Promise<unknown>;
  onStatus?: (status: "connecting" | "ready" | "disconnected" | "error", detail?: string) => void;
};

function isMessageEvent(data: unknown): boolean {
  const record = data as { post_type?: unknown; message_type?: unknown } | null;
  if (record?.post_type !== "message") return false;
  const mt = record.message_type;
  return mt === "private" || mt === "group";
}

/**
 * 戳一戳的正文。
 *
 * 用「动作」而不是「一句话」的写法：模型看到 `member_3: （戳了戳你）` 会当成一个动作，
 * 而不是一句可以接话的台词。带全角括号还有个副作用 —— 不会被当成系统播报
 * （`looksLikeSystemMessage` 要「≥8 字且以句号结尾」），也不会被当成叫到她的名字。
 */
export const POKE_CONTENT = "（戳了戳你）";

/** `post_type=notice` + `notice_type=notify` + `sub_type=poke`，SnowLuma 的群戳/私戳都是这个形状。 */
function isPokeNotice(data: unknown): boolean {
  const record = data as { post_type?: unknown; notice_type?: unknown; sub_type?: unknown } | null;
  return record?.post_type === "notice" && record.notice_type === "notify" && record.sub_type === "poke";
}

/**
 * 把「戳一戳」翻译成一条可处理的入站事件。
 *
 * 为什么要有这一步：QQ 的戳一戳是 notice，不是 message，而这条管道全部按「一条消息」
 * 建模（攒批、闸门、转录、落库）。与其为它在闸门和管道里再开一套旁路，不如在这里
 * 翻译成一条正文为 `（戳了戳你）` 的合成消息 —— 下游一行都不用改，`poke` 字段负责
 * 告诉闸门「这是有人在叫她」。
 *
 * 三条判据，缺一不可：
 *  - 戳的是**她本人**（`target_id === self_id`）：别人互戳是别人的私事，解析阶段就丢掉；
 *  - 有 `self_id`：不知道她是谁就没法判断戳的是不是她，宁可不动；
 *  - 有发件人和会话键：路由靠它。
 *
 * `message_id` 是合成的：notice 事件没有消息 id，而落库的幂等键是
 * `(conversationId, externalMessageId)`。同一秒同一个人戳多次会被合并成一轮（攒批本来就这么做）。
 */
export function resolveOnebotPokeEvent(data: unknown): OnebotResolvedEvent | null {
  if (!isPokeNotice(data)) return null;
  const record = data as {
    self_id?: unknown;
    sender_id?: unknown;
    target_id?: unknown;
    action?: unknown;
    suffix?: unknown;
  } | null;
  const selfId = String(record?.self_id ?? "");
  const targetId = record?.target_id === undefined || record?.target_id === null ? "" : String(record.target_id);
  if (!selfId || targetId !== selfId) return null;

  const groupId = readOnebotGroupId(data);
  const messageType: OnebotMessageType = groupId ? "group" : "private";
  const userId = readOnebotUserId(data) || String(record?.sender_id ?? "");
  const conversationKey = onebotConversationKey(messageType, data);
  if (!userId || !conversationKey) return null;

  return {
    messageType,
    data,
    messageId: `poke:${conversationKey}:${userId}:${Date.now()}`,
    userId,
    groupId,
    // 戳一戳没有临时会话这回事：有 group_id 就是群戳，没有就是好友私戳。
    tempGroupId: "",
    conversationKey,
    // notice 里没有昵称。群聊的显示名由 member 别名表按 QQ 号补，不需要在这里编一个。
    displayName: "",
    content: POKE_CONTENT,
    images: [],
    voices: [],
    selfId,
    senderRole: "member",
    poke: {
      targetId,
      action: typeof record?.action === "string" ? record.action : "",
      suffix: typeof record?.suffix === "string" ? record.suffix : "",
    },
  };
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 临时会话的来源群号。
 *
 * OneBot v11 里「通过群发起的临时会话」仍是一条 private 消息，群号通常挂在
 * **`sender.group_id`** 上（SnowLuma 就是这么发的：`convertPrivateMessage` 只在
 * `sub_type === "group"` 时写 `sender.group_id`）。有的网关放在顶层 `data.group_id`，
 * 两个位置都看一遍 —— 这个字段读错不会有任何报错，只是「消息永远发不出去」。
 *
 * 2026-11-01 实况：只读顶层 `group_id` 时，临时会话的回复一直按普通私聊发，
 * 网关回 `result=16 发送失败，请先添加对方为好友`，两条 ASSISTANT 记录躺在库里、
 * 对方一条没收到。
 */
function readTempConversationGroupId(data: unknown): string {
  const record = data as {
    group_id?: unknown;
    sender?: { group_id?: unknown } | null;
  } | null;
  const candidates = [record?.sender?.group_id, record?.group_id];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    // 只认非零群号：有些网关会给普通私聊塞一个 0。
    if (value && value !== "0") return value;
  }
  return "";
}

/** Parses a raw WS text frame into a resolved event, or null if it's not a handleable message. */
export function resolveOnebotEvent(data: unknown): OnebotResolvedEvent | null {
  const record = data as { message_type?: unknown; self_id?: unknown } | null;
  const messageType = record?.message_type;
  if (messageType !== "private" && messageType !== "group") return null;

  const content = readOnebotMessageText(data);
  const messageId = readOnebotMessageId(data);
  const userId = readOnebotUserId(data);
  const conversationKey = onebotConversationKey(messageType, data);
  if (!messageId || !conversationKey) return null;

  return {
    messageType,
    data,
    messageId,
    userId,
    groupId: messageType === "group" ? String((data as { group_id?: unknown } | null)?.group_id ?? "") : "",
    /**
     * 临时会话：私聊消息里带来源群号（网关用 `sub_type: "group"` 标记这种形状，
     * 群号放在 `sender.group_id`）。普通好友私聊取不到，为空。
     */
    tempGroupId: messageType === "private"
      ? readTempConversationGroupId(data)
      : "",
    conversationKey,
    displayName: readOnebotDisplayName(data),
    content,
    images: readOnebotImages(data),
    voices: readOnebotVoices(data),
    selfId: String(record?.self_id ?? ""),
    senderRole: readOnebotGroupRole(data),
  };
}

/**
 * 补齐图片直链。
 *
 * 网关推送的事件里，`image` 段有时只带 `file`、不带 `url` —— 直链要网关额外问一次 QQ，
 * 能省就省了。而「看图」旁路只认 `url`：空串等于「这条消息没有图」，静默跳过，
 * 用户看到的就是她只回了句 `[图片]`，配置、Key、模型全都对。
 *
 * 同一个 message_id 用 `get_msg` 回查就能拿到完整直链，所以缺的时候补一次。
 * **只在真缺时发请求**：绝大多数事件本来就带 url，不增加开销。
 * 补不上就原样返回 —— 看图只是少一句描述，不能挡住回话。
 */
export async function fillOnebotImageUrls(
  config: OnebotConnectionConfig,
  messageId: string,
  images: OnebotImageRef[],
): Promise<OnebotImageRef[]> {
  if (!images.length || images.every((image) => image.url)) return images;
  let refetched: OnebotImageRef[];
  try {
    const payload = await callOnebotAction(config, "get_msg", { message_id: messageId });
    refetched = readOnebotImages(payload);
  } catch {
    return images;
  }
  // 段数对不上就不猜：错位补出来的直链会把 A 图的描述安到 B 图上，比不补更糟。
  if (refetched.length !== images.length) return images;
  return images.map((image, index) =>
    image.url ? image : { ...image, url: refetched[index]?.url ?? "" });
}

/**
 * 把 WS token 拼进 URL 查询串。
 *
 * OneBot v11 两种带法（`Authorization: Bearer` 头与 `?access_token=` 查询参数）SnowLuma 都认，
 * 但 Node 内置的 WebSocket 不支持自定义握手头，所以只能走查询参数。
 * 地址里已经自带 access_token（用户手填或网关给的）就不重复拼。
 * ⚠️ 返回值里含明文 token，只能用来建连接，不许写日志、不许落库。
 */
function withWsAccessToken(url: string, token: string | undefined): string {
  if (!token) return url;
  if (/[?&]access_token=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

/**
 * Connects to the OneBot gateway and dispatches message events. Resolves with a `close`
 * function once the socket is open; the returned promise rejects on the first connection
 * failure so the supervisor can back off and retry. Abort also cancels a pending handshake;
 * the returned close function waits for onclose before a replacement socket is started.
 */
export function connectOnebot(
  config: OnebotConnectionConfig,
  handlers: OnebotHandlers,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ONEBOT_STOPPED"));
      return;
    }
    const socket = new WebSocket(withWsAccessToken(config.wsUrl, config.accessToken));
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let closedByCaller = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => { resolveClosed = done; });
    let probeAbort: AbortController | undefined;

    const clearProbe = () => {
      probeAbort?.abort();
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
    };

    const startProbe = () => {
      clearProbe();
      probeTimer = setInterval(async () => {
        try {
          probeAbort?.abort();
          probeAbort = new AbortController();
          await fetch(config.httpUrl + "/get_status", {
            signal: probeAbort.signal,
            headers: config.httpToken ? { authorization: "Bearer " + config.httpToken } : {},
          });
        } catch {
          // Probe failed: the gateway may be down. Close so the caller can reconnect.
          try {
            socket.close();
          } catch {
            // already closing
          }
        }
      }, 30_000);
      probeTimer.unref?.();
    };

    const close = () => {
      closedByCaller = true;
      clearProbe();
      try {
        socket.close();
      } catch {
        // already closing
      }
      return closed;
    };
    const abort = () => { void close(); };
    signal?.addEventListener("abort", abort, { once: true });

    socket.onopen = () => {
      if (closedByCaller) { void close(); return; }
      handlers.onStatus?.("ready");
      startProbe();
      if (!settled) {
        settled = true;
        resolve(close);
      }
    };

    socket.onmessage = async (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const payload = safeJson(text);
      if (!payload || typeof payload !== "object") return;
      // 红包只做结构诊断：不记录消息正文、QQ 号、凭据或完整原始事件。
      const redPacketDiagnostic = inspectOnebotRedPacket(payload);
      if (redPacketDiagnostic) {
        console.info("[onebot] 检测到疑似 QQ 红包事件", redPacketDiagnostic);
      }
      // 消息走原来的解析；戳一戳（notice）翻译成一条合成事件后走同一条路。
      const resolved = isMessageEvent(payload) ? resolveOnebotEvent(payload) : resolveOnebotPokeEvent(payload);
      if (!resolved) return;
      try {
        await handlers.onMessage(resolved);
      } catch (error) {
        handlers.onStatus?.("error", error instanceof Error ? error.message : String(error));
      }
    };

    /**
     * 一个 socket 的 error 可能连发几百次（网关不可达时实测 9 秒 835 次，还能把调用栈打爆）。
     * 只认第一次：close() 里置了 closedByCaller，后续事件直接丢掉，
     * 否则每一发都会写一次状态、刷一行日志，页面上看到的就是状态反复跳。
     *
     * ⚠️ 光丢弃还不够：握手失败时有些运行时不派发 close 事件，socket 卡在 CONNECTING，
     * 这个 Promise 就永远不 settle —— supervisor 会一直等它，再也不重试。
     * 所以这里主动 reject，让退避重连照常进行。
     */
    socket.onerror = () => {
      if (closedByCaller) return;
      handlers.onStatus?.("error", "ONEBOT_WS_ERROR");
      void close();
      if (!settled) {
        settled = true;
        reject(new Error("ONEBOT_WS_ERROR"));
      }
    };

    socket.onclose = (event) => {
      clearProbe();
      signal?.removeEventListener("abort", abort);
      resolveClosed();
      // 带上关闭码：1006 是网络/握手异常，1008 通常是鉴权或策略拒绝，两者排查方向完全不同。
      handlers.onStatus?.("disconnected", `code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`);
      if (!settled) {
        settled = true;
        reject(new Error("ONEBOT_WS_CLOSED: OneBot WebSocket 在就绪前关闭。"));
      }
      if (!closedByCaller) {
        // Unexpected drop: the caller's reconnect loop will re-invoke connectOnebot.
        handlers.onStatus?.("error", "ONEBOT_WS_CLOSED");
      }
    };
  });
}

/**
 * 发一条私聊。`message` 是纯文本或段数组（face / image / at），也就是 v11 的 CQ 消息。
 *
 * `tempGroupId` 是**临时会话**的来源群：QQ 里通过群发起的临时会话（非好友），
 * 回复必须带上它，网关才会走 `sendGroupTempMessage`；不带就会按普通好友私聊发，
 * 被拒成 `result=16 发送失败，请先添加对方为好友`。失败是静默的 —— 库里有一条
 * ASSISTANT 记录、对方一条没收到，表现就是「她好像不会回私信」。
 *
 * 带上之后还留一次退回：网关侧的临时会话是**内存态**（`tempSessions`，进程重启即丢），
 * 也可能对方这两天已经把她加成了好友。两种情况都该按普通私聊再试一次 ——
 * 少这一次重试，用户看到的就是「重启网关之后私信全不回」。
 */
export async function sendOnebotPrivateMessage(
  config: OnebotConnectionConfig,
  userId: string,
  message: OnebotOutgoingMessage,
  tempGroupId?: string,
): Promise<void> {
  if (!tempGroupId) {
    await callOnebotAction(config, "send_private_msg", { user_id: Number(userId), message });
    return;
  }
  try {
    await callOnebotAction(config, "send_private_msg", {
      user_id: Number(userId),
      group_id: Number(tempGroupId),
      message,
    });
  } catch (tempError) {
    const tempReason = tempError instanceof Error ? tempError.message : String(tempError);
    console.warn(
      "[onebot] 临时会话发送失败，退回普通私聊：",
      tempReason,
      JSON.stringify({ userId, tempGroupId }),
    );
    try {
      await callOnebotAction(config, "send_private_msg", { user_id: Number(userId), message });
    } catch (plainError) {
      // 两条都失败时把两边的理由都带上：只有「请先添加对方为好友」能解释为什么发不出去，
      // 只有「no such temp session」能解释为什么带了群号也没用。
      const plainReason = plainError instanceof Error ? plainError.message : String(plainError);
      throw new Error(`ONEBOT_SEND_PRIVATE_FAILED: 临时会话失败（${tempReason}）；普通私聊失败（${plainReason}）。`);
    }
  }
}

/**
 * 发布群公告。SnowLuma 的扩展动作，要求登录的小号在群里是管理员。
 * OneBot v11 标准没有公告接口；换网关时要确认动作名与参数。
 */
export async function sendOnebotGroupNotice(
  config: OnebotConnectionConfig,
  groupId: string,
  content: string,
): Promise<void> {
  await callOnebotAction(config, "_send_group_notice", {
    group_id: Number(groupId),
    content,
  });
}

/** Sends a group message through the OneBot HTTP API. */
export async function sendOnebotGroupMessage(
  config: OnebotConnectionConfig,
  groupId: string,
  message: OnebotOutgoingMessage,
): Promise<void> {
  await callOnebotAction(config, "send_group_msg", { group_id: Number(groupId), message });
}

/**
 * 发 QQ 收藏夹里的一张表情（SnowLuma 扩展 action，OneBot 标准里没有）。
 *
 * 与「图片段」的区别不是能不能看见，而是 QQ 怎么对待它：
 * `image` 段是一条聊天图片（长按是「保存图片」），这个走的是原生表情通道
 * （实测 `get_msg` 回来是 `sub_type: 1` + `summary: "[动画表情]"` + `qq_expression` 路径）。
 * 所以能走这条就走这条，本地那 200px 的副本只在 QQ 收藏里没有时才用。
 *
 * `emojiId` 必须是**完整的** `<QQ号>_0_0_0_<md5>_0_0`：
 * 同名的 `mface` 段要的是裸 md5 且字段名是驼峰 `emojiId`，两者别混。
 */
export async function sendOnebotCustomFace(
  config: OnebotConnectionConfig,
  target: { messageType: "group" | "private"; groupId: string; userId: string; tempGroupId?: string },
  emojiId: string,
): Promise<{ messageId: number | null }> {
  const scope = target.messageType === "group" && target.groupId
    ? { group_id: Number(target.groupId) }
    // 临时会话发收藏表情同样要带来源群，理由与 sendOnebotPrivateMessage 相同。
    : {
        user_id: Number(target.userId),
        ...(target.tempGroupId ? { group_id: Number(target.tempGroupId) } : {}),
      };
  const data = await callOnebotAction(config, "send_custom_face", { ...scope, emoji_id: emojiId });
  const messageId = (data as { message_id?: unknown } | null)?.message_id;
  return { messageId: typeof messageId === "number" ? messageId : null };
}

/**
 * 在她自己的 QQ 空间发一条说说。
 *
 * 这是**协议端扩展 action**（OneBot v11 标准里没有空间这个概念），SnowLuma / NapCat
 * 一系实现里都叫 `send_qzone_msg`，但参数名和返回结构各家可能有出入 ——
 * 换网关前先跑 `yarn probe:qzone`，别照着这份代码猜。
 *
 * `ugcRight` 用的是 QQ 空间自己的编码：1 公开、4 好友可见、64 仅自己。
 * 传错的话说说会发出去，只是可见范围不对 —— 这种错误在接口返回里看不出来。
 *
 * 注意返回值：**拿不到 tid 不等于没发出去**。协议端可能已经发成功、只是响应里没带，
 * 所以调用方不许在这里重试，先去空间确认。
 */
export async function sendOnebotQzonePost(
  config: OnebotConnectionConfig,
  input: { content: string; images?: string[]; ugcRight?: number },
): Promise<{ tid: string | null }> {
  const data = await callOnebotAction(config, "send_qzone_msg", {
    content: input.content,
    ugc_right: input.ugcRight ?? 1,
    ...(input.images?.length ? { images: input.images } : {}),
  });
  const record = data as { tid?: unknown; feedid?: unknown; data?: { tid?: unknown } } | null;
  const raw = record?.tid ?? record?.feedid ?? record?.data?.tid;
  return { tid: typeof raw === "string" && raw.trim() ? raw.trim() : null };
}

/**
 * 取协议端手里某个域名的 cookie 串。
 *
 * 空间网页版的接口全靠 `p_skey` 算 `g_tk`，而 `p_skey` 只有协议端（或浏览器）手里有。
 * 这里问它要 `qzone.qq.com` 的那份，免得再让用户去浏览器 DevTools 里复制一遍。
 *
 * 返回值形状各家不一：字符串、`{ cookies: "..." }`、或 `[{ name, value }]` 数组，
 * 三种都得认 —— 认不出来就当没拿到，让上层走降级。
 */
export async function getOnebotCookies(
  config: OnebotConnectionConfig,
  domain: string,
): Promise<string> {
  const data = await callOnebotAction(config, "get_cookies", { domain });
  if (typeof data === "string") return data;
  const record = data as { cookies?: unknown } | null;
  if (typeof record?.cookies === "string") return record.cookies;
  const list = Array.isArray(data) ? data : (record?.cookies as unknown);
  if (Array.isArray(list)) {
    return list
      .map((item) => {
        const cookie = item as { name?: unknown; value?: unknown } | null;
        return typeof cookie?.name === "string" && cookie.value !== undefined
          ? `${cookie.name}=${String(cookie.value)}`
          : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

export async function callOnebotAction(
  config: OnebotConnectionConfig,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(config.httpUrl + "/" + action, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.httpToken ? { authorization: "Bearer " + config.httpToken } : {}),
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`ONEBOT_SEND_HTTP_${response.status}: 发送 OneBot 消息失败。`);
  }
  // ⚠️ OneBot v11 发送失败时 HTTP 仍是 200，错误藏在 retcode 里（被风控、小号下线、群已解散）。
  // 只看 response.ok 会把「没发出去」当成「发成功」，还要等用户来问「她怎么不回我」。
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  const record = payload as { retcode?: unknown; wording?: unknown; message?: unknown } | null;
  const retcode = record?.retcode;
  if (typeof retcode === "number" && retcode !== 0) {
    const detail = typeof record?.wording === "string" && record.wording
      ? record.wording
      : typeof record?.message === "string" && record.message
        ? record.message
        : "未知原因";
    throw new Error(`ONEBOT_SEND_${retcode}: 发送 OneBot 消息失败（${detail}）。`);
  }
  // 返回 data（message_id 之类），目前只有收藏表情要拿它回读校验；其余调用方忽略即可。
  return (payload as { data?: unknown } | null)?.data;
}
