import assert from "node:assert/strict";
import { inspectOnebotRedPacket } from "../server/utils/channel-adapter/onebot/red-packet-diagnostics";

// 结构化红包段：只返回类型和字段名，绝不返回字段值。
const segmentResult = inspectOnebotRedPacket({
  post_type: "message",
  message: [
    { type: "text", data: { text: "有人发红包啦" } },
    { type: "redbag", data: { id: "secret-red-packet-id", auth_key: "secret-auth-key" } },
  ],
});
assert(segmentResult, "应识别结构化红包段");
assert.equal(segmentResult.source, "segment");
assert.deepEqual(segmentResult.candidateTypes, ["redbag"]);
assert.deepEqual(segmentResult.dataKeys, [["auth_key", "id"]]);
assert(!JSON.stringify(segmentResult).includes("secret"), "诊断结果不得包含任何字段值");

// SnowLuma 当前日志可见的文本标记。
const textResult = inspectOnebotRedPacket({
  message: [{ type: "text", data: { text: "[QQ红包]请使用新版手机QQ查收红包。" } }],
});
assert(textResult, "应识别 QQ 红包文本标记");
assert.equal(textResult.source, "text_marker");
assert.deepEqual(textResult.candidateTypes, []);

// raw_message 也可能保留网关渲染出的标记。
assert(inspectOnebotRedPacket({ message: [], raw_message: "[红包]请查收" }));

// 普通消息不产生诊断日志。
assert.equal(inspectOnebotRedPacket({ message: [{ type: "text", data: { text: "你好" } }] }), null);
assert.equal(inspectOnebotRedPacket(null), null);

console.log("OneBot 红包诊断测试通过：结构化段、文本标记、脱敏与普通消息过滤。");
