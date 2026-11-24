import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

/**
 * 群聊原文留存：只服务「她刚才在群里听到了什么」。
 *
 * 群聊默认只存「冲她来的」和「主人说的」，其余发言只留在 5 分钟内存窗口。
 * 这会让「七姐半小时前讲过什么」在检索时无原文可查。这里给一个按群开关：
 * 开启后把非 @ 她、非主人说的群消息也落库，标 `storedReason: "ambient"`，
 * 只保留 48 小时，并且**不进入快照与忆泡**——它只用于原文检索，不参与长期记忆提炼。
 */

/** 落库原因。清理策略按它分档，别随手改值。 */
export const AMBIENT_GROUP_MESSAGE_REASON = "ambient";

/** 群聊原文只留 48 小时：够回答「刚才谁说了什么」，又不会把群友闲聊长期留在库里。 */
export const AMBIENT_GROUP_MESSAGE_RETENTION_HOURS = 48;

/** `true` = 所有群；字符串数组 = 只存列出的群；其余 = 不存。 */
export type StoreAmbientGroupMessages = boolean | string[];

export function resolveStoreAmbientGroupMessages(value: unknown): StoreAmbientGroupMessages {
  if (value === true) return true;
  if (!Array.isArray(value)) return false;
  const groups = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )].slice(0, 50);
  return groups.length ? groups : false;
}

export function shouldStoreAmbientGroupMessage(
  setting: StoreAmbientGroupMessages,
  groupId: string | null | undefined,
): boolean {
  if (!groupId) return false;
  return setting === true || (Array.isArray(setting) && setting.includes(groupId));
}

/**
 * 快照、忆泡、周期来源都要排除 ambient。
 *
 * 它们是「当时听到的原文」，不是「值得长期记住的事」；混进提炼会让群友闲聊
 * 占满来源配额，把私聊和真正冲她来的话挤掉。原文检索仍然可以查到它们。
 */
/**
 * Prisma 的 JSON path NOT 在 PostgreSQL 上无法匹配缺失 key：缺失路径比较结果为 SQL
 * NULL，NOT NULL 仍是 NULL。先用正向等值查询找出 ambient ID，再用普通 UUID notIn
 * 排除；旧桌面对话、历史消息以及 metadata 缺少 storedReason 的记录都会被保留。
 */
export async function notAmbientMessageWhere(
  prisma: Pick<PrismaClient, "message">,
  where: Prisma.MessageWhereInput,
): Promise<Prisma.MessageWhereInput> {
  const ambientRows = await prisma.message.findMany({
    where: { AND: [where, { metadata: { path: ["storedReason"], equals: AMBIENT_GROUP_MESSAGE_REASON } }] },
    select: { id: true },
  });
  return { AND: [where, { id: { notIn: ambientRows.map(row => row.id) } }] };
}

/** 清理用：只删过期的 ambient，不碰证据类与主人上下文。 */
export function ambientCleanupWhere(now: Date): {
  occurredAt: { lt: Date };
  metadata: { path: string[]; equals: string };
} {
  return {
    occurredAt: { lt: new Date(now.getTime() - AMBIENT_GROUP_MESSAGE_RETENTION_HOURS * 60 * 60 * 1000) },
    metadata: { path: ["storedReason"], equals: AMBIENT_GROUP_MESSAGE_REASON },
  };
}
