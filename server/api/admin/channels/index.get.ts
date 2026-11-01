import { requireAdminActor } from "../../../utils/auth";
import { readGroupChatModeOverrides, resolveGroupChatSettings } from "../../../utils/channel-adapter/onebot/group-chat";
import { decryptApiKey } from "../../../utils/credential-encryption";
import { getPrisma } from "../../../utils/prisma";

/** 只有这几个字段允许回显到管理页；将来往凭据里塞别的东西也不会被顺带漏出去。 */
const CREDENTIAL_KEYS = ["wsUrl", "httpUrl", "accessToken", "httpToken", "snowlumaPassword"] as const;

/**
 * 解密连接凭据。解不开（换过加密密钥 / 数据坏掉）就返回 null ——
 * 一条连接的凭据出问题不该让整个列表 500。
 */
async function readCredentials(ciphertext: Uint8Array | null): Promise<Record<string, string> | null> {
  if (!ciphertext) return null;
  let plain: string;
  try {
    plain = await decryptApiKey(Buffer.from(ciphertext).toString("utf8"));
  } catch {
    return null;
  }
  try {
    const source = (JSON.parse(plain) ?? {}) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of CREDENTIAL_KEYS) {
      if (typeof source[key] === "string") result[key] = source[key] as string;
    }
    return result;
  } catch {
    return null;
  }
}

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  // 明文只在打开「连接设置」时单独取（?withCredentials=1）：默认不返回，
  // 免得首屏 SSR 把 token 写进页面 HTML —— 查看源代码就能看到的东西不算「只有管理员可见」。
  const withCredentials = getQuery(event).withCredentials === "1";
  const prisma = getPrisma();

  const connections = await prisma.platformConnection.findMany({
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      platform: true,
      displayName: true,
      platformAccountKey: true,
      status: true,
      lastEventAt: true,
      createdAt: true,
      metadata: true,
      credentialsCiphertext: true,
      characterBindings: {
        where: { status: "ACTIVE" },
        select: { id: true, characterId: true, routingKey: true, config: true, character: { select: { name: true } } },
      },
    },
  });

  const result = [];
  for (const connection of connections) {
    result.push({
      id: connection.id,
      platform: connection.platform,
      displayName: connection.displayName,
      appId: connection.platformAccountKey,
      status: connection.status,
      lastEventAt: connection.lastEventAt?.toISOString() ?? null,
      createdAt: connection.createdAt.toISOString(),
      metadata: connection.metadata,
      /** 管理员页回看明文：只是本机协议端的访问令牌，方便核对填没填对。模型的 API Key 仍然只存不读。 */
      credentials: withCredentials ? await readCredentials(connection.credentialsCiphertext) : null,
      bindings: connection.characterBindings.map((binding) => {
        const config = (binding.config && typeof binding.config === "object" && !Array.isArray(binding.config))
          ? binding.config as Record<string, unknown>
          : {};
        // 兼容旧字段 replyLimitPer10Min：窗口固定 10 分钟。
        const rawLimit = config.replyLimitPerWindow ?? config.replyLimitPer10Min;
        const rawWindow = config.replyWindowMinutes;
        // 「群聊怎么回」「刷 B站」已挪到角色（binding），未覆盖时回退连接级默认值。
        const meta = (connection.metadata && typeof connection.metadata === "object")
          ? connection.metadata as Record<string, unknown>
          : {};
        // 群聊策略统一走这里解析：老数据只有 replyOnlyWhenMentioned，新数据有 groupChatMode，
        // 前端只认一份结果，不用在页面里再猜一遍。
        const groupChat = resolveGroupChatSettings(config, meta.replyOnlyWhenMentioned === true);
        return {
          id: binding.id,
          characterId: binding.characterId,
          characterName: binding.character.name,
          routingKey: binding.routingKey,
          replyWindowMinutes: typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow >= 1
            ? Math.min(Math.round(rawWindow), 1440)
            : 10,
          replyLimitPerWindow: typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.round(rawLimit), 100)
            : 0,
          groupChat,
          // 按群覆盖的模式。前端拿它跟群号列表对照，决定每个群显示哪一档；
          // 没在这张表里的群就沿 groupChat.mode。
          groupChatModes: readGroupChatModeOverrides(config.groupChatModes),
          // 旧字段保留给还没升级的调用方；值跟着 groupChat.mode 走，省得两处说法不一致。
          replyOnlyWhenMentioned: groupChat.mode === "mention",
          groupBiliRunEnabled: typeof config.groupBiliRunEnabled === "boolean"
            ? config.groupBiliRunEnabled
            : meta.groupBiliRunEnabled === true,
        };
      }),
    });
  }

  return { connections: result };
});
