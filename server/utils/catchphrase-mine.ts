import { buildChatCompletionsEndpoint, resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { readModelUsage, recordModelUsage, type ModelUsageTokens } from "./model-usage";
import { CATCHPHRASE_STATUS, invalidateCatchphraseCache } from "./catchphrases";
import { getPrisma } from "./prisma";
import { looksLikeSystemMessage } from "./system-message";

/**
 * 从群聊里「捡梗」：她注意到群里反复在用的某句话，候选交给用户点头后才算她的口头禅。
 *
 * ## 为什么不是「让模型读群消息，判断哪些是梗」
 *
 * 梗的第一特征是**反复出现**，不是语义巧妙。这个判断靠数数，代码比模型准得多，
 * 而且便宜：先按频次筛出候选，模型只负责最后一步「这句能不能脱离语境单独说、什么时候说」。
 * 反过来让模型通读聊天记录找梗，它会把每句俏皮话都当梗，而且 token 烧得没边。
 *
 * 所以流程是固定的两段：
 *   ① `extractPhraseCandidates`（纯函数，可测）—— 清洗、归一化、数频次、砍噪音；
 *   ② `judgeCandidates`（一次模型调用）—— 候选通常个位数，批量判完。
 *
 * ## 边界
 *
 * - **只扫群聊**（`externalConversationId` 形如 `g:<群号>`）。私聊里的话是两个人之间的，
 *   收进「她会说的梗」等于把私房话拿到别处去说。
 * - **一个人反复说同一句不算**（默认要求 ≥2 个不同的人说过）：那是个人口癖或刷屏。
 * - 捡回来一律 `PENDING`，冒用群里的话说错一次很难收回 —— 见 `catchphrases.ts` 的 status 注释。
 * - 整条链路失败都静默（除了配置缺失）：扫梗是锦上添花，不该让群聊回复或页面挂掉。
 */

export type PhraseCandidate = {
  /** 清洗后、去标点的归一化文本，落库时用它去重。 */
  key: string;
  /** 展示用的原话（取出现次数最多的那个形态）。 */
  phrase: string;
  /** 窗口内出现几次。 */
  count: number;
  /** 几个人说过。 */
  speakers: number;
  /** 原话样本，最多 3 条，给弹窗和模型看语境。 */
  samples: string[];
};

export type CleanMessage = { content: string; speaker?: string };

/** 默认窗口：两周。再长就是「这个月的梗」，收进来也过时了。 */
export const MINE_WINDOW_DAYS = 14;
/** 一次最多读多少条消息。群聊再热，两周三千条也覆盖得住。 */
export const MINE_MAX_MESSAGES = 3000;
/** 至少出现几次才算「反复」。 */
export const MINE_MIN_COUNT = 3;
/** 至少几个人说过。一个人刷同一句不算群体梗。 */
export const MINE_MIN_SPEAKERS = 2;
/** 一次最多送多少条给模型判。候选再多也按频次取前几条。 */
export const MINE_MAX_CANDIDATES = 8;

/**
 * 去标点归一化：`不烧心吗？` 和 `不烧心吗` 要算同一句。
 *
 * 只用于**统计与去重**，落库和展示都用原话 —— 用户要的是她那句话的样子，
 * 不是被我们规整过的版本。
 */
const PUNCTUATION = /[\s\u3000，。！？、；：""''「」『』（）〔〕【】《》〈〉…—～·~!?,.;:'"(){}[\]\-_/\\|*&^%$#@+=`]/g;

export function normalizePhraseKey(text: string): string {
  return text.replace(PUNCTUATION, "").toLowerCase();
}

/**
 * 清洗一条群消息：去掉段标记、链接、@ 记号。
 *
 * `[图片]` / `[图片：一只猫]` / `@self` 这些是渠道拼进去的，不是人打的字；
 * 带着它们数频次，`[图片]` 会立刻成为群里「最高频的梗」。
 */
export function cleanMessageForMining(raw: string): string {
  return (raw ?? "")
    .replace(/\[[^\]]{0,60}\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@(?:self|member_\d+)/g, " ")
    .replace(/^@[^\s]{1,20}[\s\u3000]+/u, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/** 明确没有信息量、收进来只会让她像个复读机的说法（按归一化后的 key 比）。 */
const NOISE_KEYS = new Set([
  "收到", "好的", "好滴", "好嘞", "行吧", "在吗", "有人在吗", "有人吗",
  "怎么了", "为什么", "什么情况", "确实", "真实", "正确的", "笑死", "笑死我了",
  "绷不住", "辛苦了", "加油", "晚安", "早安", "早上好", "晚上好", "谢谢", "感谢",
  "打卡", "摸鱼", "上班", "下班", "吃了吗", "睡觉了", "我先走了", "有人打游戏吗",
]);

/**
 * 系统播报判定已抽到 `server/utils/system-message.ts`：落库侧和提示词侧共用一份判据。
 * 这里转出一次，保持捡梗原有调用点和测试的 import 路径不变。
 */
export { looksLikeSystemMessage };

/**
 * 这句值不值得进候选池。
 *
 * 阈值都偏低是有意的：**这一层只负责砍「明显不是话」的东西**，判断「像不像梗」
 * 交给后面的模型。这里砍太狠，真梗（四五个字的短句）会被误杀。
 */
export function isPhraseWorthConsidering(key: string): boolean {
  // 四字以下基本是「收到」「在吗」「哈哈哈」这类；用户举的例子「不烧心吗」正好四字，所以是 <4。
  if (key.length < 4) return false;
  if (key.length > 60) return false;
  // 全同一个字：哈哈哈哈 / 好好好好
  if (/^(.)\1+$/.test(key)) return false;
  // 纯语气词
  if (/^(哈|呵|嘿|嘻|呜呜|草|艹|啊|嗯|哦|噢|额|艹了)+$/.test(key)) return false;
  // 既没有汉字也没有字母数字 = 纯 emoji / 纯符号
  if (!/[\p{L}\p{N}]/u.test(key)) return false;
  if (NOISE_KEYS.has(key)) return false;
  return true;
}

/**
 * 从一批群消息里数出候选短语。
 *
 * 只做整句级别的重复统计，不做 n-gram 拆分：群里的复读梗几乎总是整句复用
 * （「xxx 不烧心吗」原样再发一遍），拆成 n-gram 反而会把半句话捞上来，
 * 拼出来的「台词」根本没人说过。
 */
export function extractPhraseCandidates(
  messages: readonly CleanMessage[],
  options: {
    minCount?: number;
    minSpeakers?: number;
    maxCandidates?: number;
  } = {},
): PhraseCandidate[] {
  const minCount = options.minCount ?? MINE_MIN_COUNT;
  const minSpeakers = options.minSpeakers ?? MINE_MIN_SPEAKERS;
  const maxCandidates = options.maxCandidates ?? MINE_MAX_CANDIDATES;

  type Bucket = { variants: Map<string, number>; count: number; speakers: Set<string>; samples: string[] };
  const buckets = new Map<string, Bucket>();

  for (const message of messages) {
    const cleaned = cleanMessageForMining(message.content);
    if (!cleaned) continue;
    // 系统播报先挡掉，再谈别的 —— 它的频次往往比真梗还高。
    if (looksLikeSystemMessage(cleaned)) continue;
    const key = normalizePhraseKey(cleaned);
    if (!isPhraseWorthConsidering(key)) continue;

    const bucket: Bucket = buckets.get(key)
      ?? { variants: new Map<string, number>(), count: 0, speakers: new Set<string>(), samples: [] };
    bucket.count += 1;
    bucket.variants.set(cleaned, (bucket.variants.get(cleaned) ?? 0) + 1);
    if (message.speaker) bucket.speakers.add(message.speaker);
    if (bucket.samples.length < 3 && !bucket.samples.includes(cleaned)) bucket.samples.push(cleaned);
    buckets.set(key, bucket);
  }

  const candidates: PhraseCandidate[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.count < minCount) continue;
    if (bucket.speakers.size < minSpeakers) continue;
    // 展示用出现最多的那个写法；次数相同就取先出现的（Map 保序），结果稳定可测。
    let phrase = "";
    let best = -1;
    for (const [variant, times] of bucket.variants) {
      if (times > best) {
        best = times;
        phrase = variant;
      }
    }
    candidates.push({
      key,
      phrase,
      count: bucket.count,
      speakers: bucket.speakers.size,
      samples: bucket.samples,
    });
  }

  // 频次优先，同频次按人数，再按 key 排 —— 完全确定的顺序，测试才断言得住。
  return candidates
    .sort((a, b) => b.count - a.count || b.speakers - a.speakers || a.key.localeCompare(b.key))
    .slice(0, maxCandidates);
}

const MINE_SYSTEM_PROMPT = [
  "YILING_CATCHPHRASE_MINING_V1",
  "你在帮一个角色从群聊里挑「她会说的口头禅」。下面每一条都是最近群里反复出现的原话（附出现次数、几个人说过、以及原话片段）。",
  "群友之间反复用同一句话，通常就是圈内梗 —— 但也不是全都值得收。逐条判断：",
  "  1. 能不能脱离当时那件具体的事，单独当一句口头禅说出来？只能针对某件事成立的（比如「昨晚那个视频太离谱了」）不算。",
  "  2. 是不是只对特定人、特定身份成立？带人名、带称呼的不算。",
  "  3. 有没有冒犯性、人身攻击、隐私内容、或者别人的私事？有就一律不要。",
  "  4. 纯问候、纯应答、纯情绪词（收到、好的、笑死）不算 —— 它们本来就在噪声名单里，漏进来也请挡掉。",
  "对通过的每一条：phrase 填**原话**（可以顺手去掉明显的错别字和多余标点，但不要改写成你自己的说法，用户要的就是那句话的样子）；usage 用一句话写「什么时候说」，描述触发场景，不要复述台词本身。",
  "usage 写不出来就不要收 —— 没有它，角色挑不准时机，收进去等于让她乱说。",
  'Return only a valid JSON object: { "items": [ { "index": 0, "keep": true, "phrase": "...", "usage": "..." } ] }. 不在列表里的 index 不要出现；keep 为 false 时 phrase/usage 可以省略。',
].join("\n");

type JudgedCandidate = { phrase: string; usage: string; candidate: PhraseCandidate };

/**
 * 送模型判一遍。
 *
 * 一次调用判全部候选，不合批就是不划算：候选只有个位数，
 * 每次调用固定开销（系统提示词）比候选本身还贵。
 */
async function judgeCandidates(
  candidates: readonly PhraseCandidate[],
  config: { model: string; apiBaseUrl: string },
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ judged: JudgedCandidate[]; usage: ModelUsageTokens | null }> {
  if (!candidates.length) return { judged: [], usage: null };
  const endpoint = buildChatCompletionsEndpoint(config.apiBaseUrl);
  const payload = {
    candidates: candidates.map((candidate, index) => ({
      index,
      phrase: candidate.phrase,
      count: candidate.count,
      speakers: candidate.speakers,
      // 两条就够看出语境，给多了只是重复烧 token。
      samples: candidate.samples.slice(0, 2),
    })),
  };

  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      // 判定要稳，不要创意：同一个群同一批消息扫两遍，结果应该差不多。
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MINE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const usage = readModelUsage(body);
  if (!response.ok) throw new Error("模型服务返回 HTTP " + response.status);

  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof first?.message?.content === "string" ? first.message.content : "";
  const parsed = parseJsonObject(text);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];

  const judged: JudgedCandidate[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : -1;
    const candidate = Number.isInteger(index) ? candidates[index] : undefined;
    // index 越界或重复出现都丢掉：只认这一批候选里的那几条，且每条只判一次。
    if (!candidate || seen.has(index)) continue;
    seen.add(index);
    if (record.keep !== true) continue;
    const phrase = typeof record.phrase === "string" ? record.phrase.trim() : "";
    const usageText = typeof record.usage === "string" ? record.usage.trim() : "";
    // 没给 usage 就不收：她挑不准时机，收进去只会乱说（同「起不出名字的表情包不收」）。
    if (!phrase || !usageText) continue;
    judged.push({ phrase: phrase.slice(0, 200), usage: usageText.slice(0, 300), candidate });
  }
  return { judged, usage };
}

/** 模型有时会用 ```json 包一层，或者前面先写一句废话。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** 从消息 metadata 里取「这是谁说的」。取不到就没法判断「是不是同一个人的口癖」。 */
function readSpeakerKey(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  // authorOpenId 最稳（平台账号级）；member 是群内代号，老数据可能只有昵称。
  for (const field of ["authorOpenId", "member", "authorDisplayName"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export type MineResult = {
  /** 读了多少条群消息。 */
  scanned: number;
  /** 数出多少条反复出现的候选。 */
  candidates: number;
  /** 入库多少条待确认。 */
  created: number;
  /** 因为已经在库里（含被否掉的）跳过了几条。 */
  skipped: number;
};

/**
 * 扫最近两周的群聊，捡回待确认的梗。
 *
 * 配置缺失（没配模型）会抛错 —— 这和「扫到一半失败」不同：用户点了按钮却什么都没发生，
 * 比看到一句「还没配模型」更糟。
 */
export async function mineCatchphrases(input: {
  characterId: string;
  windowDays?: number;
  maxMessages?: number;
  minCount?: number;
  minSpeakers?: number;
  maxCandidates?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<MineResult> {
  const prisma = getPrisma();
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw new Error("角色不存在。");

  const settings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
  if (!apiKey || !settings.model) {
    throw new Error("还没配置模型。请在「模型参数」里填好 API Key 和模型名称，再试试扫梗。");
  }

  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? MINE_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // 只认群会话：externalConversationId = `g:<群号>`。私聊的话不该被搬到别处去说。
  const conversations = await prisma.conversation.findMany({
    where: { characterId: character.id, externalConversationId: { startsWith: "g:" } },
    select: { id: true, externalConversationId: true },
    take: 30,
  });
  if (!conversations.length) {
    return { scanned: 0, candidates: 0, created: 0, skipped: 0 };
  }
  const groupLabelByConversation = new Map(
    conversations.map((item) => [item.id, item.externalConversationId?.replace(/^g:/, "QQ群 ") ?? "群聊"]),
  );

  const messages = await prisma.message.findMany({
    where: {
      conversationId: { in: conversations.map((item) => item.id) },
      role: "USER",
      occurredAt: { gte: since },
    },
    orderBy: { occurredAt: "desc" },
    take: input.maxMessages ?? MINE_MAX_MESSAGES,
    select: { content: true, occurredAt: true, conversationId: true, metadata: true },
  });
  if (!messages.length) {
    return { scanned: 0, candidates: 0, created: 0, skipped: 0 };
  }

  /**
   * 「至少两个人说过」靠 `metadata.authorOpenId` 判断。老数据可能没存发言人，
   * 这时候只能退回「频次够就算」—— 否则一条候选都过不了，功能看起来像坏的。
   * 有发言人信息的比例太低时，说明这批数据本来就答不了「谁说的」这个问题。
   */
  const cleanedMessages = messages.map((message) => {
    const speaker = readSpeakerKey(message.metadata);
    return { content: message.content, ...(speaker ? { speaker } : {}) };
  });
  const speakerKnown = cleanedMessages.filter((message) => message.speaker).length;
  const defaultMinSpeakers = speakerKnown * 2 >= cleanedMessages.length ? MINE_MIN_SPEAKERS : 1;

  const candidates = extractPhraseCandidates(cleanedMessages, {
    ...(input.minCount === undefined ? {} : { minCount: input.minCount }),
    minSpeakers: input.minSpeakers ?? defaultMinSpeakers,
    ...(input.maxCandidates === undefined ? {} : { maxCandidates: input.maxCandidates }),
  });
  if (!candidates.length) {
    return { scanned: messages.length, candidates: 0, created: 0, skipped: 0 };
  }

  /**
   * 已经在库里的一律跳过 —— **包括被用户否掉的（REJECTED）**。
   * 否掉的如果下次又被捡回来，用户就永远否不掉它，弹窗也会一直重弹。
   *
   * 比对用归一化后的 key，不按 phrase 精确匹配：库里存的可能是「不烧心吗？」，
   * 候选是「不烧心吗」，精确匹配会把它当成新的再收一遍。
   */
  const existing = await prisma.characterCatchphrase.findMany({
    where: { characterId: character.id },
    select: { phrase: true },
  });
  const existingKeys = new Set(existing.map((row) => normalizePhraseKey(row.phrase)));
  const fresh = candidates.filter((candidate) => !existingKeys.has(candidate.key));

  const result: MineResult = {
    scanned: messages.length,
    candidates: candidates.length,
    created: 0,
    skipped: candidates.length - fresh.length,
  };
  if (!fresh.length) return result;

  const { judged, usage } = await judgeCandidates(fresh, settings, apiKey, input.fetchImpl ?? fetch);
  if (usage) {
    await recordModelUsage({
      kind: "catchphrase-mine",
      model: settings.model,
      usage,
      characterId: character.id,
    }).catch(() => undefined);
  }
  if (!judged.length) return result;

  // 反查证据用：每条候选只需要一条原话，用来定位它是哪个群说的。
  const firstMessageByKey = new Map<string, typeof messages[number]>();
  for (const message of messages) {
    const key = normalizePhraseKey(cleanMessageForMining(message.content));
    if (!firstMessageByKey.has(key)) firstMessageByKey.set(key, message);
  }

  // 证据：弹窗上要能回答「她凭什么觉得这是梗」，只给台词是答不上的。
  for (const item of judged) {
    const source = item.candidate;
    const matched = firstMessageByKey.get(source.key);
    const evidence = {
      ...(matched ? { groupLabel: groupLabelByConversation.get(matched.conversationId) ?? "" } : {}),
      count: source.count,
      speakers: source.speakers,
      samples: source.samples.slice(0, 3),
    };
    try {
      await prisma.characterCatchphrase.create({
        data: {
          characterId: character.id,
          phrase: item.phrase,
          usage: item.usage,
          status: CATCHPHRASE_STATUS.pending,
          // 捡回来先 enabled=true，靠 status 挡住进候选池；
          // 用户点「入库」只改 status，不用再点一次开关。
          enabled: true,
          source: "collected",
          evidence,
        },
      });
      result.created += 1;
    } catch {
      // 唯一约束 / 并发：这一条没进去就算了，不要因为一条影响整批。
    }
  }
  invalidateCatchphraseCache(character.id);
  return result;
}

/** 角色的「自动捡梗」开关。默认关 —— 会在用户不知情时花 token，得他自己打开。 */
export function isCatchphraseAutoMineEnabled(modelConfig: unknown): boolean {
  const record = modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)
    ? modelConfig as Record<string, unknown>
    : {};
  return record.catchphraseAutoMine === true;
}

/**
 * 自动捡梗的节流：同一个角色 6 小时最多扫一次。
 *
 * 内存记一份就够：进程重启后最多多扫一次，代价是一次模型调用；
 * 为它建一张表反而不值。
 */
const AUTO_MINE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const lastAutoMineAt = new Map<string, number>();

/**
 * 在群聊回复发完之后顺手扫一次（不 await、不阻塞）。
 *
 * 只做节流和开关判断，真正的活交给 `mineCatchphrases`。失败全静默：
 * 这是锦上添花，不能让一轮群聊因为扫梗失败而报错。
 */
export function maybeAutoMineCatchphrases(modelConfig: unknown, characterId: string): void {
  if (!isCatchphraseAutoMineEnabled(modelConfig)) return;
  const last = lastAutoMineAt.get(characterId) ?? 0;
  if (Date.now() - last < AUTO_MINE_INTERVAL_MS) return;
  lastAutoMineAt.set(characterId, Date.now());
  void mineCatchphrases({ characterId }).catch(() => undefined);
}
