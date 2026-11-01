/**
 * bili CLI 输出解析 —— 把「UP 主」这类在不同命令里名字、形态都不统一的字段归一。
 *
 * 踩过的坑（这就是「记忆里 UP： 后面是空的」的根因）：
 *   列表命令（feed recommend / hot rank / search video）返回的卡片里
 *   `author` 是**对象** `{mid, name}`，不是字符串。早期实现写的是
 *   `typeof record.author === "string" ? record.author : ""`，于是恒为空。
 *   而 `video watch` / `video info` 又改用 `owner: {mid, name}`。
 * 这里一个 readAuthor() 全部兜住：字符串、对象、嵌套对象、uname/nickname 别名都认。
 */

export type BiliAuthor = { mid: string; name: string };

/** 作者字段可能叫这些名字（按优先级）。 */
const AUTHOR_NAME_KEYS = ["name", "uname", "up_name", "author", "nickname"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** mid / uid / rpid 这类标识在 JSON 里常常是数字，不能按字符串读。 */
function pickId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function pickNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * 时长统一成秒。
 * 列表卡片给的是秒数（number），但**搜索结果给的是 `"05:00"` 这种字符串**，
 * 直接 Number() 会得到 NaN。
 */
function readDuration(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map((part) => Number(part));
      if (parts.every((part) => Number.isFinite(part))) {
        // "05:00" → 300 秒；"1:05:00" → 3900 秒
        return parts.reduce((total, part) => total * 60 + part, 0);
      }
    }
    const direct = Number(trimmed);
    if (Number.isFinite(direct)) return Math.max(0, Math.round(direct));
  }
  return 0;
}

/**
 * 把任意形态的作者字段归一成 `{mid, name}`。
 * 接受：`"昵称"` / `{mid, name}` / `{uname}` / `{author: {...}}`。
 */
export function readAuthor(value: unknown, depth = 0): BiliAuthor {
  if (depth > 3) return { mid: "", name: "" };
  if (typeof value === "string") return { mid: "", name: value.trim() };
  const record = asRecord(value);
  if (!record) return { mid: "", name: "" };

  const mid = pickId(record.mid) || pickId(record.uid);
  for (const key of AUTHOR_NAME_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return { mid, name: candidate.trim() };
    }
    // 防御：author 里又套了一层对象
    if (candidate && typeof candidate === "object") {
      const nested = readAuthor(candidate, depth + 1);
      if (nested.name) return { mid: mid || nested.mid, name: nested.name };
    }
  }
  return { mid, name: "" };
}

/** `{"ok":true,"data":…}` 取 data；裸对象/数组原样返回。 */
export function unwrapBiliData(json: unknown): unknown {
  const record = asRecord(json);
  if (record && "data" in record) return record.data;
  return json;
}

