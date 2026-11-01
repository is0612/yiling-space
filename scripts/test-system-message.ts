import assert from "node:assert/strict";
import { isSystemBroadcast, looksLikeSystemMessage } from "../server/utils/system-message";

/**
 * 系统播报判定的回归测试。
 *
 * 这里锁的是**两个判据的宽严差异** —— 它是这张表最重要的性质：
 * 读取侧宁可多挡（挡错的代价是少一行上下文），写入侧宁可漏标（标错的代价是永久丢消息）。
 * 任何人把它改成「一个函数到处用」，下面那组真人长句就会开始被标成系统消息。
 */

// ── 宽判据：挡在提示词窗口外 ────────────────────────────────
assert.equal(looksLikeSystemMessage("管理命令仅管理员可用。"), true, "完整句子 + 句号 = 系统播报风格。");
assert.equal(looksLikeSystemMessage("⏳ 系统服务重启中，消息已排队，恢复后自动处理。"), true);
assert.equal(looksLikeSystemMessage("❌ 没有权限"), true, "状态 emoji 开头的一律当播报。");
assert.equal(looksLikeSystemMessage("xxx 不烧心吗"), false, "人说梗不打句号。");
assert.equal(looksLikeSystemMessage("确认发布"), false, "短句没句号，判断不了 —— 交给模型。");
assert.equal(looksLikeSystemMessage("好。"), false, "极短的带句号句子不算播报，别误杀。");

// ── 窄判据：落库时打标 ──────────────────────────────────────
assert.equal(isSystemBroadcast("管理命令仅管理员可用。"), true);
assert.equal(isSystemBroadcast("⏳ 系统服务重启中，消息已排队，恢复后自动处理。"), true);
assert.equal(isSystemBroadcast("⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。"), true);
assert.equal(isSystemBroadcast("B站内容获取失败，可能需要配置 Cookies，请在插件配置中填写后重试。"), true);
assert.equal(isSystemBroadcast("❌ 没有权限"), true, "状态 emoji 开头，两个判据都认。");

// 真人说的话：宽判据会误伤，窄判据必须放过
const humanSentences = [
  "不然呢，我总不能有多根网线吧。我走的都是一个IP。",
  "叫谁爸爸呢，乱认亲。",
  "劳资没战网，玩个屁的炉石啊，在你X上打的炉石吗。说话过过你核桃大小的脑子吧兄弟。",
  "我只是在偷偷的看着你们说话。不会乱插嘴的。",
  "在打。手牌快满了，每回合都得精算弃哪张。",
];
for (const sentence of humanSentences) {
  assert.equal(isSystemBroadcast(sentence), false, `真人长句不能被标成系统播报：${sentence}`);
}
// 其中至少有一条确实会被宽判据挡住 —— 这就是「别拿宽判据删库」的理由
assert.equal(looksLikeSystemMessage(humanSentences[0]!), true, "宽判据确实会误伤这句真人话，所以它只能用在读取侧。");

// ── 边界 ────────────────────────────────────────────────────
assert.equal(isSystemBroadcast(""), false);
assert.equal(looksLikeSystemMessage(""), false);
assert.equal(isSystemBroadcast("仅管理员可用"), true, "片段命中就够，不必整句一致（机器人的措辞会变）。");
assert.equal(isSystemBroadcast("今天好累啊。"), false, "窄判据不看句号，只认 emoji 和已知句式。");

console.log("system-message: 全部断言通过");
