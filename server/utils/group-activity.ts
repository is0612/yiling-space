/**
 * QQ 群活跃度的落库记录 —— 「这个群安静了多久」的唯一事实来源。
 *
 * 为什么不直接看 `conversations.lastMessageAt`：群消息平时不落库，她没回话的那一轮
 * 连会话行都不会被写，于是「群里正聊得热闹」和「群里一天没人说话」在库里长得一样。
 * 而主动找话题最怕的正是时机错：在热聊时插一句「你们怎么都不说话」。
 *
 * 为什么不放进内存：判断这件事的 tick 是独立进程（`scripts/run-proactive.ts`），
 * 读不到适配器里的 `GroupContext`。跨进程只能靠库。
 *
 * 写法上刻意**节流**：热群一分钟几十条，逐条 upsert 是纯浪费 ——
 * 冷场判断的精度是分钟级，落后 20 秒没有任何影响。
 */

import { getPrisma } from "./prisma";

/** 同一个群最多每这么多毫秒落一次库。 */
const THROTTLE_MS = 20_000;
/** recentLines 留几条。给模型看「刚才聊到哪」，不是给它复盘全群。 */
export const MAX_LINES = 12;
/** 单条正文进库前截断：这里存的是素材，不是证据。 */
export const MAX_LINE_CHARS = 120;
/** 内存里最多同时跟踪多少个群；超了丢最久没动静的（长时间运行的适配器不会无限涨）。 */
const MAX_TRACKED_GROUPS = 500;

export type GroupActivityLine = {
  speaker: string;
  text: string;
  at: number;
};

/** 一次落库要写的全部内容。`recentLines` 是**截至此刻**的最近几条，不是增量。 */
export type GroupActivitySnapshot = {
  channelBindingId: string;
  characterId: string;
  externalConversationId: string;
  groupId: string;
  lastMessageAt: Date;
  lastSpokeAt: Date | null;
  recentLines: GroupActivityLine[];
};

export type GroupActivityRecordInput = {
  bindingId: string;
  characterId: string;
  /** `g:<群号>`，与 Conversation.externalConversationId 同口径。 */
  conversationId: string;
  groupId: string;
  /** 收到时刻（ms）。 */
  at: number;
  speaker: string;
  text: string;
};

export type GroupActivityRecorderOptions = {
  throttleMs?: number;
  maxLines?: number;
  maxTrackedGroups?: number;
  now?: () => number;
  /** 测试注入：默认写 `group_activities`。 */
  write?: (snapshot: GroupActivitySnapshot) => Promise<void>;
};

type Entry = {
  channelBindingId: string;
  characterId: string;
  externalConversationId: string;
  groupId: string;
  lastMessageAt: number;
  lastSpokeAt: number | null;
  lines: GroupActivityLine[];
  /** 上一次真正落库的时刻；0 表示还没写过。 */
  lastWriteAt: number;
  touching: boolean;
};

/** 落库：一条 upsert。失败只记日志 —— 活跃度写不进去不该影响这轮聊天。 */
async function writeGroupActivity(snapshot: GroupActivitySnapshot): Promise<void> {
  await getPrisma().groupActivity.upsert({
    where: {
      channelBindingId_externalConversationId: {
        channelBindingId: snapshot.channelBindingId,
        externalConversationId: snapshot.externalConversationId,
      },
    },
    create: {
      channelBindingId: snapshot.channelBindingId,
      characterId: snapshot.characterId,
      externalConversationId: snapshot.externalConversationId,
      groupId: snapshot.groupId,
      lastMessageAt: snapshot.lastMessageAt,
      lastSpokeAt: snapshot.lastSpokeAt,
      recentLines: snapshot.recentLines,
    },
    update: {
      characterId: snapshot.characterId,
      groupId: snapshot.groupId,
      lastMessageAt: snapshot.lastMessageAt,
      ...(snapshot.lastSpokeAt ? { lastSpokeAt: snapshot.lastSpokeAt } : {}),
      recentLines: snapshot.recentLines,
    },
  });
}

export type GroupActivitySpokeInput = {
  bindingId: string;
  characterId: string;
  conversationId: string;
  groupId: string;
  at?: number;
};

export type GroupActivityRecorder = {
  /** 收到一条群消息（无论后面回不回）。 */
  record: (input: GroupActivityRecordInput) => void;
  /**
   * 她在这个群说了话，立刻落库 —— 下一次冷场判断要能看见它。
   * 允许在没有历史消息的情况下调用（进程刚重启）：它自己补一行。
   */
  spoke: (input: GroupActivitySpokeInput) => void;
  /** 测试与停机用：立刻把内存里的东西写下去。 */
  flush: (key?: string) => Promise<void>;
  /** 测试用：现在跟踪了多少个群。 */
  size: () => number;
};

