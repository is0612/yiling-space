/**
 * B站值班流水线（脚本化）—— 从 bili-desk 的 agent.py run_round 迁移而来。
 *
 * 采用"方案 B（脚本化）"：把"刷一轮"拆成固定步骤，只在「粗筛」「终判」「写评论」时
 * 调用 yiling-space 的模型，其余步骤直接调 bili CLI。
 *
 * 一轮的步骤（对齐 docs/bili-desk-integration.md 第 5.1 节）：
 *   1. 读判重表（7 天内看过的不再挑）+ 今日额度
 *   2. 找候选：feed recommend / hot rank / search video
 *   3. 粗筛：把候选的标题/简介/推荐理由/播放量交给模型挑出值得细看的
 *   4. 看懂：对粗筛入选的逐条 `bili video watch`（信息+AI总结+字幕+热评）
 *   5. 终判：结合看懂的正文判断值不值得占主人的注意力
 *   6. 投递：私信（默认 `dm send owner`，值班设置里可换成指定 UID）/ 公开评论（comment post --at）
 *   7. 收尾：报告 / 判重 / 人格札记写库
 *
 * ⚠️ 所有写操作（私信/评论）都检查 CLI 的 `ok` 字段与 error.code：
 *   risk_control / captcha_required / auth_expired 立即停手并写进报告，不重试、不绕过。
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrisma } from "../../prisma";
import { runBili, type BiliRunResult } from "./runner";
import { buildDutyPrompt, type BiliDutyRoundSettings } from "./duty-prompt";
import { callBiliModel } from "./llm";
import { runOwnerWatch, type OwnerWatchOutcome } from "./owner-watch";
import { recordModelUsage, readDailyQuota, type ModelUsageTokens } from "../../model-usage";
import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import { parseJsonLoose } from "../../loose-json";
import type { BiliConnectionRecord, BiliDutyConfig } from "./configure";
import { biliOptions } from "./configure";
import { acquireBiliDutyLease } from "./bili-duty-lease";
import {
  completeBiliDutyWindowRun,
  failBiliDutyWindowRun,
  startBiliDutyWindowRun,
  type BiliScheduledWindow,
} from "./bili-duty-window-run";
import { remainingQuota, toDayKey } from "./duty-scheduler";
import {
  extractBvids,
  formatCardForModel,
  formatWatchedForModel,
  isFatalBiliError,
  isRateLimited,
  parseScore,
  parseVerdict,
  parseVideoCards,
  parseBiliOwner,
  parseWatchedVideo,
  readBiliError,
  sanitizePublicText,
  unwrapBiliData,
  type BiliVideoCard,
  type BiliWatchedVideo,
} from "./cards";

export type BiliDutyRoundResult = {
  ok: boolean;
  reportId?: string;
  /** 最终挑中的条数。 */
  picked: number;
  /** 判为跳过（含看懂后放弃）的条数。 */
  skipped: number;
  /** 实际调用 `video watch` 看懂的条数。 */
  watched: number;
  seenVideos: number;
  /** 投递结果。 */
  delivered: { dm: boolean; comments: number; fav: number; dynamic: boolean };
  /** 本轮挑中并给出评价的视频（给群回执/接口展示用，最多不超过额度）。 */
  pickedItems: Array<{
    bvid: string;
    title: string;
    url: string;
    score: number | null;
    reason: string;
    comment: string;
  }>;
  /**
   * 主人内容互动的结果（`owner-watch.ts`）。
   * 没开 `duty.ownerWatch` 时是 undefined —— 和「开了但本轮没新投稿」区分开。
   */
  owner?: OwnerWatchOutcome;
  error?: string;
  /** 过程中值得记一笔的事（风控、限流、命令失败等）。 */
  notes: string[];
};

/** 最多攒多少条候选。 */
const MAX_CANDIDATES = 25;
/**
 * 「主人优先」时一轮最多强制看她主人几条。
 *
 * 不设上限的话，主人连发六条就会把这一轮全占了，她刷到的世界只剩一个人 ——
 * 那是关注，不是刷 B站。2 条足够体现「优先」，又留了位置给推荐流。
 */
const OWNER_PICK_MAX = 2;
/**
 * 「主人优先」只看最近多少天内发的投稿。
 *
 * 不设窗口的话，主人一年没更新时，`user videos --size 6` 会把一年前的六条全拉进来 ——
 * 她这轮就在「优先看」一堆去年的东西，看着很像 bug。窗口外一条都没有时退回最近 3 条：
 * 总比什么都不看好，但至少不会把两年前的视频当成今天的候选。
 */
const OWNER_FRESH_DAYS = 30;
/** 一轮最多「看懂」几条 —— watch 会拉字幕甚至触发语音转写，是这里最贵的操作。 */
const MAX_WATCH_PER_ROUND = 5;
/** watch 单条的超时：可能要等语音转写。 */
const WATCH_TIMEOUT_MS = 10 * 60 * 1000;
/** 私信正文上限（CLI 硬限制 500 字，留余量）。 */
const DM_MAX_CHARS = 480;
/** 评论文本上限（CLI 没有硬限，但像真人随口说一句）。 */
const COMMENT_MAX_CHARS = 120;

/**
 * 普通值班流评论是公开内容：必须在最终长度截断前复用公开脱敏闸。
 * 与动态、主人投稿评论走同一个规则；脱敏后为空时调用方不得执行 CLI 写操作。
 */
export function preparePublicComment(text: string): string {
  return sanitizePublicText(text).slice(0, COMMENT_MAX_CHARS);
}
/**
 * 收藏每天最多几条。CLI 只限了 5 秒/次、60 次/小时，管不住「一天收三十个视频」——
 * 收藏是「我想留着」，收了三十个等于没收藏。
 */
const FAV_PER_DAY = 2;
/** 收藏理由的最短长度。抄 surfcore 的判据：短理由说明她也没想清楚为什么要留着。 */
const FAV_MIN_REASON = 6;
/** 每天最多发一条动态。 */
const DYNAMIC_PER_DAY = 1;
/** 两条动态之间至少隔多久。跟 surfcore 的 `dynamics.gapMin` 同量级。 */
const DYNAMIC_GAP_MS = 30 * 60 * 1000;
/** 动态正文字数上限（含链接）。 */
const DYNAMIC_MAX_CHARS = 200;

type CandidateSource = "feed" | "hot" | "search" | "owner";

type Candidate = BiliVideoCard & { source: CandidateSource };

