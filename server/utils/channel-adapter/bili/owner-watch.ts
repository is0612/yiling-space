/**
 * 主人内容互动 —— 「她去看主人发了什么，然后点个赞/收藏/投币，在底下说句话」。
 *
 * 和 `duty-pipeline.ts` 那条「刷推荐流」是**两条独立的线**：
 *   - 值班线：她在 B站 上自己逛，看推荐/热榜/搜索，挑她感兴趣的，发给主人当话题；
 *   - 这条线：她只看**主人**的内容，动作对象是固定的一个人。
 *
 * 为什么单独一个文件而不是塞进 duty-pipeline：两者的判据完全相反。值班要「挑」，
 * 挑不中才是常态；这里不挑 —— 主人发的东西她一定看，只是「怎么反应」有个分寸。
 *
 * 三条硬约束（都是实测/业务边界，别随手改）：
 *
 * 1. **只对「绑定之后新发布」的投稿动手**。绑定那一刻把当时的最新投稿时间记成基线
 *    （`bili_actions` 里 `kind = "owner-baseline"`），之后只处理晚于它的。
 *    要是不设基线，第一次开启就会对着 41 个历史投稿连发三连 —— 这是最容易被判成
 *    机器行为、也最容易把主人通知栏刷满的做法。
 *
 * 2. **点赞/收藏/投币以 `video relation` 为准，不用本地表判重**。CLI 一次就能拿回
 *    「赞了没 / 投了几个币 / 收藏了没 / 关注了没」，那是账号上的真实状态；
 *    本地表只用来判「这条投稿处理过没」（避免重复评论）。
 *
 * 3. **关注动作不做**。bili CLI 没有 `user follow` 命令，要代码化只能自己读
 *    `credential.json` 的 sessdata + bili_jct 去调 `x/relation/modify`，
 *    等于绕开 CLI 的限流与风控保护。所以这里只做**健康检查**：`following_up` 为 false
 *    时写一条提醒，让用户自己手动点关注。
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrisma } from "../../prisma";
import { biliOptions, type BiliConnectionRecord, type BiliDutyConfig } from "./configure";
import {
  isFatalBiliError,
  isRateLimited,
  parseBiliOwner,
  parseScore,
  parseVideoCards,
  readBiliError,
  sanitizePublicText,
  unwrapBiliData,
  type BiliVideoCard,
} from "./cards";
import { callBiliModel } from "./llm";
import { runBili } from "./runner";
import type { ModelUsageTokens } from "../../model-usage";

/** 拉主人投稿时每页几条。她只关心最近发的，翻不到第三页。 */
const OWNER_PAGE_SIZE = 10;
/**
 * 一轮最多处理几条新投稿。
 *
 * 主人可能一次连发好几条（尤其投稿季），但不该在一轮里连着评论四五条 ——
 * 剩下的下一轮再处理（`bili_seen_videos` 没有记录，下一轮照样能捡回来）。
 */
const FRESH_PER_ROUND = 2;
/**
 * 投币每天最多几个。
 *
 * CLI 的本地限流是每天 5 个，但那是「防止投太多」的上限，不是「有多少投多少」。
 * 账号的硬币余额可能只有两三个（实测 2 个），所以这里压到 1 个 —— 硬币是真实消耗且不可退。
 */
const COIN_PER_DAY = 1;
/** 评论正文字数上限。主人视频底下是公开场合，一句话就够。 */
const OWNER_COMMENT_MAX_CHARS = 80;
/**
 * 素材的新鲜度窗口。
 *
 * 即使晚于基线，也只看最近 7 天发布的 —— 鱼停用一个月再开，不该对着一个月前的东西
 * 补三连。基线管「不碰历史」，这个窗口管「不补积压」。
 */
const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 基线在 `bili_actions` 里的 kind。 */
const BASELINE_KIND = "owner-baseline";

/** `video relation` 的返回：账号上对这个视频的真实状态。 */
type VideoRelation = { liked: boolean; coins: number; favorited: boolean; followingUp: boolean };

export type OwnerWatchItem = {
  bvid: string;
  title: string;
  url: string;
  score: number | null;
  comment: string;
  /** 这一条实际做了哪些动作，写进报告用。 */
  actions: string[];
};

