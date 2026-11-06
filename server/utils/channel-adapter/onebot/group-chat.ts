/**
 * QQ 群聊的「自然接话」：攒批 → 过闸门 → 由模型决定说不说。
 *
 * 群聊和私聊不是一回事。私聊里对方说一句就该回一句；群里是一群人在聊，
 * 她要么插得进去、要么就该潜水。逐条回复会变成客服，而「群里每句话都回」
 * 正是 2026-10-29 那次 32 秒刷 6 条的直接原因。
 *
 * 这里负责两件**不花 token** 的事：把连发的消息攒成一轮，以及判断这一轮值不值得看。
 * 真正的「说不说」交给模型（它可以直接返回 silent），因为该不该插话是语义问题，
 * 用规则判不准 —— 规则只负责把明显不该看的挡在外面。
 */

import { formatClockMinutes, inQuietHours, readClockMinutes } from "../../proactive-settings";
import { usageDayKey } from "../../model-usage";

export type GroupChatMode = "mention" | "ambient" | "all";

export type GroupChatSettings = {
  /** mention = 只回 @ 她的；ambient = 判断着接话（默认）；all = 每句都回（老行为）。 */
  mode: GroupChatMode;
  /** 最后一条消息之后安静这么久，算一轮结束。 */
  batchWindowSeconds: number;
  /** 被 @ 时等这么久就处理，不用等整轮聊完 —— 点名叫她还要等十秒，太迟钝。 */
  mentionWindowSeconds: number;
  /** 两条回复之间至少隔多久。 */
  minGapSeconds: number;
  /** 每天最多说几句（按群算，东八区日界）。 */
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  /** 跟她完全无关的闲聊，被放进去看一眼的概率。 */
  ambientChance: number;
  /** 群里怎么叫她（昵称、简称）。留空就只认 @ 和角色名。 */
  aliases: string[];
};

/**
 * 默认取「自然」档：接得上就说、接不上就潜水。
 * `ambiguous` 的边界留给模型，闸门只拦明显不该开口的情况。
 */
export const GROUP_CHAT_DEFAULTS: GroupChatSettings = {
  mode: "ambient",
  batchWindowSeconds: 12,
  mentionWindowSeconds: 4,
  minGapSeconds: 90,
  dailyMax: 60,
  quietStart: "23:30",
  quietEnd: "07:30",
  ambientChance: 0.15,
  aliases: [],
};

const MODES: readonly GroupChatMode[] = ["mention", "ambient", "all"];

export type FriendIdentityKind = "UNKNOWN" | "HUMAN" | "AI";
export type FriendChatPolicy = "DEFAULT" | "ALLOW" | "BLOCK";

/** 连续只包含 AI 发言的群聊轮数上限；真人参与后由适配器清零。 */
export const MAX_CONSECUTIVE_AI_ROUNDS = 3;

/**
 * 身份与交流权限分开判断：
 * - BLOCK 永远拒绝；
 * - ALLOW 明确加入该角色的 AI 朋友名单；
 * - DEFAULT 下 AI 不接话，真人和未知对象保留原行为。
 */
export function shouldBlockFriendSpeaker(
  identityKind: FriendIdentityKind,
  chatPolicy: FriendChatPolicy,
): boolean {
  if (chatPolicy === "BLOCK") return true;
  if (chatPolicy === "ALLOW") return false;
  return identityKind === "AI";
}

/** 一轮只有在每条消息都来自已标记 AI 时，才计入连续 AI 对话保护。 */
export function isAiOnlyGroupRound(identityKinds: readonly FriendIdentityKind[]): boolean {
  return identityKinds.length > 0 && identityKinds.every((kind) => kind === "AI");
}

/** 达到连续 AI 轮数上限后暂停；后续真人参与会将计数清零。 */
export function shouldPauseAiOnlyRound(consecutiveAiRounds: number): boolean {
  return Number.isFinite(consecutiveAiRounds)
    && consecutiveAiRounds >= MAX_CONSECUTIVE_AI_ROUNDS;
}

