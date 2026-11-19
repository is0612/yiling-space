import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { decryptApiKey, encryptApiKey } from "../../../utils/credential-encryption";
import { readTrimmedString } from "../../../utils/local-api";
import { ONEBOT_DEFAULT_HTTP_URL, ONEBOT_DEFAULT_WS_URL } from "../../../utils/channel-adapter/onebot/configure";
import { getPrisma } from "../../../utils/prisma";

/**
 * Creates or updates a channel connection.
 *
 * QQ OneBot：WS/HTTP 地址与 Token 用 AES-256-GCM 加密入库，QQ 号兼作唯一账号键。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<Record<string, unknown>>(event);
  const platform = readTrimmedString(body?.platform, "平台", 50);

  if (platform === "qq-onebot") {
    return createOnebotConnection(body);
  }
  throw createError({ statusCode: 400, statusMessage: "不支持该平台，目前支持 qq-onebot。" });
});

async function createOnebotConnection(body: Record<string, unknown>) {
  const qqNumber = readTrimmedString(body?.qqNumber, "QQ 号", 100, { required: true });
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || `QQ 小号 ${qqNumber}`;
  // 群聊回复策略默认「仅被 @ 时才回复」——见啥回啥会把别人的聊天也接走，还容易触发风控。
  const replyOnlyWhenMentioned = typeof body?.replyOnlyWhenMentioned === "boolean" ? body.replyOnlyWhenMentioned : true;
  // 群管理动作默认关闭：只开「群公告」，且只认群主/管理员。踢人/禁言不在本期范围。
  const groupAnnouncementEnabled = body?.groupAnnouncementEnabled === true;
  // 空间动作默认关闭，且只认主人 QQ。配额的三个数字不放进表单，用默认值
  // （发多了被封号比少发两条严重），需要时直接改 metadata。
  const qzoneEnabled = body?.qzoneEnabled === true;
  // 空间主动：她自己想发 / 想评论时来问主人。默认关，比「听命执行」更激进。
  const qzoneAutoAskEnabled = body?.qzoneAutoAskEnabled === true;
  // 主动问的时间点（如 "12:00,18:30"）与每天上限。省略字段 = 不改旧值。
  const qzoneAutoAskTimes = body?.qzoneAutoAskTimes === undefined
    ? undefined
    : readTrimmedString(body?.qzoneAutoAskTimes, "主动问时间点", 100);
  let qzoneAutoAskDailyMax: number | undefined;
  if (body?.qzoneAutoAskDailyMax !== undefined) {
    const n = Number(body.qzoneAutoAskDailyMax);
    if (!Number.isInteger(n) || n < 0 || n > 12) {
      throw createError({ statusCode: 400, statusMessage: "主动问每天上限必须是 0 到 12 之间的整数。" });
    }
    qzoneAutoAskDailyMax = n;
  }
  // 「看看空间」翻谁的说说：留空就用协议端好友列表的前几个。省略字段 = 不改旧值。
  const qzoneFriendQqs = body?.qzoneFriendQqs === undefined
    ? undefined
    : readTrimmedString(body?.qzoneFriendQqs, "空间好友 QQ", 200);
  // 主人 QQ：空间动作只认这个号，群聊里也用它标出主人。留空 = 未设置；省略字段 = 不改旧值。
  let ownerQq: string | undefined;
  if (body?.ownerQq !== undefined) {
    ownerQq = readTrimmedString(body?.ownerQq, "主人 QQ 号", 20);
    if (ownerQq && !/^\d{5,15}$/u.test(ownerQq)) {
      throw createError({ statusCode: 400, statusMessage: "主人 QQ 号必须是 5 到 15 位数字。" });
    }
    if (ownerQq && ownerQq === qqNumber) {
      throw createError({ statusCode: 400, statusMessage: "主人 QQ 不能和小号自己相同。" });
    }
  }
  const ownerName = body?.ownerName === undefined
    ? undefined
    : readTrimmedString(body?.ownerName, "主人称呼", 60);
  const submittedWsUrl = readTrimmedString(body?.wsUrl, "WS 地址", 500);
  const submittedHttpUrl = readTrimmedString(body?.httpUrl, "HTTP API 地址", 500);
  const submittedAccessToken = readTrimmedString(body?.accessToken, "WS Token", 500);
  const submittedHttpToken = readTrimmedString(body?.httpToken, "HTTP Token", 500);
  // 面板密码里可能有空格，所以只去首尾空白，且不做「密码强度」限制 —— 面板自己管这档事。
  const submittedSnowlumaPassword = readTrimmedString(body?.snowlumaPassword, "SnowLuma 密码", 200);

  const prisma = getPrisma();

  // 约定：地址/Token 留空 = 沿用已保存的值，否则改一次显示名就把 Token 清空了。
  // 编辑页会回填明文，但仍要留这条兜底：凭据解不开时表单是空的，浏览器也可能自动填充。
  let oldCredentials: Record<string, unknown> = {};
  const existing = await prisma.platformConnection.findUnique({
    where: { platform_platformAccountKey: { platform: "qq-onebot", platformAccountKey: qqNumber } },
    select: { credentialsCiphertext: true },
  });
  if (existing?.credentialsCiphertext) {
    try {
      const plain = await decryptApiKey(Buffer.from(existing.credentialsCiphertext).toString("utf8"));
      oldCredentials = JSON.parse(plain) as Record<string, unknown>;
    } catch {
      // 解不开就按「没有旧值」处理，让用户重新填。
    }
  }
  const reuse = (submitted: string, key: string) => {
    if (submitted) return submitted;
    return typeof oldCredentials[key] === "string" ? (oldCredentials[key] as string) : "";
  };

  const wsUrl = reuse(submittedWsUrl, "wsUrl") || ONEBOT_DEFAULT_WS_URL;
  const httpUrl = reuse(submittedHttpUrl, "httpUrl") || ONEBOT_DEFAULT_HTTP_URL;
  const accessToken = reuse(submittedAccessToken, "accessToken");
  const httpToken = reuse(submittedHttpToken, "httpToken");
  // 面板密码和 Token 走同一条加密通道：它只用来登录 SnowLuma 网页面板（自动配节点），
  // 不参与 WS 鉴权，也不跟着连接下发 —— 只有 ?withCredentials=1 时才回显。
  const snowlumaPassword = reuse(submittedSnowlumaPassword, "snowlumaPassword");

  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({
    wsUrl,
    httpUrl,
    accessToken,
    httpToken,
    snowlumaPassword,
  })), "utf8");

  const connection = await prisma.$transaction(async (tx) => {
    const saved = await tx.platformConnection.upsert({
    where: { platform_platformAccountKey: { platform: "qq-onebot", platformAccountKey: qqNumber } },
    create: {
      platform: "qq-onebot",
      platformAccountKey: qqNumber,
      displayName,
      status: "DISCONNECTED",
      credentialsCiphertext,
      metadata: {
        qqNumber,
        replyOnlyWhenMentioned,
        groupAnnouncementEnabled,
        qzoneEnabled,
        qzoneAutoAskEnabled,
        ...(qzoneAutoAskTimes !== undefined ? { qzoneAutoAskTimes } : {}),
        ...(qzoneAutoAskDailyMax !== undefined ? { qzoneAutoAskDailyMax } : {}),
        ...(qzoneFriendQqs !== undefined ? { qzoneFriendQqs } : {}),
        ...(ownerQq !== undefined ? { ownerQq } : {}),
        ...(ownerName !== undefined ? { ownerName } : {}),
      },
    },
    update: {
      displayName,
      credentialsCiphertext,
    },
    select: { id: true, platform: true, displayName: true, platformAccountKey: true, status: true },
    });
    // 原子合并，避免保存表单清掉 runner 的重载状态。
    await tx.$executeRaw`
      UPDATE platform_connections
      SET metadata = COALESCE(metadata, '{}'::jsonb)
        || ${JSON.stringify({
          qqNumber,
          replyOnlyWhenMentioned,
          groupAnnouncementEnabled,
          qzoneEnabled,
          qzoneAutoAskEnabled,
          ...(qzoneAutoAskTimes !== undefined ? { qzoneAutoAskTimes } : {}),
          ...(qzoneAutoAskDailyMax !== undefined ? { qzoneAutoAskDailyMax } : {}),
        ...(qzoneAutoAskTimes !== undefined ? { qzoneAutoAskTimes } : {}),
        ...(qzoneAutoAskDailyMax !== undefined ? { qzoneAutoAskDailyMax } : {}),
          ...(qzoneFriendQqs !== undefined ? { qzoneFriendQqs } : {}),
          ...(ownerQq !== undefined ? { ownerQq } : {}),
          ...(ownerName !== undefined ? { ownerName } : {}),
        })}::jsonb
      WHERE id = ${saved.id}::uuid
    `;
    return saved;
  });

  return {
    id: connection.id,
    platform: connection.platform,
    displayName: connection.displayName,
    appId: connection.platformAccountKey,
    status: connection.status,
  };
}
