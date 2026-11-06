/**
 * QQ 群聊的短期上下文与「话题参与」状态。
 *
 * 这里只放**不落库、有界、可过期**的东西：
 *   - 最近几分钟的群聊，给模型当背景（被闸门丢掉的消息也从这里进）；
 *   - QQ → 成员代号的映射，保证入模时不出现真实账号；
 *   - 她实际参与过的话题，用来判断「这轮是不是接着刚才那个话题」。
 *
 * 全部按「连接内的绑定 + 群会话」隔离；连接由调用方保证（一个 handler 一个实例）。
 * 纯内存：进程重启后她变回「没参与过任何话题」，这是可接受的降级。
 */

export type GroupMentionTarget = "self" | "other" | "all";

/** 一条群消息里与判定有关的事实。正文保持原样，@ 的代号化在 formatText 里做。 */
export type GroupMessageFacts = {
  messageId: string;
  /** 收到时刻（ms）。 */
  at: number;
  senderQq: string;
  displayName: string;
  text: string;
  mentionTargets: GroupMentionTarget[];
  replyToMessageId: string;
  /** 这条 @ 到的原始 QQ（含她自己和 all）。只用于学「谁是谁的人」，不入提示词。 */
  mentionQqs?: string[];
};

/**
 * 群里一个人属于谁 —— 给模型判断「我的鱼」「我家宝」到底指谁用。
 *
 * 只说归属，不说关系性质：自述「主人夸我了」和显示名「X的Y」都只是线索，
 * 有的是主人，有的是饲养员，模型不该把这层说得比线索更硬。
 */
export type GroupMemberOwnership = {
  /** 这个人的代号（member_n）。 */
  member: string;
  speaker: string;
  /** 他属于的人的代号。 */
  belongsTo: string;
  belongsToName: string;
};

export type GroupBackgroundLine = {
  id: string;
  at: number;
  /** 成员代号，如 member_2；她自己是 self。 */
  member: string;
  speaker: string;
  text: string;
};

export type GroupTopicAnchor = { id: string; label: string };

export type GroupRelation = "direct" | "followup" | "shared_topic" | "ambient" | "unrelated";

export type GroupDecision = {
  relation: GroupRelation;
  topicAnchorMessageId?: string;
  evidenceMessageIds: string[];
};

type StoredMessage = GroupMessageFacts;

type Topic = {
  anchorMessageId: string;
  participants: string[];
  triggerMessageId: string;
  lastEvidenceAt: number;
  createdAt: number;
  expiresAt: number;
  source: "mention" | "ambient";
};

type ConversationState = {
  messages: StoredMessage[];
  topics: Topic[];
  memberCodes: Map<string, string>;
  nextMember: number;
  /** senderQq → ownerQq：从群里自述学来的归属（「@某人 主人夸我了」）。 */
  owners: Map<string, string>;
  /** senderQq → 最近一次「@ 了别人」的收到时刻：判断后面那几句还在跟谁讲。 */
  lastOtherMention: Map<string, number>;
};

export type GroupContextOptions = {
  /** 这个小号自己的 QQ；@ 她会被写成 @self。 */
  selfQq?: string;
  now?: () => number;
  /** 背景只保留最近这么久。 */
  windowMs?: number;
  maxMessages?: number;
  maxChars?: number;
  /** 单条正文进提示词前的截断。 */
  maxTextPerMessage?: number;
  maxMembers?: number;
  maxTopics?: number;
  /** 无相关互动多久失效。 */
  topicTtlMs?: number;
  /** 一个话题从建立起最多活多久，防止被无限续命。 */
  topicMaxLifeMs?: number;
};

const DEFAULTS = {
  windowMs: 5 * 60 * 1000,
  maxMessages: 40,
  maxChars: 6000,
  maxTextPerMessage: 600,
  maxMembers: 200,
  maxTopics: 3,
  topicTtlMs: 3 * 60 * 1000,
  topicMaxLifeMs: 15 * 60 * 1000,
} as const;

