/**
 * 「记忆页里有，聊天里没出现」到底卡在哪一环？
 *
 * 这条链路有四个可能断点，肉眼看不出来：
 *   1. 不在可读范围（私人范围没授权、群聊只读全局）；
 *   2. 在候选集里，但关键词一条都没命中；
 *   3. 命中了，但排在后面被条数或 token 预算挤掉；
 *   4. 放进提示词了，模型没用（那要看回合详情的 used）。
 *
 * 本脚本用与网页聊天相同的范围和预算跑一遍，只回答 1–3 落在哪一档。
 * 只读：不写库、不调模型、不改状态。
 *
 * 用法：
 *   yarn tsx scripts/probe-memory-reach.ts --character=<角色id> --query="还记得海边那次约定吗"
 *   yarn tsx scripts/probe-memory-reach.ts --character=<id> --query="…" --memory=<记忆id>
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveChatMemoryScopes } from "../server/utils/memory-scope-access";
import { resolveChatTimeZone } from "../server/utils/chat-time-context";
import { loadPromptMemoryCandidates } from "../server/utils/prompt-memory-candidates";
import { loadPromptEventCandidates } from "../server/utils/prompt-event-candidates";
import { selectPromptMemoryContext } from "../server/utils/prompt-memory-selection";
import {
  rankMemoriesWithBudget, resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveSnapshotTokenBudget,
} from "../server/utils/memory-retrieval";
import { resolveEventItemLimit, resolveEventRecentDays, resolveEventTokenBudget } from "../server/utils/memory-event-retrieval";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");
const args = Object.fromEntries(process.argv.slice(2).map(raw => {
  const matched = /^--([^=]+)(?:=([\s\S]*))?$/u.exec(raw);
  return matched ? [matched[1], matched[2] ?? "true"] : [raw.replace(/^--/u, ""), "true"];
}));
const characterId = String(args.character ?? "").trim();
const query = String(args.query ?? "").trim();
const targetId = String(args.memory ?? "").trim();
if (!characterId || !query) throw new Error("用法：--character=<角色id> --query=<问句> [--memory=<记忆id>]");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const character = await prisma.character.findFirst({
  where: { id: characterId },
  select: {
    id: true, name: true, ownerId: true, modelConfig: true,
    memorySetting: { select: { timezone: true } },
    memoryScopes: {
      select: {
        id: true, scopeType: true, userId: true, externalIdentityId: true,
        externalIdentity: { select: { status: true, linkedUserId: true } },
      },
    },
  },
});
if (!character) throw new Error(`找不到角色 ${characterId}`);

const readable = resolveChatMemoryScopes(character.memoryScopes, character.ownerId);
const readableScopeIds = readable.map(scope => scope.id);
const scopeOriginForMap = new Map(readable.map(scope => [scope.id, scope.origin]));
const timeZone = resolveChatTimeZone(character.memorySetting?.timezone);

const { memories: memoryCandidates, snapshots: snapshotCandidates } = await loadPromptMemoryCandidates(prisma, {
  readableScopeIds, query,
});
const eventCandidates = await loadPromptEventCandidates(prisma, { readableScopeIds, query, timeZone });
const selected = await selectPromptMemoryContext({
  query,
  now: new Date(),
  timeZone,
  memoryCandidates,
  snapshotCandidates,
  eventCandidates,
  participantIds: [],
  limits: {
    memoryItems: resolveMemoryItemLimit(character.modelConfig),
    memoryTokens: resolveMemoryTokenBudget(character.modelConfig),
    snapshots: 4,
    snapshotTokens: resolveSnapshotTokenBudget(character.modelConfig),
    events: resolveEventItemLimit(character.modelConfig),
    eventTokens: resolveEventTokenBudget(character.modelConfig),
    recentEventDays: resolveEventRecentDays(character.modelConfig),
  },
  scopeOf: (memoryScopeId) => (scopeOriginForMap.get(memoryScopeId) ?? "character"),
  loadParticipantNames: async events => events.map(event => [...event.participants]),
});

// 全量相关度（不截断、不限预算）用来回答「是没命中还是排太后」。
const scored = rankMemoriesWithBudget(query, memoryCandidates);
const scoredIndex = new Map(scored.items.map((item, index) => [item.id, index]));
const selectedIds = new Set(selected.memories.map(item => item.id));

const rows = targetId
  ? memoryCandidates.filter(candidate => candidate.id === targetId)
  : memoryCandidates.filter(candidate => scoredIndex.has(candidate.id)).slice(0, 10);

const report = rows.map(candidate => {
  const rank = scoredIndex.get(candidate.id);
  const inPrompt = selectedIds.has(candidate.id);
  const reason = inPrompt
    ? "已放入提示词"
    : rank === undefined
      ? "关键词没命中（问句和这条记忆没有共同词）"
      : "命中但被条数或 token 预算挤掉";
  return {
    id: candidate.id,
    category: candidate.category,
    scope: scopeOriginForMap.get(candidate.memoryScopeId) ?? "character",
    matched: rank !== undefined,
    rank: rank === undefined ? null : rank + 1,
    inPrompt,
    reason,
  };
});

const missingInScope = targetId && !rows.length
  ? await prisma.memoryItem.findFirst({
      where: { id: targetId },
      select: { id: true, status: true, deletedAt: true, memoryScopeId: true },
    })
  : null;

console.log(`角色：${character.name}`);
console.log(`可读范围：${readable.map(scope => `${scope.origin}(${scope.id.slice(0, 8)})`).join("、") || "无"}`);
console.log(`候选：记忆 ${memoryCandidates.length} 条，快照 ${snapshotCandidates.length} 份，忆泡 ${eventCandidates.length} 条`);
console.log(`放进提示词：记忆 ${selected.selection.memory.count} 条（挤掉 ${selected.selection.memory.dropped}）、快照 ${selected.selection.snapshot.count} 份、忆泡 ${selected.selection.event.count} 条`);
if (!targetId) {
  console.log("\n本轮最相关的几条（--memory=<id> 可单独追问一条）：");
  for (const row of report) console.log(`- ${row.id} [${row.category}/${row.scope}] 第 ${row.rank} 位 ${row.inPrompt ? "✓ 已放入" : "✗ 未放入"}`);
} else if (!rows.length) {
  console.log(`\n目标 ${targetId} 不在候选集里：`);
  if (!missingInScope) console.log("- 库里没有这条记忆（或已被删除）。");
  else console.log(`- 状态 ${missingInScope.status}${missingInScope.deletedAt ? "（已删除）" : ""}，范围 ${missingInScope.memoryScopeId}；该范围不在本次可读范围，或不在候选查询窗口内。`);
} else {
  for (const row of report) {
    console.log(`\n${row.id}`);
    console.log(`  相关度排序：${row.rank ?? "未命中"}；${row.inPrompt ? "已放入提示词" : "未放入提示词"}`);
    console.log(`  结论：${row.reason}`);
  }
}
console.log("\n（只读：未调用模型、未修改任何数据；第 4 档「放进去了但模型没用」看回合详情的 used。）");
await prisma.$disconnect();
