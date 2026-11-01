/**
 * QQ 收藏表情（「我的收藏」里的表情包），走 SnowLuma 的扩展 action。
 *
 * 这不是 OneBot v11 标准接口。四个 action 都是 SnowLuma 加的，实测行为如下：
 *   - `fetch_custom_face_detail` → `data: [{ emoji_id, resId, url, md5, desc }]`，`url` 可以直接下载；
 *   - `add_custom_face`           → **回传 `emoji_id`**，接受 `base64://`；`is_origin` 表示按原图存；
 *   - `modify_custom_face`        → 传 `{ emoji_id, desc }` 改备注，回查确认生效；
 *   - `delete_custom_face`        → 真删（条数确实少一条）。
 *
 * 两个必须自己防的坑：
 *   1. **HTTP 200 不代表成功**。OneBot 的惯例是错误藏在 `retcode` 里；
 *      不认识的 action 更是干脆回 `retcode: 1404, message: "unknown action"`——
 *      拿 NapCat 之类的网关硬调用就会走到这里，不判 retcode 会当成「收藏夹是空的」。
 *   2. **空列表有两种含义**：真的空，和「网关没登录/接口挂了但回了空数组」。
 *      后者如果被当成「QQ 那边全删了」，本地几十张图的标签会一次性进回收站。
 *      这个判断不放在这里（这里只负责取数），由 `qq-sticker-sync.ts` 的安全阀拦。
 */

import type { OnebotConnectionConfig } from "./channel-adapter/onebot/client";

/** 收藏夹里的一张表情。 */
export type QqCustomFace = {
  /** 唯一 id，形如 `<QQ号>_0_0_0_<md5>_0_0`。删除、改备注都要靠它。 */
  emojiId: string;
  /** 从 emoji_id（或返回里自带的 md5 字段）取到的内容指纹，取不到就是空串。 */
  md5: string;
  /** 原图直链（qpic）。有时效，只在本次同步里用，别落库。 */
  url: string;
  /** QQ 里给这张表情打的备注，通常是空的。 */
  desc: string;
};

/** QQ 那边返回了错误。`retcode` 为 null 表示 HTTP 就不通。 */
export class QqCustomFaceError extends Error {
  readonly action: string;
  readonly retcode: number | null;

  constructor(action: string, detail: string, retcode: number | null) {
    super(detail);
    this.name = "QqCustomFaceError";
    this.action = action;
    this.retcode = retcode;
  }
}

/** 一次最多拉多少张。QQ 收藏夹上限在 300 上下，一次拉完比分页稳。 */
export const QQ_CUSTOM_FACE_LIMIT = 300;

/** QQ 备注的长度上限没写在文档里，跟本地名字一样截 60，超了肯定写不进去。 */
const MAX_DESC_CHARS = 60;

/**
 * 从 emoji_id 里拆 md5：`<QQ号>_0_0_0_<md5>_0_0`。
 *
 * 为什么要它：同一张图在 QQ 里删掉再加，`emoji_id` 会换、md5 不变。
 * 只按 emoji_id 对账的话，这种情况会被当成「QQ 新增一张 + 本地那张失效」，
 * 结果就是重复导入一份、本地打好的标签丢掉。
 * 认不出来就返回空串，调用方退回「只按 emoji_id 匹配」。
 */
export function md5FromEmojiId(emojiId: string): string {
  const parts = String(emojiId ?? "").split("_");
  const candidate = parts[4] ?? "";
  return /^[a-f0-9]{32}$/i.test(candidate) ? candidate.toLowerCase() : "";
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 从返回体里挖出数组：结构可能直接是 `data: []`，也可能包一层。 */
function firstObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(item)) return firstObjectArray(item);
    }
  }
  return [];
}

/**
 * 把 `fetch_custom_face_detail` 的返回解析成表情列表。
 *
 * 字段名按实测来（`emoji_id` / `resId` / `url` / `md5` / `desc`），但每种都多认几个别名 ——
 * SnowLuma 改过版本、别的网关也用同名 action，多认几个不会错。
 * 缺 `emoji_id`（认不出、删不掉）或缺 `url`（下不下来）的条目直接丢：
 * 留着它只会在对账时凭空多出一条「本地该有但导不进来」的记录。
 */