/**
 * 按群覆盖的模式：`{ "<群号>": "mention" | "ambient" | "all" }`。
 *
 * 为什么需要它：一条绑定可以挂多个群（routingKey 逗号分隔），而「一个群热闹、另一个群只要被 @ 才回」
 * 是很常见的组合。模式存在绑定级时只能取一个，等于让用户重新拆绑定。
 * 只覆盖 mode，其余闸门参数仍跟绑定走 —— 要按群调节奏的场景目前没有，多一份配置就多一处不一致。
 */
export type GroupChatModeOverrides = Record<string, GroupChatMode>;

/** 群号的宽松校验：QQ 群号是纯数字。放开范围是为了兼容测试群号。 */
export function isGroupId(value: string): boolean {
  return /^\d{5,12}$/.test(value);
}

/**
 * 读按群覆盖的模式表。非法项直接跳过而不是报错 —— 一张群号表里混进一个手改的脏值，
 * 不该让整条绑定的群聊设置全部失效。
 */
export function readGroupChatModeOverrides(value: unknown, maxEntries = 50): GroupChatModeOverrides {
  const raw = asRecord(value);
  const overrides: GroupChatModeOverrides = {};
  for (const [key, mode] of Object.entries(raw)) {
    const groupId = key.trim();
    if (!isGroupId(groupId)) continue;
    if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) continue;
    overrides[groupId] = mode as GroupChatMode;
    if (Object.keys(overrides).length >= maxEntries) break;
  }
  return overrides;
}

/** 把绑定级设置按群覆盖成这个群实际用的设置；这一群没单独设过就沿绑定那档。 */
export function groupChatForGroup(
  settings: GroupChatSettings,
  overrides: GroupChatModeOverrides | undefined,
  groupId: string | null | undefined,
): GroupChatSettings {
  if (!groupId || !overrides) return settings;
  const mode = overrides[groupId];
  return mode ? { ...settings, mode } : settings;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.round(value), max));
}

/** 别名接受数组或「小夏,夏夏 阿夏」这种手填串：两种都常见，没必要让一种报错。 */
function readAliases(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return [...new Set(
    raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 1 && item.length <= 20),
  )].slice(0, 12);
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/**
 * 从绑定配置里读群聊设置。
 *
 * `legacyMentionOnly` 是连接级的旧开关：绑定没写 `groupChatMode` 时用它兜底，
 * 所以老数据不用迁移也能继续用。**注意旧语义 `replyOnlyWhenMentioned: false`
 * 现在解释成 ambient 而不是「全都回」** —— 「全都回」只有显式选 `all` 才会有。
 */
export function resolveGroupChatSettings(config: unknown, legacyMentionOnly = true): GroupChatSettings {
  const raw = asRecord(config);
  const stored = raw.groupChatMode;
  let mode: GroupChatMode;
  if (typeof stored === "string" && (MODES as readonly string[]).includes(stored)) {
    mode = stored as GroupChatMode;
  } else if (typeof raw.replyOnlyWhenMentioned === "boolean") {
    mode = raw.replyOnlyWhenMentioned ? "mention" : "ambient";
  } else {
    mode = legacyMentionOnly ? "mention" : "ambient";
  }
  const clock = (value: unknown, fallback: string) => {
    const minutes = readClockMinutes(value);
    return minutes === null ? fallback : formatClockMinutes(minutes);
  };
  return {
    mode,
    batchWindowSeconds: clampInt(raw.batchWindowSeconds, GROUP_CHAT_DEFAULTS.batchWindowSeconds, 3, 60),
    mentionWindowSeconds: clampInt(raw.mentionWindowSeconds, GROUP_CHAT_DEFAULTS.mentionWindowSeconds, 1, 30),
    minGapSeconds: clampInt(raw.minGapSeconds, GROUP_CHAT_DEFAULTS.minGapSeconds, 0, 3600),
    dailyMax: clampInt(raw.dailyMax, GROUP_CHAT_DEFAULTS.dailyMax, 0, 1000),
    quietStart: clock(raw.quietStart, GROUP_CHAT_DEFAULTS.quietStart),
    quietEnd: clock(raw.quietEnd, GROUP_CHAT_DEFAULTS.quietEnd),
    ambientChance: clampRatio(raw.ambientChance, GROUP_CHAT_DEFAULTS.ambientChance),
    aliases: readAliases(raw.groupAliases),
  };
}

