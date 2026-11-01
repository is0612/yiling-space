import "dotenv/config";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { fetchQqCustomFaces } from "../server/utils/qq-custom-face";

/**
 * 探针：把「收藏表情」当消息发出去，网关认不认、认成什么。
 *
 * 为什么必须实测：OneBot v11 标准里没有「发收藏表情」的段或 action。
 *   - go-cqhttp 系的实现用 `mface` 段（emoji_id + summary + url）；
 *   - 也有实现提供 `send_custom_face` 这个扩展 action。
 * 两种都可能在 SnowLuma 上有、也可能只有一种，而且「发出去变成一张普通图片」和
 * 「真的走表情通道」在接口返回里长得一样 —— 唯一能分辨的是 `get_msg` 回来的段类型。
 */

async function callAction(
  httpUrl: string,
  token: string | undefined,
  action: string,
  params: Record<string, unknown> = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const response = await fetch(`${httpUrl}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: unknown = text.slice(0, 400);
  try {
    body = JSON.parse(text);
  } catch {
    // 原样留着
  }
  return { httpStatus: response.status, body };
}

function brief(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (typeof item === "string" && item.length > 120) return `${item.slice(0, 120)}…(${item.length})`;
    return item;
  });
}

const connections = await loadOnebotConnections();
if (!connections.length) {
  console.log("没有可用的 QQ 连接。");
  process.exit(0);
}
const connection = connections[0]!;
const { httpUrl, httpToken } = connection.config;
console.log(`连接：${connection.id}  QQ ${connection.accountQq || "(未知)"}  主人 ${connection.ownerQq || "(未设置)"}`);

const faces = await fetchQqCustomFaces(connection.config);
console.log(`收藏夹：${faces.length} 条`);
const face = faces[0];
if (!face) {
  console.log("收藏夹是空的，没法测。先跑一次同步把本地表情推上去。");
  process.exit(0);
}
console.log(`拿这张来测：emoji_id=${face.emojiId}  备注「${face.desc}」`);

const ownerQq = connection.ownerQq;
if (!ownerQq) {
  console.log("\n没设置主人 QQ，不敢随便发（会发到别人那里）。先在 QQ 行为面板里填「主人 QQ」。");
  process.exit(0);
}

const withUrl = face.url;

console.log("\n=== A. mface 段（go-cqhttp 那套）===");
const a = await callAction(httpUrl, httpToken, "send_private_msg", {
  user_id: Number(ownerQq),
  message: [{
    type: "mface",
    data: { emoji_id: face.emojiId, summary: `[${face.desc || "表情"}]`, url: withUrl },
  }],
});
console.log(`send_private_msg → HTTP ${a.httpStatus}  ${brief(a.body)}`);
const aMessageId = (a.body as { data?: { message_id?: number } } | null)?.data?.message_id;

if (aMessageId) {
  const got = await callAction(httpUrl, httpToken, "get_msg", { message_id: aMessageId });
  console.log(`get_msg → ${brief((got.body as { data?: { message?: unknown } } | null)?.data?.message)}`);
}

console.log("\n=== B. send_custom_face action（扩展 action 那套）===");
const b = await callAction(httpUrl, httpToken, "send_custom_face", {
  user_id: Number(ownerQq),
  emoji_id: face.emojiId,
});
console.log(`send_custom_face → HTTP ${b.httpStatus}  ${brief(b.body)}`);
const bMessageId = (b.body as { data?: { message_id?: number } } | null)?.data?.message_id;
if (bMessageId) {
  const got = await callAction(httpUrl, httpToken, "get_msg", { message_id: bMessageId });
  console.log(`get_msg → ${brief((got.body as { data?: { message?: unknown } } | null)?.data?.message)}`);
}
