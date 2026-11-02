/**
 * QQ 空间：让她能发说说、看好友动态、评论别人的说说。
 *
 * 为什么没有走「网页版自动化」那条路：Playwright 点页面最稳也最贵（要开浏览器、
 * 要维护登录态、还慢）；而协议端（SnowLuma / NapCat 一系）本来就已经登录着她的 QQ，
 * 手里就有 `p_skey`。所以这里分两档：
 *
 * 1. **协议端扩展 action**（`send_qzone_msg`）：发说说。不用管 cookie，协议端负责。
 * 2. **空间网页 CGI**：评论、好友动态。协议端没实现这些 —— 拿 `get_cookies` 要一份
 *    `qzone.qq.com` 的 cookie，自己算 `g_tk` 去调。
 *
 * 三条硬约束（都是踩出来的，别改）：
 *
 * - **没有 tid 不等于没发出去。** 协议端可能发成功了只是响应里没带 tid。这时重试就是
 *   连发两条 —— 所有现成实现都在 README 里加粗警告过这一点。所以本模块只在明确
 *   「动作不存在」时才降级重试，其余失败一律交给人工去空间确认。
 * - **cookie / g_tk 会过期。** 每次调用失败都先清缓存重取一次，第二次仍失败就停手报错，
 *   不要在一个已经失效的凭证上死循环。
 * - **这是别人的地盘。** 腾讯服务条款禁止自动化，频率必须自己压住：日上限 + 冷却，
 *   见 `QZONE_DEFAULT_LIMITS`。
 */

import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import { getPrisma } from "../../prisma";
import { callRawModel } from "../../raw-llm";
import { readDailyQuota, recordModelUsage, type ModelUsageTokens } from "../../model-usage";
import { callOnebotAction, getOnebotCookies, sendOnebotQzonePost, type OnebotConnectionConfig } from "./client";

export const QZONE_ACTION_TTL_MS = 10 * 60 * 1000;
export const QZONE_MAX_POST_CHARS = 1_000;
export const QZONE_MAX_COMMENT_CHARS = 200;
export const QZONE_CONFIRM_POST = "确认发说说";
export const QZONE_CONFIRM_COMMENT = "确认评论";

/** 可见范围：QQ 空间自己的编码，传错不会报错、只会发到不该发的范围。 */
export const QZONE_VISIBLE = { PUBLIC: 1, FRIENDS: 4, SELF: 64 } as const;

/**
 * 默认配额。压得比「发得爽」低得多：这是别人的地盘，被风控要验证码的代价
 * 远大于多发两条说说。可在连接 metadata 里放宽。
 */
export const QZONE_DEFAULT_LIMITS = {
  dailyPosts: 3,
  dailyComments: 8,
  commentCooldownMinutes: 30,
} as const;

const QZONE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const QZONE_TAOTAO = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin";
/**
 * 说说列表接口在 `taotao.qq.com`（**没有** `.qzone` 那一段）。
 * 和发表/评论的 `taotao.qzone.qq.com` 是两个域名，抄错会拿到 302 到登录页。
 */
const QZONE_TAOTAO_MOOD = "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin";
const QZONE_TIMEOUT_MS = 15_000;

export type QzoneCredential = {
  uin: string;
  cookie: string;
  /** 算 g_tk 用的那个值：优先 p_skey，退化到 skey。 */
  pSkey: string;
  gtk: number;
};

export type QzoneFeed = {
  tid: string;
  uin: string;
  nickname: string;
  excerpt: string;
  time: string;
};

/* ------------------------------------------------------------------ *
 * 纯函数：g_tk / cookie / JSONP / HTML
 * ------------------------------------------------------------------ */

/**
 * `p_skey` → `g_tk`。
 *
 * 就是 QQ 全家桶那个经典哈希：从 5381 起，每位 `h += (h << 5) + code`，取低 31 位。
 * 每一步都 `& 0x7fffffff` 是必须的 —— JS 的 `<<` 是 32 位有符号运算，长 cookie
 * 不截断会溢出成负数，算出来的 g_tk 完全不对，接口只回一个 `-3000`。
 */
export function computeQzoneGtk(pSkey: string): number {
  let hash = 5381;
  for (let index = 0; index < pSkey.length; index += 1) {
    hash += (hash << 5) + pSkey.charCodeAt(index);
    hash &= 0x7fffffff;
  }
  return hash;
}

export function parseQzoneCookieString(raw: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const part of String(raw ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key) pairs[key] = value;
  }
  return pairs;
}

/** `uin=o0123456789` 里的 `o` 前缀要去掉，接口只认纯数字。 */
export function normalizeQzoneUin(value: string): string {
  const trimmed = String(value ?? "").trim().replace(/^o/u, "");
  return /^\d{5,15}$/u.test(trimmed) ? trimmed : "";
}

export function buildQzoneCredential(rawCookie: string, fallbackUin = ""): QzoneCredential | null {
  const pairs = parseQzoneCookieString(rawCookie);
  const uin = normalizeQzoneUin(pairs.uin ?? pairs.p_uin ?? "")
    || normalizeQzoneUin(fallbackUin);
  // p_skey 是空间的；只有 skey 时也试一次（部分接口认），但成功率明显低。
  const token = pairs.p_skey || pairs.skey || "";
  if (!uin || !token) return null;
  return { uin, cookie: rawCookie, pSkey: token, gtk: computeQzoneGtk(token) };
}