/** 列表命令的结果列表：顶层数组，或 items / list / result / data 里的数组。 */
function extractRawList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  for (const key of ["items", "list", "result", "data"]) {
    const inner = record[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/** feed 的推荐理由：可能是字符串，也可能是 `{content}`。 */
function readReason(record: Record<string, unknown>): string {
  const raw = record.reason ?? record.rcmd_reason;
  const nested = asRecord(raw);
  if (nested) return pickString(nested.content).slice(0, 120);
  return pickString(raw).slice(0, 120);
}

export type BiliVideoStat = {
  view: number;
  like: number;
  danmaku: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
};

export type BiliVideoCard = {
  bvid: string;
  title: string;
  author: BiliAuthor;
  desc: string;
  /** 推荐流给的推荐理由（反映这个账号平时看什么）。 */
  reason: string;
  duration: number;
  pubdate: string;
  url: string;
  stat: BiliVideoStat;
};

function readStat(record: Record<string, unknown>): BiliVideoStat {
  // 列表卡片（feed / hot rank）有 stat 对象；搜索结果把 play / favorites 平铺在顶层。
  const stat = asRecord(record.stat) ?? {};
  return {
    view: pickNumber(stat.view ?? record.play),
    like: pickNumber(stat.like),
    danmaku: pickNumber(stat.danmaku ?? record.danmaku ?? record.video_review),
    reply: pickNumber(stat.reply ?? record.comment),
    favorite: pickNumber(stat.favorite ?? record.favorites),
    coin: pickNumber(stat.coin),
    share: pickNumber(stat.share),
  };
}

/** 解析列表命令的卡片数组（feed recommend / hot rank / search video 通用）。 */
export function parseVideoCards(data: unknown): BiliVideoCard[] {
  const cards: BiliVideoCard[] = [];
  for (const raw of extractRawList(data)) {
    const record = asRecord(raw);
    if (!record) continue;
    const bvid = pickString(record.bvid) || pickString(record.bv_id);
    if (!bvid) continue;
    cards.push({
      bvid,
      title: pickString(record.title).slice(0, 200),
      author: readAuthor(record.author ?? record.owner ?? record.up),
      desc: pickString(record.desc).slice(0, 200),
      reason: readReason(record),
      duration: readDuration(record.duration),
      pubdate: pickString(record.pubdate),
      url: pickString(record.url) || `https://www.bilibili.com/video/${bvid}`,
      stat: readStat(record),
    });
  }
  return cards;
}

export type BiliWatchedVideo = {
  bvid: string;
  title: string;
  author: BiliAuthor;
  desc: string;
  tags: string[];
  aiSummary: string;
  transcriptSource: string;
  transcriptText: string;
  chapters: Array<{ from: number; to: number; title: string }>;
  hotComments: Array<{ user: string; content: string; like: number }>;
  danmakuPeaks: Array<{ timeStr: string; count: number; top: string[] }>;
  framesSheet: string;
  duration: number;
  stat: BiliVideoStat;
};

/**
 * 解析 `bili video watch` 的结果。
 * 结构：`{bvid, aid, title, desc, owner:{mid,name}, stat, tags, chapters, ai_summary,
 *         transcript:{source,text}, hot_comments:[{user,content,like}], danmaku:{total,peaks:[...]},
 *         frames_sheet}`
 */
export function parseWatchedVideo(data: unknown): BiliWatchedVideo | null {
  const record = asRecord(data);
  if (!record) return null;
  const bvid = pickString(record.bvid);
  if (!bvid) return null;

  const transcript = asRecord(record.transcript) ?? {};
  const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [];
  const chapters = Array.isArray(record.chapters)
    ? record.chapters
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => !!c)
        .map((c) => ({
          from: pickNumber(c.from),
          to: pickNumber(c.to),
          title: pickString(c.title),
        }))
    : [];
  const hotComments = Array.isArray(record.hot_comments)
    ? record.hot_comments
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => !!c)
        .map((c) => ({
          user: pickString(c.user),
          content: pickString(c.content).slice(0, 200),
          like: pickNumber(c.like),
        }))
    : [];
  const danmaku = asRecord(record.danmaku) ?? {};
  const danmakuPeaks = Array.isArray(danmaku.peaks)
    ? danmaku.peaks
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => !!p)
        .map((p) => ({
          timeStr: pickString(p.time_str),
          count: pickNumber(p.count),
          top: Array.isArray(p.top) ? p.top.filter((t): t is string => typeof t === "string").slice(0, 3) : [],
        }))
    : [];

  return {
    bvid,
    title: pickString(record.title).slice(0, 200),
    author: readAuthor(record.owner ?? record.author ?? record.up),
    desc: pickString(record.desc).slice(0, 800),
    tags: tags.slice(0, 12),
    aiSummary: pickString(record.ai_summary),
    transcriptSource: pickString(transcript.source),
    transcriptText: pickString(transcript.text),
    chapters,
    hotComments,
    danmakuPeaks,
    framesSheet: pickString(record.frames_sheet),
    duration: readDuration(record.duration),
    stat: readStat(record),
  };
}

