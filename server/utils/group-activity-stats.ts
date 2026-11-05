import type { PrismaClient } from "../../src/generated/prisma/client";
import { parseEventTimeRange } from "./memory-event-time";

/**
 * 「这个群里谁跟我聊过 / 谁跟我聊得最多」——用代码数出来，不让模型从几条忆泡里拼名单。
 *
 * 实况：她回答「昨天跟谁聊」时把另一个群的群友算进了本群，因为
 * 忆泡挂在 CHARACTER_GLOBAL 下、participants 是显示名，模型分不清「哪个群」；
 * 回答「今天跟谁聊」时又只报了最近视频话题里的三个人。两件事都不是模型「记错了」，
 * 是输入里根本没有一份按群、按天的完整名单 —— 它只能从检索到的几条事件里猜。
 *
 * 这里只做统计，不做判断：谁说了几句、几句是冲她说的、最后一句是什么时候。
 * 事实交给代码，模型只负责用角色的口吻说出来。
 *
 * 和 `group-activity.ts` 区分：那个是「群安静了多久」的内存记录器，给主动搭话判冷场用；
 * 这个是回答「跟谁聊过」的只读统计。用途不同，别合并。
 */

export type GroupActivityMember = {
  name: string;
  /** 平台账号（QQ 号）。提示词里不出现，只用于合并同名。 */
  accountId: string;
  /** 这个人在本群、本时间窗内的 USER 消息条数。 */
  messages: number;
  /** 其中 @ 她、叫到她名字、或 @all 的条数。 */
  atYou: number;
  /** 最后一条消息的时间（ISO）。 */
  lastAt: string;
  /** 这个人是不是主人。显示名叫「主人」的群友不算，按 QQ 号认。 */
  isOwner: boolean;
};

export type GroupActivityContext = {
  /** 时间窗的中文标签：「今天」「昨天」「最近 7 天」「全部记录」。 */
  rangeLabel: string;
  start: string;
  end: string;
  totalMessages: number;
  members: GroupActivityMember[];
  /** 给模型看的口径说明。别在提示词里另写一份。 */
  note: string;
};

/**
 * 这轮是不是在问「谁 / 跟谁聊」。
 *
 * 只用于**群聊**：私聊里问「你昨天跟谁聊天」也该查记忆，但不需要按群聚合。
 * 判据故意宽一点 —— 多算一次只是多一段背景，少算一次她才真的会瞎编。
 */
export function isGroupActivityQuery(text: string): boolean {
  const value = text.normalize("NFKC").trim();
  if (!value) return false;
  const asksPeople = /(跟|和|与|同).{0,8}(谁|哪些人|哪几个人|谁们)|(谁|哪些人|哪几个人).{0,8}(跟|和|与|同)?.{0,4}(我|本宝|她)|聊天最多|聊得最多|说话最多|聊最多/u.test(value);
  const talks = /(聊|说话|搭话|唠|聊过)/u.test(value);
  return asksPeople && talks;
}

/** 从群绑定配置里拆出「她在这个群可能被叫的名字」。 */
export function parseSelfNames(input: {
  characterName: string;
  groupAliases?: string | null;
}): string[] {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 2) names.add(trimmed);
  };
  add(input.characterName);
  // 绑定里的别名是「小夏，夏夏」这种逗号/顿号分隔的字符串。
  for (const part of (input.groupAliases ?? "").split(/[,，、;；\s]+/u)) add(part);
  return [...names];
}

export type GroupActivityQueryInput = {
  prisma: Pick<PrismaClient, "message">;
  conversationId: string;
  query: string;
  now?: Date;
  timeZone?: string;
  /** 她自己的 QQ 号：@ 这个号才算「冲她说的」。 */
  selfQq?: string | null;
  /** 主人的 QQ 号：统计里标出 isOwner，免得把显示名叫「主人」的群友当成主人。 */
  ownerQq?: string | null;
  /** 她在群里可能被叫到的名字（角色名 + 绑定别名）。 */
  selfNames?: readonly string[];
  /** 最多列几个人。默认 8：再多提示词里也装不下，模型也念不完。 */
  limit?: number;
};

const ALL_TIME_START = new Date("2000-01-01T00:00:00.000Z");
const MAX_MESSAGES = 8000;

