import assert from "node:assert/strict";
import {
  AMBIENT_GROUP_MESSAGE_REASON,
  AMBIENT_GROUP_MESSAGE_RETENTION_HOURS,
  ambientCleanupWhere,
  notAmbientMessageWhere,
  resolveStoreAmbientGroupMessages,
  shouldStoreAmbientGroupMessage,
} from "../server/utils/group-ambient-memory";
import { buildStoredMessageMetadata } from "../server/utils/channel-adapter/pipeline";

// 配置解析：只认 true 或群号数组，坏值一律退回关闭。
assert.equal(resolveStoreAmbientGroupMessages(true), true);
assert.equal(resolveStoreAmbientGroupMessages(false), false);
assert.equal(resolveStoreAmbientGroupMessages(undefined), false);
assert.equal(resolveStoreAmbientGroupMessages("389834620"), false);
assert.deepEqual(resolveStoreAmbientGroupMessages([" 389834620 ", "389834620", "", 123]), ["389834620"]);
assert.equal(resolveStoreAmbientGroupMessages([]), false);

// 按群判断：true 表示所有群，数组只放行列出的群。
assert.equal(shouldStoreAmbientGroupMessage(true, "389834620"), true);
assert.equal(shouldStoreAmbientGroupMessage(["389834620"], "389834620"), true);
assert.equal(shouldStoreAmbientGroupMessage(["389834620"], "1127648581"), false);
assert.equal(shouldStoreAmbientGroupMessage(false, "389834620"), false);
assert.equal(shouldStoreAmbientGroupMessage(true, undefined), false);

// 快照/忆泡来源必须排除 ambient，原文检索不受影响。
assert.deepEqual(notAmbientMessageWhere(), {
  NOT: { metadata: { path: ["storedReason"], equals: AMBIENT_GROUP_MESSAGE_REASON } },
});

// 清理只删 48 小时之前的 ambient。
const now = new Date("2026-11-24T12:00:00.000Z");
const cleanup = ambientCleanupWhere(now);
assert.equal(cleanup.metadata.equals, "ambient");
assert.equal(cleanup.occurredAt.lt.toISOString(), "2026-11-22T12:00:00.000Z");
assert.equal(AMBIENT_GROUP_MESSAGE_RETENTION_HOURS, 48);

// 落库 metadata 要能标出 ambient，清理和筛选都靠这个字段。
const metadata = buildStoredMessageMetadata({
  platform: "qq-onebot",
  storedReason: "ambient",
  message: { authorOpenId: "123456789", authorDisplayName: "某个群友", content: "刚才说的那句话", kind: "HUMAN" },
});
assert.equal(metadata.storedReason, "ambient");
assert.equal(metadata.authorOpenId, "123456789");

console.log("Ambient group message settings and filters passed (pure helpers, no database or model calls).");
