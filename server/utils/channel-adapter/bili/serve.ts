/**
 * B站渠道的被动回复处理 —— 对应 QQ 的 serve.ts。
 *
 * 与 QQ 的差异：B站没有 WebSocket 推送，被动消息（私信/评论/@）靠轮询 bili CLI 的
 * 收件箱命令（feed inbox / feed replies）获取。这里提供：
 *   - createBiliMessageHandler：把一条 B站 消息事件转成通用流水线调用。
 *   - pollBiliInbox：轮询收件箱，把新消息交给 handler。
 *
 * ⚠️ 两条踩过的坑（都会让「每条消息都被丢掉」）：
 *   1. 返回结构是 `{"ok":true,"data":{"items":[...]}}`，要先把 data 剥开再取 items，
 *      直接拿 `json.items` 永远是空的。
 *   2. 字段名跟直觉不一样：
 *      - `dm list` 给的是**会话卡片**：`uid` / `name` / `last_message:{from,text,time}`，
 *        不是 `id` / `text`。
 *      - `feed replies` 给的是：`content` / `user:{mid,name}` / `on:{bvid,...}` / `rpid` / `root`，
 *        不是 `text` / `uid` / `bvid`。
 *   老实现按后者去读，于是 content 和 id 恒为空，消息在 missing_fields 那一关全被丢掉。
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrisma } from "../../prisma";
import type { BiliConnectionRecord, BiliBindingRecord } from "./configure";
import { biliOptions } from "./configure";
import { handleChannelMessage } from "../pipeline";
import { runBili } from "./runner";
import { readBiliMessageId, readBiliMessageText, type BiliMessageEventType } from "./types";
import { readBiliError, unwrapBiliData } from "./cards";

export type BiliHandleOutcome =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 把一段文本写进临时文件，交给 bili 的 `--file`（避免引号和换行被 shell 切碎）。 */
async function withTempText<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `yiling-bili-reply-${randomUUID()}.txt`);
  await writeFile(path, text, "utf8");
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string {
  // rpid / mid / root 这些字段 CLI 给的是数字，直接当字符串读会变成空
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export type BiliReplyTarget = {
  eventType: BiliMessageEventType;
  bvid: string;
  rpid: string;
  root: string;
};

/**
 * 构造一个 B站 消息事件处理器：把事件路由到绑定角色，走通用流水线，再把回复通过
 * bili dm send / comment reply 发回。
 */
export function createBiliMessageHandler(record: BiliConnectionRecord, binding: BiliBindingRecord) {
  return async (eventType: BiliMessageEventType, data: unknown): Promise<BiliHandleOutcome> => {
    const content = readBiliMessageText(eventType, data);
    const externalMessageId = readBiliMessageId(data);
    const externalConversationId = (data as { conversationKey?: unknown } | null)?.conversationKey;
    const authorUid = (data as { authorUid?: unknown } | null)?.authorUid;
    if (!content || !externalMessageId || typeof externalConversationId !== "string" || !externalConversationId) {
      return { status: "ignored", reason: "missing_fields" };
    }

    // 数据目录跟账号走：CLI 只认 BILI_CLI_HOME，统一由 biliOptions 拼
    const options = biliOptions(record);

    await getPrisma()
      .platformConnection.update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);

    // 回发：私信走 dm send，评论走 comment reply（楼中楼）/ comment post（新评论）
    const sendReply = async (reply: string): Promise<void> => {
      const text = reply.trim();
      if (!text) return;

      if (eventType === "DM_MESSAGE_CREATE") {
        const uid = typeof authorUid === "string" && authorUid ? authorUid : "owner";
        await withTempText(text, (path) => runBili(["dm", "send", uid, "--file", path], options));
        return;
      }

      const payload = data as { bvid?: unknown; rpid?: unknown; root?: unknown } | null;
      const bvid = readString(payload?.bvid);
      if (!bvid) return;
      const rpid = readString(payload?.rpid);
      const root = readString(payload?.root);

      // 回复别人的评论要用 comment reply 才是楼中楼；comment post 会变成一条新的根评论
      const argv = rpid ? ["comment", "reply", bvid, rpid] : ["comment", "post", bvid];
      await withTempText(text, (path) => {
        const full = [...argv, "--file", path];
        if (rpid && root) full.push("--root", root);
        return runBili(full, options);
      });
    };

    return handleChannelMessage({
      platform: "bili",
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType,
      externalConversationId,
      externalMessageId,
      authorOpenId: typeof authorUid === "string" ? authorUid : "",
      authorPlatformUid: typeof authorUid === "string" ? authorUid : "",
      content,
      sendReply,
    });
  };
}

/** 把 CLI 返回的 `{ok,data:{items}}` 拆成数组成员。 */
function readList(json: unknown): Array<Record<string, unknown>> {
  const data = unwrapBiliData(json);
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => !!asRecord(item));
  }
  const record = asRecord(data);
  if (!record) return [];
  for (const key of ["items", "list", "result"]) {
    const inner = record[key];
    if (Array.isArray(inner)) {
      return inner.filter((item): item is Record<string, unknown> => !!asRecord(item));
    }
  }
  return [];
}

/** 轮询收件箱一次，把未读消息交给 handler。返回处理条数。 */
export async function pollBiliInbox(
  record: BiliConnectionRecord,
  binding: BiliBindingRecord,
  handler: ReturnType<typeof createBiliMessageHandler>,
): Promise<number> {
  const { bin, env } = biliOptions(record);
  let handled = 0;

  // 收私信。`dm list` 返回的是会话卡片，只有「最后一条消息」，所以粒度是会话级的：
  // 同一会话连续两条只会看到后一条。够用，且省调用；要更细就走 `dm read <uid>`。
  const dm = await runBili(["dm", "list", "--unread"], { bin, env });
  if (!readBiliError(dm.json)) {
    for (const item of readList(dm.json)) {
      const uid = readString(item.uid);
      const last = asRecord(item.last_message);
      const text = readString(last?.text);
      // from 不是 "them" 说明最后一条是我们自己发的（或 B站代发的自动回复），不该回
      if (!uid || !text || readString(last?.from) !== "them") continue;
      const outcome = await handler("DM_MESSAGE_CREATE", {
        type: "DM_MESSAGE_CREATE",
        id: `dm:${uid}:${readString(last?.time)}`,
        authorUid: uid,
        conversationKey: `dm:${uid}`,
        content: text,
        timestamp: readString(last?.time),
      });
      if (outcome.status === "replied" || outcome.status === "duplicate") handled += 1;
    }
  }

  // 收回复我的评论。字段：content / user.mid / on.bvid / rpid / root
  const replies = await runBili(["feed", "replies"], { bin, env });
  if (!readBiliError(replies.json)) {
    for (const item of readList(replies.json)) {
      const rpid = readString(item.rpid) || readString(item.id);
      const content = readString(item.content);
      if (!rpid || !content) continue;
      const user = asRecord(item.user);
      const on = asRecord(item.on);
      const bvid = readString(on?.bvid);
      const outcome = await handler("COMMENT_CREATE", {
        type: "COMMENT_CREATE",
        id: rpid,
        authorUid: readString(user?.mid),
        conversationKey: `video:${bvid || rpid}`,
        content,
        timestamp: readString(item.time),
        bvid,
        rpid,
        root: readString(item.root),
      });
      if (outcome.status === "replied" || outcome.status === "duplicate") handled += 1;
    }
  }

  return handled;
}