/**
 * 聚合本群一段时间内的发言人。
 *
 * 只查 USER 消息：ASSISTANT 是她自己，算进去会把「她回了多少句」混成「谁说了多少句」。
 * `atYou` 是确定性判据：@ 她的 QQ 号、正文里出现她的名字、或 @all —— 不靠模型判断。
 */
export async function buildGroupActivityContext(
  input: GroupActivityQueryInput,
): Promise<GroupActivityContext | null> {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? "Asia/Shanghai";
  const parsed = parseEventTimeRange(input.query, now, timeZone);
  const start = parsed?.start ?? ALL_TIME_START;
  const end = parsed?.end ?? now;
  const rangeLabel = parsed?.label ?? "全部记录";

  const rows = await input.prisma.message.findMany({
    where: { conversationId: input.conversationId, role: "USER", occurredAt: { gte: start, lt: end } },
    // 先取最近的 8000 条，再按时间正序聚合：超长群也优先保住最近这一段，
    // 否则「全部记录」会停在最老的 8000 条上，最近的口径全错。
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: MAX_MESSAGES,
    select: { content: true, occurredAt: true, metadata: true },
  });
  if (rows.length === 0) return null;
  rows.reverse();

  const selfQq = input.selfQq?.trim() ?? "";
  const ownerQq = input.ownerQq?.trim() ?? "";
  const selfNames = (input.selfNames ?? []).map((name) => name.trim()).filter(Boolean);
  const byAccount = new Map<string, GroupActivityMember>();

  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    const accountId = typeof meta.authorOpenId === "string" ? meta.authorOpenId.trim() : "";
    const displayName = typeof meta.authorDisplayName === "string"
      ? meta.authorDisplayName.trim()
      : typeof meta.member === "string"
        ? meta.member.trim()
        : "";
    const key = accountId || displayName || "unknown";
    const content = row.content;
    const isOwner = Boolean(ownerQq && accountId === ownerQq);
    const mentioned = Boolean(selfQq && content.includes("@" + selfQq)) ||
      /@all/iu.test(content) ||
      selfNames.some((name) => content.includes(name));
    const existing = byAccount.get(key);
    if (existing) {
      existing.messages += 1;
      if (mentioned) existing.atYou += 1;
      if (isOwner) existing.isOwner = true;
      existing.lastAt = row.occurredAt.toISOString();
      // 昵称以最新一条为准：群里改名片很频繁。
      if (displayName) existing.name = displayName;
    } else {
      byAccount.set(key, {
        name: displayName || "群友",
        accountId,
        messages: 1,
        atYou: mentioned ? 1 : 0,
        lastAt: row.occurredAt.toISOString(),
        isOwner,
      });
    }
  }

  /**
   * 两张榜取并集：按发言条数前 N、按「冲她说的条数」前 N。
   *
   * 只按发言条数取会漏掉主人这种「话不多、但句句是在跟她说话」的人 ——
   * 2026-11-04 问「这个群里谁跟你聊天最多」时，主人 75 条排不进前 8，
   * 而按 atYou 数他其实是第一（39 条）。两个口径都要给，模型才不会只看见话痨。
   */
  const all = [...byAccount.values()];
  const perList = Math.max(3, Math.min(8, input.limit ?? 8));
  const byMessages = [...all]
    .sort((left, right) => right.messages - left.messages || right.atYou - left.atYou)
    .slice(0, perList);
  const byAtYou = all
    .filter((member) => member.atYou > 0)
    .sort((left, right) => right.atYou - left.atYou || right.messages - left.messages)
    .slice(0, perList);
  const merged = new Map<string, GroupActivityMember>();
  for (const member of [...byMessages, ...byAtYou]) merged.set(member.accountId || member.name, member);
  const members = [...merged.values()]
    .sort((left, right) => right.atYou - left.atYou || right.messages - left.messages)
    .slice(0, perList * 2);

  return {
    rangeLabel,
    start: start.toISOString(),
    end: end.toISOString(),
    totalMessages: rows.length,
    members,
    note: `本群 ${rangeLabel}的群友发言统计：messages = 发言条数；atYou = @ 你、叫你名字或 @all 的条数。这是本群口径，不是全局互动次数，也不代表私聊关系。`,
  };
}
