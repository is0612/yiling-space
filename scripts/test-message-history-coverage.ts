import assert from "node:assert/strict";
import { historyCursorWhere, historyExcludedIds, loadMessageHistoryCoverage, type HistoryMessage } from "../server/utils/message-history-coverage";
import { selectRawMessagesForMemoryAssistant } from "../server/utils/message-retrieval";

const at = new Date("2026-01-01T12:00:00Z");
const row = (id: string, minute: number, content = "普通闲聊", conversationId = "group-a"): HistoryMessage => ({
  id, role: "USER", content, conversationId, occurredAt: new Date(at.getTime() + minute * 60_000),
});
assert.deepEqual([...historyExcludedIds({ groupChat: true, recentIds: ["r"], suppliedIds: ["s"] })], ["s"]);
assert.deepEqual([...historyExcludedIds({ groupChat: false, recentIds: ["r"], suppliedIds: ["s"] })], ["r", "s"]);
assert.deepEqual(historyCursorWhere(row("tie", 0), "desc"), { OR: [
  { occurredAt: { lt: at } }, { occurredAt: at, id: { lt: "tie" } },
] });
const excluded = new Set(["seen"]);
let pages = 0;
let neighborCalls = 0;
const result = await loadMessageHistoryCoverage({
  matched: [...Array.from({ length: 20 }, () => row("seen", 0)), row("blocked", -1)],
  window: [row("seen", 0)], excludeIds: excluded,
  filterVisible: async rows => rows.filter(item => item.id !== "blocked"),
  fetchPage: async options => {
    pages++;
    assert.equal(options.cursor?.id, "seen", "Fallback starts outside the original recent window even when excluded.");
    assert(options.excludeIds.includes("seen"));
    return [row("old", -16, "学费拿糖抵"), row("old-reply", -15, "先交一包")];
  },
  fetchNeighbors: async () => { neighborCalls++; return []; },
});
assert.equal(pages, 1, "Duplicate or blocked keyword hits cannot suppress fallback.");
assert.equal(neighborCalls, 0, "Blocked anchors must not cause neighborhood queries.");
assert.deepEqual(result.map(item => item.id), ["old", "old-reply"]);
let outsideWindowCalls = 0;
await loadMessageHistoryCoverage({
  matched: [], window: Array.from({ length: 100 }, (_, i) => row("w" + i, i)), excludeIds: new Set(),
  filterVisible: async rows => rows,
  fetchPage: async options => { outsideWindowCalls++; assert.equal(options.cursor?.id, "w0"); return [row("outside", -1)]; },
  fetchNeighbors: async () => [],
});
assert.equal(outsideWindowCalls, 1, "A large recent window does not consume the outside-window fallback quota.");
let calls = 0;
await loadMessageHistoryCoverage({
  matched: Array.from({ length: 20 }, (_, i) => row("m" + i, i)), window: [], excludeIds: new Set(),
  filterVisible: async rows => rows, fetchPage: async () => { throw new Error("Enough valid matches must not scan fallback."); },
  fetchNeighbors: async () => { calls++; return []; },
});
assert.equal(calls, 8, "Neighbor expansion is bounded to four anchors and two directions.");
const boundedNeighbors = await loadMessageHistoryCoverage({
  matched: [row("anchor", 0, "学费")], window: [], excludeIds: new Set(),
  filterVisible: async rows => rows.filter(item => item.id !== "blocked-neighbor"),
  fetchPage: async () => [],
  fetchNeighbors: async (_anchor, direction) => direction === "after" ? [
    row("cross-room", 1, "OTHER_PRIVATE", "private-b"), row("too-far", 9),
    row("blocked-neighbor", 1), row("allowed-neighbor", 1),
  ] : [],
});
assert.deepEqual(boundedNeighbors.map(item => item.id), ["anchor", "allowed-neighbor"],
  "Neighbor expansion independently checks room/time and applies blocked-speaker filtering.");
const selected = selectRawMessagesForMemoryAssistant("学费", [
  row("anchor", 0, "学费拿糖抵"), row("reply", 1, "先交一包，本宝验验甜不甜"),
  row("other-room", 1, "PRIVATE_OTHER_ROOM", "private-b"), row("far", 10, "FAR_AWAY"),
], { limit: 4 });
assert(selected.some(item => item.id === "reply"), "Reply without keyword survives beside its source.");
assert(!selected.some(item => item.id === "other-room"), "Neighbors cannot cross conversations.");
assert(!selected.some(item => item.id === "far"), "Neighbors cannot cross the bounded time window.");
const excludedNeighbor = selectRawMessagesForMemoryAssistant("学费", [row("anchor", 0, "学费拿糖抵"), row("reply", 1, "先交一包")], { excludeIds: new Set(["reply"]) });
assert(!excludedNeighbor.some(item => item.id === "reply"));
console.log("Message history coverage tests passed (no database or model calls).");
