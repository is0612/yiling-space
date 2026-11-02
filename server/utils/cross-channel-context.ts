import { estimateTokens } from "./memory-retrieval";

/**
 * 把「同一个人在 QQ 群里说过的话」带进他的一对一对话。
 *
 * 为什么需要它：群聊和私聊是两个会话（`Conversation` 按 `externalConversationId` 唯一），
 * 最近对话窗口只回看当前这一条会话的 40 条历史。于是他在群里说的话，私聊里她一个字
 * 都接不到 —— 用户原话是「两个窗口各记各的记录，这边是真没接到」。
 *
 * 而记忆层又太慢：群消息要先落库、再等按天任务写成忆泡，才有机会被检索到。
 * 这条旁路补的是**这两小时**，memory / events 那条路补的是**那几天**，两件事不重叠。
 *
 * 三条硬约束（改这里之前先读）：
 * 1. **只带这个人自己说的和她的回应。** 群里第三人说的话一个字都不带 —— 群里几十号人
 *    在聊，全带进来既是噪声也是隐私事故。这也是「只通主人」这个口径的落点。
 * 2. **它是另一个窗口的记录，不是本窗口的历史。** 所以调用方必须单独分区传给提示词，
 *    不能并进 `recentMessages` —— 并进去模型会以为自己刚在这个窗口里说过这些。
 * 3. **有界**：时间窗、条数、token 三重上限，且第一条永远放行（一次提问不该因为
 *    预算恰好差几 token 就变成「她什么都不知道」）。
 */

/** 往回看多久。更长的时间交给忆泡，这里只补「刚才」这一小段。 */
export const CROSS_CHANNEL_WINDOW_MINUTES = 120;
/** 最多带几条。主人两小时内说 16 句以上，说明他一直在群里聊，私聊里只要近的那部分。 */
export const CROSS_CHANNEL_MAX_LINES = 16;
/** token 预算。跟 `rawMessageTokenBudget`（900）一个量级，但这是白送的背景，给少一点。 */
export const CROSS_CHANNEL_TOKEN_BUDGET = 600;
/**
 * 她的回应必须在主人发言之后多久内。
 *
 * 不设这个上限，「同一个群里她的所有回复」都会进来：她跟别人聊了两小时，那些话跟他
 * 毫无关系，带进来只会让私聊变成群聊的转播。十分钟足够覆盖「他问 → 她答」这一来一回。
 */
export const CROSS_CHANNEL_REPLY_GAP_MINUTES = 10;
/** 单条正文上限。群里的长贴不占满预算。 */
const CROSS_CHANNEL_LINE_MAX_CHARS = 400;

export type CrossChannelCandidate = {
  /** 消息 id。去重按它，别用正文哈希。 */
  id: string;
  role: string;
  content: string;
  occurredAt: Date;
  /** 消息所在会话。判断「她的回应是不是接在这个人后面」要用。 */
  conversationId: string;
  /** 展示用的来源标签，如 `QQ群 123456`。 */
  groupLabel: string;
  /** 发言人的平台账号，用来认出「这条是主人说的」。 */
  authorOpenId?: string;
  authorDisplayName?: string;
};

export type CrossChannelLine = {
  id: string;
  role: "USER" | "ASSISTANT";
  speaker?: string;
  content: string;
  occurredAt: string;
  groupLabel: string;
};

export type SelectCrossChannelOptions = {
  /** 注入时钟，测试用。 */
  now: Date;
  /** 当前一对一对话方的平台账号。只认这个人自己在群里说的话。 */
  ownerUid: string;
  windowMinutes?: number;
  maxLines?: number;
  tokenBudget?: number;
  replyGapMinutes?: number;
};

export type CrossChannelSelection = {
  lines: CrossChannelLine[];
  /** 时间窗内属于这个人的发言条数（不受预算裁剪影响，用于日志）。 */
  ownerLines: number;
  /** 因为条数或预算被裁掉的条数。 */
  dropped: number;
};

