import assert from "node:assert/strict";
import { selectPeriodSourceInput, selectPeriodSourceMessages, type PeriodSourceMessage } from "../server/utils/memory-source-selection";

const BASE = Date.parse("2026-10-20T00:00:00+08:00");

function message(conversationId: string, index: number, origin?: string) {
  return {
    id: `${conversationId}-${String(index).padStart(4, "0")}`,
    conversationId,
    occurredAt: new Date(BASE + index * 60_000),
    ...(origin ? { origin } : {}),
  };
}

function fill(conversationId: string, count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => message(conversationId, index + offset));
}

// ── 水群不能把私聊挤出窗口 ──────────────────────────────────
// 一个群 8 天说了 500 句，私聊只有 20 句。旧实现按全局时间取前后各 125 条，
// 私聊会被整段挤掉；现在按会话配额，两边都要留下。
{
  const group = fill("group", 500);
  const privateChat = fill("private", 20, 10_000);
  const selected = selectPeriodSourceMessages([...group, ...privateChat]);
  const groupCount = selected.filter((item) => item.conversationId === "group").length;
  const privateCount = selected.filter((item) => item.conversationId === "private").length;
  assert.equal(privateCount, 20, "私聊的 20 条必须全部留下。");
  assert.equal(groupCount, 80, "单个会话最多取 80 条。");
  assert.equal(selected.length, 100, "总量应为两会话之和（未触到 250 预算）。");
}

// ── 结果按时间升序，模型看到的顺序与真实发生顺序一致 ────────
{
  const selected = selectPeriodSourceMessages([...fill("a", 10), ...fill("b", 10, 5_000)]);
  const times = selected.map((item) => item.occurredAt.getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y), "来源消息必须按时间升序输出。");
}

// ── 同一行被补取两次也不会重复 ──────────────────────────────
{
  const rows = fill("a", 5);
  const selected = selectPeriodSourceMessages([...rows, ...rows]);
  assert.equal(selected.length, 5, "同一 id 只保留一次。");
}

// ── 预算小于会话数时，保住最近在说话的会话 ──────────────────
{
  const older = fill("old", 5, 0);
  const newer = fill("new", 5, 10_000);
  const latest = fill("latest", 5, 20_000);
  const selected = selectPeriodSourceMessages([...older, ...newer, ...latest], { budget: 2 });
  assert.equal(selected.length, 2, "预算为 2 时只放 2 条。");
  assert.deepEqual(
    [...new Set(selected.map((item) => item.conversationId))].sort(),
    ["latest", "new"],
    "预算不够时先保住最近有消息的会话。",
  );
}

// ── 预算充足时每个会话至少保住最新一条 ──────────────────────
{
  const selected = selectPeriodSourceMessages(
    [...fill("a", 30), ...fill("b", 3, 10_000), ...fill("c", 1, 20_000)],
    { budget: 6 },
  );
  for (const conversationId of ["a", "b", "c"]) {
    assert(
      selected.some((item) => item.conversationId === conversationId),
      `会话 ${conversationId} 至少要有 1 条来源。`,
    );
  }
}

// ── 空输入 ──────────────────────────────────────────────────
assert.deepEqual(selectPeriodSourceMessages([]), [], "没有消息时返回空数组。");

// ── 一对一锚点优先于群聊 ───────────────────────────────────
// 预算只够放少量锚点时，私聊/本地的最新一条必须留下，即使它比群聊更久远。
{
  const group = fill("group", 5, 20_000).map((item) => ({ ...item, origin: "QQ群 12345678" }));
  const privateChat = fill("private", 2, 0).map((item) => ({ ...item, origin: "私聊" }));
  const local = fill("local", 2, 5_000).map((item) => ({ ...item, origin: "本地对话" }));
  const selected = selectPeriodSourceMessages([...group, ...privateChat, ...local], { budget: 3 });
  const origins = selected.map((item) => item.origin);
  assert(origins.includes("私聊"), "私聊的最新一条必须留下。");
  assert(origins.includes("本地对话"), "本地对话的最新一条必须留下。");
  assert.equal(selected.length, 3, "预算为 3 时只放 3 条。");
}

// ── Worker 共用入口：中段唯一私聊锚点不能被第二次首尾截断丢掉 ──
{
  const rows: PeriodSourceMessage[] = [
    ...fill("early-group", 80),
    ...fill("middle-group", 80, 100),
    ...fill("late-group", 80, 300),
    ...fill("latest-group", 80, 500),
  ].map((row) => ({
    ...row, role: "USER", eventType: "message", content: "合成群聊测试消息",
    origin: "QQ群 12345678", isOwner: false,
  }));
  const privateAnchor: PeriodSourceMessage = {
    ...message("private", 250, "私聊"),
    role: "USER", eventType: "message", content: "合成私聊锚点",
    isOwner: true, speaker: "测试主人", member: "member_1",
    mentionTargets: ["self"], mentions: [{ target: "self" }],
    authorOpenId: "synthetic-owner", platform: "qq-onebot",
  };
  rows.push(privateAnchor);
  const originalIds = rows.map((row) => row.id);
  const { sourceMessages, aiMessages } = selectPeriodSourceInput([...rows, privateAnchor]);
  assert.equal(sourceMessages.length, 250, "统一入口必须沿用 250 条总预算。");
  const anchorIndex = sourceMessages.findIndex((row) => row.id === privateAnchor.id);
  assert(anchorIndex >= 60 && anchorIndex < sourceMessages.length - 60,
    "夹具必须把唯一私聊锚点放在旧首尾 120 条之外。");
  assert.deepEqual(aiMessages.map((row) => row.id), sourceMessages.map((row) => row.id),
    "来源记录、证据白名单与入模 ID/顺序必须完全相同，不能再二次抽样。");
  assert.equal(new Set(aiMessages.map((row) => row.id)).size, aiMessages.length);
  for (const conversationId of new Set(sourceMessages.map((row) => row.conversationId))) {
    assert(sourceMessages.filter((row) => row.conversationId === conversationId).length <= 80);
  }
  assert.deepEqual(aiMessages[anchorIndex], {
    id: privateAnchor.id, role: "USER", eventType: "message", content: privateAnchor.content,
    occurredAt: privateAnchor.occurredAt.toISOString(), origin: "私聊", isOwner: true,
    mentionTargets: ["self"], mentions: [{ target: "self" }],
    speaker: "测试主人", member: "member_1",
  }, "Worker 实际使用的纯转换应保留归属字段，同时不透传作者账号。");
  assert.deepEqual(rows.map((row) => row.id), originalIds, "选择与映射不得重排调用方数组。");
  assert.deepEqual(selectPeriodSourceInput([...rows].reverse()), { sourceMessages, aiMessages },
    "查询返回顺序不应改变最终来源与入模顺序。");
}

assert.deepEqual(selectPeriodSourceInput([]), { sourceMessages: [], aiMessages: [] });

console.log("memory source selection: 全部通过");