export class GroupContext {
  private readonly now: () => number;
  private readonly selfQq: string;
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly maxTextPerMessage: number;
  private readonly maxMembers: number;
  private readonly maxTopics: number;
  private readonly topicTtlMs: number;
  private readonly topicMaxLifeMs: number;
  private readonly states = new Map<string, ConversationState>();

  constructor(options: GroupContextOptions = {}) {
    this.now = options.now ?? Date.now;
    this.selfQq = options.selfQq ?? "";
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.maxMessages = options.maxMessages ?? DEFAULTS.maxMessages;
    this.maxChars = options.maxChars ?? DEFAULTS.maxChars;
    this.maxTextPerMessage = options.maxTextPerMessage ?? DEFAULTS.maxTextPerMessage;
    this.maxMembers = options.maxMembers ?? DEFAULTS.maxMembers;
    this.maxTopics = options.maxTopics ?? DEFAULTS.maxTopics;
    this.topicTtlMs = options.topicTtlMs ?? DEFAULTS.topicTtlMs;
    this.topicMaxLifeMs = options.topicMaxLifeMs ?? DEFAULTS.topicMaxLifeMs;
  }

  /** 记一条群消息（无论后面会不会回）。重复 messageId 只留第一次。 */
  remember(key: string, message: GroupMessageFacts): void {
    const state = this.state(key);
    if (state.messages.some((item) => item.messageId === message.messageId)) return;
    state.messages.push({ ...message });
    this.learnOwnership(state, message);
    // 这条 @ 的是别人：记下来，他后面那几句多半还是在跟那个人讲。
    const mentionsOther = (message.mentionQqs ?? []).some(
      (qq) => qq && qq !== "all" && qq !== this.selfQq,
    ) || message.mentionTargets.includes("other");
    if (mentionsOther) state.lastOtherMention.set(message.senderQq, message.at);
    this.prune(state);
  }

  /**
   * 这个人刚才是不是在跟**别人**说话。
   *
   * 群里的话常拆两条发：「@群友乙 不是刷屏」+「是这个不适合发群里」。第一条 @ 了别人，
   * 在「全都回」档会被 `addressed_to_others` 挡掉、不落库；第二条没有 @，就成了一颗
   * 孤零零的「对所有人说」的话 —— 她于是当成在说自己（2026-10-31 22:02
   * 「不适合你还发，本宝都看见了」）。所以「刚 @ 过别人」这件事要留一会儿：
   * 同一个人紧接着多说的那几句，仍然是在跟那个人讲。
   *
   * 只算「@ 了别人」：@ 她、@all 不算 —— 那两种本来就是冲她/冲大家说的。
   */
  addressedOtherWithin(key: string, senderQq: string, at: number, withinMs: number): boolean {
    const since = this.state(key).lastOtherMention.get(senderQq);
    if (since === undefined) return false;
    return at >= since && at - since <= withinMs;
  }

  /**
   * 从一条消息里学「谁属于谁」。
   *
   * 只在两个条件同时成立时记账：正文里有「主人」，且**恰好 @ 了一个别人**。
   * 那句「@群友甲 嘿嘿主人夸我了」是硬证据；@ 了两个人就分不清认的是哪个，
   * 宁可不记 —— 记错了比不记更糟，模型会拿着一张错的表去判断「我的鱼」是谁。
   */
  private learnOwnership(state: ConversationState, message: GroupMessageFacts): void {
    if (!message.text || !/主人/u.test(message.text)) return;
    const others = (message.mentionQqs ?? []).filter(
      (qq) => qq && qq !== "all" && qq !== this.selfQq && qq !== message.senderQq,
    );
    if (others.length !== 1) return;
    state.owners.set(message.senderQq, others[0]!);
  }

