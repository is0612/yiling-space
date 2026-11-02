/**
 * QQ 小号（OneBot v11）渠道的连接加载 —— 对应官方 QQ 的 configure.ts。
 *
 * 连接凭据（wsUrl / httpUrl / accessToken / httpToken / replyOnlyWhenMentioned）加密存于
 * PlatformConnection.credentialsCiphertext，与官方 QQ 一致。SnowLuma 的 WS token 与 HTTP
 * token 是不同值，故分开存。
 */

import { decryptApiKey, encryptApiKey } from "../../credential-encryption";
import { getPrisma } from "../../prisma";
import type { OnebotConnectionConfig } from "./client";
import {
  readGroupChatModeOverrides,
  resolveGroupChatSettings,
  type GroupChatModeOverrides,
  type GroupChatSettings,
} from "./group-chat";
import { ONEBOT_PLATFORM } from "./types";
import { QZONE_DEFAULT_LIMITS } from "./qzone";

export type OnebotBindingRecord = {
  id: string;
  characterId: string;
  /** 角色名。群聊里用来判断「有没有人叫她」，所以跟绑定一起读出来。 */
  characterName: string;
  routingKey: string | null;
  /** 群聊限流：每 replyWindowMinutes 分钟最多 replyLimitPerWindow 条；0 条 = 不限。 */
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  /** 群聊怎么回：仅 @ / 自然接话 / 全都回。含攒批与闸门参数。 */
  groupChat: GroupChatSettings;
  /** 按群覆盖的群聊模式（群号 → 模式）。这一群没写就沿 groupChat.mode。 */
  groupChatModes: GroupChatModeOverrides;
  /** 群聊是否仅当被 @ 时才回复（已回退到连接默认值，私聊总是回复）。 */
  replyOnlyWhenMentioned: boolean;
  /** 主人能否在群里触发她刷一轮 B站（已回退到连接默认值）。 */
  groupBiliRunEnabled: boolean;
};

/**
 * 把绑定里存的 routingKey 拆成群号列表。routingKey 支持逗号分隔的多个群号
 * （如 "12345,67890"），老的单群号数据天然是只有一个元素的列表。
 */
export function parseBindingRoutingKeys(routingKey: string | null): string[] {
  if (!routingKey) return [];
  return [...new Set(
    routingKey
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  )];
}

/**
 * 这条绑定的 routingKey 管不管这个群。空或 `"*"` 是默认绑定，收所有群。
 *
 * 抽出来是因为「路由时该不该理这个群」和「主动开口时能不能在这个群说话」
 * 必须是同一套判断：用户把群号从 routingKey 里删掉，意思是「这个群我不管了」，
 * 但 `group_activities` 里的旧行不会跟着消失 —— 只看绑定 ID 就选候选，
 * 她会跑到一个已经解绑的群里自己开口。
 *
 * 注意别拿它替换 `routeOnebotEventToBinding` 里的精确匹配：那边默认绑定排在
 * 具体绑定之后，语义不同。
 */
export function bindingAcceptsGroup(routingKey: string | null, groupId: string): boolean {
  if (!routingKey || routingKey.trim() === "*") return true;
  return parseBindingRoutingKeys(routingKey).includes(groupId);
}