export type OwnerWatchOutcome = {
  /** 本轮新发现的主人投稿条数（可能大于实际处理的，见 FRESH_PER_ROUND）。 */
  fresh: number;
  liked: number;
  faved: number;
  coined: number;
  commented: number;
  /** 私信是否发出。 */
  dm: boolean;
  /** 关注关系是否正常；false = 没关注主人（只提醒，不自动关注）。 */
  following: boolean;
  /**
   * 这一轮只是建立了基线，还没开始互动。
   *
   * 首次打开开关的那一轮永远是 true —— 不设基线的话「开启」这个动作本身
   * 就会触发一轮对 41 条历史投稿的三连。UI 要靠这个字段说清「为什么什么都没发生」。
   */
  baselineCreated: boolean;
  /**
   * 这一轮为什么没动作。
   *
   * `brief` 档位的日报只写挑中的视频、不写过程记录，所以「互动线到底跑没跑」
   * 必须在结果里明说 —— 否则用户看到「什么都没发生」只能猜。
   */
  status: "baseline" | "no-fresh" | "all-done" | "done";
  items: OwnerWatchItem[];
};

export type OwnerWatchContext = {
  record: BiliConnectionRecord;
  config: BiliDutyConfig;
  /**
   * 这一轮值班针对的绑定（不是 `record.bindings[0]`）。
   *
   * 一个连接可以挂多条绑定（不同角色共用同一台 B站 账号），猜第一条会把
   * 主人的互动记到别人的账上、也会读错别人的基线。
   */
  bindingId: string;
  /** 角色人设 —— 评论要像她说的，不是像客服。 */
  characterPrompt: string;
  model: {
    model: string;
    apiKey: string;
    apiBaseUrl?: string;
    onUsage?: (usage: ModelUsageTokens) => void;
  };
  day: string;
  notes: string[];
};

/** 把一段文本写进临时文件，交给 bili 的 `--file`（跟 duty-pipeline 里同一套做法）。 */
async function withTempText<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `yiling-bili-owner-${randomUUID()}.txt`);
  await writeFile(path, text, "utf8");
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/** 取命令返回的 data；失败只记 note，不抛。 */
function commandData(json: unknown, label: string, notes: string[]): unknown | null {
  const error = readBiliError(json);
  if (error) {
    notes.push(`${label} 失败：${error.code}${error.message ? `（${error.message}）` : ""}`);
    return null;
  }
  return unwrapBiliData(json);
}

/** 读 bili CLI 里记的主人（`owner set` 写的那个）。 */
async function readOwner(record: BiliConnectionRecord, notes: string[]): Promise<{ mid: string; name: string } | null> {
  const result = await runBili(["owner", "show"], biliOptions(record));
  const error = readBiliError(result.json);
  if (error) {
    notes.push(`读主人失败：${error.code}${error.message ? `（${error.message}）` : ""}`);
    return null;
  }
  return parseBiliOwner(result.json);
}

/**
 * 读基线，没有就建一条。
 *
 * 返回 `{ baseline, created }`：首次创建时 `created = true`，调用方这一轮**不互动**，
 * 只把基线落下 —— 不然「开启」这个动作本身就会触发一轮对最新投稿的三连。
 */
async function readBaseline(bindingId: string, now: Date): Promise<{ baseline: Date; created: boolean }> {
  const prisma = getPrisma();
  const existing = await prisma.biliAction.findFirst({
    where: { bindingId, kind: BASELINE_KIND },
    orderBy: { createdAt: "desc" },
    select: { detail: true, createdAt: true },
  });
  if (existing) {
    // detail 存 ISO 时间；解析不出来（老数据/手改）就退回这行的 createdAt，别当没有。
    const parsed = existing.detail ? new Date(existing.detail) : null;
    return { baseline: parsed && !Number.isNaN(parsed.getTime()) ? parsed : existing.createdAt, created: false };
  }
  await prisma.biliAction.create({
    data: { bindingId, day: toDay(now), kind: BASELINE_KIND, detail: now.toISOString() },
  });
  return { baseline: now, created: true };
}