  /** 给模型看的正文：@ 她 → @self，@ 已知成员 → @member_n，@全体保留。 */
  formatText(key: string, text: string, selfQq = this.selfQq): string {
    if (!text) return "";
    const mapTarget = (raw: string) => {
      if (raw === "all") return "@all";
      if (selfQq && raw === selfQq) return "@self";
      return `@${this.memberCode(key, raw)}`;
    };
    return text
      // 字符串消息可能还带着 CQ 码，先换掉再处理拍平后的 @QQ。
      .replace(/\[CQ:at,qq=(\d+|all)\]/g, (_match, raw: string) => mapTarget(raw))
      .replace(/@(\d+|all)\b/g, (_match, raw: string) => mapTarget(raw));
  }

  memberCode(key: string, qq: string): string {
    if (!qq) return "member_unknown";
    const state = this.state(key);
    const existing = state.memberCodes.get(qq);
    if (existing) return existing;
    state.nextMember += 1;
    const code = `member_${state.nextMember}`;
    state.memberCodes.set(qq, code);
    while (state.memberCodes.size > this.maxMembers) {
      const oldest = state.memberCodes.keys().next().value;
      if (oldest === undefined) break;
      state.memberCodes.delete(oldest);
    }
    return code;
  }

  /**
   * 窗口内某条消息是谁发的（QQ 号）。
   *
   * 只给**出站**用：引用回复时要在消息里 @ 原文作者，而模型只拿得到 transcript 的
   * message id（提示词里不能出现真实账号）。所以这层映射留在进程内，由发送侧查。
   * 查不到（消息比窗口老、或这轮压根没经过这里）返回 null，调用方就别 @。
   */
  senderOf(key: string, messageId: string, maxAgeMs = this.windowMs): string | null {
    if (!messageId) return null;
    const now = this.now();
    const found = this.state(key).messages.find((message) =>
      message.messageId === messageId && now - message.at <= maxAgeMs);
    return found?.senderQq || null;
  }

  /**
   * 群里已知的归属：谁是谁的人。
   *
   * 只给**能对上人的**那些：显示名推断出的名字如果在窗口里找不到，就当没这回事 ——
   * 一张半准不准的表比没有表更糟，模型会拿它当事实用。
   * 上限 20 条：这个群同时有二十几条鱼，再多也只是噪音。
   */
  members(key: string, excludedSenders: ReadonlySet<string> = new Set()): GroupMemberOwnership[] {
    const state = this.state(key);
    const nameOfQq = new Map<string, string>();
    const qqOfName = new Map<string, string>();
    for (const message of state.messages) {
      if (!message.senderQq || !message.displayName || excludedSenders.has(message.senderQq)) continue;
      nameOfQq.set(message.senderQq, message.displayName);
      if (!qqOfName.has(message.displayName)) qqOfName.set(message.displayName, message.senderQq);
    }
    // 代号按发言先后分配，和 transcript 里的顺序一致 —— 否则这里先给「被归属的人」
    // 分配代号，主客就颠倒了，模型看到的 member_1 和 transcript 里对不上。
    for (const qq of nameOfQq.keys()) this.memberCode(key, qq);
    const pairs = new Map<string, string>();
    for (const [qq, name] of nameOfQq) {
      const ownerName = parseDisplayNameOwner(name);
      const ownerQq = ownerName ? qqOfName.get(ownerName) : undefined;
      if (ownerQq && ownerQq !== qq) pairs.set(qq, ownerQq);
    }
    // 自述优先：名字可能有歧义，自己 @ 着人喊「主人」不会。
    for (const [qq, ownerQq] of state.owners) {
      if (!excludedSenders.has(qq) && !excludedSenders.has(ownerQq)) pairs.set(qq, ownerQq);
    }
    const out: GroupMemberOwnership[] = [];
    for (const [qq, ownerQq] of pairs) {
      const speaker = nameOfQq.get(qq);
      const ownerName = nameOfQq.get(ownerQq);
      if (!speaker || !ownerName) continue;
      out.push({
        member: this.memberCode(key, qq),
        speaker: speaker.slice(0, 40),
        belongsTo: this.memberCode(key, ownerQq),
        belongsToName: ownerName.slice(0, 40),
      });
      if (out.length >= 20) break;
    }
    return out;
  }

