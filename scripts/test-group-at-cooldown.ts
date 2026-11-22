import assert from "node:assert/strict";
import { claimGroupAt, groupAtKey, GROUP_AT_COOLDOWN_MS, resetGroupAtCooldown } from "../server/utils/channel-adapter/onebot/at-cooldown";
const now = 1_700_000_000_000;
resetGroupAtCooldown();
const key = groupAtKey("sender-a", "group-a", "member-a");
const first = claimGroupAt(key, now);
assert.equal(first.allowed, true);
assert.equal(claimGroupAt(key, now).allowed, false, "并发请求不能穿透预约");
if (!first.allowed) throw new Error("expected reservation");
first.release();
const retry = claimGroupAt(key, now + 1000);
assert.equal(retry.allowed, true, "发送失败释放后可重试");
if (!retry.allowed) throw new Error("expected retry reservation");
retry.commit(now + 2000);
assert.equal(claimGroupAt(key, now + 2000 + GROUP_AT_COOLDOWN_MS - 1).allowed, false);
assert.equal(claimGroupAt(key, now + 2000 + GROUP_AT_COOLDOWN_MS).allowed, true, "从实际成功时间计时");
for (const other of [groupAtKey("sender-b", "group-a", "member-a"), groupAtKey("sender-a", "group-b", "member-a"), groupAtKey("sender-a", "group-a", "member-b")]) {
  assert.equal(claimGroupAt(other, now).allowed, true, "发送者、群和收件人分别隔离");
}
resetGroupAtCooldown();
console.log("群聊 @ 冷却：全部通过");