function toDay(date: Date): string {
  // 东八区日界，与值班报告的 day 同口径。
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 读 `video relation`：赞了没、投了几个币、收藏了没、关注了没。 */
async function readRelation(record: BiliConnectionRecord, bvid: string): Promise<VideoRelation | null> {
  const result = await runBili(["video", "relation", bvid], biliOptions(record));
  if (readBiliError(result.json)) return null;
  const data = unwrapBiliData(result.json) as Record<string, unknown> | null;
  if (!data) return null;
  const coins = typeof data.coins === "number" ? data.coins : Number(data.coins);
  return {
    liked: data.liked === true,
    coins: Number.isFinite(coins) ? coins : 0,
    favorited: data.favorited === true,
    followingUp: data.following_up === true,
  };
}

type ActionOutcome = { ok: boolean; fatal: boolean; code?: string };

/** 统一的写操作执行 + 错误分类，对齐 duty-pipeline 的处理方式。 */
async function runWrite(
  record: BiliConnectionRecord,
  argv: string[],
  label: string,
  notes: string[],
): Promise<ActionOutcome> {
  const result = await runBili(argv, biliOptions(record));
  const error = readBiliError(result.json);
  if (!error && result.code === 0) return { ok: true, fatal: false };
  const code = error?.code ?? (result.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || result.stderr.slice(0, 120);
  if (isFatalBiliError(code)) {
    notes.push(`${label} 失败（${code}）：${detail}`);
    return { ok: false, fatal: true, code };
  }
  notes.push(isRateLimited(code) ? `${label} 被本地限流：${detail}` : `${label} 失败（${code}）：${detail}`);
  return { ok: false, fatal: false, code };
}

/** 从模型回复里取「标签：内容」。 */
function labeledLine(text: string, label: string): string {
  const match = text.match(new RegExp(`${label}\\s*[：:]\\s*(.+)`));
  if (!match) return "";
  const value = (match[1] ?? "").trim();
  return value === "无" || value === "没有" || value === "-" ? "" : value;
}

/**
 * 让模型给一条主人投稿打分 + 写一句评论。
 *
 * 只喂标题/时长/播放量，**不 watch**：watch 单条最慢几十分钟（要拉字幕甚至语音转写），
 * 而这里要的只是「她看完之后会说什么」，标题已经够模型判断了。
 */
async function judgeOwnerVideo(
  ctx: OwnerWatchContext,
  card: BiliVideoCard,
): Promise<{ score: number | null; comment: string; reason: string }> {
  const systemPrompt = [
    ctx.characterPrompt,
    "",
    "你现在在看你主人新发的 B站 投稿。下面给你这条投稿的信息。",
    "用你自己的口吻写一句公开评论，会显示在视频评论区，主人和别的观众都看得见。",
    "",
    "输出格式（三行，不要别的）：",
    "分数：<0-20 的整数，你对这条的喜欢程度>",
    "理由：<一句话，只给你自己看>",
    "评论：<一句公开评论，20-60 字；拿不准就写「无」>",
    "",
    "底线：",
    "- 评论是公开的，不要提「主人」「私信」「额度」这类私下关系的词。",
    "- 不要写「沙发」「第一」「占楼」。",
    "- 不要编造视频内容 —— 你只看到标题，别假装看过画面。",
    "- 夸得具体一点（夸标题里的那个点），不要空夸。",
  ].join("\n");

  const stats = [
    // duration 是秒数（`readDuration` 统一转成整数），直接给模型看 195 没意义。
    card.duration > 0
      ? `时长：${Math.floor(card.duration / 60)}:${String(card.duration % 60).padStart(2, "0")}`
      : "",
    card.stat.view > 0 ? `播放：${card.stat.view}` : "",
    card.stat.like > 0 ? `点赞：${card.stat.like}` : "",
    card.stat.reply > 0 ? `评论：${card.stat.reply}` : "",
  ].filter(Boolean).join("　");

  const userPrompt = [
    `标题：《${card.title}》`,
    card.desc ? `简介：${card.desc}` : "",
    stats ? `数据：${stats}` : "",
    "",
    "按上面的格式输出。",
  ].filter(Boolean).join("\n");

  try {
    const reply = await callBiliModel({
      systemPrompt,
      userPrompt,
      model: ctx.model.model,
      apiKey: ctx.model.apiKey,
      apiBaseUrl: ctx.model.apiBaseUrl,
      temperature: 0.6,
      maxTokens: 2048,
      onUsage: ctx.model.onUsage,
    });
    return {
      score: parseScore(reply),
      comment: labeledLine(reply, "评论").slice(0, OWNER_COMMENT_MAX_CHARS),
      reason: labeledLine(reply, "理由"),
    };
  } catch (error) {
    ctx.notes.push(`给主人投稿打分失败：${error instanceof Error ? error.message : String(error)}`);
    return { score: null, comment: "", reason: "" };
  }
}

/**
 * 跑一轮主人互动。返回 null = 没开这个开关（调用方不用管）。
 *
 * 调用方（`runDutyRound`）负责把结果并进报告。
 */
export async function runOwnerWatch(ctx: OwnerWatchContext): Promise<OwnerWatchOutcome | null> {
  const { record, config, notes } = ctx;
  if (!config.ownerWatch) return null;

  const prisma = getPrisma();
  const bindingId = ctx.bindingId;
  if (!bindingId) {
    notes.push("主人互动：没有绑定记录，跳过。");
    return null;
  }

  const owner = await readOwner(record, notes);
  if (!owner?.mid) {
    notes.push("主人互动：bili CLI 里还没设主人（`bili owner set <UID>`），跳过。");
    return null;
  }

  const now = new Date();
  const today = ctx.day || toDay(now);
  const outcome: OwnerWatchOutcome = {
    fresh: 0, liked: 0, faved: 0, coined: 0, commented: 0, dm: false, following: true,
    baselineCreated: false, status: "done", items: [],
  };

  // 基线：第一次跑只落基线，不互动。
  const { baseline, created } = await readBaseline(bindingId, now);
  if (created) {
    outcome.baselineCreated = true;
    outcome.status = "baseline";
    notes.push(`主人互动：建立基线（${baseline.toISOString()}），从这之后主人新发的投稿才会互动。`);
    return outcome;
  }

  // 拉主人最近的投稿（按最新排序）。
  const list = await runBili(
    ["user", "videos", owner.mid, "--order", "new", "--size", String(OWNER_PAGE_SIZE)],
    biliOptions(record),
  );
  const listData = commandData(list.json, "拉主人投稿", notes);
  if (!listData) return outcome;

  const cards = parseVideoCards(listData);
  const freshWindowStart = now.getTime() - FRESH_WINDOW_MS;
  const fresh = cards.filter((card) => {
    const published = card.pubdate ? Date.parse(card.pubdate) : Number.NaN;
    if (Number.isNaN(published)) return false;
    return published > baseline.getTime() && published > freshWindowStart;
  });
  outcome.fresh = fresh.length;
  if (fresh.length === 0) {
    outcome.status = "no-fresh";
    return outcome;
  }

  // 处理过的（这条已经走完一轮互动）不再进。
  //
  // ⚠️ 这里**不能用 `bili_seen_videos` 判重**：那张表是「值班流看过什么」的账本，
  // 值班流会排除 7 天内的记录。如果这条线也往里写，主人的新投稿就会被她自己的互动线
  // 「吃掉」—— 互动做了，但刷视频那条线再也看不到它，等于没认真看。
  // 所以两套账分开：`owner-done` 管「这条互动走完没」，`bili_seen_videos` 只管值班流。
  const done = await prisma.biliAction.findMany({
    where: { bindingId, kind: "owner-done", bvid: { in: fresh.map((card) => card.bvid) } },
    select: { bvid: true },
  });
  const doneSet = new Set(done.map((row) => row.bvid ?? ""));
  const todo = fresh.filter((card) => !doneSet.has(card.bvid)).slice(0, FRESH_PER_ROUND);
  if (todo.length === 0) {
    outcome.status = "all-done";
    notes.push("主人互动：这几天新发的投稿都已经处理过了。");
    return outcome;
  }

  // 今日已投币数：硬币不可退，必须按天卡死。
  const coinedToday = config.ownerCoinMinScore > 0
    ? await prisma.biliAction.count({ where: { bindingId, day: today, kind: "owner-coin" } })
    : COIN_PER_DAY;
  let coinBudget = Math.max(0, COIN_PER_DAY - coinedToday);
  if (config.ownerCoinMinScore > 0 && coinBudget <= 0) {
    notes.push("主人互动：今天已经给主人投过币了，这一轮只点赞收藏。");
  }

  let fatal = false;

  for (const card of todo) {
    if (fatal) break;

    const relation = await readRelation(record, card.bvid);
    if (!relation) {
      notes.push(`主人互动：读不到 ${card.bvid} 的互动状态，跳过这条。`);
      continue;
    }
    if (!relation.followingUp) {
      outcome.following = false;
      notes.push("主人互动：还没关注主人（CLI 没有关注命令，需要手动点一下关注）。");
    }

    const actions: string[] = [];

    // 点赞
    if (config.ownerLike && !relation.liked) {
      const result = await runWrite(record, ["video", "like", card.bvid], `点赞 ${card.bvid}`, notes);
      if (result.ok) {
        outcome.liked += 1;
        actions.push("点赞");
        await prisma.biliAction.create({
          data: { bindingId, day: today, kind: "owner-like", bvid: card.bvid },
        }).catch(() => undefined);
      }
      if (result.fatal) fatal = true;
    }

    // 收藏
    if (config.ownerFav && !relation.favorited && !fatal) {
      const result = await runWrite(record, ["video", "fav", card.bvid], `收藏 ${card.bvid}`, notes);
      if (result.ok) {
        outcome.faved += 1;
        actions.push("收藏");
        await prisma.biliAction.create({
          data: { bindingId, day: today, kind: "owner-fav", bvid: card.bvid },
        }).catch(() => undefined);
      }
      if (result.fatal) fatal = true;
    }

    // 打分 + 评论：只有要投币或要评论时才值得为它花一次模型调用。
    const needJudge = (config.ownerComment || config.ownerCoinMinScore > 0) && !fatal;
    const judged = needJudge ? await judgeOwnerVideo(ctx, card) : { score: null, comment: "", reason: "" };

    // 投币：分数够 + 今天还没投过 + 账号上确实一个都没投。
    if (
      config.ownerCoinMinScore > 0
      && coinBudget > 0
      && !fatal
      && relation.coins === 0
      && judged.score !== null
      && judged.score >= config.ownerCoinMinScore
    ) {
      const result = await runWrite(
        record,
        ["video", "coin", card.bvid, "--coins", "1"],
        `投币 ${card.bvid}`,
        notes,
      );
      if (result.ok) {
        outcome.coined += 1;
        coinBudget -= 1;
        actions.push("投币 1");
        await prisma.biliAction.create({
          data: { bindingId, day: today, kind: "owner-coin", bvid: card.bvid, detail: `分数 ${judged.score}` },
        }).catch(() => undefined);
      }
      if (result.fatal) fatal = true;
    } else if (config.ownerCoinMinScore > 0 && relation.coins === 0 && judged.score !== null && coinBudget > 0) {
      notes.push(`《${card.title.slice(0, 20)}》${judged.score} 分没到投币门槛 ${config.ownerCoinMinScore}，不投。`);
    }

    // 评论：公开内容，必须过脱敏闸。
    if (config.ownerComment && judged.comment && !fatal) {
      const text = sanitizePublicText(judged.comment).slice(0, OWNER_COMMENT_MAX_CHARS);
      if (text) {
        const result = await withTempText(text, (path) =>
          runWrite(record, ["comment", "post", card.bvid, "--file", path, "--at", "owner"], `评论 ${card.bvid}`, notes),
        );
        if (result.ok) {
          outcome.commented += 1;
          actions.push("评论");
          await prisma.biliAction.create({
            data: { bindingId, day: today, kind: "owner-comment", bvid: card.bvid, detail: text },
          }).catch(() => undefined);
        }
        if (result.fatal) fatal = true;
      } else {
        notes.push(`《${card.title.slice(0, 20)}》的评论过不了公开闸（含 @ / 长数字 / 私下称呼），不发。`);
      }
    }

    outcome.items.push({
      bvid: card.bvid,
      title: card.title,
      url: card.url,
      score: judged.score,
      comment: judged.comment,
      actions,
    });

    // 这条互动走完了 —— 即使一个动作都没成功，也不在下一轮反复重试同一批
    // （风控中断的会留空 actions，那种本该重试，但反复重试反而更容易被判成脚本）。
    await prisma.biliAction.create({
      data: {
        bindingId,
        day: today,
        kind: "owner-done",
        bvid: card.bvid,
        detail: actions.length ? actions.join("、") : "无动作",
      },
    }).catch(() => undefined);
  }

  // 私信：只在这一轮真的动过手时发，汇总成一条（CLI 限 10 秒/次，不要拆成多条连发）。
  if (config.dmMode !== "off" && outcome.items.some((item) => item.actions.length > 0)) {
    const lines = [`看到你新发的啦：`];
    for (const item of outcome.items) {
      if (item.actions.length === 0) continue;
      lines.push(`《${item.title.slice(0, 40)}》`);
      lines.push(`　${item.actions.join("、")}　${item.url}`);
    }
    const text = lines.join("\n").slice(0, 480);
    const recipient = config.dmTargetUid || "owner";
    const result = await withTempText(text, (path) => {
      const argv = ["dm", "send", recipient, "--file", path];
      if (config.dmAllowNew) argv.push("--allow-new");
      return runWrite(record, argv, "私信主人", notes);
    });
    outcome.dm = result.ok;
  }

  return outcome;
}