  /** 本轮之外、仍在窗口内的背景，按时间正序；超预算时从最旧的开始丢。 */
  background(key: string, excludeIds: readonly string[], limits?: { windowMs: number; maxMessages: number; maxChars: number }): GroupBackgroundLine[] {
    const state = this.state(key);
    const now = this.now();
    const excluded = new Set(excludeIds);
    const lines: GroupBackgroundLine[] = [];
    for (const message of state.messages.slice(-(limits?.maxMessages ?? this.maxMessages))) {
      if (excluded.has(message.messageId)) continue;
      if (now - message.at > (limits?.windowMs ?? this.windowMs)) continue;
      lines.push({
        id: message.messageId,
        at: message.at,
        member: this.memberCode(key, message.senderQq),
        speaker: message.displayName,
        text: this.truncate(this.formatText(key, message.text)),
      });
    }
    // 从最旧的开始丢，直到总量进预算；至少保留最后一条。
    let total = lines.reduce((sum, line) => sum + line.text.length, 0);
    while ((total > (limits?.maxChars ?? this.maxChars) || lines.length > (limits?.maxMessages ?? this.maxMessages)) && lines.length > 1) {
      const dropped = lines.shift();
      total -= dropped?.text.length ?? 0;
    }
    return lines;
  }

  /** 有活跃话题、且这轮里有人是参与者（或引用锚点）时，值得看一眼。 */
  topicCandidate(key: string, facts: readonly GroupMessageFacts[]): boolean {
    const state = this.state(key);
    const now = this.now();
    const active = state.topics.filter((topic) => now < topic.expiresAt);
    if (!active.length) return false;
    const senders = new Set(facts.map((fact) => this.memberCode(key, fact.senderQq)));
    const replies = new Set(facts.map((fact) => fact.replyToMessageId).filter(Boolean));
    return active.some((topic) =>
      topic.participants.some((member) => senders.has(member))
      || (topic.anchorMessageId && replies.has(topic.anchorMessageId)),
    );
  }