/**
 * 拆 JSONP 外壳。空间的老接口几乎全是 `_Callback({...});`，直接 `JSON.parse` 必炸。
 * 响应本身就是纯 JSON 时原样解析 —— 新接口偶尔这么给。
 */
export function parseQzoneJsonp(raw: string): unknown {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // 先当纯 JSON 试：`format=json` 的接口（评论、发说说）回的就是裸 JSON，
  // 而 `data.feeds` 里那串 HTML 会带 `(` / `)`，若先按 JSONP 切括号会被切坏。
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 不是纯 JSON，再按 `_Callback({...});` 的 JSONP 外壳拆。
  }
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  const body = start >= 0 && end > start ? text.slice(start + 1, end) : text;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function stripQzoneHtml(value: string): string {
  return String(value ?? "")
    // 图片表情在正文里是 <img src="..."/>：留个占位，否则「配了个表情」这件事会消失。
    .replace(/<img[^>]*>/giu, "[图片]")
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<[^>]+>/gu, "")
    .replace(/&[a-zA-Z#0-9]+;/gu, (entity) => HTML_ENTITIES[entity] ?? " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 秒级时间戳 → 人话。列表要让主人一眼看出「这是刚才的还是前天的」。 */
export function formatQzoneTime(seconds: number, now = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(Math.max(0, now - seconds * 1_000) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(seconds * 1_000);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/**
 * 解析 `emotion_cgi_msglist_v6` 的说说列表。
 *
 * 为什么不用 `feeds3_html_more`（好友动态）：2026-11-02 实测它回的是**非标准 JSON**
 * （键不带引号、字符串用单引号），`JSON.parse` 直接失败；而且返回的 `data.main`
 * 里只有翻页参数、一条说说都没有。反过来 `emotion_cgi_msglist_v6?uin=<某人>` 是
 * 干净 JSON，`tid` / `content` / `created_time` / `cmtnum` 全都有 —— 评论需要的正是 tid。
 *
 * 代价是：它是「按人查」，不是「一条聚合流」。所以「看看空间」会按好友名单逐个拉，
 * 见 `listQzoneFriendMoods`。
 */
export function parseQzoneMoodList(payload: unknown, fallbackUin = ""): QzoneFeed[] {
  const record = (payload ?? {}) as { msglist?: unknown; data?: { msglist?: unknown } };
  const list = Array.isArray(record.msglist)
    ? record.msglist
    : Array.isArray(record.data?.msglist)
      ? record.data.msglist
      : [];

  const feeds: QzoneFeed[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const mood = item as Record<string, unknown> | null;
    const tid = typeof mood?.tid === "string" ? mood.tid.trim() : "";
    if (!tid || seen.has(tid)) continue;
    // secret 非 0 是私密/部分可见的说说，评论它没有意义，也容易踩到「无权限」。
    if (typeof mood?.secret === "number" && mood.secret !== 0) continue;

    const uin = normalizeQzoneUin(String(mood?.uin ?? "")) || normalizeQzoneUin(fallbackUin);
    if (!uin) continue;

    const content = stripQzoneHtml(String(mood?.content ?? ""));
    const created = Number(mood?.created_time ?? 0);
    seen.add(tid);
    feeds.push({
      tid,
      uin,
      nickname: String(mood?.name ?? "").trim() || uin,
      excerpt: content.slice(0, 200) || "（这条只有图，没写字）",
      time: formatQzoneTime(created),
    });
  }
  return feeds;
}

/* ------------------------------------------------------------------ *
 * 指令解析
 * ------------------------------------------------------------------ */

/**
 * 「发条说说：今天下雨」/「发个空间说说」/「说说：……」
 *
 * 与群公告同一条原则：必须有动作或冒号。「这条说说真好看」是闲聊，不能触发。
 */
export function parseQzonePostRequest(content: string): { topic: string } | null {
  const text = String(content ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  if (isQzoneConfirm(text, "POST") || isQzoneConfirm(text, "COMMENT")) return null;

  const matched = /(?:发|写|来|更新|置顶)(?:一|个|条|篇)?(?:条)?\s*(?:QQ\s*)?(?:空间|说说)/iu.test(text)
    || /(?:QQ\s*)?空间\s*[：:]/iu.test(text)
    || /说说\s*[：:]/u.test(text);
  if (!matched) return null;

  // 把「发个空间说说：」这一整段引导语剥掉，剩下的才是主题。
  // 只从「说说/空间」处切会让「发个空间说说」变成主题「空间说说」—— 模型会照着它编一句。
  const stripped = text
    .replace(
      /^(?:帮我|给我|替我)?\s*(?:发|写|来|更新|置顶)(?:一|个|条|篇)?(?:条)?\s*(?:QQ\s*)?(?:(?:空间)?说说|空间)\s*[：:]?\s*/iu,
      "",
    )
    .replace(/^(?:QQ\s*)?(?:说说|空间)\s*[：:]\s*/iu, "")
    .trim();

  // 一句都没剥掉 = 这种说法没认出来，宁可让模型自由发挥，也别把整条指令当主题。
  const topic = stripped === text ? "" : stripped;
  return { topic: topic.slice(0, QZONE_MAX_POST_CHARS) };
}

/**
 * 「看看空间」「去空间逛逛」「看看 123456 的空间」。
 *
 * 带 QQ 号就是只看那个人；不带就按好友名单挑几个人的最近说说
 * （空间没有可靠的「一条聚合动态流」，见 `parseQzoneMoodList` 的说明）。
 */
export function parseQzoneBrowseRequest(content: string): { targetUin: string } | null {
  const text = String(content ?? "").replace(/\s+/gu, "").trim();
  if (!text || text.length > 40) return null;
  // 「空间站」不是空间。这个歧义在中文里太常见，先挡掉再谈别的。
  if (/空间站/u.test(text)) return null;
  const matched = /(?:看看|瞅瞅|翻翻|逛逛|刷刷|看一眼|去)(?:一下|一圈)?[^\s]{0,12}?空间/u.test(text)
    || /(?:有谁|谁)(?:发|更新)(?:了)?(?:说说|空间)/u.test(text)
    || /空间动态|好友动态/u.test(text);
  if (!matched) return null;
  // 「看看 123456 的空间」里的号：整句里第一个 5~12 位数字就是它。
  const uin = text.match(/(\d{5,12})/u)?.[1] ?? "";
  return { targetUin: normalizeQzoneUin(uin) };
}

/**
 * 「评论第 2 条：好可爱」/「评论 3 好可爱」/「评论 12345678 3：写得真好」。
 *
 * 序号指的是上一条「看看空间」列出来的顺序 —— 没列过就没有序号可用，
 * 那种情况下让用户重新说一次，比猜一条去评论安全得多。
 */
export function parseQzoneCommentRequest(
  content: string,
): { index: number | null; body: string } | null {
  const text = String(content ?? "").trim();
  if (!text) return null;
  if (isQzoneConfirm(text, "COMMENT")) return null;

  // 末尾那个 lookahead 是必须的：「评论家都是骗子」不是指令。只有「评论」后面紧跟
  // 空格、序号、标点或直接结束，才算在让她评论。
  const matched = text.match(
    /^评论(?:一下)?(?=\s|第|\d|[：:、,，]|$)\s*(?:第\s*(\d{1,2})\s*(?:条|个)?|(\d{1,2})\s*[：:、,，\s])?\s*[：:、,，]?\s*([\s\S]*)$/u,
  );
  if (!matched) return null;
  const rawIndex = matched[1] ?? matched[2];
  const index = rawIndex ? Number(rawIndex) : null;
  const body = (matched[3] ?? "").trim().slice(0, QZONE_MAX_COMMENT_CHARS);
  // 给了序号没给内容 = 让鱼自己写一句；两头都没有就是没听懂。
  if (index === null && !body) return null;
  return { index: index && index > 0 ? index : null, body };
}

/**
 * 确认词分开写，是因为公告那句「确认发布」已经在用了。
 * 共用一套确认词的话，一条「确认发布」到底发公告还是发说说，代码无从判断。
 */
export function isQzoneConfirm(content: string, kind: "POST" | "COMMENT"): boolean {
  const text = String(content ?? "")
    .replace(/@\d+/gu, "")
    .replace(/\s+/gu, "")
    .replace(/[。！!～~]+$/u, "");
  return text === (kind === "POST" ? QZONE_CONFIRM_POST : QZONE_CONFIRM_COMMENT);
}

/** 主人对「我想发/评论，行吗」的**同意**回复。口语也认，但只认短词，避免误判。 */
export function isQzoneApprove(content: string): boolean {
  const text = String(content ?? "")
    .replace(/@\d+/gu, "")
    .replace(/\s+/gu, "")
    .replace(/[。！!～~]+$/u, "");
  return /^(?:行|可以|好|嗯|ok|可|发吧|发|评吧|评论吧|同意|准了|没问题)$/iu.test(text);
}

/** 主人对「行吗」的**拒绝**回复。和同意一样，只认短词。 */
export function isQzoneReject(content: string): boolean {
  const text = String(content ?? "")
    .replace(/@\d+/gu, "")
    .replace(/\s+/gu, "")
    .replace(/[。！!～~]+$/u, "");
  return /^(?:不行|不好|不要|别|算了|不|否|拒绝|别发|别评|不用|不了)$/iu.test(text);
}

/* ------------------------------------------------------------------ *
 * 凭证
 * ------------------------------------------------------------------ */

type CachedCredential = { credential: QzoneCredential; at: number };
const credentialCache = new Map<string, CachedCredential>();
const CREDENTIAL_TTL_MS = 20 * 60 * 1000;

export function clearQzoneCredentialCache(config: OnebotConnectionConfig): void {
  credentialCache.delete(config.httpUrl);
}

/**
 * 拿一份能用的空间凭证。顺序：环境变量 → 协议端。
 *
 * 环境变量排在前面不是随意：调试时最想要的是「我贴的这份 cookie 到底能不能用」，
 * 如果协议端那边有一份坏的，永远轮不到手动这份，人就会以为代码写错了。
 */
export async function resolveQzoneCredential(
  config: OnebotConnectionConfig,
  options: { force?: boolean } = {},
): Promise<QzoneCredential> {
  const key = config.httpUrl;
  const cached = credentialCache.get(key);
  if (!options.force && cached && Date.now() - cached.at < CREDENTIAL_TTL_MS) {
    return cached.credential;
  }

  const envCookie = (process.env.QZONE_COOKIE ?? "").trim();
  if (envCookie) {
    const credential = buildQzoneCredential(envCookie, process.env.QZONE_UIN ?? "");
    if (credential) {
      credentialCache.set(key, { credential, at: Date.now() });
      return credential;
    }
    throw new Error("QZONE_NO_AUTH: 环境变量 QZONE_COOKIE 里没有 p_skey 或 uin。");
  }

  let raw = "";
  try {
    raw = await getOnebotCookies(config, "qzone.qq.com");
  } catch (error) {
    throw new Error(
      `QZONE_NO_AUTH: 协议端没有返回 qzone.qq.com 的 cookie（${error instanceof Error ? error.message : String(error)}）。`
      + " 可以先跑 yarn probe:qzone 看这条通道通不通。",
    );
  }
  const credential = buildQzoneCredential(raw);
  if (!credential) {
    throw new Error("QZONE_NO_AUTH: 协议端返回的 cookie 里没有 p_skey，无法计算 g_tk。");
  }
  credentialCache.set(key, { credential, at: Date.now() });
  return credential;
}

/* ------------------------------------------------------------------ *
 * 空间 CGI
 * ------------------------------------------------------------------ */

async function qzoneRequest(
  url: string,
  auth: QzoneCredential,
  init: { method?: "GET" | "POST"; form?: Record<string, string>; referer?: string } = {},
): Promise<unknown> {
  const method = init.method ?? "POST";
  const body = init.form ? new URLSearchParams(init.form).toString() : undefined;
  const response = await fetch(url, {
    method,
    headers: {
      "user-agent": QZONE_UA,
      cookie: auth.cookie,
      referer: init.referer ?? `https://user.qzone.qq.com/${auth.uin}`,
      origin: "https://user.qzone.qq.com",
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(QZONE_TIMEOUT_MS),
  });
  // 登录态失效时空间会 302 到登录页，而不是回一个 JSON —— 只看 HTTP 状态码不够。
  if (response.status === 401 || response.status === 403 || response.redirected) {
    throw new Error(`QZONE_AUTH_${response.status}: 空间拒绝了这次请求，cookie 可能已失效。`);
  }
  if (!response.ok) {
    throw new Error(`QZONE_HTTP_${response.status}: 空间接口请求失败。`);
  }
  return parseQzoneJsonp(await response.text());
}

/**
 * 校验空间接口返回的业务码。
 *
 * 和 OneBot 一样：HTTP 200 不代表成功，失败信息在 body 里。空间这边的常见码：
 * `-3000` 未登录 / cookie 失效，`-10000` 操作太频繁，`-10001` 参数不对。
 * 全都抛出去，让上层决定是重取凭证还是直接放弃。
 */
export function assertQzoneOk(payload: unknown, what: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new Error(`QZONE_BAD_RESPONSE: ${what}返回的不是 JSON。`);
  }
  const record = payload as Record<string, unknown>;
  const rawCode = record.code ?? record.ret ?? 0;
  const code = typeof rawCode === "string" ? Number(rawCode) : rawCode;
  if (typeof code === "number" && Number.isFinite(code) && code !== 0) {
    const message = typeof record.message === "string" ? record.message
      : typeof record.msg === "string" ? record.msg
        : "";
    throw new Error(`QZONE_API_${code}: ${what}失败${message ? `（${message}）` : ""}。`);
  }
  return record;
}

/** 发说说：网页 CGI 兜底路径。协议端不支持 `send_qzone_msg` 时才走这里。 */
export async function publishQzonePostViaCgi(
  auth: QzoneCredential,
  input: { content: string; visible?: number },
): Promise<{ tid: string | null }> {
  const payload = await qzoneRequest(
    `${QZONE_TAOTAO}/emotion_cgi_publish_v6?g_tk=${auth.gtk}`,
    auth,
    {
      form: {
        syn_tweet_verson: "1",
        paramstr: "1",
        who: "1",
        con: input.content,
        feedversion: "1",
        ver: "1",
        ugc_right: String(input.visible ?? QZONE_VISIBLE.PUBLIC),
        to_sign: "0",
        hostuin: auth.uin,
        code_version: "1",
        format: "json",
        qzreferrer: `https://user.qzone.qq.com/${auth.uin}`,
      },
    },
  );
  const record = assertQzoneOk(payload, "发表说说");
  const tid = record.tid ?? (record.data as { tid?: unknown } | undefined)?.tid;
  return { tid: typeof tid === "string" && tid.trim() ? tid.trim() : null };
}

/**
 * 评论别人的说说。
 *
 * 协议端的空间扩展只覆盖「自己发」，评论得自己调 `emotion_cgi_re_feeds`。
 *
 * 踩过的坑（2026-11-02 实测 `-10004 参数错误`，对照开源实现修正）：
 * - **`topicId` 是 `{uin}_{tid}__1` 三段式，不是裸 tid**。之前直接传 tid，接口回 `-10004`。
 *   末尾 `__1` 是评论类型标记（1 = 普通评论，2 = 回复）。
 * - `hostUin` 是**被评论的人**，`uin` 是她自己 —— 写反会变成给自己留言。
 * - 必填还有 `plat=qzone` / `source=ic` / `format=fs` / `ref=feeds` / `paramstr=1`，
 *   缺了也会参数错。`platformid` 用 52。
 */
export async function commentQzoneFeed(
  config: OnebotConnectionConfig,
  input: { targetUin: string; tid: string; content: string; replyCommentId?: string },
  options: { forceAuth?: boolean } = {},
): Promise<void> {
  const auth = await resolveQzoneCredential(config, { force: options.forceAuth });
  const targetUin = normalizeQzoneUin(input.targetUin);
  if (!targetUin || !input.tid) throw new Error("QZONE_BAD_TARGET: 缺少评论目标（uin 或 tid）。");
  const payload = await qzoneRequest(
    `${QZONE_TAOTAO}/emotion_cgi_re_feeds?g_tk=${auth.gtk}`,
    auth,
    {
      form: {
        topicId: `${targetUin}_${input.tid}__1`,
        feedsType: "100",
        inCharset: "utf-8",
        outCharset: "utf-8",
        plat: "qzone",
        source: "ic",
        // hostUin 是**被评论的人**，uin 是她自己 —— 这两个写反了会变成给自己留言。
        hostUin: targetUin,
        isSignIn: "",
        platformid: "52",
        uin: auth.uin,
        format: "json",
        ref: "feeds",
        content: input.content,
        richval: "",
        richtype: "",
        private: "0",
        paramstr: "1",
        qzreferrer: `https://user.qzone.qq.com/${targetUin}`,
        ...(input.replyCommentId ? { commentId: input.replyCommentId } : {}),
      },
    },
  );
  assertQzoneOk(payload, "评论说说");
}

/**
 * 某个人的说说列表（`emotion_cgi_msglist_v6`）。
 *
 * `uin` 传谁就查谁：自己的、朋友的都行 —— 拿得到说明对她可见（私密说说会被
 * `secret` 过滤掉）。这个接口用的是 `taotao.qq.com`，注意别写成 `taotao.qzone.qq.com`。
 */
export async function listQzoneMoods(
  config: OnebotConnectionConfig,
  uin: string,
  count = 3,
  options: { forceAuth?: boolean } = {},
): Promise<QzoneFeed[]> {
  const target = normalizeQzoneUin(uin);
  if (!target) return [];
  const auth = await resolveQzoneCredential(config, { force: options.forceAuth });
  const want = Math.min(Math.max(Math.trunc(count), 1), 20);
  const query = new URLSearchParams({
    uin: target,
    pos: "0",
    num: String(want),
    g_tk: String(auth.gtk),
    format: "jsonp",
  });
  const payload = await qzoneRequest(`${QZONE_TAOTAO_MOOD}/emotion_cgi_msglist_v6?${query.toString()}`, auth, {
    method: "GET",
    // referer 指向被查的那个人的空间：用她自己的地址去看别人的说说，容易被拦。
    referer: `https://user.qzone.qq.com/${target}`,
  });
  assertQzoneOk(payload, "获取说说列表");
  return parseQzoneMoodList(payload, target).slice(0, want);
}

/**
 * QQ 的「我的电脑 / 我的手机 / 我的Pad」是设备号，不是人。
 * 实测好友列表里它们的 user_id 固定在 2113929217~2113929219 —— 拉它们的说说纯属浪费请求。
 */
const QZONE_DEVICE_UINS = new Set(["2113929217", "2113929218", "2113929219"]);

export function isQzoneDeviceFriend(uin: string, nickname: string): boolean {
  return QZONE_DEVICE_UINS.has(uin) || /^我的(?:电脑|手机|pad|ipad)$/iu.test(nickname.trim());
}

/** 协议端有标准 OneBot v11 的 `get_friend_list`，好友名单不用主人手抄。 */
export async function readQzoneFriendQqs(
  config: OnebotConnectionConfig,
  limit = 5,
  exclude: readonly string[] = [],
): Promise<Array<{ uin: string; nickname: string }>> {
  try {
    const data = await callOnebotAction(config, "get_friend_list", {});
    const list = Array.isArray(data) ? data : [];
    const skip = new Set(exclude);
    const friends: Array<{ uin: string; nickname: string }> = [];
    for (const item of list) {
      const friend = item as { user_id?: unknown; nickname?: unknown; remark?: unknown } | null;
      const uin = normalizeQzoneUin(String(friend?.user_id ?? ""));
      if (!uin || skip.has(uin)) continue;
      const nickname = String(friend?.remark ?? friend?.nickname ?? "").trim();
      // 设备号和「自己」都跳过：前者不是人，后者不该被自己评论。
      if (isQzoneDeviceFriend(uin, nickname)) continue;
      friends.push({ uin, nickname });
      if (friends.length >= limit) break;
    }
    return friends;
  } catch {
    // 网关不给好友列表不算错误：还有「主人手填名单」这条路。
    return [];
  }
}

/**
 * 「看看空间」真正要做的事：按名单逐个拉最近说说，合成一条列表。
 *
 * 为什么不拉「全量好友动态」：那个接口（`feeds3_html_more`）实测返回的 HTML/JSON
 * 一条说说都没有，靠不住（见 `parseQzoneMoodList`）。按人查慢一点，但每条都拿得到 tid。
 *
 * 逐个查而不是并发：一次「看看空间」打 5 个请求已经不少了，串行还能在第一个
 * `-3000` 时立刻停下，不至于把剩下四个也撞上风控。
 */
export async function listQzoneFriendMoods(
  config: OnebotConnectionConfig,
  options: { uins?: string[]; perFriend?: number; maxFriends?: number; selfUin?: string } = {},
): Promise<{ feeds: QzoneFeed[]; errors: string[] }> {
  const perFriend = Math.min(Math.max(Math.trunc(options.perFriend ?? 2), 1), 5);
  const maxFriends = Math.min(Math.max(Math.trunc(options.maxFriends ?? 5), 1), 10);
  const selfUin = normalizeQzoneUin(options.selfUin ?? "");

  const explicit = (options.uins ?? [])
    .map((uin) => normalizeQzoneUin(uin))
    .filter((uin) => uin && uin !== selfUin);
  const targets = explicit.length
    ? explicit.slice(0, maxFriends).map((uin) => ({ uin, nickname: "" }))
    : await readQzoneFriendQqs(config, maxFriends, selfUin ? [selfUin] : []);

  const feeds: QzoneFeed[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const target of targets) {
    try {
      for (const feed of await listQzoneMoods(config, target.uin, perFriend)) {
        // 两个号互为好友时同一批说说会拿到两遍，按 tid 去重。
        if (seen.has(feed.tid)) continue;
        seen.add(feed.tid);
        feeds.push(feed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${target.uin}: ${message}`);
      // 登录态失效就没必要接着问别人了，五个请求只会一起失败。
      if (message.startsWith("QZONE_AUTH_") || message.includes("QZONE_API_-3000")) break;
    }
  }
  return { feeds, errors };
}

/* ------------------------------------------------------------------ *
 * 发说说（对外入口：协议端优先）
 * ------------------------------------------------------------------ */

/** 协议端到底认不认这个动作：只有明确「没有这个接口」才降级，其余失败照抛。 */
export function isUnsupportedAction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ONEBOT_SEND_HTTP_404|ONEBOT_SEND_1404|不支持|未知的?动作|unknown\s*action|not\s*(?:found|supported)|no\s*such/iu.test(message);
}

/**
 * 发一条说说。协议端优先，明确不支持才走网页 CGI。
 *
 * 返回的 tid 可能是 null —— 那不代表失败，只代表「协议端没说」。调用方据此记一条
 * 「已提交，去空间确认」，**不要因此重发**。
 */
export async function publishQzonePost(
  config: OnebotConnectionConfig,
  input: { content: string; images?: string[]; visible?: number },
): Promise<{ tid: string | null; via: "action" | "cgi" }> {
  try {
    const action = await sendOnebotQzonePost(config, {
      content: input.content,
      ...(input.images?.length ? { images: input.images } : {}),
      ugcRight: input.visible ?? QZONE_VISIBLE.PUBLIC,
    });
    return { tid: action.tid, via: "action" };
  } catch (error) {
    if (!isUnsupportedAction(error)) throw error;
  }
  const auth = await resolveQzoneCredential(config);
  const cgi = await publishQzonePostViaCgi(auth, { content: input.content, visible: input.visible });
  return { tid: cgi.tid, via: "cgi" };
}

/* ------------------------------------------------------------------ *
 * 配额
 * ------------------------------------------------------------------ */

function qzoneDayStart(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export type QzoneUsage = {
  posts: number;
  comments: number;
  lastCommentAt: Date | null;
};

export async function readQzoneUsage(connectionId: string): Promise<QzoneUsage> {
  const prisma = getPrisma();
  const since = qzoneDayStart();
  const [posts, comments, lastComment] = await Promise.all([
    prisma.onebotQzoneAction.count({
      where: { connectionId, kind: "POST", status: "PUBLISHED", publishedAt: { gte: since } },
    }),
    prisma.onebotQzoneAction.count({
      where: { connectionId, kind: "COMMENT", status: "PUBLISHED", publishedAt: { gte: since } },
    }),
    prisma.onebotQzoneAction.findFirst({
      where: { connectionId, kind: "COMMENT", status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true },
    }),
  ]);
  return { posts, comments, lastCommentAt: lastComment?.publishedAt ?? null };
}

/** 过不了就返回一句能直接发给用户听的话，不要只返回 false。 */
export async function checkQzoneQuota(
  connectionId: string,
  kind: "POST" | "COMMENT",
  limits: { dailyPosts: number; dailyComments: number; commentCooldownMinutes: number },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const usage = await readQzoneUsage(connectionId);
  if (kind === "POST") {
    if (limits.dailyPosts > 0 && usage.posts >= limits.dailyPosts) {
      return { allowed: false, reason: `今天已经发了 ${usage.posts} 条说说，到上限了（每天 ${limits.dailyPosts} 条）。` };
    }
    return { allowed: true };
  }
  if (limits.dailyComments > 0 && usage.comments >= limits.dailyComments) {
    return { allowed: false, reason: `今天已经评论了 ${usage.comments} 条，到上限了（每天 ${limits.dailyComments} 条）。` };
  }
  if (usage.lastCommentAt && limits.commentCooldownMinutes > 0) {
    const elapsedMinutes = (Date.now() - usage.lastCommentAt.getTime()) / 60_000;
    if (elapsedMinutes < limits.commentCooldownMinutes) {
      const wait = Math.ceil(limits.commentCooldownMinutes - elapsedMinutes);
      return { allowed: false, reason: `刚评论过，还有 ${wait} 分钟冷却。` };
    }
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ *
 * 草稿（落库 → 确认 → 发布）
 * ------------------------------------------------------------------ */

export type PendingQzoneAction = {
  id: string;
  kind: string;
  content: string;
  topic: string;
  targetUin: string | null;
  targetTid: string | null;
  targetExcerpt: string | null;
  visible: number;
  requestedBy: string;
  characterId: string | null;
  expiresAt: Date;
};

export async function createPendingQzoneAction(input: {
  connectionId: string;
  characterId: string;
  kind: "POST" | "COMMENT";
  content: string;
  topic: string;
  requestedBy: string;
  conversationKey: string;
  visible?: number;
  targetUin?: string;
  targetTid?: string;
  targetExcerpt?: string;
}): Promise<PendingQzoneAction> {
  const prisma = getPrisma();
  const expiresAt = new Date(Date.now() + QZONE_ACTION_TTL_MS);
  return prisma.$transaction(async (tx) => {
    // 同一个连接同一类动作只留一条待确认：连说两次「发说说」时，旧草稿不该还能被确认。
    await tx.onebotQzoneAction.updateMany({
      where: { connectionId: input.connectionId, kind: input.kind, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    return tx.onebotQzoneAction.create({
      data: {
        connectionId: input.connectionId,
        characterId: input.characterId,
        kind: input.kind,
        content: input.content,
        topic: input.topic,
        requestedBy: input.requestedBy,
        conversationKey: input.conversationKey,
        visible: input.visible ?? QZONE_VISIBLE.PUBLIC,
        targetUin: input.targetUin ?? null,
        targetTid: input.targetTid ?? null,
        targetExcerpt: input.targetExcerpt ?? null,
        status: "PENDING",
        expiresAt,
      },
      select: {
        id: true, kind: true, content: true, topic: true, targetUin: true, targetTid: true,
        targetExcerpt: true, visible: true, requestedBy: true, characterId: true, expiresAt: true,
      },
    });
  });
}

export async function findPendingQzoneAction(
  connectionId: string,
  kind: "POST" | "COMMENT",
): Promise<PendingQzoneAction | null> {
  const prisma = getPrisma();
  await prisma.onebotQzoneAction.updateMany({
    where: { connectionId, kind, status: "PENDING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED" },
  });
  return prisma.onebotQzoneAction.findFirst({
    where: { connectionId, kind, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, kind: true, content: true, topic: true, targetUin: true, targetTid: true,
      targetExcerpt: true, visible: true, requestedBy: true, characterId: true, expiresAt: true,
    },
  });
}

/** 原子认领；重复投递的确认事件不会发两次。 */
export async function claimPendingQzoneAction(id: string): Promise<boolean> {
  const result = await getPrisma().onebotQzoneAction.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "PUBLISHING" },
  });
  return result.count === 1;
}

export async function finishQzoneAction(
  id: string,
  result: { ok: boolean; error?: string; tid?: string | null },
): Promise<void> {
  await getPrisma().onebotQzoneAction.update({
    where: { id },
    data: {
      // ⚠️ 没有 tid 也判定成功：「发出去了但没说 tid」比「没发出去」常见得多，
      // 记成 FAILED 会让人以为没发，然后重发一条。
      status: result.ok ? "PUBLISHED" : "FAILED",
      error: result.ok ? null : (result.error ?? "UNKNOWN").slice(0, 500),
      resultTid: result.ok ? (result.tid ?? null) : null,
      publishedAt: result.ok ? new Date() : null,
    },
  });
}

export async function writeQzoneAudit(input: {
  connectionId: string;
  characterId: string | null;
  actionId: string;
  kind: "POST" | "COMMENT";
  requestedBy: string;
  ok: boolean;
  error?: string;
}): Promise<void> {
  await getPrisma().auditLog.create({
    data: {
      actorType: "SYSTEM",
      characterId: input.characterId,
      action: input.ok ? "channel.qzone_published" : "channel.qzone_failed",
      entityType: "PlatformConnection",
      entityId: input.connectionId,
      details: {
        kind: input.kind,
        actionId: input.actionId,
        requestedBy: input.requestedBy,
        ...(input.ok ? {} : { error: (input.error ?? "").slice(0, 300) }),
      },
    },
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * 拟稿
 * ------------------------------------------------------------------ */

export function buildQzonePostSystemPrompt(input: {
  characterName: string;
  characterPrompt: string;
  styleExamples?: string | null;
}): string {
  return [
    "YILING_QZONE_POST_V1",
    `你正在以「${input.characterName}」的身份，在自己的 QQ 空间发一条说说。`,
    "要求：",
    "- 只输出说说正文，不要引号、标题、解释、Markdown；",
    "- 80 字以内，像随手记，不像作文；可以有情绪、有小事，但不要总结人生；",
    "- 不要话题标签（#），不要「今天也要努力呀」这种模板句；",
    "- 不要提自己是 AI、不要提「作为一个人」；",
    "- 不编造没被交代过的具体事实（地点、人名、数字）；拿不准就写感受。",
    "",
    "角色人设：",
    input.characterPrompt.slice(0, 12_000),
    ...(input.styleExamples?.trim()
      ? ["", "说话风格示例：", input.styleExamples.trim().slice(0, 4_000)]
      : []),
  ].join("\n");
}

export function buildQzonePostUserPrompt(input: { topic: string; recentContext: string }): string {
  const topic = input.topic.trim();
  return [
    topic ? `想说的内容/方向：${topic}` : "没给主题。就按此刻的心情写一句，别硬凑。",
    ...(input.recentContext.trim()
      ? ["", "最近的对话（仅供参考，不要复述）：", input.recentContext.trim().slice(0, 3_000)]
      : []),
  ].join("\n");
}

export function buildQzoneCommentSystemPrompt(input: {
  characterName: string;
  characterPrompt: string;
  styleExamples?: string | null;
}): string {
  return [
    "YILING_QZONE_COMMENT_V1",
    `你正在以「${input.characterName}」的身份，评论 QQ 空间里别人的一条说说。`,
    "要求：",
    "- 只输出评论正文，30 字以内，一句话就够；",
    "- 像熟人顺口搭话，不客套、不夸「写得好」、不复述对方说了什么；",
    "- 不要表情符号刷屏，不要提自己是 AI；",
    "- 对方是朋友，语气自然、可以损、可以共情，但不要自作多情。",
    "",
    "角色人设：",
    input.characterPrompt.slice(0, 12_000),
    ...(input.styleExamples?.trim()
      ? ["", "说话风格示例：", input.styleExamples.trim().slice(0, 4_000)]
      : []),
  ].join("\n");
}

export function buildQzoneCommentUserPrompt(input: {
  nickname: string;
  excerpt: string;
  hint: string;
}): string {
  return [
    `对方：${input.nickname}`,
    `说说是：${input.excerpt.slice(0, 300)}`,
    ...(input.hint.trim() ? ["", `你想让她表达的倾向：${input.hint.trim().slice(0, 200)}`] : []),
  ].join("\n");
}

/** 模型偶尔套代码块或自己加「说说：」前缀；发出去的正文要干净。 */
export function sanitizeQzoneText(text: string, maxChars: number): string {
  let value = String(text ?? "").trim();
  value = value.replace(/^```[a-zA-Z]*\s*/u, "").replace(/\s*```$/u, "").trim();
  value = value.replace(/^(说说|评论|动态)\s*[：:]\s*/u, "").trim();
  value = value.replace(/^["“”'‘’]+|["“”'‘’]+$/gu, "").trim();
  value = value.replace(/\n{3,}/gu, "\n\n").trim();
  return value.slice(0, maxChars).trim();
}

/**
 * 用角色自己的模型拟稿。
 *
 * 和 `announcement.ts` 的 `draftAnnouncementText` 是同构的（取角色 → 解 Key → 查额度 →
 * 调模型 → 记账）。没有抽公共函数是因为两边的 prompt 结构差得远，硬合并出来的
 * 抽象层会比分着写更难读；哪天第三处出现，再抽。
 */
export async function draftQzoneText(input: {
  characterId: string;
  bindingId: string;
  conversationId: string | null;
  kind: "POST" | "COMMENT";
  topic: string;
  hint?: string;
  target?: { nickname: string; excerpt: string };
}): Promise<{ content: string; model: string }> {
  const prisma = getPrisma();
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: { name: true, basePrompt: true, styleExamples: true, status: true, modelConfig: true },
  });
  if (!character) throw new Error("CHARACTER_MISSING");
  if (character.status !== "ACTIVE") throw new Error("CHARACTER_INACTIVE");

  const settings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
  } catch {
    throw new Error("API_KEY_DECRYPT_FAILED");
  }
  if (!apiKey || !settings.model) throw new Error("MODEL_NOT_CONFIGURED");

  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) throw new Error("DAILY_QUOTA_EXCEEDED");

  const recent = input.conversationId
    ? await prisma.message.findMany({
        where: { conversationId: input.conversationId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 10,
        select: { role: true, content: true },
      })
    : [];

  const style = {
    characterName: character.name,
    characterPrompt: character.basePrompt,
    styleExamples: character.styleExamples,
  };
  const isPost = input.kind === "POST";

  let usage: ModelUsageTokens | null = null;
  const raw = await callRawModel({
    systemPrompt: isPost ? buildQzonePostSystemPrompt(style) : buildQzoneCommentSystemPrompt(style),
    userPrompt: isPost
      ? buildQzonePostUserPrompt({
          topic: input.topic,
          recentContext: recent
            .reverse()
            .map((message) => `${message.role === "USER" ? "对方" : "你"}：${message.content.slice(0, 160)}`)
            .join("\n"),
        })
      : buildQzoneCommentUserPrompt({
          nickname: input.target?.nickname ?? "朋友",
          excerpt: input.target?.excerpt ?? input.topic,
          hint: input.hint ?? "",
        }),
    model: settings.model,
    apiKey,
    apiBaseUrl: settings.apiBaseUrl,
    temperature: settings.temperature,
    maxTokens: Math.min(Math.max(settings.maxTokens, 400), 1_200),
    onUsage: (value) => { usage = value; },
  });

  const content = sanitizeQzoneText(
    raw,
    isPost ? QZONE_MAX_POST_CHARS : QZONE_MAX_COMMENT_CHARS,
  );
  if (!content) throw new Error(isPost ? "EMPTY_QZONE_POST" : "EMPTY_QZONE_COMMENT");

  await recordModelUsage({
    kind: "channel",
    model: settings.model,
    usage,
    characterId: input.characterId,
    channelBindingId: input.bindingId,
    conversationId: input.conversationId,
    metadata: { task: isPost ? "qzone-post" : "qzone-comment" },
  });
  return { content, model: settings.model };
}