export function readQqCustomFaces(payload: unknown): QqCustomFace[] {
  const data = (payload as { data?: unknown } | null)?.data;
  const rows = firstObjectArray(data);
  const faces: QqCustomFace[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const emojiId = readString(row, ["emoji_id", "emojiId", "id"]);
    const url = readString(row, ["url", "URL", "file"]);
    if (!emojiId || !url || seen.has(emojiId)) continue;
    seen.add(emojiId);
    faces.push({
      emojiId,
      md5: readString(row, ["md5", "MD5"]) || md5FromEmojiId(emojiId),
      url,
      desc: readString(row, ["desc", "remark", "name"]),
    });
  }
  return faces;
}

type ActionResult = { retcode: number; data: unknown; payload: unknown; wording: string };

/** 打一次 HTTP API。超时 20 秒：拉图列表和上传原图都可能慢，但卡住必须能放弃。 */
async function callAction(
  config: OnebotConnectionConfig,
  action: string,
  params: Record<string, unknown> = {},
): Promise<ActionResult> {
  let response: Response;
  try {
    response = await fetch(`${config.httpUrl}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.httpToken ? { authorization: `Bearer ${config.httpToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new QqCustomFaceError(action, `QQ 网关连不上（${reason}），先确认协议端还开着。`, null);
  }

  if (!response.ok) {
    throw new QqCustomFaceError(action, `QQ 网关返回 HTTP ${response.status}。`, null);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new QqCustomFaceError(action, "QQ 网关返回的不是 JSON，协议端版本可能不匹配。", null);
  }

  const record = (payload ?? {}) as {
    retcode?: unknown;
    wording?: unknown;
    message?: unknown;
  };
  const retcode = typeof record.retcode === "number" ? record.retcode : 0;
  const wording =
    (typeof record.wording === "string" && record.wording)
    || (typeof record.message === "string" && record.message)
    || "";

  // 1404 + "unknown action" 是「这个网关没有收藏表情接口」，跟「调用失败」要分开说，
  // 否则用户会去查 Token 而不是去换网关。
  if (retcode === 1404 || /unknown action/i.test(wording)) {
    throw new QqCustomFaceError(action, "当前 QQ 网关没有收藏表情接口（需要 SnowLuma）。", retcode);
  }
  if (retcode !== 0) {
    throw new QqCustomFaceError(
      action,
      `QQ 收藏表情操作失败${wording ? `（${wording}）` : ""}，retcode ${retcode}。`,
      retcode,
    );
  }
  return { retcode, data: (payload as { data?: unknown }).data, payload, wording };
}

/** 拉收藏夹。返回空数组只代表「这次拉到 0 条」，是不是真没有由调用方判断。 */
export async function fetchQqCustomFaces(
  config: OnebotConnectionConfig,
  count: number = QQ_CUSTOM_FACE_LIMIT,
): Promise<QqCustomFace[]> {
  const result = await callAction(config, "fetch_custom_face_detail", { count });
  return readQqCustomFaces(result.payload);
}

/**
 * 往收藏夹加一张，返回新生成的 `emoji_id`。
 *
 * `is_origin: true` 是「按原图存」。我们传上去的图已经缩到 200px 宽，本来就是想收藏这个尺寸，
 * 但不开这个开关时 SnowLuma 还会再压一次，压完的图发到群里会糊。
 */
export async function addQqCustomFace(
  config: OnebotConnectionConfig,
  image: Buffer,
): Promise<string> {
  const result = await callAction(config, "add_custom_face", {
    file: `base64://${image.toString("base64")}`,
    is_origin: true,
  });
  const data = (result.data ?? {}) as Record<string, unknown>;
  const emojiId = readString(data, ["emoji_id", "emojiId", "id"]);
  if (!emojiId) {
    // 加成功了但拿不到 id 是最坏的一种：QQ 里多了一张、本地认不出是哪张，下次同步会当成「QQ 新增」再导一遍。
    // 宁可直接报错，让人知道这次收藏没绑上。
    throw new QqCustomFaceError("add_custom_face", "收藏成功但网关没回 emoji_id，无法与本地对应。", result.retcode);
  }
  return emojiId;
}

/** 改 QQ 里这张表情的备注。本地改了名字就同步过去，两边看着才是同一批。 */
export async function modifyQqCustomFaceDesc(
  config: OnebotConnectionConfig,
  emojiId: string,
  desc: string,
): Promise<void> {
  await callAction(config, "modify_custom_face", {
    emoji_id: emojiId,
    desc: desc.slice(0, MAX_DESC_CHARS),
  });
}

/** 从 QQ 收藏里删掉一张。 */
export async function deleteQqCustomFace(
  config: OnebotConnectionConfig,
  emojiId: string,
): Promise<void> {
  await callAction(config, "delete_custom_face", { emoji_id: emojiId });
}