  /** 给模型的参与锚点：只给还活着的，最多 maxTopics。 */
  anchors(key: string, excludedMessageIds: ReadonlySet<string> = new Set()): GroupTopicAnchor[] {
    const now = this.now();
    return this.state(key).topics
      .filter((topic) => now < topic.expiresAt && !excludedMessageIds.has(topic.anchorMessageId))
      .sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt)
      .slice(0, this.maxTopics)
      .map((topic) => ({ id: topic.anchorMessageId, label: this.labelOf(key, topic.anchorMessageId) }));
  }

  /**
   * 回复发送成功后登记参与。
   *
   * direct（被 @）用触发消息当锚点；水群用这一轮第一条。更新的是「参与者有交集」的
   * 旧话题，而不是「同一个邀请者」—— 同一个人可以同时聊几件事。
   */
  recordReply(
    key: string,
    facts: readonly GroupMessageFacts[],
    options: { source: "mention" | "ambient"; anchorMessageId?: string },
  ): void {
    if (!facts.length) return;
    const anchor = options.anchorMessageId
      || (options.source === "mention"
        ? facts.find((fact) => fact.mentionTargets.includes("self"))?.messageId
        : facts[0]!.messageId)
      || facts[0]!.messageId;
    const participants = [...new Set(facts.map((fact) => this.memberCode(key, fact.senderQq)))];
    const now = this.now();
    const state = this.state(key);
    const existing = state.topics.find((topic) =>
      now < topic.expiresAt && topic.participants.some((member) => participants.includes(member)),
    );
    if (existing) {
      existing.lastEvidenceAt = now;
      existing.expiresAt = this.expiry(existing, now);
      existing.participants = [...new Set([...existing.participants, ...participants])];
      return;
    }
    state.topics.push({
      anchorMessageId: anchor,
      participants,
      triggerMessageId: facts[0]!.messageId,
      lastEvidenceAt: now,
      createdAt: now,
      expiresAt: Math.min(now + this.topicTtlMs, now + this.topicMaxLifeMs),
      source: options.source,
    });
    this.pruneTopics(state);
  }

  /**
   * 模型判了「这还是在跟我聊」但选择沉默时，允许有界地续一下已有话题。
   * 只续已存在的锚点，不新建；返回是否真的续了。
   */
  refreshFromDecision(key: string, decision: GroupDecision | null): boolean {
    if (!decision) return false;
    if (decision.relation !== "followup" && decision.relation !== "shared_topic") return false;
    const anchorId = decision.topicAnchorMessageId;
    if (!anchorId) return false;
    const now = this.now();
    const topic = this.state(key).topics.find(
      (item) => item.anchorMessageId === anchorId && now < item.expiresAt,
    );
    if (!topic) return false;
    topic.lastEvidenceAt = now;
    topic.expiresAt = this.expiry(topic, now);
    return true;
  }

  /** 测试用：直接数还活着的话题。 */
  activeTopicCount(key: string): number {
    const now = this.now();
    return this.state(key).topics.filter((topic) => now < topic.expiresAt).length;
  }

  clear(key: string): void {
    this.states.delete(key);
  }

  private state(key: string): ConversationState {
    let state = this.states.get(key);
    if (!state) {
      state = { messages: [], topics: [], memberCodes: new Map(), nextMember: 0, owners: new Map(), lastOtherMention: new Map() };
      this.states.set(key, state);
    }
    return state;
  }

  private expiry(topic: Topic, now: number): number {
    return Math.min(now + this.topicTtlMs, topic.createdAt + this.topicMaxLifeMs);
  }

  private prune(state: ConversationState): void {
    const now = this.now();
    // 语境助手需要更早的教学/引用前因；普通 background() 仍按默认 5 分钟/40 条裁剪。
    state.messages = state.messages.filter((message) => now - message.at <= Math.max(this.windowMs, 15 * 60_000));
    const retained = Math.max(this.maxMessages, 120);
    if (state.messages.length > retained) {
      state.messages.splice(0, state.messages.length - retained);
    }
  }

  private pruneTopics(state: ConversationState): void {
    const now = this.now();
    state.topics = state.topics.filter((topic) => now < topic.expiresAt);
    if (state.topics.length <= this.maxTopics) return;
    state.topics.sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt);
    state.topics.splice(this.maxTopics);
  }

  private labelOf(key: string, messageId: string): string {
    const message = this.state(key).messages.find((item) => item.messageId === messageId);
    if (!message) return "";
    const text = this.truncate(this.formatText(key, message.text));
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }

  private truncate(text: string): string {
    return text.length > this.maxTextPerMessage ? `${text.slice(0, this.maxTextPerMessage)}…` : text;
  }
}

/**
 * 从群名片里读「属于谁」。
 *
 * 这个群的 bot 起名高度规律：`小明的小鱼`、`小鱼儿（主人：小蓝）`、`小红的宝宝`。
 * 两种写法都认，但都只是**弱线索** —— 名字里带「X的」也可能只是随口起的。
 * 硬证据是自述（`learnOwnership`），两者冲突时以自述为准。
 *
 * 「X的Y」只认第一个「的」，且 X 不超过 16 字：再长就多半是句子不是名字了。
 */
export function parseDisplayNameOwner(displayName: string): string {
  const name = displayName.trim();
  if (!name) return "";
  const tagged = name.match(/[（(]\s*主人\s*[：:]\s*([^）)]+)[）)]/u);
  if (tagged?.[1]) return tagged[1].trim().slice(0, 40);
  const possessive = name.match(/^([^的]{1,16})的.+$/u);
  if (possessive?.[1]) return possessive[1].trim();
  return "";
}

export function createGroupContext(options?: GroupContextOptions): GroupContext {
  return new GroupContext(options);
}
