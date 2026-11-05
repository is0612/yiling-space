import assert from "node:assert/strict";
import { nextPrivateChatCursor, privateChatCursorWhere, readPrivateChatCursor } from "../server/utils/private-chat-cursor";

const at = new Date("2026-11-05T03:00:00.000Z");
const cursor = readPrivateChatCursor(at.toISOString(), "message-b");
assert.deepEqual(cursor, { occurredAt: at, id: "message-b" });
assert.deepEqual(privateChatCursorWhere(cursor!), {
  OR: [
    { occurredAt: { lt: at } },
    { occurredAt: at, id: { lt: "message-b" } },
  ],
});
assert.deepEqual(nextPrivateChatCursor({ occurredAt: at, id: "message-a" }), {
  before: at.toISOString(), beforeId: "message-a",
});
assert.equal(nextPrivateChatCursor(undefined), null);
assert.throws(() => readPrivateChatCursor(at.toISOString(), undefined));
assert.throws(() => readPrivateChatCursor("not-a-date", "id"));
console.log("Private chat composite cursor tests passed.");
