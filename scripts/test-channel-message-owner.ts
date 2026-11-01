import assert from "node:assert/strict";
import { resolveOwnerPrivateScopeRepair } from "../server/utils/channel-adapter/pipeline";
import { readSourceMessageIsOwner } from "../server/utils/conversation-message";

/**
 * 提炼/忆泡侧的两条确定性判据：
 * - 桌面对话没有渠道账号，USER 消息按主人算，否则私聊忆泡的 participantRefs 少一个「对方」；
 * - 主人私聊的老会话来自身份范围时要归位到 USER_PRIVATE，非主人绝不搬回去。
 */

assert.equal(
  readSourceMessageIsOwner({ source: "yiling-chat-ui" }, { origin: "本地对话", role: "USER" }),
  true,
  "桌面对话的 USER 消息就是主人说的。",
);
assert.equal(
  readSourceMessageIsOwner({ source: "yiling-chat-ui" }, { origin: "本地对话", role: "ASSISTANT" }),
  false,
  "她自己的消息不能标成主人。",
);
assert.equal(
  readSourceMessageIsOwner({ authorOpenId: "556" }, { origin: "私聊", role: "USER" }),
  false,
  "渠道私聊里的普通用户不是主人，仍然只认 isOwner。",
);
assert.equal(
  readSourceMessageIsOwner({ isOwner: true }, { origin: "QQ群 123456", role: "USER" }),
  true,
  "群聊里渠道明确标了 isOwner 的才是主人。",
);

assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: "owner-scope", currentScopeId: "external-scope" }),
  "owner-scope",
  "主人发言时，挂在外部身份范围上的老会话要迁到主人私人范围。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: "owner-scope", currentScopeId: "owner-scope" }),
  null,
  "已经在主人范围里就不用再写。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: false, ownerPrivateScopeId: "owner-scope", currentScopeId: "external-scope" }),
  null,
  "不是主人的私聊绝不往主人范围搬 —— 猜错等于把主人的私聊暴露给外人。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: null, currentScopeId: "external-scope" }),
  null,
  "没有主人私人范围时什么都不做。",
);

console.log("私聊主人判定测试通过：桌面 USER 按主人、渠道只认 isOwner、老会话只往主人范围归位。");