/**
 * 她说完话之后这么久之内，群里的话都算「在接她的话」。
 *
 * 判据只取 `lastSpokeAt`，理由不是省事，而是它天然覆盖了两条来源：走回复管道的正常接话、
 * 以及主动开口（`group-initiative` 发的消息同样以 `role: ASSISTANT` 落进同一个群会话）。
 * 这恰好是最容易漏掉的一类 —— 她开了个头，群友顺着说一句、没有 @ 也没有叫她名字，
 * 旧逻辑里这叫「不相关」，只剩 `ambientChance` 的抽签，八成半的接话她根本看不见。
 *
 * 3 分钟与 `group-context.ts` 的 `topicTtlMs` 同一个尺度：项目里「短期关注」就是这个量级。
 */
export const FOLLOWUP_WINDOW_MS = 3 * 60 * 1000;

/**
 * 接话场景的最短间隔，替代 90 秒的 `minGap`。
 *
 * `minGap` 压的是「没人叫她时追着别人聊」；而别人刚回她一句，她再答一句是同一段对话的来回。
 * 不给豁免的话，`minGap = 90` 会把 30 秒内到达的回应整轮丢掉 —— 那不是「别刷屏」，
 * 那是「聊到一半突然没了」。仍留 20 秒下限，避免同一秒里连发两条。
 */
export const FOLLOWUP_MIN_GAP_MS = 20 * 1000;

/** 群聊里她这一次的提示词版本，用于排查「她为什么没说话」。 */
export type GroupChatGateInput = {
  settings: GroupChatSettings;
  now: Date;
  /** 批次里有真实 @ 她（at 段的 QQ 是她）。 */
  direct: boolean;
  /** 正文里出现了她的名字/别名。弱线索：可以看一眼，但不强制回。 */
  named: boolean;
  /** 程序从短期话题参与里找到的候选：有人在接着她参与过的话题说。 */
  topicCandidate: boolean;
  /**
   * 她上一次在这个群说话的时刻（含主动开口）。
   *
   * 两个用途，别只当成节流参数：一是 `minGap` 的间隔判定，二是「这轮是不是在接她的话」
   * —— 见 `FOLLOWUP_WINDOW_MS`。
   */
  lastSpokeAt: Date | null;
  /** 今天这个群她已说过的句数。 */
  spokenToday: number;
  /** 0-1，由调用方注入，方便测试抽签边界。 */
  random: number;
  /**
   * 这一批里有人 @ 的是**别的群成员**，而不是她。
   *
   * 和 `direct` 不冲突：@ 她并顺带 @ 别人仍算 direct。只有「@ 了别人、没 @ 她、
   * 也没叫到她的名字」才为真 —— 那是在找人办事，不是在跟她说话。
   */
  addressedToOthers?: boolean;
  /**
   * 这一批 @ 她的话**全是为了把话收回来**（「没说你」「不是说你」「我说的是别人」）。
   *
   * 只有在 `direct` 为真时才有意义：@ 是程序事实，但「被澄清」不是「被点名办事」。
   * 见下方 `isClarificationMessage`。
   */
  clarificationOnly?: boolean;
};

export type GroupChatGateResult = {
  allowed: boolean;
  reason: string;
  /** 放行后是否「不允许主动沉默」：只有真实 @ 与 all 档为 true。 */
  mustReply: boolean;
};

/**
 * 闸门顺序：先判配置性问题（模式），再判时间性问题（安静时段 / 每日上限 / 间隔），
 * 最后才轮到相关性。顺序不能反 —— 反过来会出现「明明已经吵到上限了，还在算该不该接话」。
 *
 * direct（真实 @）是程序事实，不能被模型或名额改写：它可以绕过安静时段，
 * 但仍要受每日上限与最短间隔约束；all 档保持旧的「每条都回」行为。
 */
