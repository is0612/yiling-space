import assert from "node:assert/strict";
import {
  buildAnnouncementSystemPrompt,
  buildAnnouncementUserPrompt,
  isAnnouncementConfirm,
  parseAnnouncementRequest,
  sanitizeAnnouncement,
} from "../server/utils/channel-adapter/onebot/announcement";
import { isOnebotGroupAdmin, readOnebotGroupRole } from "../server/utils/channel-adapter/onebot/types";

// 身份：只有群主/管理员能触发；缺失 role 时按普通成员处理。
assert.equal(readOnebotGroupRole({ sender: { role: "owner" } }), "owner");
assert.equal(readOnebotGroupRole({ sender: { role: "admin" } }), "admin");
assert.equal(readOnebotGroupRole({ sender: { role: "member" } }), "member");
assert.equal(readOnebotGroupRole({ sender: {} }), "member");
assert.equal(readOnebotGroupRole({}), "member");
assert.equal(isOnebotGroupAdmin({ sender: { role: "owner" } }), true);
assert.equal(isOnebotGroupAdmin({ sender: { role: "admin" } }), true);
assert.equal(isOnebotGroupAdmin({ sender: { role: "member" } }), false);
assert.equal(isOnebotGroupAdmin({}), false);

// 意图：动作 + 群公告才算；单纯聊到「群公告」不能触发。
assert.deepEqual(parseAnnouncementRequest("写个群公告：本周六晚八点活动"), { topic: "本周六晚八点活动" });
assert.deepEqual(parseAnnouncementRequest("设置一个群公告"), { topic: "" });
assert.deepEqual(parseAnnouncementRequest("现在你是群管理了，设置一个群公告"), { topic: "" });
assert.deepEqual(parseAnnouncementRequest("群公告：周五停服维护"), { topic: "周五停服维护" });
assert.equal(parseAnnouncementRequest("这个群公告写得真好"), null);
assert.equal(parseAnnouncementRequest("今天聊点什么"), null);
assert.equal(parseAnnouncementRequest("确认发布"), null);

// 确认词：只认完整的「确认发布」，避免管理员随口说「发布」误触。
assert.equal(isAnnouncementConfirm("确认发布"), true);
assert.equal(isAnnouncementConfirm(" 确认发布。 "), true);
assert.equal(isAnnouncementConfirm("@123456789 确认发布"), true);
assert.equal(isAnnouncementConfirm("确认"), false);
assert.equal(isAnnouncementConfirm("发布"), false);
assert.equal(isAnnouncementConfirm("确认一下"), false);
assert.equal(isAnnouncementConfirm("不要发布"), false);

// 正文清理：去代码块、去「公告：」前缀、去包裹引号、限长。
assert.equal(sanitizeAnnouncement("```text\n公告：本周六活动\n```"), "本周六活动");
assert.equal(sanitizeAnnouncement("“周五停服维护”"), "周五停服维护");
assert.equal(sanitizeAnnouncement(""), "");
assert.equal(sanitizeAnnouncement("a".repeat(800)).length, 500);

// 提示词：带标记（供模拟模型识别），并要求只输出正文；不包含任何凭据字段。
const system = buildAnnouncementSystemPrompt({
  characterName: "小鲸鱼",
  characterPrompt: "你是一条爱聊天的鲸鱼。",
  styleExamples: "说话简短。",
});
assert(system.includes("YILING_GROUP_ANNOUNCEMENT_V1"));
assert(system.includes("只输出公告正文"));
assert(system.includes("小鲸鱼"));
assert(!system.includes("apiKey"));
const user = buildAnnouncementUserPrompt({ topic: "周末活动", recentContext: "群成员：周六有空吗" });
assert(user.includes("周末活动"));
assert(user.includes("周六有空吗"));
const emptyTopic = buildAnnouncementUserPrompt({ topic: "", recentContext: "" });
assert(emptyTopic.includes("未指定"));

console.log("OneBot 群公告单元测试通过：身份限制、意图识别、确认词、正文清理与提示词。");