export type OnebotConnectionRecord = {
  id: string;
  platform: string;
  /**
   * 这个小号自己的 QQ 号。事件里的 `self_id` 缺失时拿它判断「是不是 @ 我」——
   * 网关偶尔不发 self_id，缺了就等于谁都没 @ 她，群聊会整段静默。
   */
  accountQq: string;
  config: OnebotConnectionConfig;
  /** 群聊回复策略的连接级默认值：各 binding 未单独覆盖时生效（私聊总是回复）。 */
  replyOnlyWhenMentioned: boolean;
  /** 是否允许群主/管理员让她拟群公告草稿。连接级，默认关闭。 */
  groupAnnouncementEnabled: boolean;
  /**
   * 是否允许主人在 QQ 里让她发空间说说、评论别人的说说。连接级，默认关闭。
   *
   * 比群公告更要紧的是「谁能触发」：空间是她自己账号上的一举一动，只认主人 QQ；
   * 群友说「发条说说」一律当闲聊。
   */
  qzoneEnabled: boolean;
  /** 空间动作的日上限与冷却。压得很低是故意的，见 qzone.ts 顶部的风控说明。 */
  qzoneLimits: {
    dailyPosts: number;
    dailyComments: number;
    commentCooldownMinutes: number;
  };
  /**
   * 「看看空间」要翻谁的说说。留空就退回协议端 `get_friend_list` 的前几个好友。
   *
   * 手填名单更可靠：好友列表里可能有几十个人，逐个查等于自己撞风控；
   * 而她真正会去评论的，通常就那么几个号。
   */
  qzoneFriendQqs: string[];
  /**
   * 是否让她**主动**想发说说 / 评论朋友说说，想好了来问主人「行吗」。连接级，默认关闭。
   *
   * 和 `qzoneEnabled` 是两个开关：`qzoneEnabled` 是「主人下指令她能执行」，
   * 这个是「没人下指令，她自己想开口」。两个都开，她才会既听命又主动。
   */
  qzoneAutoAskEnabled: boolean;
  /**
   * 主动问的**固定时间点**（东八区 "HH:MM"）。只有到了这些点、且当天还没问够，才会问。
   * 空数组 = 不设时间点，也就不主动问（即使 `qzoneAutoAskEnabled` 开着）。
   *
   * 为什么不用 `proactive.ts` 那种「安静时段 + 最小间隔」：主动找话可以随时冒一句，
   * 空间主动问是「要往公共空间写东西」，随机时间问会显得突兀；固定几个点更可控。
   */
  qzoneAutoAskTimes: string[];
  /** 每天最多主动问几次（跨所有时间点）。 */
  qzoneAutoAskDailyMax: number;
  /** 「刷一轮 B站」的连接级默认值：各 binding 未单独覆盖时生效。 */
  groupBiliRunEnabled: boolean;
  /** 主人 QQ 号；空 = 未设置，群里 B站 指令不生效。连接级。 */
  ownerQq: string;
  /** 主人称呼（可留空）；留空时回退到外部身份/群名片。 */
  ownerName: string;
  /**
   * SnowLuma 面板密码（凭据里加密存的）。
   *
   * 单独从凭据里解出来、不塞进 `config`：它不参与 WS 连接，
   * 只在「一键启动后自动登录面板配节点」时用一次。
   */
  snowlumaPassword: string;
  bindings: OnebotBindingRecord[];
  reloadRequestedAt?: string;
};

/**
 * HTTP 默认 3002 不是笔误：协议端默认都在 3000，而 3000 正是本站 dev server 的端口，
 * 撞上就一条消息也发不出去。
 */
export const ONEBOT_DEFAULT_WS_URL = process.env.ONEBOT_WS_URL || "ws://127.0.0.1:3001";
export const ONEBOT_DEFAULT_HTTP_URL = process.env.ONEBOT_HTTP_URL || "http://127.0.0.1:3002";

const ONEBOT_CREDENTIAL_DEFAULTS = {
  wsUrl: ONEBOT_DEFAULT_WS_URL,
  httpUrl: ONEBOT_DEFAULT_HTTP_URL,
};

function readConfig(credentials: string | null, accountKey: string | null): OnebotConnectionConfig {
  let wsUrl = ONEBOT_CREDENTIAL_DEFAULTS.wsUrl;
  let httpUrl = ONEBOT_CREDENTIAL_DEFAULTS.httpUrl;
  let accessToken = process.env.ONEBOT_TOKEN || "";
  let httpToken = process.env.ONEBOT_HTTP_TOKEN || "";

  if (credentials) {
    try {
      const parsed = JSON.parse(credentials) as Record<string, unknown>;
      if (typeof parsed.wsUrl === "string" && parsed.wsUrl.trim()) wsUrl = parsed.wsUrl.trim();
      if (typeof parsed.httpUrl === "string" && parsed.httpUrl.trim()) httpUrl = parsed.httpUrl.trim();
      if (typeof parsed.accessToken === "string") accessToken = parsed.accessToken;
      if (typeof parsed.httpToken === "string") httpToken = parsed.httpToken;
    } catch {
      // Unparsable credentials are ignored; env / defaults apply.
    }
  }

  // Account key can carry the QQ number; not used as a token but kept for reference.
  void accountKey;

  return {
    wsUrl,
    httpUrl,
    ...(accessToken ? { accessToken } : {}),
    ...(httpToken ? { httpToken } : {}),
  };
}