type PickedVideo = {
  candidate: Candidate;
  watched: BiliWatchedVideo | null;
  /** 模型给的一句话理由。 */
  reason: string;
  /** 模型写的公开评论（可能为空）。 */
  comment: string;
  /** 终判给的分（0-20）；null = 模型没给，别当成 0。 */
  score: number | null;
};

/** 跳过的候选也要带理由 —— 口味里规定了「跳过理由写两个字」时，这里就是它落地的地方。 */
type SkippedVideo = { candidate: Candidate; reason: string; score: number | null };

/** 把一段文本写进临时文件，交给 bili 的 `--file`（避免命令行被引号/换行切碎）。 */
async function withTempText<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `yiling-bili-${randomUUID()}.txt`);
  await writeFile(path, text, "utf8");
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/** 执行一条 bili 命令并把错误收进 notes；返回解析后的 data。 */
function readCommandData(result: BiliRunResult, label: string, notes: string[]): unknown | null {
  const error = readBiliError(result.json);
  if (error) {
    notes.push(`${label} 失败：${error.code}${error.message ? `（${error.message}）` : ""}`);
    return null;
  }
  if (result.timedOut) {
    notes.push(`${label} 超时（${Math.round(result.elapsed)} 秒）`);
    return null;
  }
  if (result.code !== 0 || result.json === null) {
    notes.push(`${label} 未返回 JSON（退出码 ${result.code}${result.stderr ? `：${result.stderr.slice(0, 120)}` : ""}）`);
    return null;
  }
  return unwrapBiliData(result.json);
}

/** 从模型回复里取「标签：内容」这一行。 */
function readLabeledLine(text: string, label: string): string {
  const match = text.match(new RegExp(`${label}\\s*[：:]\\s*(.+)`));
  if (!match) return "";
  const value = (match[1] ?? "").trim();
  return value === "无" || value === "没有" || value === "-" ? "" : value;
}

/** 读 bili CLI 里记的主人 UID（没有就返回空串，不造空壳）。 */
async function readOwnerMid(record: BiliConnectionRecord, notes: string[]): Promise<string> {
  const result = await runBili(["owner", "show"], biliOptions(record));
  const error = readBiliError(result.json);
  if (error) {
    notes.push(`读主人失败：${error.code}${error.message ? `（${error.message}）` : ""}`);
    return "";
  }
  return parseBiliOwner(result.json)?.mid ?? "";
}

/**
 * 把「主人优先」的投稿补进粗筛结果，排在前面。
 *
 * 这是整条链路里唯一「模型说别看、代码偏要看」的地方，所以单独抽出来钉测试。
 * 两条规则：
 *   1. 主人的投稿一定在里面，不管模型有没有留（`OWNER_PICK_MAX` 封顶）；
 *   2. 补进来的不能被 `watchLimit` 挤掉 —— 否则额度紧的那一轮，「优先」就失效了。
 */
export function mergeOwnerFirst(ownerBvids: string[], modelPicked: string[], watchLimit: number): string[] {
  const owners = ownerBvids.slice(0, OWNER_PICK_MAX);
  const merged = [...new Set([...owners, ...modelPicked.filter((bvid) => !owners.includes(bvid))])];
  return merged.slice(0, Math.max(watchLimit, owners.length));
}

/**
 * 从主人的投稿列表里挑出这轮「优先看」的。
 *
 * 规则见 `OWNER_FRESH_DAYS`：先按窗口筛，窗口内一条都没有时退回最近 3 条。
 * 解析不出 `pubdate` 的一律保留 —— 宁可多看一条，也别因为接口字段变了把主人的视频全滤掉。
 * 导出是为了钉测试：这是唯一会因为「日期格式变了」而静默清空整条路径的地方。
 */
export function pickOwnerCandidates<T extends { pubdate: string }>(
  cards: T[],
  now = Date.now(),
): { picked: T[]; fellBack: boolean } {
  const since = now - OWNER_FRESH_DAYS * 24 * 60 * 60 * 1000;
  const recent = cards.filter((card) => {
    const published = card.pubdate ? Date.parse(card.pubdate) : Number.NaN;
    return Number.isNaN(published) || published >= since;
  });
  if (recent.length > 0) return { picked: recent, fellBack: false };
  return { picked: cards.slice(0, 3), fellBack: cards.length > 0 };
}

/**
 * 找候选：主人投稿（可选）+ 推荐流 + 分区热榜 + 关键词搜索。
 * 按 bvid 去重；已看过（7 天内）的不再进来。
 *
 * 主人的投稿**先 push**，所以它永远排在候选列表最前面 —— 粗筛阶段模型按顺序读，
 * 靠前的更容易被留下；再加 `mergeOwnerFirst` 的硬保证，不指望模型听话。
 */
async function collectCandidates(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  seenBvids: Set<string>,
  notes: string[],
  ownerMid = "",
  ownerDiag: string[] = [],
): Promise<Candidate[]> {
  const options = biliOptions(record);
  const candidates: Candidate[] = [];
  const used = new Set<string>();

  const push = (cards: BiliVideoCard[], source: CandidateSource) => {
    for (const card of cards) {
      if (candidates.length >= MAX_CANDIDATES) return;
      if (seenBvids.has(card.bvid) || used.has(card.bvid)) continue;
      used.add(card.bvid);
      candidates.push({ ...card, source });
    }
  };

  // 主人优先：主人的投稿压在候选队首。
  // 时间窗见 `pickOwnerCandidates`（最近 30 天，一条都没有时退回最近 3 条）——
  // 不设窗口的话，主人一年没更新时会把去年的六条当成「这轮刷到的」，看着很像 bug。
  // 「7 天内看过的不再进来」由 seenBvids 管，两层窗口各管各的。
  if (config.ownerFirst && ownerMid) {
    const ownerVideos = await runBili(
      ["user", "videos", ownerMid, "--order", "new", "--size", "6"],
      options,
    );
    const ownerData = readCommandData(ownerVideos, "拉主人的投稿", notes);
    if (ownerData) {
      const { picked: cards, fellBack } = pickOwnerCandidates(parseVideoCards(ownerData));
      if (fellBack) {
        notes.push(`主人优先：最近 ${OWNER_FRESH_DAYS} 天没有新投稿，退回最近 3 条。`);
      }

      const before = candidates.length;
      push(cards, "owner");
      const added = candidates.length - before;
      // 诊断单独记一份：brief 档日报不写 notes，出了「怎么没刷到我的视频」这种问题，
      // 用户只能看到「什么都没发生」，没有任何线索。
      ownerDiag.push(
        added > 0
          ? `主人的投稿进了 ${added} 条候选（最近 ${OWNER_FRESH_DAYS} 天）`
          : `主人最近的投稿这 7 天里都看过了，这轮不重复看`,
      );
    } else {
      ownerDiag.push("拉主人的投稿失败（原因见过程记录）");
    }
  } else if (config.ownerFirst) {
    ownerDiag.push("读不到主人 UID，这轮没按优先处理");
  }

  const feed = await runBili(["feed", "recommend", "--unseen", "-n", "12"], options);
  const feedData = readCommandData(feed, "feed recommend", notes);
  if (feedData) push(parseVideoCards(feedData), "feed");

  // 排行榜是最稳的来源：不依赖这个账号的推荐画像，每天都有新东西。
  const hot = await runBili(["hot", "rank", "--zone", config.zone || "all", "--limit", "15", "--unseen"], options);
  const hotData = readCommandData(hot, "hot rank", notes);
  if (hotData) push(parseVideoCards(hotData), "hot");

  if (config.keywords.length > 0 && candidates.length < MAX_CANDIDATES) {
    for (const keyword of config.keywords.slice(0, 3)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      // --order 的合法值只有 default/views/new/danmaku/favorites/comments。
      // 老实现传的是 pubdate（不存在），CLI 直接抛 invalid_argument，整条搜索路径全废。
      const searchResult = await runBili(["search", "video", keyword, "--order", "new", "--size", "10"], options);
      const searchData = readCommandData(searchResult, `search "${keyword}"`, notes);
      if (searchData) push(parseVideoCards(searchData), "search");
    }
  }

  return candidates;
}

