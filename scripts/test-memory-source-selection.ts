import assert from "node:assert/strict";
import { selectPeriodSourceMessages } from "../server/utils/memory-source-selection";

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

console.log("memory source selection: 全部通过");