function formatDuration(seconds: number): string {
  if (!seconds) return "未知";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/**
 * 把「看懂」的结果压成一段给模型看的紧凑文本。
 * watch 的原始 JSON 很大（字幕动辄几千字），不裁剪会挤爆上下文。
 */
export function formatWatchedForModel(video: BiliWatchedVideo, transcriptChars = 1200): string {
  const lines: string[] = [
    `标题：${video.title}`,
    `UP：${video.author.name || "（未知）"}`,
    `时长：${formatDuration(video.duration)}`,
  ];
  if (video.tags.length) lines.push(`标签：${video.tags.join(" / ")}`);
  if (video.desc) lines.push(`简介：${video.desc.slice(0, 300)}`);
  if (video.aiSummary) lines.push(`B站 AI 总结：${video.aiSummary.slice(0, 400)}`);
  if (video.transcriptText && transcriptChars > 0) {
    const text = video.transcriptText.replace(/\s+/g, " ").trim();
    lines.push(`正文（${video.transcriptSource || "字幕"}）：${text.slice(0, transcriptChars)}`);
  } else {
    lines.push("正文：无字幕/未转写");
  }
  if (video.hotComments.length) {
    lines.push("热评：");
    for (const comment of video.hotComments.slice(0, 5)) {
      lines.push(`- ${comment.user || "匿名"}：${comment.content}（赞 ${comment.like}）`);
    }
  }
  return lines.join("\n");
}

/** 列表卡片的紧凑描述（粗筛阶段给模型看）。 */
export function formatCardForModel(card: BiliVideoCard, index: number): string {
  const parts = [`${index + 1}. [${card.bvid}] ${card.title}（UP：${card.author.name || "未知"}）`];
  const meta: string[] = [];
  if (card.duration) meta.push(formatDuration(card.duration));
  if (card.stat.view) meta.push(`播放 ${card.stat.view}`);
  if (card.stat.danmaku) meta.push(`弹幕 ${card.stat.danmaku}`);
  if (card.reason) meta.push(`推荐理由：${card.reason}`);
  if (meta.length) parts.push(`   ${meta.join(" · ")}`);
  if (card.desc) parts.push(`   简介：${card.desc.slice(0, 80)}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 模型判词的解析
// ---------------------------------------------------------------------------

/** 表示「不要」的词。判定顺序很关键，见 parseVerdict。 */
const NEGATIVE_WORDS = ["不值得", "不值", "跳过", "不看", "没意思", "别推", "skip", "pass"];
const POSITIVE_WORDS = ["值得"];

/**
 * 解析模型对单条视频的判词。
 *
 * 为什么不直接 `reply.includes("值得")`：因为「不**值得**」里也含「值得」，
 * 老实现会把明确的否定判成挑中，等于白挑。这里改成取最早出现的判词定性。
 */
export function parseVerdict(reply: string): { worth: boolean; reason: string } {
  const text = (reply || "").trim();
  const reason = text.slice(0, 200);
  if (!text) return { worth: false, reason: "" };

  const lowered = text.toLowerCase();
  let firstNegative = -1;
  for (const word of NEGATIVE_WORDS) {
    const at = lowered.indexOf(word.toLowerCase());
    if (at >= 0 && (firstNegative < 0 || at < firstNegative)) firstNegative = at;
  }
  let firstPositive = -1;
  for (const word of POSITIVE_WORDS) {
    const at = lowered.indexOf(word);
    if (at >= 0 && (firstPositive < 0 || at < firstPositive)) firstPositive = at;
  }

  // 都不出现 → 保守判为跳过：宁可漏一条，也不拿噪音占主人的注意力
  if (firstPositive < 0) return { worth: false, reason };
  if (firstNegative >= 0 && firstNegative < firstPositive) return { worth: false, reason };
  return { worth: true, reason };
}

/**
 * 解析终判给的分数（0-20）。
 *
 * 找不到返回 null 而不是 0：0 分的意思是「差到极点」，会被当成当天最低分压掉别的东西；
 * 而「这轮没打分」应该当作没发生。两者混在一起，收藏与发动态的阈值判定就全乱了。
 */
export function parseScore(reply: string): number | null {
  const match = (reply || "").match(/分数\s*[：:]\s*(\d{1,2})/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(20, Math.round(value)));
}

/**
 * 公开发布前的脱敏闸。动态是所有人都看得到的，而理由那段话本来是写给主人的。
 *
 * 只挡最常见的几种：@ 提及、长数字串（QQ 号 / UID）、以及把私密关系说出口的句子。
 * 这不是完备的语义防护 —— 真正的边界是「理由由终判在看过人设后写、不读私信」。
 */
export function sanitizePublicText(text: string): string {
  return (text || "")
    .split(/(?<=[。！？!?\n])/)
    .filter((part) => !/主人|私信|报备|额度|群友/.test(part))
    .join("")
    .replace(/@\S+/g, "")
    .replace(/\d{6,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 宽松 JSON 解析已抽到 `server/utils/loose-json.ts`（主动机制也用），直接从那边引。 */

/** 从模型返回里提取 bvid 列表（JSON 解析失败时的兜底）。 */
export function extractBvids(text: string): string[] {
  const found = (text || "").match(/BV[0-9A-Za-z]{10}/g) ?? [];
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// bili CLI 的错误结构
// ---------------------------------------------------------------------------

export type BiliCliError = { code: string; message: string; hint: string };

/** `{"ok":false,"error":{code,message,hint}}` → 错误对象；成功返回 null。 */
export function readBiliError(json: unknown): BiliCliError | null {
  const record = asRecord(json);
  if (!record || record.ok !== false) return null;
  const error = asRecord(record.error);
  return {
    code: pickString(error?.code) || "unknown_error",
    message: pickString(error?.message),
    hint: pickString(error?.hint),
  };
}

/** 这类错误出现时必须立刻停手，不能重试、不能换方式绕。 */
export function isFatalBiliError(code: string): boolean {
  return (
    code === "risk_control" ||
    code === "captcha_required" ||
    code === "auth_expired" ||
    code === "not_logged_in" ||
    code === "login_pending"
  );
}

/** 本地限流：等一会儿可以恢复，但要按 CLI 给的 retry_after 来。 */
export function isRateLimited(code: string): boolean {
  return code === "rate_limited";
}

/**
 * `bili owner show` / `owner set` 的返回：`{ ok: true, data: { owner: { mid, name } } }`。
 * 没设过主人时 CLI 也可能回 `owner: null`，所以读不到就返回 null，不要造一个空壳。
 */
export type BiliOwner = { mid: string; name: string };

export function parseBiliOwner(json: unknown): BiliOwner | null {
  const data = asRecord(unwrapBiliData(json));
  const owner = asRecord(data?.owner);
  if (!owner) return null;
  const mid = pickId(owner.mid) || pickId(owner.uid);
  const name = pickString(owner.name) || pickString(owner.uname);
  if (!mid && !name) return null;
  return { mid, name: name || mid };
}

/**
 * `bili me show` 的账号资料：
 * `{ ok: true, data: { mid, name, sign, level, coins, face, sex, url } }`。
 *
 * face 是 i0/i2.hdslb.com 的头像地址，前端直连加载（`referrerpolicy="no-referrer"`，
 * 和视频封面同一个路子，服务端不缓存二进制）。url 就是主页地址，CLI 给了就用，没给就按 mid 拼。
 */
export type BiliMe = {
  mid: string;
  name: string;
  face: string;
  level: number;
  sign: string;
  homeUrl: string;
};

export function parseBiliMe(json: unknown): BiliMe | null {
  const data = asRecord(unwrapBiliData(json));
  // 兼容两种形状：资料直接在 data 上，或包一层 data.profile。
  const me = asRecord(data?.profile) ?? data;
  if (!me) return null;
  const mid = pickId(me.mid) || pickId(me.uid);
  const name = pickString(me.name) || pickString(me.uname);
  if (!mid && !name) return null;

  let face = pickString(me.face);
  if (face.startsWith("//")) face = `https:${face}`;
  const homeUrl = pickString(me.url) || (mid ? `https://space.bilibili.com/${mid}` : "");
  return {
    mid,
    name: name || mid,
    face,
    level: pickNumber(me.level),
    sign: pickString(me.sign),
    homeUrl,
  };
}