/** 粗筛与终判分开记账：一个按候选条数、一个按入选视频条数，单价差一倍以上。 */
type BiliUsageKind = "bili-screening" | "bili-judge";

/** 粗筛：把候选列表交给模型，让它挑出值得细看的（返回 bvid 数组）。 */
async function shortlistCandidates(
  candidates: Candidate[],
  limit: number,
  model: {
    characterPrompt: string;
    model: string;
    apiKey: string;
    apiBaseUrl?: string;
    memoryLines: string[];
    onUsage?: (kind: BiliUsageKind, usage: ModelUsageTokens) => void;
  },
  notes: string[],
): Promise<string[]> {
  if (candidates.length === 0 || limit <= 0) return [];

  const listing = candidates
    .map((card, index) => formatCardForModel(card, index, card.source === "owner" ? "主人发的" : undefined))
    .join("\n");
  const memoryText = model.memoryLines.length ? `我记得这些：\n${model.memoryLines.join("\n")}\n\n` : "";

  const hasOwner = candidates.some((card) => card.source === "owner");
  const prompt = [
    "这是我这轮刷到的候选视频。",
    "",
    `${memoryText}先粗筛一遍：把明显不值得花时间的剔掉，只留最值得细看的，最多 ${limit} 条。`,
    "拿不准的可以留，后面我会真的去看内容再定。",
    ...(hasOwner
      ? [
          "",
          "标了【主人发的】是我主人自己的投稿。这类优先留 —— 就算你不觉得特别好看，也先留下，" +
            "我自己看完再定。主人的投稿和别的候选排在一起时，放前面。",
        ]
      : []),
    "",
    `只输出一个 JSON 数组，元素是 BV 号，按值得看的程度从高到低排，不要任何别的文字。`,
    `例如：["BV1xx411c7mD"]`,
    "",
    "候选：",
    listing,
  ].join("\n");

  let reply = "";
  try {
    reply = await callBiliModel({
      systemPrompt: model.characterPrompt,
      userPrompt: prompt,
      model: model.model,
      apiKey: model.apiKey,
      apiBaseUrl: model.apiBaseUrl,
      temperature: 0.3,
      // 25 条候选的粗筛，思考型模型光思考就要 1500~2200 tokens；给低于这个数的预算会正文全空
      maxTokens: 4096,
      onUsage: (usage) => model.onUsage?.("bili-screening", usage),
    });
  } catch (error) {
    notes.push(`粗筛调用模型失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const parsed = parseJsonLoose(reply);
  const known = new Set(candidates.map((c) => c.bvid));
  let picked: string[] = [];
  if (Array.isArray(parsed)) {
    picked = parsed.filter((item): item is string => typeof item === "string" && known.has(item));
  }
  // 模型没老实给 JSON 时，退化成从文本里抓 BV 号
  if (picked.length === 0) {
    picked = extractBvids(reply).filter((bvid) => known.has(bvid));
  }
  if (picked.length === 0) {
    notes.push(`粗筛没有选中任何候选（模型输出无法解析：${reply.slice(0, 80)}）`);
    return [];
  }
  // 去重并保持顺序，再按 limit 截断
  return [...new Set(picked)].slice(0, limit);
}

/** 看懂一条视频。失败返回 null（note 里会留下原因）。 */
async function watchVideo(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  bvid: string,
  notes: string[],
): Promise<BiliWatchedVideo | null> {
  const args = ["video", "watch", bvid, "--comments", "5", "--max-chars", "1200", "--frames", String(config.frames)];
  const result = await runBili(args, { ...biliOptions(record), timeoutMs: WATCH_TIMEOUT_MS });
  const data = readCommandData(result, `video watch ${bvid}`, notes);
  if (!data) return null;
  const watched = parseWatchedVideo(data);
  if (!watched) notes.push(`video watch ${bvid} 返回结构无法解析`);
  return watched;
}

/** 终判：看着正文判断这条值不值得占主人的注意力。 */
async function judgeVideo(
  candidate: Candidate,
  watched: BiliWatchedVideo,
  model: {
    characterPrompt: string;
    model: string;
    apiKey: string;
    apiBaseUrl?: string;
    memoryLines: string[];
    onUsage?: (kind: BiliUsageKind, usage: ModelUsageTokens) => void;
  },
  notes: string[],
): Promise<{ worth: boolean; reason: string; comment: string; score: number | null }> {
  const material = formatWatchedForModel(watched);
  const memoryText = model.memoryLines.length ? `我记得这些：\n${model.memoryLines.join("\n")}\n\n` : "";

  const isOwnerVideo = candidate.source === "owner";
  const prompt = [
    isOwnerVideo
      ? `${memoryText}我把主人发的这条视频看完了，材料如下：`
      : `${memoryText}我把这条视频看完了，材料如下：`,
    "",
    material,
    "",
    "---",
    ...(isOwnerVideo
      ? [
          "这是主人自己发的，我肯定看完了 —— 不用判断值不值得。",
          "我要定两件事：看完想说什么，以及我有多喜欢。",
          "按下面三行回答，一行一个字段，不要用 JSON、不要加别的解释：",
          "分数：0 到 20 的整数（这是我喜不喜欢，不是好不好；别虚高，也别客气）",
          "理由：一句话，30 字内，说清我为什么喜欢、哪里打动我",
          "评论：想在他的评论区说一句就写 60 字内、像我自己说的话；不想说就写「无」",
        ]
      : [
          "判断：这条值不值得占主人的注意力？拿不准就跳过，别反复权衡。",
          "按下面四行回答，一行一个字段，不要用 JSON、不要加别的解释：",
          "判断：值得  或  判断：跳过",
          "分数：0 到 20 的整数（四把尺子见章程，不要虚高）",
          "理由：一句话，30 字内，说清为什么。跳过也要写；口味里规定了写法的（比如只写两个字），按口味写",
          "评论：如果要公开评论，写一句 60 字内、像自己刷到随口说一句的话；不需要就写「无」",
        ]),
  ].join("\n");

  let reply = "";
  try {
    reply = await callBiliModel({
      systemPrompt: model.characterPrompt,
      userPrompt: prompt,
      model: model.model,
      apiKey: model.apiKey,
      apiBaseUrl: model.apiBaseUrl,
      temperature: 0.4,
      // 单条终判要输出三行 + 思考，3072 起步
      maxTokens: 3072,
      onUsage: (usage) => model.onUsage?.("bili-judge", usage),
    });
  } catch (error) {
    notes.push(`终判 ${candidate.bvid} 调用模型失败：${error instanceof Error ? error.message : String(error)}`);
    return { worth: false, reason: "", comment: "", score: null };
  }

  const verdict = parseVerdict(reply);
  const reason = readLabeledLine(reply, "理由").slice(0, 120) || verdict.reason.slice(0, 120);
  const comment = readLabeledLine(reply, "评论").slice(0, COMMENT_MAX_CHARS);
  // 主人发的视频不交给模型判「要不要」：上面提示词已经不问判断了，
  // 这里再兜一层 —— 模型万一还是写了「跳过」，也不该把它扔掉。
  return { worth: isOwnerVideo ? true : verdict.worth, reason, comment, score: parseScore(reply) };
}

/** 组装私信正文：单条用「标题/链接/理由」，多条用编号汇总（都在 500 字内）。 */
function buildDmText(picked: PickedVideo[]): string {
  if (picked.length === 0) return "";
  if (picked.length === 1) {
    const only = picked[0];
    if (!only) return "";
    const lines = [`标题：${only.candidate.title.slice(0, 60)}`, `链接：${only.candidate.url}`];
    if (only.reason) lines.push(`理由：${only.reason}`);
    return lines.join("\n").slice(0, DM_MAX_CHARS);
  }

  const header = `今天挑了 ${picked.length} 条：`;
  const body: string[] = [];
  for (const [index, item] of picked.entries()) {
    const line = `${index + 1}. ${item.candidate.title.slice(0, 40)} — ${item.reason || "值得一看"}`;
    body.push(line);
    body.push(`   ${item.candidate.url}`);
  }
  const text = [header, ...body].join("\n");
  if (text.length <= DM_MAX_CHARS) return text;
  // 超长就少报几条，别把正文截断成半句话
  const trimmed = picked.slice(0, Math.max(1, picked.length - 1));
  return [header, ...trimmed.flatMap((item, index) => [`${index + 1}. ${item.candidate.title.slice(0, 40)} — ${item.reason || "值得一看"}`, `   ${item.candidate.url}`])]
    .join("\n")
    .slice(0, DM_MAX_CHARS);
}

type DeliveryOutcome = { sent: boolean; fatal: boolean; note?: string };

/** 私信收件人：空 = CLI 记的 owner（主人），否则是指定 UID。 */
function dmRecipient(config: BiliDutyConfig): { arg: string; label: string } {
  return config.dmTargetUid
    ? { arg: config.dmTargetUid, label: `私信 UID ${config.dmTargetUid}` }
    : { arg: "owner", label: "私信主人" };
}

/** 私信主人（或值班设置里指定的收件人）。 */
async function deliverDm(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  picked: PickedVideo[],
  beforeExternalWrite: () => Promise<void>,
): Promise<DeliveryOutcome> {
  if (config.dmMode === "off") return { sent: false, fatal: false };
  if (picked.length === 0) return { sent: false, fatal: false };
  const text = buildDmText(picked);
  if (!text.trim()) return { sent: false, fatal: false };

  const recipient = dmRecipient(config);
  const outcome = await withTempText(text, async (path) => {
    const argv = ["dm", "send", recipient.arg, "--file", path];
    // 陌生收件人（没聊过、也不是互关）CLI 会直接拒发，要显式开 --allow-new
    if (config.dmAllowNew) argv.push("--allow-new");
    await beforeExternalWrite();
    const result = await runBili(argv, biliOptions(record));
    return result;
  });

  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `${recipient.label}失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `私信被本地限流，这轮放弃投递：${detail}` };
  return { sent: false, fatal: false, note: `${recipient.label}失败（${code}）：${detail}` };
}

/** 发一条公开评论（有 @ 目标时用真正的 --at，对方会收到提醒）。 */
async function deliverComment(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  bvid: string,
  text: string,
  beforeExternalWrite: () => Promise<void>,
): Promise<DeliveryOutcome> {
  const trimmed = preparePublicComment(text);
  if (!trimmed) {
    return {
      sent: false,
      fatal: false,
      ...(text.trim() ? { note: `评论 ${bvid} 经公开发布脱敏后为空，已跳过。` } : {}),
    };
  }

  const args = ["comment", "post", bvid];
  const outcome = await withTempText(trimmed, async (path) => {
    const argv = [...args, "--file", path];
    if (config.mentionName) argv.push("--at", config.mentionName);
    await beforeExternalWrite();
    return runBili(argv, biliOptions(record));
  });

  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `评论 ${bvid} 失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `评论 ${bvid} 被本地限流：${detail}` };
  return { sent: false, fatal: false, note: `评论 ${bvid} 失败（${code}）：${detail}` };
}

/** 收藏一条视频。CLI 自带 guard（5 秒一次、60 次/小时），日上限由调用方管。 */
async function favVideo(
  record: BiliConnectionRecord,
  bvid: string,
  beforeExternalWrite: () => Promise<void>,
): Promise<DeliveryOutcome> {
  await beforeExternalWrite();
  const outcome = await runBili(["video", "fav", bvid], biliOptions(record));
  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `收藏 ${bvid} 失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `收藏 ${bvid} 被本地限流：${detail}` };
  return { sent: false, fatal: false, note: `收藏 ${bvid} 失败（${code}）：${detail}` };
}

