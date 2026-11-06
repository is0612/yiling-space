/**
 * OneBot 消息完整性的第二轮复现测试（只新增测试，不改生产代码）。
 *
 * 覆盖两件事：
 *  1. `voice` 段（而非只有 `record`）在正文里有没有占位符，转写结果能不能回填。
 *  2. mention 档下主人（ownerQq）的普通发言，是不是在进攒批之前就被丢掉了。
 *
 * 全程不联网、不连数据库：
 *  - 事件用 `resolveOnebotEvent` 从裸帧解析，不走 WS；
 *  - Prisma 通过 `getPrisma()` 的缓存位 `globalThis.__yilingPrisma` 注入桩，
 *    记录调用但不真正连接（见 `createStubPrisma`）。
 *
 * 跑法：`npx tsx scripts/test-onebot-message-integrity.ts`
 */

import { readOnebotMessageText, readOnebotVoices } from "../server/utils/channel-adapter/onebot/types";
import { applyVoiceTranscripts } from "../server/utils/voice";
import { resolveOnebotEvent } from "../server/utils/channel-adapter/onebot/client";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { resolveGroupChatSettings } from "../server/utils/channel-adapter/onebot/group-chat";
import type { OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
import type { OnebotResolvedEvent } from "../server/utils/channel-adapter/onebot/client";

// ── 极简用例运行器：一条失败不影响后面的用例，最后统一汇总 ──────────
type CaseResult = { name: string; ok: boolean; detail: string };
const results: CaseResult[] = [];
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ name, ok: true, detail: "" });
    console.log(`  PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL ${name}\n       ${detail.replaceAll("\n", "\n       ")}`);
  }
}
function expectEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

// ── 一、voice 段：正文占位符 + 转写回填 ───────────────────────────
console.log("\n[1] OneBot voice 段");

const voiceFrame = {
  message_type: "group",
  self_id: "111",
  group_id: "900001",
  user_id: "333",
  message_id: "voice-1",
  sender: { nickname: "群友甲" },
  message: [{ type: "voice", data: { url: "http://203.0.113.10/voice.silk", file: "a.silk" } }],
};

await check("voice 段在正文留下占位符", () => {
  const text = readOnebotMessageText(voiceFrame);
  if (!text.includes("[语音]")) {
    throw new Error(`正文里没有 [语音] 占位符，实际正文=${JSON.stringify(text)}`);
  }
});

await check("voice 段进入语音识别链路", () => {
  const voices = readOnebotVoices(voiceFrame);
  expectEqual(voices.length, 1, "readOnebotVoices 必须收下 voice 段");
  expectEqual(voices[0]?.url, "http://203.0.113.10/voice.silk", "直链必须原样保留");
});

await check("voice 段转写结果回填到占位符", () => {
  const text = readOnebotMessageText(voiceFrame);
  expectEqual(applyVoiceTranscripts(text, ["我今天不去"]), "[语音：我今天不去]", "转写必须落到正文里");
});

await check("record 段原有行为不变（正文 + 回填）", () => {
  const recordFrame = {
    ...voiceFrame,
    message: [{ type: "record", data: { url: "http://203.0.113.10/voice.amr", file: "a.amr" } }],
  };
  const text = readOnebotMessageText(recordFrame);
  expectEqual(text, "[语音]", "record 段正文占位符不能被这次改动打坏");
  expectEqual(applyVoiceTranscripts(text, ["转写结果"]), "[语音：转写结果]", "record 段回填必须照常");
});

await check("文字与 voice 混排时顺序不错乱", () => {
  const mixed = {
    ...voiceFrame,
    message: [
      { type: "text", data: { text: "你听这个" } },
      { type: "voice", data: { url: "http://203.0.113.10/mix.silk" } },
      { type: "text", data: { text: "笑死" } },
    ],
  };
  const text = readOnebotMessageText(mixed);
  expectEqual(text, "你听这个[语音]笑死", "语音占位符要落在它在段数组里的位置");
  expectEqual(applyVoiceTranscripts(text, ["这也太好笑了"]), "你听这个[语音：这也太好笑了]笑死", "回填不能跑到句尾");
});

// ── 二、mention 档下主人的普通发言 ────────────────────────────────
console.log("\n[2] mention 模式 · 主人普通发言");

/**
 * Prisma 桩：`getPrisma()` 会优先返回 `globalThis.__yilingPrisma`。
 * 这里塞一个「什么方法都能调、调用即记录、永远 resolve(null)」的代理，
 * 保证 handler 里的落库旁路（连接活性、群活跃度）不会真连库，也不会抛。
 */
const prismaCalls: string[] = [];
function createStubPrisma(): unknown {
  const wrap = (path: string): unknown => new Proxy(function stub() {}, {
    get(_target, property) {
      // 别让代理自己被当成 thenable，否则 await 会炸。
      if (property === "then") return undefined;
      return wrap(`${path}.${String(property)}`);
    },
    apply() {
      prismaCalls.push(`${path}()`);
      return Promise.resolve(null);
    },
  });
  return wrap("prisma");
}
(globalThis as Record<string, unknown>).__yilingPrisma = createStubPrisma();

