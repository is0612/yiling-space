import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { buildGroupActivityContext } from "../server/utils/group-activity-stats";

const now = new Date("2026-11-07T12:00:00.000Z");
const rows = [
  {
    content: "@999 你好，我是被屏蔽的 AI",
    occurredAt: new Date("2026-11-07T11:58:00.000Z"),
    metadata: { authorOpenId: "blocked-ai", authorDisplayName: "不想搭理的鱼" },
  },
  {
    content: "@999 我是允许交流的 AI",
    occurredAt: new Date("2026-11-07T11:57:00.000Z"),
    metadata: { authorOpenId: "allowed-ai", authorDisplayName: "想交流的小鱼" },
  },
  {
    content: "人类朋友在群里聊天",
    occurredAt: new Date("2026-11-07T11:56:00.000Z"),
    metadata: { authorOpenId: "human", authorDisplayName: "真人朋友" },
  },
  {
    content: "主人也在群里",
    occurredAt: new Date("2026-11-07T11:55:00.000Z"),
    metadata: { authorOpenId: "owner", authorDisplayName: "主人" },
  },
  {
    content: "未知身份保持原有行为",
    occurredAt: new Date("2026-11-07T11:54:00.000Z"),
    metadata: { authorOpenId: "unknown", authorDisplayName: "还没确认的人" },
  },
];

const prisma = {
  message: {
    findMany: async () => rows,
  },
  externalIdentity: {
    findMany: async () => [
      { platformUid: "blocked-ai", kind: "AI", memoryScopes: [{ friendChatPolicy: "BLOCK" }] },
      { platformUid: "allowed-ai", kind: "AI", memoryScopes: [{ friendChatPolicy: "ALLOW" }] },
      { platformUid: "human", kind: "HUMAN", memoryScopes: [{ friendChatPolicy: "DEFAULT" }] },
      // 就算数据库设置成 AI + BLOCK，ownerQq 仍按主人身份优先，不会误过滤主人。
      { platformUid: "owner", kind: "AI", memoryScopes: [{ friendChatPolicy: "BLOCK" }] },
    ],
  },
} as unknown as Pick<PrismaClient, "message" | "externalIdentity">;

const result = await buildGroupActivityContext({
  prisma,
  conversationId: "test-conversation",
  characterId: "test-character",
  platform: "qq-onebot",
  query: "跟谁聊天最多",
  now,
  selfQq: "999",
  ownerQq: "owner",
});

assert.ok(result, "至少有一个允许显示的成员时应返回统计。");
assert.equal(result.totalMessages, 4, "被禁止 AI 的历史发言不进入统计总数。");
assert.deepEqual(
  result.members.map((member) => member.accountId).sort(),
  ["allowed-ai", "human", "owner", "unknown"],
  "只排除当前策略禁止的对象；允许 AI、真人、主人和未知身份继续保留。",
);
assert.ok(
  !result.members.some((member) => member.name === "不想搭理的鱼"),
  "被屏蔽的 AI 不应通过历史群聊统计进入模型提示词。",
);

console.log("通过：群聊历史统计遵循 AI 身份与角色交流权限。");
