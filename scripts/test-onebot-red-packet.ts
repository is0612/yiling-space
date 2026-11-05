import assert from "node:assert/strict";
import { inspectOnebotRedPacketEvent } from "../server/utils/channel-adapter/onebot/client";

const textEvent = {
  post_type: "message",
  message_type: "group",
  user_id: 101,
  group_id: 202,
  message_id: -303,
  message: [{ type: "text", data: { text: "[QQ红包]请使用新版手机QQ查收红包。" } }],
  raw_message: "[QQ红包]请使用新版手机QQ查收红包。",
};
const textDiagnostic = inspectOnebotRedPacketEvent(textEvent);
assert.ok(textDiagnostic, "应识别 SnowLuma WebUI 展示的 [QQ红包] 文本标记。");
assert.equal(textDiagnostic.messageType, "group");
assert.ok(textDiagnostic.matchedBy.includes("segment_data_marker"));
assert.deepEqual(textDiagnostic.segmentTypes, ["text"]);

// 结构化红包段：只暴露段类型与字段名，不暴露任何字段值。
const structuredEvent = {
  post_type: "message",
  message_type: "group",
  user_id: 123,
  group_id: 456,
  message_id: 789,
  message: [
    { type: "text", data: { text: "看这里" } },
    { type: "redbag", data: { id: "sensitive-red-packet-id", auth: "secret-token", title: "恭喜发财" } },
  ],
};
const structuredDiagnostic = inspectOnebotRedPacketEvent(structuredEvent);
assert.ok(structuredDiagnostic, "应识别红包专用消息段。");
assert.ok(structuredDiagnostic.matchedBy.includes("segment_type"));
assert.deepEqual(structuredDiagnostic.candidateSegments, [
  { type: "redbag", dataKeys: ["id", "auth", "title"] },
]);
assert.equal(JSON.stringify(structuredDiagnostic).includes("sensitive-red-packet-id"), false);
assert.equal(JSON.stringify(structuredDiagnostic).includes("secret-token"), false);
assert.equal(JSON.stringify(structuredDiagnostic).includes("恭喜发财"), false);

// 普通聊天不应触发诊断。
assert.equal(inspectOnebotRedPacketEvent({
  post_type: "message",
  message_type: "group",
  message: [{ type: "text", data: { text: "今天吃什么？" } }],
}), null);

// 原始消息字段里即使出现标记，也只输出标记来源，不泄露原文。
const rawOnlyDiagnostic = inspectOnebotRedPacketEvent({
  post_type: "message",
  message_type: "group",
  message: "普通文本",
  raw_message: "[QQ红包]某人发了红包",
});
assert.ok(rawOnlyDiagnostic);
assert.deepEqual(rawOnlyDiagnostic.matchedBy, ["raw_message_marker"]);
assert.equal(JSON.stringify(rawOnlyDiagnostic).includes("某人"), false);

console.log("OneBot 红包事件脱敏诊断测试通过。");