export function evaluateGroupChatGate(input: GroupChatGateInput): GroupChatGateResult {
  const { settings, now, direct } = input;

  /**
   * 这一轮是不是在接她刚说过的话。
   *
   * 只看「她上次开口距现在多久」。为什么不算「是不是引用了她那条」：QQ 群里大多数回话
   * 不引用，拿引用当判据会漏掉绝大多数真实接话；而时间窗的代价是「她说完后三分钟内的
   * 任何消息都送进去看一眼」—— 这与本文件开头的原则一致：闸门负责「送不送到她眼前」，
   * 「说不说」交给模型（`mustReply = false`）。
   *
   * `addressedToOthers` 为真时不算：那是有人点名找别人办事，她刚说完话也不该凑上去。
   */
  const sinceOwnMs = input.lastSpokeAt
    ? now.getTime() - input.lastSpokeAt.getTime()
    : Number.POSITIVE_INFINITY;
  const continuing = !direct && !input.addressedToOthers && sinceOwnMs <= FOLLOWUP_WINDOW_MS;

  // 「全都回」是用户显式选的，保持老行为，不再叠任何门槛 —— 只有一条例外：
  // 有人明确 @ 了**别的成员**（没 @ 她、也没叫她的名字）。那是在找人办事，
  // 不是跟她说话；「全都回」的意思是「群里说什么都愿意搭一句」，不是「别人私事也插嘴」。
  // 实测 2026-10-31 14:03「@群友甲 你那边迁移是怎么做的」她照样接了。
  if (settings.mode === "all") {
    if (input.addressedToOthers && !direct && !input.named) {
      return { allowed: false, reason: "addressed_to_others", mustReply: false };
    }
    return { allowed: true, reason: "all_messages", mustReply: true };
  }
  if (settings.mode === "mention" && !direct && !input.named && !input.topicCandidate) {
    return { allowed: false, reason: "not_cued", mustReply: false };
  }

  if (!direct && inQuietHours(now, settings)) {
    return { allowed: false, reason: "quiet_hours", mustReply: false };
  }
  if (settings.dailyMax > 0 && input.spokenToday >= settings.dailyMax) {
    return { allowed: false, reason: "daily_limit", mustReply: false };
  }
  // 最小间隔只压「没人点名时的自然接话」。
  // @ 是明确指令，必须豁免：2026-10-30 她 10:32:12 回完一句，10:32:48 有人 @ 她，
  // 36 秒 < 90 秒 → 被判 too_soon 丢掉，人看到的就是「@ 了也不回」。
  // 安静时段早就有 `!direct` 豁免，这里漏了，属实现不一致。
  //
  // 接话场景用更短的下限（见 `FOLLOWUP_MIN_GAP_MS`）：别人刚回她一句，她答一句是同一段
  // 对话的来回，90 秒的「别追着聊」在这里只会表现为「聊到一半突然没了」。
  if (!direct && input.lastSpokeAt && settings.minGapSeconds > 0) {
    const gapMs = now.getTime() - input.lastSpokeAt.getTime();
    const floorMs = continuing
      ? Math.min(FOLLOWUP_MIN_GAP_MS, settings.minGapSeconds * 1000)
      : settings.minGapSeconds * 1000;
    if (gapMs < floorMs) {
      return { allowed: false, reason: "too_soon", mustReply: false };
    }
  }
  // `direct` 仍然允许说话（她会看到这一轮），但「必须说话」是有例外的：
  // 被澄清的话逼着开口，等于逼她把台阶踢回去。
  if (direct) {
    return input.clarificationOnly
      ? { allowed: true, reason: "clarification", mustReply: false }
      : { allowed: true, reason: "direct", mustReply: true };
  }
  if (input.named) return { allowed: true, reason: "named", mustReply: false };
  // 接着她刚说过的话说：和「叫到名字」同一档的弱线索 —— 送进去看一眼，但允许沉默。
  if (continuing) return { allowed: true, reason: "continuing", mustReply: false };
  if (input.topicCandidate) return { allowed: true, reason: "topic", mustReply: false };
  if (input.random < settings.ambientChance) return { allowed: true, reason: "chance", mustReply: false };
  return { allowed: false, reason: "not_relevant", mustReply: false };
}

/**
 * 攒批窗口：被 @ 或叫到名字用短窗口（有人在找她，别让人等一整轮）；
 * all 档也用短窗口（它要保持「很快回」的手感）；其余走整轮窗口。
 */
export function groupChatWindowMs(settings: GroupChatSettings, urgent: boolean): number {
  if (urgent) return settings.mentionWindowSeconds * 1000;
  if (settings.mode === "all") return Math.min(settings.mentionWindowSeconds, 3) * 1000;
  return settings.batchWindowSeconds * 1000;
}