/**
 * 动态正文：理由 + 标题 + 链接。
 *
 * 理由本来是写给主人的，发到动态上等于换了一群读者，所以先过脱敏闸。
 * 整段都被闸挡掉时返回空串 —— 宁可今天不发，也不发一条只剩标题和链接的空壳。
 */
function buildDynamicText(item: PickedVideo): string {
  const reason = sanitizePublicText(item.reason).slice(0, 100);
  if (!reason) return "";
  const title = item.candidate.title.trim().slice(0, 60);
  return [`${reason}`, `——《${title}》`, item.candidate.url].join("\n").slice(0, DYNAMIC_MAX_CHARS);
}

/** 发一条公开动态。这是整条流水线里唯一会向陌生人可见的写操作。 */
async function postDynamic(
  record: BiliConnectionRecord,
  text: string,
  beforeExternalWrite: () => Promise<void>,
): Promise<DeliveryOutcome> {
  const trimmed = text.trim().slice(0, DYNAMIC_MAX_CHARS);
  if (!trimmed) return { sent: false, fatal: false };
  const outcome = await withTempText(trimmed, async (path) => {
    await beforeExternalWrite();
    return runBili(["dynamic", "post", "--file", path], biliOptions(record));
  });
  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `发动态失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `发动态被本地限流：${detail}` };
  return { sent: false, fatal: false, note: `发动态失败（${code}）：${detail}` };
}

/**
 * 跑一轮值班。绑定到某个角色（binding），读该角色的长期记忆做判断，写报告/判重/札记。
 *
 * 注意：这里 bili CLI 的"找候选/看懂/投递"是真实跨进程调用；模型判断是真实模型调用。
 * 在没有配置 bili CLI / 模型 / 凭证的环境下，本函数会返回明确的错误，而不是假装成功。
 */
export async function runDutyRound(
  record: BiliConnectionRecord,
  binding: { id: string; characterId: string },
  scheduledWindow?: BiliScheduledWindow,
): Promise<BiliDutyRoundResult> {
  const prisma = getPrisma();
  const lease = await acquireBiliDutyLease(prisma, binding.id);
  if (!lease) {
    return {
      ok: false,
      picked: 0,
      skipped: 0,
      watched: 0,
      seenVideos: 0,
      delivered: { dm: false, comments: 0, fav: 0, dynamic: false },
      pickedItems: [],
      notes: ["该角色的 B站 值班已有一轮正在执行，本次未启动，避免重复评论、私信或互动。"],
      error: "已有值班轮次正在执行",
    };
  }

  let windowRunStarted = false;
  try {
    if (scheduledWindow) {
      // 必须在锁内、任何模型/CLI/外部动作之前先记本窗口已尝试。
      await startBiliDutyWindowRun(prisma, binding.id, scheduledWindow, lease.token);
      windowRunStarted = true;
    }

    const result = await runDutyRoundLocked(record, binding, lease.assertOwned);
    if (scheduledWindow && windowRunStarted) {
      await lease.assertOwned();
      const updated = await completeBiliDutyWindowRun(
        prisma,
        binding.id,
        scheduledWindow,
        lease.token,
        result.error ?? null,
      );
      if (!updated) {
        console.warn("[bili] 本轮结果未能写回窗口记录（租约可能已被接管）。", binding.id);
      }
    }
    return result;
  } catch (error) {
    if (scheduledWindow && windowRunStarted) {
      try {
        await lease.assertOwned();
        const updated = await failBiliDutyWindowRun(prisma, binding.id, scheduledWindow, lease.token, error);
        if (!updated) {
          console.warn("[bili] 本轮异常未能写回窗口记录（租约可能已被接管）。", binding.id);
        }
      } catch (markError) {
        console.error(
          "[bili] 记录值班窗口异常状态失败；窗口开始记录仍会阻止自动重复执行。",
          markError instanceof Error ? markError.message : String(markError),
        );
      }
    }
    throw error;
  } finally {
    await lease.release().catch((error: unknown) => {
      console.error("[bili] 释放值班执行租约失败；它会在过期后自动回收。", error instanceof Error ? error.message : String(error));
    });
  }
}

async function runDutyRoundLocked(
  record: BiliConnectionRecord,
  binding: { id: string; characterId: string },
  beforeExternalWrite: () => Promise<void>,
): Promise<BiliDutyRoundResult> {
  const prisma = getPrisma();
  const now = new Date();
  const today = toDayKey(now);
  const notes: string[] = [];
  const empty = {
    picked: 0,
    skipped: 0,
    watched: 0,
    seenVideos: 0,
    delivered: { dm: false, comments: 0, fav: 0, dynamic: false },
    pickedItems: [] as BiliDutyRoundResult["pickedItems"],
  };

  const character = await prisma.character.findUnique({
    where: { id: binding.characterId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      userAddress: true,
      status: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { ok: false, ...empty, notes, error: "找不到绑定的角色" };
  // 已暂停/归档的角色不应再主动刷视频或发评论。
  if (character.status !== "ACTIVE") return { ok: false, ...empty, notes, error: "角色已停用，跳过本轮值班" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { ok: false, ...empty, notes, error: "角色缺少全局记忆范围" };

  const config: BiliDutyConfig = record.duty;

  // 1. 读判重表（最近 7 天看过的 BV）
  const seenSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const seenVideos = await prisma.biliSeenVideo.findMany({
    where: { bindingId: binding.id, seenAt: { gte: seenSince } },
    select: { bvid: true },
  });
  const seenBvids = new Set(seenVideos.map((v) => v.bvid));

  // 今天已挑条数 = 今天报告的 pickedCount 之和；「重置今日额度」之后只数新报告。
  const todayReports = await prisma.biliRoundReport.findMany({
    where: { bindingId: binding.id, day: today },
    select: { pickedCount: true, roundIndex: true, createdAt: true },
  });
  const resetAt = config.quotaResetAt ? new Date(config.quotaResetAt) : null;
  const countedReports = resetAt ? todayReports.filter((report) => report.createdAt >= resetAt) : todayReports;
  const pickedToday = countedReports.reduce((sum, r) => sum + r.pickedCount, 0);
  const remaining = remainingQuota(config, { day: today, picked: pickedToday, windowsRun: [] });

  // 模型准备：主人互动和推荐流两条线都要用，所以提到最前面。
  // 主人互动**不吃值班额度** —— 今天推荐流已经挑够了（remaining = 0），
  // 主人发了新视频照样该去看；只有模型 token 额度见底才一起停（打分要花钱）。
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl);
  } catch {
    return { ok: false, ...empty, seenVideos: seenBvids.size, notes, error: "角色 API Key 解密失败" };
  }
  if (!apiKey || !modelSettings.model) {
    return { ok: false, ...empty, seenVideos: seenBvids.size, notes, error: "角色未配置模型" };
  }

  // 一轮最多 30 次调用，额度见底时连候选都不筛 —— 先停手比筛到一半没钱更安全。
  const quota = await readDailyQuota(binding.characterId, character.modelConfig);
  if (quota.exceeded) {
    notes.push(`今日模型额度已用完（${quota.used} / ${quota.limit} tokens），本轮不刷。`);
    return { ok: false, ...empty, seenVideos: seenBvids.size, notes, error: "额度已用完" };
  }

  // 锁失效时尽早停止，避免继续消耗模型额度或推进主人互动流程。
  await beforeExternalWrite();

  // 0. 主人内容互动（owner-watch.ts）。独立于推荐流：只对主人的投稿动手。
  const ownerResult = await runOwnerWatch({
    record,
    config,
    // 传这一轮的 binding，不是连接的第一条 —— 一个连接可以挂多个角色。
    bindingId: binding.id,
    characterPrompt: character.basePrompt.slice(0, 12_000),
    day: today,
    notes,
    beforeExternalWrite,
    model: {
      model: modelSettings.model,
      apiKey,
      apiBaseUrl: modelSettings.apiBaseUrl,
      onUsage: (usage) => {
        void recordModelUsage({
          kind: "bili-owner",
          model: modelSettings.model,
          usage,
          characterId: binding.characterId,
          channelBindingId: binding.id,
        });
      },
    },
  });

  // 主人互动可能已经走过多个外部写操作；返回主流程前再确认一次租约。
  await beforeExternalWrite();

  if (remaining <= 0) {
    return {
      ok: false,
      ...empty,
      picked: pickedToday,
      seenVideos: seenBvids.size,
      notes,
      owner: ownerResult ?? undefined,
      error: "今天额度已用完",
    };
  }

  // 2. 找候选
  // 「主人优先」要读一次 owner；没设主人时按普通推荐流刷，不要因此让整轮失败。
  const ownerMid = config.ownerFirst ? await readOwnerMid(record, notes) : "";
  if (config.ownerFirst && !ownerMid) notes.push("主人优先：bili CLI 里还没设主人，这轮按普通推荐流刷。");
  // 「主人」这条线的诊断，单独攒一份写进日报 —— 不受 reportLevel 影响。
  const ownerDiag: string[] = [];
  if (!config.ownerFirst) ownerDiag.push("「刷B站时优先看主人的投稿」没开");
  const candidates = await collectCandidates(record, config, seenBvids, notes, ownerMid, ownerDiag);
  if (candidates.length === 0) {
    const fatal = notes.some((note) => /auth_expired|not_logged_in|login_pending/.test(note));
    return {
      ok: !fatal,
      ...empty,
      seenVideos: seenBvids.size,
      notes,
      owner: ownerResult ?? undefined,
      error: fatal ? "B站凭证失效，需要重新扫码登录" : "没有新候选",
    };
  }

  // 3. 模型准备已在前面完成，这里只组装提示词。

  const settings: BiliDutyRoundSettings = {
    today,
    remaining,
    perDay: config.perDay,
    keywords: config.keywords,
    zone: config.zone,
    frames: config.frames,
    dmMode: config.dmMode,
    autoComment: config.autoComment,
    commentPerRound: config.commentPerRound,
    mentionName: config.mentionName,
    userAddress: character.userAddress ?? "",
    dmTarget: config.dmTargetUid,
    watchLimit: Math.min(MAX_WATCH_PER_ROUND, Math.max(remaining, 1) + 2),
    favMinScore: config.favMinScore,
    autoDynamic: config.autoDynamic,
    dynamicMinScore: config.dynamicMinScore,
  };
  const dutyPrompt = buildDutyPrompt(config, settings);

  // 检索该角色的长期记忆，作为判断依据
  const activeMemories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: globalScope.id, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, category: true, content: true, confidence: true },
  });
  const memoryLines = activeMemories.slice(0, 8).map((m) => `- [${m.category}] ${m.content.slice(0, 200)}`);

  const model = {
    // 粗筛和终判共用同一份人设 + 值班准则，避免两步的尺度不一致。
    // ⚠️ 这里**故意不注入** `styleExamples`（对话示例）：一轮最多 30 次调用，
    //    每条候选都白带一遍示例，而且示例教的是聊天的语气，会把 30 字理由带成碎碎念。
    //    她说话的口吻由 basePrompt 里「性格 / 说话风格」那几段兜住。
    characterPrompt: `${character.basePrompt.slice(0, 12_000)}\n\n${dutyPrompt}`,
    model: modelSettings.model,
    apiKey,
    apiBaseUrl: modelSettings.apiBaseUrl,
    memoryLines,
    onUsage: (kind: BiliUsageKind, usage: ModelUsageTokens) => {
      void recordModelUsage({
        kind,
        model: modelSettings.model,
        usage,
        characterId: binding.characterId,
        channelBindingId: binding.id,
      });
    },
  };

  // 4. 粗筛：只对入选的才付出 watch 的代价
  await beforeExternalWrite();
  const modelShortlist = await shortlistCandidates(candidates, settings.watchLimit, model, notes);
  // 「主人发的」不交给粗筛决定要不要看：模型没留也补到最前面（最多 OWNER_PICK_MAX 条）。
  // 提示词里已经请它优先，但那是请求不是契约 —— 主人发的东西她一定看，这条由代码保证。
  const ownerPicks = candidates
    .filter((card) => card.source === "owner")
    .map((card) => card.bvid);
  if (ownerPicks.length) {
    notes.push(`主人优先：${Math.min(ownerPicks.length, OWNER_PICK_MAX)} 条主人的投稿直接进细看队列。`);
  }
  const shortlist = mergeOwnerFirst(ownerPicks, modelShortlist, settings.watchLimit);
  const byBvid = new Map(candidates.map((card) => [card.bvid, card]));

  // 5. 看懂 + 终判
  const picked: PickedVideo[] = [];
  const skipped: SkippedVideo[] = [];
  let watchedCount = 0;

  for (const bvid of shortlist) {
    await beforeExternalWrite();
    const candidate = byBvid.get(bvid);
    if (!candidate) continue;
    if (picked.length >= remaining) break;

    const watched = await watchVideo(record, config, bvid, notes);
    if (!watched) {
      // 看不懂就不硬判 —— 记为跳过，理由写清楚，别假装看过
      skipped.push({ candidate, reason: "看不懂内容", score: null });
      continue;
    }
    watchedCount += 1;

    // watch 返回的 owner 才是权威的 UP 名，顺手补上卡片的作者（列表卡片有时是空的）
    if (!candidate.author.name && watched.author.name) candidate.author = watched.author;

    const verdict = await judgeVideo(candidate, watched, model, notes);
    if (verdict.worth && picked.length < remaining) {
      picked.push({ candidate, watched, reason: verdict.reason, comment: verdict.comment, score: verdict.score });
    } else {
      skipped.push({ candidate, reason: verdict.reason, score: verdict.score });
    }

    // 风控一旦出现，本轮立刻停止继续 watch
    if (notes.some((note) => /risk_control|captcha_required/.test(note))) break;
  }

  // 没进粗筛的候选也算"看过"，写进判重表，避免下一轮反复出现在候选里
  const shortlistSet = new Set(shortlist);
  for (const candidate of candidates) {
    if (!shortlistSet.has(candidate.bvid)) skipped.push({ candidate, reason: "粗筛没留", score: null });
  }

  // 6. 投递
  // 「主人互动」那条线已经对同一条视频做过的事，这里不要再做一遍：
  // 同一条视频底下出现两条自己的评论、或者同一夹里收两次，都很像刷屏。
  const ownerTouched = new Map<string, string[]>();
  for (const item of ownerResult?.items ?? []) ownerTouched.set(item.bvid, item.actions);
  const ownerDid = (bvid: string, action: string) => (ownerTouched.get(bvid) ?? []).includes(action);

  const delivered = { dm: false, comments: 0, fav: 0, dynamic: false };
  if (picked.length > 0) {
    const dmOutcome = await deliverDm(record, config, picked, beforeExternalWrite);
    delivered.dm = dmOutcome.sent;
    if (dmOutcome.note) notes.push(dmOutcome.note);

    const commentEnabled = config.autoComment && config.dmMode !== "only";
    if (commentEnabled && !dmOutcome.fatal) {
      let fatal = false;
      const commentTargets = picked
        .filter((item) => item.comment && !ownerDid(item.candidate.bvid, "评论"))
        .slice(0, config.commentPerRound);
      for (const item of commentTargets) {
        if (fatal) break;
        const outcome = await deliverComment(record, config, item.candidate.bvid, item.comment, beforeExternalWrite);
        if (outcome.sent) delivered.comments += 1;
        if (outcome.note) notes.push(outcome.note);
        if (outcome.fatal) fatal = true;
      }
    }
  }

  // 6.5 对外动作：收藏 / 发动态。
  // 都在报告落库之前做完 —— 动作结果要写进报告，但失败只记一笔，不能让整轮值班变成失败。
  if (picked.length > 0) {
    if (config.favMinScore > 0) {
      const favToday = await prisma.biliAction.count({ where: { bindingId: binding.id, day: today, kind: "fav" } });
      let favBudget = Math.max(0, FAV_PER_DAY - favToday);
      if (favBudget <= 0) notes.push(`今天已经收藏了 ${FAV_PER_DAY} 条，这一轮不再收。`);

      for (const item of picked) {
        if (favBudget <= 0) break;
        if ((item.score ?? 0) < config.favMinScore) continue;
        // 主人那条线已经收进收藏夹了，别收第二次。
        if (ownerDid(item.candidate.bvid, "收藏")) continue;
        // 理由太短说明她自己也没想清楚为什么要留着，那就别占收藏夹。
        if (item.reason.trim().length < FAV_MIN_REASON) {
          notes.push(`《${item.candidate.title.slice(0, 20)}》分数够但理由太短，不收藏。`);
          continue;
        }
        const outcome = await favVideo(record, item.candidate.bvid, beforeExternalWrite);
        if (outcome.note) notes.push(outcome.note);
        if (!outcome.sent) {
          if (outcome.fatal) break;
          continue;
        }
        favBudget -= 1;
        delivered.fav += 1;
        await prisma.biliAction.create({
          data: { bindingId: binding.id, day: today, kind: "fav", bvid: item.candidate.bvid, detail: item.reason.slice(0, 200) },
        }).catch(() => undefined);
      }
    }

    // 发动态：一天一条、两条隔 30 分钟、必须是当天最高分且过门槛。
    // 没有「最高分」概念的话，一天挑五条就要纠结发哪条 —— 排序已经替她做了决定。
    if (config.autoDynamic) {
      const best = [...picked].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
      const bestScore = best?.score ?? -1;
      if (!best || bestScore < config.dynamicMinScore) {
        notes.push(`当天最高分 ${bestScore >= 0 ? String(bestScore) : "未知"} 没到发动态的门槛 ${config.dynamicMinScore}，不发。`);
      } else {
        const [dynamicToday, lastDynamic] = await Promise.all([
          prisma.biliAction.count({ where: { bindingId: binding.id, day: today, kind: "dynamic" } }),
          prisma.biliAction.findFirst({
            where: { bindingId: binding.id, kind: "dynamic" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
        ]);
        const gapOk = !lastDynamic || Date.now() - lastDynamic.createdAt.getTime() >= DYNAMIC_GAP_MS;
        if (dynamicToday >= DYNAMIC_PER_DAY) {
          notes.push("今天已经发过动态，不再发。");
        } else if (!gapOk) {
          notes.push("距离上一条动态不到 30 分钟，这一轮先不发。");
        } else {
          const text = buildDynamicText(best);
          if (!text) {
            notes.push(`《${best.candidate.title.slice(0, 20)}》的理由过不了公开闸，今天不发动态。`);
          } else {
            const outcome = await postDynamic(record, text, beforeExternalWrite);
            if (outcome.note) notes.push(outcome.note);
            if (outcome.sent) {
              delivered.dynamic = true;
              await prisma.biliAction.create({
                data: { bindingId: binding.id, day: today, kind: "dynamic", bvid: best.candidate.bvid, detail: text },
              }).catch(() => undefined);
            }
          }
        }
      }
    }
  }

  // 7. 收尾：写报告 + 判重表（事务内）
  const roundIndex = todayReports.reduce((max, r) => Math.max(max, r.roundIndex), 0) + 1;
  const reportContent = picked
    .map((item) => {
      const lines = [`### ${item.candidate.bvid}`, `${item.candidate.title}（UP：${item.candidate.author.name || "未知"}）`, item.candidate.url];
      if (item.score !== null) lines.push(`分数：${item.score}`);
      if (item.reason) lines.push(`理由：${item.reason}`);
      return lines.join("\n");
    })
    .join("\n\n");

  // 主人这一段放在日报最前面 —— 那是她这一轮最在意的事，推荐流是「顺带逛的」。
  //
  // 即使这一轮什么都没做也要写：`brief` 档不落过程记录，用户看到「没刷到我的视频」
  // 却翻不到任何原因，只能猜。所以「为什么没进候选 / 为什么没互动」必须单独落一行。
  const ownerLines: string[] = [];
  if (!config.ownerWatch) ownerLines.push("互动：没开（「自动看主人发的并互动」）");
  if (ownerResult) {
    if (ownerResult.status === "baseline") {
      ownerLines.push("互动：这轮建立了基线，从下一条主人投稿开始生效");
    } else if (ownerResult.status === "no-fresh") {
      ownerLines.push("互动：这 7 天主人没有新发的投稿");
    } else if (ownerResult.status === "all-done") {
      ownerLines.push("互动：这几天的新投稿都处理过了");
    } else if (ownerResult.items.length === 0) {
      ownerLines.push("互动：这轮没有需要处理的投稿");
    }
  }
  if (ownerDiag.length) ownerLines.push(...ownerDiag);
  for (const item of ownerResult?.items ?? []) {
    ownerLines.push(
      [
        `### ${item.bvid}`,
        item.title,
        item.url,
        ...(item.score !== null ? [`分数：${item.score}`] : []),
        `动作：${item.actions.length ? item.actions.join("、") : "（没做，只读过）"}`,
        ...(item.comment ? [`评论：${item.comment}`] : []),
      ].join("\n"),
    );
  }
  const ownerBlock = ownerLines.length ? ["--- 主人 ---", ...ownerLines].join("\n\n") : "";

  // 过程记录跟着报告一起落库：一条都没挑中时，「为什么」比「没挑中」重要得多。
  // 以前 notes 只在内存里返回、接口也没透出去，页面只剩「本轮没有挑中的视频」，
  // 排查「全跳过」时完全无从下手（2026-10-28 就是这么踩的）。
  const notesBlock = notes.length ? `--- 过程记录 ---\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
  const skippedBlock = skipped.length
    ? `--- 跳过 ---\n${skipped
        .slice(0, 30)
        .map((item) => `- ${item.candidate.title.slice(0, 40)}（${item.reason || "跳过"}）`)
        .join("\n")}`
    : "";
  const contentToStore = config.reportLevel === "off"
    ? "（日报已关闭，只记录额度与判重）"
    : [
        ownerBlock,
        reportContent || "（本轮没有挑中的视频）",
        ...(config.reportLevel === "full" ? [skippedBlock, notesBlock] : []),
      ].filter(Boolean).join("\n\n");

  // 人格札记：替换掉 bili-desk 的 human-world.md，落成角色长期记忆。
  // 只在挑中视频（或真的对主人的投稿动过手）时写 —— 「刷了 5 条一条没挑」不值得占用长期记忆，
  // 那种情况值班台自己的 BiliRoundReport 已经记着了。
  //
  // 主人那一段单独写：那是她「今天去看过主人发的东西」的事实，比刷到几条视频重要得多，
  // 而且后续聊天里问「你看到我发的了吗」时，这条记忆就是她答得上来的依据。
  const ownerJournalItems = (ownerResult?.items ?? []).filter((item) => item.actions.length > 0);
  const journalParts: string[] = [];
  if (ownerJournalItems.length) {
    journalParts.push(
      `我去看了主人新发的${ownerJournalItems
        .map((item) => `《${item.title.slice(0, 40)}》`)
        .join("、")}，依次做了${ownerJournalItems.map((item) => item.actions.join("+")).join("、")}。`,
    );
  }
  if (picked.length) {
    journalParts.push(
      `我在 B站 看了 ${watchedCount} 条视频，挑中了 ${picked.length} 条：${picked
        .map((item) => `《${item.candidate.title.slice(0, 40)}》（UP：${item.candidate.author.name || "未知"}）`)
        .join("、")}`,
    );
  }
  const journal = journalParts.join("\n");
  // 同一 (binding, day, roundIndex) 重跑时覆盖同一条记忆，不重复堆积
  const journalKey = `bili-duty:${binding.id}:${today}:${roundIndex}`;

  // 最终报告、判重和札记同样属于本轮的数据库写入；失去租约的旧执行者不能落库。
  await beforeExternalWrite();
  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.biliRoundReport.create({
      data: {
        bindingId: binding.id,
        day: today,
        roundIndex,
        pickedCount: picked.length,
        content: contentToStore,
      },
      select: { id: true },
    });

    if (journal) {
      const existing = await tx.memoryItem.findFirst({
        where: { memoryScopeId: globalScope.id, dedupeKey: journalKey },
        select: { id: true },
      });
      if (existing) {
        await tx.memoryItem.update({ where: { id: existing.id }, data: { content: journal } });
      } else {
        await tx.memoryItem.create({
          data: {
            memoryScopeId: globalScope.id,
            category: "EVENT",
            content: journal,
            // 是模型自己的判断，不是主人亲口说的，可信度略低于对话抽取的记忆
            confidence: 0.8,
            dedupeKey: journalKey,
            validFrom: now,
          },
        });
      }
    }

    // 判重表：用 createMany + skipDuplicates 批量写。
    // 原来是逐条 create 再 catch 掉唯一冲突 —— 但在 Postgres 事务里，一条语句失败
    // 会让整个事务进入 aborted 状态，后面写的东西（包括上面那条记忆）跟着一起回滚。
    const seenRows = [
      ...picked.map((item) => ({ candidate: item.candidate, result: "picked", reason: item.reason || "值得", score: item.score })),
      ...skipped.map((item) => ({ candidate: item.candidate, result: "skipped", reason: item.reason || "跳过", score: item.score })),
    ].map(({ candidate, result, reason, score }) => ({
      bindingId: binding.id,
      bvid: candidate.bvid,
      title: candidate.title,
      author: candidate.author.name,
      result,
      reason,
      score,
    }));
    if (seenRows.length) {
      await tx.biliSeenVideo.createMany({ data: seenRows, skipDuplicates: true });
    }
    return created;
  });

  return {
    ok: true,
    reportId: report.id,
    picked: picked.length,
    skipped: skipped.length,
    watched: watchedCount,
    seenVideos: seenBvids.size + picked.length + skipped.length,
    delivered,
    pickedItems: picked.map((item) => ({
      bvid: item.candidate.bvid,
      title: item.candidate.title,
      url: item.candidate.url,
      score: item.score,
      reason: item.reason,
      comment: item.comment,
    })),
    owner: ownerResult ?? undefined,
    notes,
  };
}
