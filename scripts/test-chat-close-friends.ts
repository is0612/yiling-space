import assert from "node:assert/strict";
import { buildAcquaintancePayload, generateConversationReply } from "../server/utils/chat-reply";
import type { Acquaintances } from "../server/utils/friends";

/**
 * 熟人名册（acquaintances）进提示词。
 *
 * 起因：2026-11-01 12:20 有人问「你跟谁关系最好」，她答「跟小胖鱼呗」—— 那是群里另一个
 * bot 的昵称，不是任何关系记录。她原本对「自己认识谁」零信息。
 *
 * v23 之前是一张扁平总榜，两个问题：
 * - 群里分不清是哪个群的熟人，A 群的小胖鱼会被当成 B 群那个人；
 * - 私聊里被问「跟谁最好」时，群里天天见的人次数天然高，私聊的亲近对象排不上号。
 *
 * 所以现在是三档：fromPrivate / fromGroups / inThisGroup。这个测试盯四件事：
 * 1. 私聊：两档要**分开说**，不许拼成一张排行榜；
 * 2. 群聊：只有 inThisGroup 能决定「这屋里谁跟我熟」，别群的人不许拿来凑数；
 * 3. 没传：一个字都不能提，否则模型会凭空编朋友；
 * 4. payload 形态：日期裁成 M-D、空档整段不写、全空返回 null。
 */

const originalFetch = globalThis.fetch;
let capturedBody = "";

globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-chat-model",
    choices: [{
      message: {
        role: "assistant",
        content: JSON.stringify({ reply: "昔涟吧，来得最勤。", usedMemoryIds: [], usedSnapshotIds: [], usedEventIds: [] }),
      },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

type Captured = { messages: Array<{ role: string; content: string }> };

function readCaptured() {
  const body = JSON.parse(capturedBody) as Captured;
  return {
    system: body.messages.find((item) => item.role === "system")?.content ?? "",
    user: body.messages.find((item) => item.role === "user")?.content ?? "",
  };
}

const base = {
  characterName: "小汐",
  characterPrompt: "你是一条嘴硬心软的鲸鱼。",
  model: "test-chat-model",
  apiKey: "sk-close-friends-test",
  apiBaseUrl: "https://close-friends.example/v1",
  currentMessage: "你跟谁关系最好",
  recentMessages: [],
  memories: [],
  snapshots: [],
};

function roster(patch: Partial<Acquaintances> = {}): Acquaintances {
  return {
    fromPrivate: [{
      name: "没有喵i",
      times: 36,
      lastSeenAt: new Date("2026-11-01T12:00:00Z"),
      via: "PRIVATE",
      aliases: ["喵喵", "小喵"],
    }],
    fromGroups: [{
      name: "昔涟",
      times: 198,
      lastSeenAt: new Date("2026-10-31T12:00:00Z"),
      via: "GROUP",
      groups: ["鲸鱼观察站"],
      aliases: ["涟宝"],
    }],
    inThisGroup: [],
    totals: { private: 2, group: 109 },
    ...patch,
  };
}

// ① 私聊：两档分开说，payload 里不许出现 inThisGroup（网页对话没有「当前群」）。
await generateConversationReply({
  ...base,
  acquaintances: roster(),
});

const inPrivate = readCaptured();
assert(inPrivate.system.includes("acquaintances is your roster of people you actually talk with"), "系统提示必须解释熟人名册是什么。");
assert(
  inPrivate.system.includes("Keep fromPrivate and fromGroups separate"),
  "私聊里两档必须分开说，否则她只会念群里的高频名字。",
);
assert(inPrivate.system.includes("Your owner is not in acquaintances"), "主人不走外部身份，提示里要说明他不在这张册子里。");
assert(!inPrivate.system.includes("inThisGroup is the only part"), "私聊分支不该讲「这屋里谁在」。");
assert(inPrivate.user.includes("\"fromPrivate\""), "私聊的熟人要进 payload。");
assert(inPrivate.user.includes("\"fromGroups\""), "群里的熟人也要进 payload。");
assert(!inPrivate.user.includes("\"inThisGroup\""), "没有当前群的时候不能凭空出现 inThisGroup。");
assert(inPrivate.user.includes("\"inGroups\":[\"鲸鱼观察站\"]"), "跨群榜要标出是哪个群的，否则同名的人分不开。");
assert(inPrivate.user.includes("\"totals\":{\"private\":2,\"group\":109}"), "总数要带上，榜只有 8 个位置。");
assert(inPrivate.user.includes("\"lastSeen\":\"11-1\""), "日期要裁成 M-D，整条 ISO 串会被原样念出来。");
assert(inPrivate.system.includes("aliases are the names you privately use"), "私聊里带了备注，就要说明那是她私下的叫法。");
assert(inPrivate.user.includes("\"aliases\":[\"喵喵\",\"小喵\"]"), "私聊档的备注要进 payload。");

// ② 群聊：只有 inThisGroup 能定语气，跨群榜只是背景，且一律不许念。
await generateConversationReply({
  ...base,
  groupChat: true,
  direct: true,
  transcript: [{ id: "m1", speaker: "昔涟", content: "@小汐 你跟谁关系最好", isOwner: false }],
  acquaintances: roster({
    inThisGroup: [{
      name: "昔涟",
      times: 12,
      lastSeenAt: new Date("2026-10-31T12:00:00Z"),
      via: "GROUP",
      aliases: ["涟涟"],
    }],
  }),
});

const inGroup = readCaptured();
assert(
  inGroup.system.includes("inThisGroup is the only part that tells you who is in this room"),
  "群聊里必须点明只有 inThisGroup 能说明「这屋里谁跟我熟」。",
);
assert(
  inGroup.system.includes("not this group's member list"),
  "跨群榜不是本群成员表，不写这句她会拿别群熟人当屋里的人。",
);
assert(inGroup.system.includes("read groupAcquaintances then inThisGroup"), "定语气前必须先读熟人卡，再读本群名册，避免忽略已有交往记录。");
assert(inGroup.system.includes("barely know"), "两张表都没记录的人要明确「基本不认识」，否则她会对生人自来熟。");
assert(inGroup.system.includes("inGroups keeps them apart"), "同名不同群的两个人要能分开。");
assert(inGroup.system.includes("Never recite counts or read the roster aloud"), "群里必须禁止把名册念给一屋子人。");
assert(!inGroup.system.includes("Your owner is not in acquaintances"), "群聊分支不该再讲主人那一段。");
assert(!inGroup.system.includes("When asked who you are closest to"), "群聊分支不该走「回答问题」那套说法。");
assert(inGroup.user.includes("\"inThisGroup\""), "群聊里这一屋的熟人要进 payload。");
assert(inGroup.user.includes("\"aliases\":[\"涟涟\"]"), "本群熟人的备注要带进群聊 —— 她平时就是这么叫的。");
assert(!inGroup.user.includes("喵喵"), "私聊档的备注不能带进群聊：那是私下给别人的叫法，当众喊出来就是事故。");
assert(!inGroup.user.includes("涟宝"), "跨群榜的备注同样不能带进这个群。");
assert(
  inGroup.system.includes("They appear only for people who have spoken in this room"),
  "群聊里要写清备注只对本群熟人有效，否则她会拿它去叫名单外的人。",
);

// ③ 不带名册：一个字都不能出现，否则模型会自己编朋友。
await generateConversationReply({ ...base });

const withoutRoster = readCaptured();
assert(!withoutRoster.system.includes("acquaintances is your roster"), "没带名册时系统提示不能提这一段。");
assert(!withoutRoster.system.includes("aliases are the names you privately use"), "一条备注都没有时不能讲备注规则，否则她会给每个人现编外号。");
assert(!withoutRoster.user.includes("acquaintances"), "没带名册时 payload 不能有这个字段。");

// ④ payload 形态：空档整段不写、全空返回 null。
assert.equal(buildAcquaintancePayload(null), null, "没传就是 null。");
assert.equal(
  buildAcquaintancePayload({ fromPrivate: [], fromGroups: [], inThisGroup: [], totals: { private: 0, group: 0 } }),
  null,
  "三档全空且总数为零时返回 null —— 否则她会对着一份空名册编人。",
);
const onlyTotals = buildAcquaintancePayload({
  fromPrivate: [],
  fromGroups: [],
  inThisGroup: [],
  totals: { private: 0, group: 3 },
});
assert(onlyTotals && !("fromPrivate" in onlyTotals), "空的档位不要写成空数组：模型会读成「一个都没有」。");
assert(onlyTotals?.totals.group === 3, "只有总数时也要把总数带上。");

globalThis.fetch = originalFetch;
console.log(
  "熟人名册提示词测试通过：私聊两档分开说、群聊只认 inThisGroup、跨群带群号、没传完全不提、空档不写空数组。",
);