/** 文字里有没有叫到她的名字。大小写不敏感，去掉空白再比 —— 群里打字很少规范。 */
export function mentionsCharacterName(content: string, names: readonly string[]): boolean {
  if (!content) return false;
  const text = content.toLowerCase().replace(/\s+/g, "");
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, "");
    if (target && text.includes(target)) return true;
  }
  return false;
}

/**
 * 这句 @ 她是不是只为了**把话收回来** ——「没说你」「不是说你」「我说的是别人」。
 *
 * 为什么要单独认：程序层面它和「点名叫她办事」长得一模一样（at 段都指向她），
 * 但对人的含义正好相反 —— 这是递台阶，不是找人干活。实况：她刚把
 * 别人的调侃认成自己，对方 @ 她说「没说你呢」，她却被 `mustReply` 逼着必须开口，
 * 回了一句「没说我你@我干嘛，手滑啊」，把台阶踢了回去。
 *
 * 判据故意收紧成「短句 + 澄清词」：长句里出现「没说你」往往后面还跟着正事
 * （「没说你呢，你那个迁移怎么做的」），那种必须回。宁可漏认，不要误判成「可以不理人」。
 */
export function isClarificationMessage(content: string): boolean {
  if (!content) return false;
  const text = content
    .replace(/\[CQ:[^\]]*\]/g, "")
    .replace(/@\d+/g, "")
    .replace(/@self/giu, "")
    .replace(/\s+/gu, "");
  if (!text || text.length > 24) return false;
  return /(?:没|不是)(?:在)?说你|不是跟你(?:说话|说)|跟你(?:没|无)关系|别误会|说的不是你|我说的是(?:别人|他|她|它)/u.test(text);
}

/** 东八区当天零点，用于按天统计她说过几句。 */
export function groupChatDayStart(now: Date = new Date()): Date {
  return new Date(`${usageDayKey(now)}T00:00:00+08:00`);
}

export type GroupChatBatchItem = { at: number };

/**
 * 按「绑定 + 群」攒消息。
 *
 * 两个时间概念：
 *   - 窗口：最后一条消息之后安静 `windowMs` 才算聊完，期间每来一条就顺延；
 *   - 兜底：从第一条起最多等 `maxWaitMs`，否则一群人一直在聊，她就永远等不到开口的时机。
 *
 * 已经开跑的批次立刻从 Map 里摘掉，新消息进下一批 —— 不能让 flush 期间的等待
 * 把新消息也拖进旧批次，那会让她回一句已经过时的话。
 */
export function createGroupChatBuffer<T extends GroupChatBatchItem>(options: {
  onFlush: (key: string, items: T[]) => void | Promise<void>;
  maxItems?: number;
  maxWaitMs?: number;
  now?: () => number;
}) {
  const maxItems = options.maxItems ?? 30;
  const maxWaitMs = options.maxWaitMs ?? 45_000;
  const now = options.now ?? Date.now;
  const pending = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> | null; firstAt: number }>();

  const flush = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.items.length) return;
    void Promise.resolve(options.onFlush(key, entry.items)).catch((error) => {
      console.error("[onebot] 群聊批次处理失败：", error instanceof Error ? error.message : String(error));
    });
  };

  return {
    push(key: string, item: T, windowMs: number): void {
      const at = now();
      let entry = pending.get(key);
      if (!entry) {
        entry = { items: [], timer: null, firstAt: at };
        pending.set(key, entry);
      }
      entry.items.push(item);
      if (entry.items.length > maxItems) entry.items.splice(0, entry.items.length - maxItems);
      if (entry.timer) clearTimeout(entry.timer);
      const remaining = Math.max(200, maxWaitMs - (at - entry.firstAt));
      const delay = Math.min(Math.max(200, windowMs), remaining);
      entry.timer = setTimeout(() => flush(key), delay);
      entry.timer.unref?.();
    },
    /** 测试与停机用：立刻把某一群或全部待处理批次冲出去。 */
    drain(key?: string): void {
      if (key) {
        flush(key);
        return;
      }
      for (const pendingKey of [...pending.keys()]) flush(pendingKey);
    },
    size(key: string): number {
      return pending.get(key)?.items.length ?? 0;
    },
  };
}
