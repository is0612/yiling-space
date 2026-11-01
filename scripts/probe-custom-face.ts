import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";

/**
 * 探针：摸清 SnowLuma 的「收藏表情」接口到底长什么样。
 *
 * 为什么要有它：双向同步（QQ 收藏 ⇄ 本地表情库）能不能做，卡在三个未知上 ——
 *   1. `fetch_custom_face(_detail)` 返回的字段叫什么（emoji_id / desc / url？有没有原图）；
 *   2. `add_custom_face` 加完之后会不会把 emoji_id 还给我们（不回的话就得靠 diff 或备注回查）；
 *   3. 收藏有上限、删除是否有独立 action。
 * 这些照文档猜没用：SnowLuma 的文档站是单页应用抓不到正文，NapCat 同名接口的返回又是空对象。
 *
 * 用法：
 *   yarn probe:custom-face            # 只读：登录信息 + 收藏夹列表 + 详情（不动账号）
 *   yarn probe:custom-face --write    # 会真的往收藏夹加一张测试图（200×200 的纯色块）
 *   yarn probe:custom-face --write --file=.data/stickers/xxx/xxx.png   # 用指定图加
 *
 * 只读那步永远先跑：它决定了后面所有设计，且没有副作用。
 */

/** 输出里的 URL 截断，避免刷屏（rkey 很长，而且有时效）。 */
function shorten(value: unknown, max = 96): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…(${value.length})` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => shorten(item, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shorten(item, max);
    }
    return out;
  }
  return value;
}

function print(label: string, payload: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(shorten(payload), null, 2));
}

/** 直接打 http API，把 retcode 和 data 原样打出来 —— 探针要的就是「原样」。 */
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
  let body: unknown = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 400);
  }
  return { httpStatus: response.status, body };
}

/** 从返回里尽量认出表情列表：结构未知，所以按「数组里带 id 字段」来找。 */
function readFaceList(body: unknown): Array<Record<string, unknown>> {
  const data = (body as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
      }
    }
  }
  return [];
}

/** 测试图：优先用 --file 指定的，否则现做一张 200×200 的纯色块（不进她的表情库）。 */
async function buildTestImage(fileArg?: string): Promise<{ buffer: Buffer; from: string }> {
  if (fileArg) {
    const buffer = await fs.readFile(path.resolve(process.cwd(), fileArg));
    return { buffer, from: `文件 ${fileArg}（${buffer.length} 字节）` };
  }
  const buffer = await sharp({
    create: { width: 200, height: 200, channels: 4, background: { r: 90, g: 140, b: 210, alpha: 1 } },
  }).png().toBuffer();
  return { buffer, from: "现场生成的 200×200 蓝色方块" };
}

async function main() {
  const args = process.argv.slice(2);
  const doWrite = args.includes("--write");
  const fileArg = args.find((item) => item.startsWith("--file="))?.slice("--file=".length);
  const deleteArg = args.find((item) => item.startsWith("--delete="))?.slice("--delete=".length);

  const connections = await loadOnebotConnections();
  if (!connections.length) {
    console.log("没有可用的 QQ 连接（platform_connections 里没有 qq-onebot，或凭据解不开）。");
    return;
  }
  // 多连接时只探第一个：探针不是巡检工具，一次看一个号就够了。
  const connection = connections[0]!;
  const { httpUrl, httpToken } = connection.config;
  console.log(`连接：${connection.id}  QQ ${connection.accountQq || "(未知)"}  HTTP ${httpUrl}`);
  console.log(`HTTP Token：${httpToken ? "已配置" : "(空)"}`);

  // 0. 先确认这条链路是通的：连不上就别看后面的报错了。
  const login = await callAction(httpUrl, httpToken, "get_login_info");
  print("get_login_info", login);
  if (login.httpStatus !== 200) {
    console.log("\nHTTP 不是 200，先解决连通性（网关没起 / 端口不对 / Token 不对）。");
    return;
  }

  // 1. 收藏夹列表。先不带参数试一次，再带 count 试一次 —— 两种实现都可能。
  const listPlain = await callAction(httpUrl, httpToken, "fetch_custom_face");
  print("fetch_custom_face（无参数）", { httpStatus: listPlain.httpStatus, ...listPlain.body as object });
  const plainItems = readFaceList(listPlain.body);
  console.log(`→ 认出 ${plainItems.length} 条；第一条的字段：${plainItems[0] ? Object.keys(plainItems[0]).join(", ") : "(空)"}`);

  const listCount = await callAction(httpUrl, httpToken, "fetch_custom_face", { count: 10 });
  const countItems = readFaceList(listCount.body);
  console.log(`fetch_custom_face（count=10）→ ${countItems.length} 条`);

  // 2. 详情接口：这个更可能带 url / 备注，也就是「能不能下载到原图」的关键。
  const detail = await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 5 });
  print("fetch_custom_face_detail（count=5）", { httpStatus: detail.httpStatus, ...detail.body as object });
  const detailItems = readFaceList(detail.body);
  console.log(`→ 认出 ${detailItems.length} 条；第一条的字段：${detailItems[0] ? Object.keys(detailItems[0]).join(", ") : "(空)"}`);

  // 3. 汇总：把「有多少、上限多少、有没有 desc」这些一次说清，省得回头再翻 JSON。
  const items = detailItems.length ? detailItems : plainItems.length ? plainItems : countItems;
  console.log("\n=== 汇总 ===");
  console.log(`收藏条数（本次拉到）：${items.length}`);
  if (items[0]) {
    console.log(`字段名：${Object.keys(items[0]).join(" / ")}`);
    const sample = items[0];
    for (const [key, value] of Object.entries(sample)) {
      const kind = Array.isArray(value) ? `array(${value.length})` : typeof value;
      console.log(`  ${key}: ${kind}${typeof value === "string" ? ` = ${String(shorten(value, 60))}` : ""}`);
    }
  }

  if (args.includes("--flow")) {
    // 完整走一遍：加一张 → 改备注 → 回查 → 删掉。
    // 目的只有一个：确认 `modify_custom_face` 的参数形状（回写名字要用），以及删除会不会真生效。
    const image = await buildTestImage(fileArg);
    const added = await callAction(httpUrl, httpToken, "add_custom_face", {
      file: `base64://${image.buffer.toString("base64")}`,
      is_origin: true,
    });
    print("add_custom_face", added);
    const emojiId = (added.body as { data?: { emoji_id?: string } } | null)?.data?.emoji_id;
    if (!emojiId) {
      console.log("\n没拿到 emoji_id，后面几步没法做。");
      return;
    }

    const remark = `同步测试-${Date.now()}`;
    const modified = await callAction(httpUrl, httpToken, "modify_custom_face", { emoji_id: emojiId, desc: remark });
    print(`modify_custom_face（emoji_id + desc）`, modified);

    const listed = readFaceList((await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 60 })).body);
    const target = listed.find((item) => String(item.emoji_id) === emojiId);
    console.log(`\n回查备注：库里是「${String(target?.desc ?? "")}」，写入的是「${remark}」—— ${String(target?.desc ?? "") === remark ? "一致，参数猜对了" : "不一致，参数名要换（试 remark / name / text）"}`);

    const removed = await callAction(httpUrl, httpToken, "delete_custom_face", { emoji_id: emojiId });
    print("delete_custom_face", removed);
    const finalList = readFaceList((await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 60 })).body);
    console.log(`删完剩 ${finalList.length} 条 —— ${finalList.some((item) => String(item.emoji_id) === emojiId) ? "还在，删除没生效" : "已清掉，账号恢复原样"}`);
    return;
  }

  if (deleteArg) {
    // 删除探针：先数一遍、删完再数一遍，只看「条数有没有真的变」，不信 retcode。
    // SnowLuma 对不认识的 action 也可能回 200 + retcode 0，所以必须眼见为实。
    const bogus = await callAction(httpUrl, httpToken, "definitely_not_a_real_action", {});
    console.log("\n=== 不存在的 action 长什么样（用来判断 retcode 可不可信）===");
    console.log(JSON.stringify({ httpStatus: bogus.httpStatus, body: shorten(bogus.body) }));

    const beforeDelete = readFaceList((await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 60 })).body);
    console.log(`\n删除前：${beforeDelete.length} 条`);
    const removed = await callAction(httpUrl, httpToken, "delete_custom_face", { emoji_id: deleteArg });
    print("delete_custom_face", removed);
    const afterDelete = readFaceList((await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 60 })).body);
    console.log(`删除后：${afterDelete.length} 条 —— ${afterDelete.length < beforeDelete.length ? "真的删掉了" : "条数没变，删除没生效或 action 名不对"}`);
    return;
  }

  if (!doWrite) {
    console.log("\n（只读模式。要真加一张测试图，加 --write；要删一条，加 --delete=<emoji_id>。）");
    return;
  }

  // 4. 写入探针：这一步会真的改账号数据，只在 --write 时才走。
  const before = new Set(items.map((item) => String(item.emoji_id ?? item.id ?? "")));
  const image = await buildTestImage(fileArg);
  console.log(`\n测试图：${image.from}`);
  const added = await callAction(httpUrl, httpToken, "add_custom_face", {
    file: `base64://${image.buffer.toString("base64")}`,
    is_origin: true,
  });
  print("add_custom_face（base64://）", added);

  const after = await callAction(httpUrl, httpToken, "fetch_custom_face_detail", { count: 60 });
  const afterItems = readFaceList(after.body);
  const fresh = afterItems.filter((item) => !before.has(String(item.emoji_id ?? item.id ?? "")));
  console.log("\n=== 加完之后 ===");
  console.log(`收藏条数：${afterItems.length}（加之前 ${before.size}）`);
  if (fresh.length) {
    console.log("新增的条目（这就是「加完怎么拿到 emoji_id」的答案）：");
    print("新增条目", fresh);
  } else {
    console.log("没看到新条目 —— 要么接口没吃 base64，要么列表有缓存/分页。");
  }

  // 5. 删除能力：只探测 action 是否存在，不真删（真的删要用户明确要求）。
  const probeDelete = await callAction(httpUrl, httpToken, "delete_custom_face", { emoji_id: "0" });
  console.log("\n=== delete_custom_face 是否存在 ===");
  console.log(JSON.stringify({ httpStatus: probeDelete.httpStatus, body: shorten(probeDelete.body) }));
  console.log("（这里故意传了个不存在的 emoji_id：返回「找不到」说明 action 存在，返回「不支持」说明要用别的写法。）");
}

void main().catch((error) => {
  console.error("\n探针失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