/**
 * 建一个记录器。一个连接一个实例即可 —— 同一张群不会挂在两个连接上。
 *
 * 节流命中时**不丢数据**：内存里的 `lastMessageAt` 一直是最新的，
 * 下一次真正落库时会把它一起写进去。冷场判断看的是分钟级，落后 20 秒无所谓。
 */
export function createGroupActivityRecorder(options: GroupActivityRecorderOptions = {}): GroupActivityRecorder {
  const throttleMs = options.throttleMs ?? THROTTLE_MS;
  const maxLines = options.maxLines ?? MAX_LINES;
  const maxTracked = options.maxTrackedGroups ?? MAX_TRACKED_GROUPS;
  const now = options.now ?? Date.now;
  const write = options.write ?? writeGroupActivity;
  const entries = new Map<string, Entry>();

  const keyOf = (bindingId: string, conversationId: string) => `${bindingId}:${conversationId}`;

  const snapshotOf = (entry: Entry): GroupActivitySnapshot => ({
    channelBindingId: entry.channelBindingId,
    characterId: entry.characterId,
    externalConversationId: entry.externalConversationId,
    groupId: entry.groupId,
    lastMessageAt: new Date(entry.lastMessageAt),
    lastSpokeAt: entry.lastSpokeAt ? new Date(entry.lastSpokeAt) : null,
    recentLines: entry.lines,
  });

  /** 落库；同一群不并发写。失败吞掉，只记一行日志。 */
  const flushEntry = async (entry: Entry): Promise<void> => {
    if (entry.touching) return;
    entry.touching = true;
    entry.lastWriteAt = now();
    try {
      await write(snapshotOf(entry));
    } catch (error) {
      console.error("[onebot] 群活跃度写入失败：", error instanceof Error ? error.message : String(error));
    } finally {
      entry.touching = false;
    }
  };

  /** 超过跟踪上限时丢最久没动静的那个 —— 它也是最不可能马上要判冷场的。 */
  const evictIfNeeded = () => {
    if (entries.size <= maxTracked) return;
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.lastMessageAt < oldestAt) {
        oldestAt = entry.lastMessageAt;
        oldestKey = key;
      }
    }
    if (oldestKey) entries.delete(oldestKey);
  };

  const createEntry = (
    key: string,
    seed: Omit<Entry, "lastSpokeAt" | "lines" | "lastWriteAt" | "touching">,
  ): Entry => {
    const entry: Entry = { ...seed, lastSpokeAt: null, lines: [], lastWriteAt: 0, touching: false };
    entries.set(key, entry);
    evictIfNeeded();
    return entry;
  };

  return {
    record(input) {
      if (!input.bindingId || !input.conversationId) return;
      const key = keyOf(input.bindingId, input.conversationId);
      let entry = entries.get(key);
      if (!entry) {
        entry = createEntry(key, {
          channelBindingId: input.bindingId,
          characterId: input.characterId,
          externalConversationId: input.conversationId,
          groupId: input.groupId,
          lastMessageAt: input.at,
        });
      }
      entry.lastMessageAt = Math.max(entry.lastMessageAt, input.at);
      const text = (input.text ?? "").trim();
      if (text) {
        entry.lines.push({
          speaker: (input.speaker ?? "").trim() || "群友",
          text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
          at: input.at,
        });
        if (entry.lines.length > maxLines) entry.lines.splice(0, entry.lines.length - maxLines);
      }
      // 第一次见到这个群一定写；之后按节流来。
      if (entry.lastWriteAt === 0 || now() - entry.lastWriteAt >= throttleMs) {
        void flushEntry(entry);
      }
    },

    spoke(input) {
      if (!input.bindingId || !input.conversationId) return;
      const key = keyOf(input.bindingId, input.conversationId);
      const at = input.at ?? now();
      const entry = entries.get(key) ?? createEntry(key, {
        channelBindingId: input.bindingId,
        characterId: input.characterId,
        externalConversationId: input.conversationId,
        groupId: input.groupId,
        lastMessageAt: at,
      });
      entry.lastSpokeAt = at;
      entry.lastMessageAt = Math.max(entry.lastMessageAt, at);
      void flushEntry(entry);
    },

    async flush(key) {
      const targets = key
        ? [entries.get(key)].filter((entry): entry is Entry => Boolean(entry))
        : [...entries.values()];
      await Promise.all(targets.map((entry) => flushEntry(entry)));
    },

    size() {
      return entries.size;
    },
  };
}
