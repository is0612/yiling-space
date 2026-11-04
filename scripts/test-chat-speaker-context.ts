import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";

const originalFetch = globalThis.fetch;
let capturedBody = "";
globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-chat-model",
    choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: "我的主人是烟火清凉。", usedMemoryIds: [], usedSnapshotIds: [] }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const result = await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "你的主人是谁",
    recentMessages: [],
    memories: [],
    snapshots: [],
    speaker: { displayName: "群友", isOwner: false, ownerDisplayName: "烟火清凉" },
  });

  // 不写死版本号：写死的是「上一次的答案」，每次升版都得手动改一遍（这里就跟不上了，
  // 断言停在 v25 而模板已经 v27）。这里只校验形状；「标记与版本号同源」由
  // scripts/test-chat-reply.ts 负责。
  assert.match(result.promptTemplateVersion, /^conversation-retrieval-v\d+$/u);
  const body = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages.find((item) => item.role === "system")?.content ?? "";
  const user = body.messages.find((item) => item.role === "user")?.content ?? "";
  assert(system.includes("not your own owner"), "系统提示必须明确角色不是自己的主人。");
  assert(system.includes("ownerDisplayName"), "系统提示必须解释主人名字字段。");
  assert(user.includes("\"isOwner\":false"), "非主人说话时必须标明不是主人。");
  assert(user.includes("烟火清凉"), "主人名字必须进入提示词。");
  assert(!system.includes("10000002") && !user.includes("10000002"), "提示词不能带平台账号 ID。");

  await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "本宝的主人当然是我自己",
    recentMessages: [],
    memories: [],
    snapshots: [],
    speaker: { displayName: "烟火清凉", isOwner: true, ownerDisplayName: "烟火清凉" },
  });
  const body2 = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const user2 = body2.messages.find((item) => item.role === "user")?.content ?? "";
  assert(user2.includes("\"isOwner\":true"), "主人说话时必须标明是主人。");

  // 群聊：一轮里好几个人说话，主人身份必须挂在**每一行**上。
  // 顶层 speaker 在群聊路径下不传，只给顶层就等于没有身份信息（对谁都喊主人的根因）。
  await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "（本轮消息见 transcript）",
    groupChat: true,
    allowSilent: true,
    transcript: [
      { id: "m1", member: "member_1", speaker: "群友甲", content: "@self 大肥鱼她说我呜呜", isOwner: false },
      { id: "m2", member: "member_2", speaker: "烟火清凉", content: "夸的是你", isOwner: true },
    ],
    // 历史消息也要带发言人：群聊里 role USER 不代表同一个人。
    recentMessages: [
      { role: "USER", content: "今天好热", occurredAt: new Date().toISOString(), speaker: "群友甲", isOwner: false },
      { role: "ASSISTANT", content: "热就少穿点", occurredAt: new Date().toISOString(), hadSticker: true },
      // 她刚发过一条语音，下一轮换成文字。没有 hadVoice 她就当自己一直在打字。
      { role: "ASSISTANT", content: "语料？本宝手里没这号东西", occurredAt: new Date().toISOString(), hadVoice: true },
    ],
    memories: [],
    snapshots: [],
  });
  const body3 = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const system3 = body3.messages.find((item) => item.role === "system")?.content ?? "";
  const user3 = body3.messages.find((item) => item.role === "user")?.content ?? "";
  assert(system3.includes("carries isOwner"), "群聊系统提示必须解释每行的 isOwner。");
  assert(system3.includes("not your owner"), "群聊系统提示必须说明群友不是主人。");
  assert(user3.includes("\"isOwner\":false"), "群友的行必须标明 isOwner:false。");
  assert(user3.includes("\"isOwner\":true"), "主人的行必须标明 isOwner:true。");
  assert(system3.includes("recentMessages are earlier lines"), "群聊系统提示必须解释历史消息里的发言人。");
  // 2026-10-31 16:08：别人说「这鱼嘴挺硬」，她认成自己，抢了别人的台词；
  // 主人 @ 她「没说你呢」递台阶，她反问一句踢回去。两件事都要有明文规矩。
  assert(system3.includes("Referents and possessives are not you by default"), "群聊系统提示必须说明指代默认不是她。");
  assert(system3.includes("没说你"), "群聊系统提示必须把「澄清」和「挑衅」分开。");
  // 21:00「我的鱼也是成气候了」说的是他自己那条鱼，她接「谁是你的鱼了」。
  // 所有格和指代并成同一条规矩：判据只有「这一句 @ 了她、或者叫了她的名字没有」。
  assert(system3.includes("我的鱼 / 我家宝"), "群聊系统提示必须说明「我的X」指的是说话人自己的 bot。");
  assert(system3.includes("the message is not about you"), "群聊系统提示必须写明：没有 @、没有名字的话不是在说她。");
  assert(system3.includes("A line starting with /"), "群聊系统提示必须说明斜杠命令是发给别的 bot 的，不是骂她。");
  // 22:01「@群友乙 你在群里也可以学习一下她们的表情包」是主人在教群友乙，
  // 她把自己当成被教的那个，回了「学得像不像啊」「这张算及格」。
  // 「@self 不等于在说她」那条是另一面：@你 也可能是「你帮我跟她说一下」。
  assert(system3.includes("belongs to them"), "群聊系统提示必须说明「有人在教另一个 bot」这段对话不属于她。");
  assert(system3.includes("Being @self does not make the sentence about you"), "群聊系统提示必须写明：被 @ 也可能是拿她当传话筒，主语是第三人。");
  // 她自己发的表情包下一轮不可见：图只在 metadata，recentMessages 只有文字。
  // hadSticker 把它标出来，她才认得出「那张图是我贴的」。
  assert(system3.includes("hadSticker"), "群聊系统提示必须解释 hadSticker 是「自己那条带过图」。");
  assert(system3.includes("own it"), "群聊系统提示必须写明：带过图的就认领。");

  // 历史消息：USER 行不能只剩 role + content，否则 20 条历史分不清谁是谁。
  const recentSection = body3.messages.length ? user3.slice(user3.indexOf("\"recentMessages\"")) : "";
  assert(recentSection.includes("\"speaker\":\"群友甲\""), "历史 USER 行必须带发言人。");
  assert(!recentSection.includes("\"speaker\":\"小鲸鱼\""), "她自己说的话不该被当成 USER 带发言人。");
  assert(recentSection.includes("\"hadSticker\":true"), "带过表情包的 ASSISTANT 历史行必须标 hadSticker:true，否则她认不出自己发的图。");
  // 2026-11-02 16:26：她刚发完 5 秒语音，对方说「语音我这边听不了」，她回「本宝本来也只会打字」。
  // 语音痕迹只在 metadata，历史里不带出来，她就当自己没说过话。
  assert(system3.includes("hadVoice"), "系统提示必须解释 hadVoice 是「自己那条是语音」。");
  assert(system3.includes("do not say you can only type"), "系统提示必须写明：别否认自己会发语音。");
  assert(recentSection.includes("\"hadVoice\":true"), "发过语音的 ASSISTANT 历史行必须标 hadVoice:true，否则她下一轮否认自己说过话。");
  assert(!system3.includes("groupMembers says who belongs"), "没带归属表时不许提这个字段，否则模型会凭空认亲戚。");

  /**
   * 群内归属：21:00「我的鱼也是成气候了」说的是他自己那条鱼，她接「谁是你的鱼了」。
   * v15 只给了「所有格不是你」这条规矩，她无处可比；v16 把表摆进来，让她查。
   */
  await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "（本轮消息见 transcript）",
    groupChat: true,
    allowSilent: true,
    transcript: [
      { id: "m9", member: "member_1", speaker: "群友甲", content: "我的鱼也是成气候了", isOwner: false },
    ],
    groupMembers: [
      { member: "member_2", speaker: "千人安知鱼之乐", belongsTo: "member_1", belongsToName: "群友甲" },
    ],
    recentMessages: [],
    memories: [],
    snapshots: [],
  });
  const body4 = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const system4 = body4.messages.find((item) => item.role === "system")?.content ?? "";
  const user4 = body4.messages.find((item) => item.role === "user")?.content ?? "";
  assert(system4.includes("groupMembers says who belongs"), "有归属表时必须解释这张表是什么。");
  assert(system4.includes("Check it before you treat a possessive as yours"), "必须写出「先查表再判断所有格」这一步。");
  assert(user4.includes("\"belongsTo\":\"member_1\""), "归属关系必须进 payload，否则提示词让她查也没得查。");

  console.log("对话主人上下文测试通过：主人/群友区分、主人名字注入、群聊逐行 isOwner、群内归属表（谁属于谁）、平台账号 ID 不进入提示词。");
} finally {
  globalThis.fetch = originalFetch;
}