/**
 * 空间动作的配额。默认值故意压得很低（每天 3 条说说 / 8 条评论 / 30 分钟冷却），
 * 因为这条通道没有官方 API，频率上去了代价是账号被要验证码甚至限制。
 * 0 表示不限 —— 和群聊限流的语义保持一致，省得两套规则打架。
 */
function readQzoneLimits(metadata: Record<string, unknown>): {
  dailyPosts: number;
  dailyComments: number;
  commentCooldownMinutes: number;
} {
  const read = (key: string, fallback: number, max: number): number => {
    const raw = metadata[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
    return Math.min(Math.round(raw), max);
  };
  return {
    dailyPosts: read("qzoneDailyPosts", QZONE_DEFAULT_LIMITS.dailyPosts, 20),
    dailyComments: read("qzoneDailyComments", QZONE_DEFAULT_LIMITS.dailyComments, 50),
    commentCooldownMinutes: read(
      "qzoneCommentCooldownMinutes",
      QZONE_DEFAULT_LIMITS.commentCooldownMinutes,
      1_440,
    ),
  };
}

/**
 * 「看看空间」的名单：接受逗号/空格分隔的字符串，也接受数组。
 * 去重、去非数字，最多 10 个 —— 更多的话一次「看看空间」要打十几个请求，
 * 这不是翻得更多，是在给自己招风控。
 */
function readQzoneFriendQqs(metadata: Record<string, unknown>): string[] {
  const raw = metadata.qzoneFriendQqs;
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : typeof raw === "string"
      ? raw.split(/[,，\s]+/u)
      : [];
  const uins: string[] = [];
  for (const part of parts) {
    const uin = part.trim().replace(/^o/u, "");
    if (!/^\d{5,15}$/u.test(uin) || uins.includes(uin)) continue;
    uins.push(uin);
    if (uins.length >= 10) break;
  }
  return uins;
}

/**
 * 主动问的时间点：接受逗号分隔的字符串或数组，如 `"12:00,18:30"`。
 * 只留合法的 "HH:MM"（分钟必须是 0 或 5 的倍数，太碎的分钟会让 tick 很难对上），
 * 去重并排序。空 = 不设时间点。
 */
function readQzoneAutoAskTimes(metadata: Record<string, unknown>): string[] {
  const raw = metadata.qzoneAutoAskTimes;
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : typeof raw === "string"
      ? raw.split(/[,，\s]+/u)
      : [];
  const times = new Set<string>();
  for (const part of parts) {
    const matched = part.trim().match(/^(\d{1,2}):(\d{2})$/u);
    if (!matched) continue;
    const hour = Number(matched[1]);
    const minute = Number(matched[2]);
    if (hour > 23 || minute > 59 || minute % 5 !== 0) continue;
    times.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return [...times].sort();
}

/**
 * 已经有 QQ 连接了吗 —— 决定「能不能接管面板密码」。
 *
 * 接管靠的是 spawn 时塞 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD`（SnowLuma 只在还没有
 * `config/webui.json` 时认这个变量）。密码是我们生成的，**必须马上有地方存**：
 * 没有连接可写，就等于把面板密码生成出来又扔掉，人之后彻底登不进去。
 */
export async function hasPrimaryOnebotConnection(): Promise<boolean> {
  const count = await getPrisma().platformConnection.count({
    where: { platform: ONEBOT_PLATFORM, status: { not: "DISABLED" } },
  });
  return count > 0;
}

/**
 * 改「主连接」的凭据：只动 patch 里给的字段，其余原样保留。
 *
 * 两个用途，都是「别让人手抄」：
 * - 自动接管的面板密码（`snowlumaPassword`）；
 * - 连接里没填的令牌，从面板抄回来的（`accessToken` / `httpToken`）——
 *   不抄的话适配器发消息不带令牌，HTTP API 直接 401。
 *
 * 写坏了等于把整条渠道弄断，所以：先解密现有 JSON、合并、再加密写回；解不开就只写这几个字段。
 * 返回 false = 没有连接可写，调用方自己决定回退。
 */
export async function updatePrimaryOnebotCredentials(patch: {
  snowlumaPassword?: string;
  accessToken?: string;
  httpToken?: string;
}): Promise<boolean> {
  const entries = Object.entries(patch).filter(([, value]) => typeof value === "string" && value.length > 0);
  if (!entries.length) return true;

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findFirst({
    where: { platform: ONEBOT_PLATFORM, status: { not: "DISABLED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, credentialsCiphertext: true },
  });
  if (!connection) return false;

  let credentials: Record<string, unknown> = {};
  if (connection.credentialsCiphertext) {
    try {
      const plain = await decryptApiKey(Buffer.from(connection.credentialsCiphertext).toString("utf8"));
      const parsed = JSON.parse(plain) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        credentials = parsed as Record<string, unknown>;
      }
    } catch {
      // 解不开就只写这几个字段；反正这份凭据本来也读不出来了，人得重新填。
    }
  }

  for (const [key, value] of entries) credentials[key] = value;
  const ciphertext = Buffer.from(await encryptApiKey(JSON.stringify(credentials)), "utf8");
  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: { credentialsCiphertext: ciphertext },
  });
  return true;
}

/** 只写面板密码。语义单独留一个名字，调用处一眼能看出在干什么。 */
export async function savePrimarySnowlumaPassword(password: string): Promise<boolean> {
  return updatePrimaryOnebotCredentials({ snowlumaPassword: password });
}

/**
 * 请运行中的适配器按最新凭据重连一次 —— 和页面「重连」按钮写的是同一个标记，由适配器自己轮询消费。
 *
 * 自动补起里用：令牌刚抄进连接、而适配器早就在跑时，它内存里那份还是旧配置。
 * 不叫它重来一遍，它会一直拿空令牌发消息（HTTP 401 / WS 握手失败），
 * 人看到的现象是「明明补好了却还是不通」。
 */
export async function requestOnebotReload(connectionId: string): Promise<boolean> {
  const count = await getPrisma().$executeRaw`
    UPDATE platform_connections
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('onebotReloadRequestedAt', ${new Date().toISOString()}::text),
      "updatedAt" = NOW()
    WHERE id = ${connectionId}::uuid AND platform = ${ONEBOT_PLATFORM}::text AND status <> 'DISABLED'
  `;
  return count > 0;
}

/**
 * 加载所有应服务的 OneBot 连接及其活动角色绑定。凭据残缺（无法解密）的连接被跳过而不崩溃。
 */
export async function loadOnebotConnections(
  platform: string = ONEBOT_PLATFORM,
  /** 仅测试用：读取 DISABLED 连接，避免本机正在运行的适配器把测试连接当成真实连接。 */
  options: { includeDisabled?: boolean } = {},
): Promise<OnebotConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: options.includeDisabled ? { platform } : { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      platformAccountKey: true,
      credentialsCiphertext: true,
      metadata: true,
      characterBindings: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          characterId: true,
          routingKey: true,
          config: true,
          character: { select: { name: true } },
        },
      },
    },
  });

  const records: OnebotConnectionRecord[] = [];
  for (const connection of connections) {
    let credentials: string | null = null;
    if (connection.credentialsCiphertext) {
      try {
        credentials = await decryptApiKey(Buffer.from(connection.credentialsCiphertext).toString("utf8"));
      } catch (error) {
        console.error("[channel] 解密 OneBot 凭据失败：", error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
    // 连接级默认「仅被 @ 时才回复」：见啥回啥会接走别人的聊天，还容易触发风控。
    const connectionMentionOnly =
      typeof metadata.replyOnlyWhenMentioned === "boolean" ? metadata.replyOnlyWhenMentioned : true;
    const groupAnnouncementEnabled = metadata.groupAnnouncementEnabled === true;
    const groupBiliRunEnabled = metadata.groupBiliRunEnabled === true;
    // 空间动作只认主人，所以开关和「有没有填主人 QQ」是一件事的两面：没填主人就等于关。
    const qzoneEnabled = metadata.qzoneEnabled === true;
    const qzoneAutoAskEnabled = metadata.qzoneAutoAskEnabled === true;
    const qzoneAutoAskTimes = readQzoneAutoAskTimes(metadata);
    const qzoneAutoAskDailyMax = typeof metadata.qzoneAutoAskDailyMax === "number"
      && Number.isFinite(metadata.qzoneAutoAskDailyMax)
      ? Math.min(Math.max(Math.round(metadata.qzoneAutoAskDailyMax), 0), 12)
      : 2;
    const qzoneLimits = readQzoneLimits(metadata);
    const qzoneFriendQqs = readQzoneFriendQqs(metadata);
    const ownerQq = typeof metadata.ownerQq === "string" ? metadata.ownerQq.trim() : "";
    const ownerName = typeof metadata.ownerName === "string" ? metadata.ownerName.trim() : "";
    // 小号自己的号：metadata.qqNumber 是页面填的，platformAccountKey 是连接建好后存的同一串。
    const accountQq = (
      (typeof metadata.qqNumber === "string" && metadata.qqNumber.trim())
      || connection.platformAccountKey
      || ""
    ).toString().trim();

    // 面板密码和 wsUrl/Token 存在同一个加密串里，这里单独解出来给「自动配节点」用。
    let snowlumaPassword = "";
    if (credentials) {
      try {
        const parsed = JSON.parse(credentials) as Record<string, unknown>;
        if (typeof parsed.snowlumaPassword === "string") snowlumaPassword = parsed.snowlumaPassword;
      } catch {
        // 解不开就当没填，自动配节点会让人去补。
      }
    }

    records.push({
      id: connection.id,
      platform: connection.platform,
      accountQq,
      snowlumaPassword,
      config: readConfig(credentials, connection.platformAccountKey),
      replyOnlyWhenMentioned: connectionMentionOnly,
      groupAnnouncementEnabled,
      groupBiliRunEnabled,
      qzoneEnabled,
      qzoneLimits,
      qzoneFriendQqs,
      qzoneAutoAskEnabled,
      qzoneAutoAskTimes,
      qzoneAutoAskDailyMax,
      ownerQq,
      ownerName,
      reloadRequestedAt: typeof metadata.onebotReloadRequestedAt === "string"
        ? metadata.onebotReloadRequestedAt : undefined,
      bindings: connection.characterBindings.map((binding) => {
        const config = (binding.config && typeof binding.config === "object" && !Array.isArray(binding.config))
          ? binding.config as Record<string, unknown>
          : {};
        const rawWindow = config.replyWindowMinutes;
        // 老字段 replyLimitPer10Min 迁移：窗口固定 10 分钟、条数原样带过来。
        const rawLimit = config.replyLimitPerWindow ?? config.replyLimitPer10Min;
        // binding 没写就沿用连接默认值，这样老数据不丢、新绑定也有个起点。
        const replyOnlyWhenMentioned = typeof config.replyOnlyWhenMentioned === "boolean"
          ? config.replyOnlyWhenMentioned
          : connectionMentionOnly;
        return {
          id: binding.id,
          characterId: binding.characterId,
          characterName: binding.character?.name ?? "",
          routingKey: binding.routingKey,
          replyWindowMinutes: typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow >= 1
            ? Math.min(Math.round(rawWindow), 1440)
            : 10,
          replyLimitPerWindow: typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.round(rawLimit), 100)
            : 0,
          groupChat: resolveGroupChatSettings(config, connectionMentionOnly),
          groupChatModes: readGroupChatModeOverrides(config.groupChatModes),
          replyOnlyWhenMentioned,
          groupBiliRunEnabled: typeof config.groupBiliRunEnabled === "boolean"
            ? config.groupBiliRunEnabled
            : groupBiliRunEnabled,
        };
      }),
    });
  }
  return records;
}