/**
 * 纯函数：候选消息 → 可以进提示词的那几行。全部输入输出都不碰数据库。
 */
export function selectCrossChannelContext(
  candidates: readonly CrossChannelCandidate[],
  options: SelectCrossChannelOptions,
): CrossChannelSelection {
  const ownerUid = (options.ownerUid ?? "").trim();
  if (!ownerUid) return { lines: [], ownerLines: 0, dropped: 0 };

  const windowMinutes = options.windowMinutes ?? CROSS_CHANNEL_WINDOW_MINUTES;
  const maxLines = Math.max(1, Math.trunc(options.maxLines ?? CROSS_CHANNEL_MAX_LINES));
  const tokenBudget = Math.max(1, Math.trunc(options.tokenBudget ?? CROSS_CHANNEL_TOKEN_BUDGET));
  const replyGapMs = Math.max(1, Math.trunc(options.replyGapMinutes ?? CROSS_CHANNEL_REPLY_GAP_MINUTES)) * 60_000;
  const since = options.now.getTime() - windowMinutes * 60_000;

  /**
   * 一次线性扫描，记住「这个群里上一条 USER 是谁」。
   *
   * 不能只用「她这句前面 10 分钟内有主人发言」来判断：群里通常是
   * 他说话 → 她答 → 群友插一句 → 她答群友，四条消息全在十分钟内，
   * 用时间窗判的话第二句回应也会被当成接他的（第一版就是这么错的，
   * 单测直接抓到了）。所以判断依据是**上一条开口的人是谁**，不是时间远近。
   */
  const ordered = [...candidates]
    .filter((candidate) => Number.isFinite(candidate.occurredAt.getTime()))
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));

  const lastUserByConversation = new Map<string, { uid: string; at: number }>();
  const picked: CrossChannelCandidate[] = [];
  let ownerLines = 0;
  for (const candidate of ordered) {
    const at = candidate.occurredAt.getTime();
    if (candidate.role === "USER") {
      const uid = (candidate.authorOpenId ?? "").trim();
      lastUserByConversation.set(candidate.conversationId, { uid, at });
      if (uid === ownerUid && at >= since) {
        picked.push(candidate);
        ownerLines += 1;
      }
      continue;
    }
    if (candidate.role !== "ASSISTANT") continue;
    const previous = lastUserByConversation.get(candidate.conversationId);
    // 上一句必须是他说的话。群友刚插过一句，紧跟着的回应就是接群友的，不能带。
    if (!previous || previous.uid !== ownerUid) continue;
    // 隔太久也不再算「接他那句」：她可能是自己想起什么，或者接着别的话题。
    if (at - previous.at > replyGapMs) continue;
    if (at < since) continue;
    picked.push(candidate);
  }

  const merged = picked.map((candidate) => toLine(candidate));

  // 从最新往回装：预算不够时先丢旧的，剩下的正好是「刚才」那一段。
  const kept: CrossChannelLine[] = [];
  let spent = 0;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxLines) break;
    const line = merged[index]!;
    const cost = estimateTokens(line.content) + 12;
    // 第一条永远放行，否则一次有内容的提问会变成「她什么都没接到」。
    if (kept.length > 0 && spent + cost > tokenBudget) break;
    kept.push(line);
    spent += cost;
  }
  kept.reverse();

  return { lines: kept, ownerLines, dropped: merged.length - kept.length };
}

function toLine(candidate: CrossChannelCandidate): CrossChannelLine {
  const content = candidate.content.trim().slice(0, CROSS_CHANNEL_LINE_MAX_CHARS);
  const speaker = (candidate.authorDisplayName ?? "").trim();
  return {
    id: candidate.id,
    role: candidate.role === "ASSISTANT" ? "ASSISTANT" : "USER",
    ...(candidate.role === "ASSISTANT" || !speaker ? {} : { speaker: speaker.slice(0, 40) }),
    content,
    occurredAt: candidate.occurredAt.toISOString(),
    groupLabel: candidate.groupLabel,
  };
}