const OWNER_QQ = "222";
const MEMBER_QQ = "333";
const SELF_QQ = "111";

const binding = {
  id: "binding-1",
  characterId: "character-1",
  characterName: "小忆",
  routingKey: "900001",
  replyWindowMinutes: 10,
  replyLimitPerWindow: 5,
  groupChat: resolveGroupChatSettings({ groupChatMode: "mention" }, true),
  groupChatModes: {},
  replyOnlyWhenMentioned: true,
  groupBiliRunEnabled: false,
};

const record = {
  id: "connection-1",
  platform: "onebot",
  accountQq: SELF_QQ,
  config: { accountQq: SELF_QQ, wsUrl: "ws://127.0.0.1:0", httpUrl: "http://127.0.0.1:0", accessToken: "" },
  replyOnlyWhenMentioned: true,
  groupAnnouncementEnabled: false,
  qzoneEnabled: false,
  qzoneLimits: { dailyPosts: 0, dailyComments: 0, commentCooldownMinutes: 0 },
  ownerQq: OWNER_QQ,
  bindings: [binding],
} as unknown as OnebotConnectionRecord;

const handler = createOnebotMessageHandler(record);

function groupEvent(userId: string, messageId: string, segments: unknown[]): OnebotResolvedEvent {
  const event = resolveOnebotEvent({
    message_type: "group",
    self_id: SELF_QQ,
    group_id: "900001",
    user_id: userId,
    message_id: messageId,
    sender: { nickname: userId === OWNER_QQ ? "主人" : "群友甲" },
    message: segments,
  });
  if (!event) throw new Error("事件解析失败，测试前提不成立");
  return event;
}
const plainText = (text: string) => [{ type: "text", data: { text } }];

await check("主人的普通群消息不能停在 mention 早退", async () => {
  const outcome = await handler(groupEvent(OWNER_QQ, "m-owner-plain", plainText("今天工作有点累")));
  // 「进攒批」是落库（storedReason=context）的必要前置：进不了攒批，flushGroupRound 里
  // 「主人在说话：原文仍要落库」那段逻辑永远执行不到。
  expectEqual(
    outcome.status,
    "buffered",
    `主人的普通发言必须进入攒批，实际 ${JSON.stringify(outcome)}（storedReason=context 依赖这一步）`,
  );
});

await check("普通群友的普通消息仍然被 mention 闸门挡下", async () => {
  const outcome = await handler(groupEvent(MEMBER_QQ, "m-member-plain", plainText("今天工作有点累")));
  expectEqual(
    { status: outcome.status, reason: "reason" in outcome ? outcome.reason : undefined },
    { status: "ignored", reason: "not_mentioned" },
    "群友的普通消息不能因为修主人那条而一起放行",
  );
});

await check("对照组：同一主人在 ambient 档下能进攒批", async () => {
  // 把 mode 换成 ambient，其他一切不变。若这条通过而上面那条失败，
  // 说明丢消息的变量就是 mention 早退本身，不是 handler 或者事件构造的问题。
  const ambientRecord = {
    ...record,
    bindings: [{ ...binding, groupChat: resolveGroupChatSettings({ groupChatMode: "ambient" }, false) }],
  } as unknown as OnebotConnectionRecord;
  const ambientHandler = createOnebotMessageHandler(ambientRecord);
  const outcome = await ambientHandler(groupEvent(OWNER_QQ, "m-owner-ambient", plainText("今天工作有点累")));
  expectEqual(outcome.status, "buffered", `ambient 档下主人发言应进攒批，实际 ${JSON.stringify(outcome)}`);
});

await check("主人 @ 她时仍然直接进攒批（现有行为不回退）", async () => {
  const outcome = await handler(groupEvent(OWNER_QQ, "m-owner-at", [
    { type: "at", data: { qq: SELF_QQ } },
    { type: "text", data: { text: "在吗" } },
  ]));
  expectEqual(outcome.status, "buffered", "被 @ 的消息本来就应该进攒批");
});

await check("群里没人说话时不会凭空产生落库调用", () => {
  // 只是确认桩生效：上面三个用例走过之后，Prisma 桩必须只被「连接活性/群活跃度」这类旁路碰过，
  // 不该出现消息落库。消息落库依赖真实库，本轮按约束不跑。
  const persisted = prismaCalls.filter((call) => /message\.(create|createMany)/.test(call));
  expectEqual(persisted, [], "本轮不应触发消息落库（无数据库环境）");
});

// ── 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\nonebot message integrity: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("\n未通过：");
  for (const item of failed) console.log(`- ${item.name}：${item.detail}`);
}
process.exit(failed.length ? 1 : 0);
