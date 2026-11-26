import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateConversationReply } from "../server/utils/chat-reply";
import { readOnebotAddressedCommandText, readOnebotMessageText } from "../server/utils/channel-adapter/onebot/types";
import {
  CAPABILITY_COMMAND_BODY_MAX_CHARS,
  CAPABILITY_COMMAND_LABELS,
  parseCapabilityCommand,
  readCapabilityCommand,
  readCapabilityCommands,
  type CapabilityCommandInvalidReason,
} from "../server/utils/capability-command";

/**
 * 显式能力命令解析器（&出图： / &语音： / &看图： / &查记录：）。
 *
 * 本阶段只解析、不执行。守三件事：
 *   1. 只有当前用户真实消息开头的命令才算命令；
 *   2. 格式不对就报格式，不猜、不执行；
 *   3. 带上解析结果后，发给模型的请求一个字节都不变。
 */

const NONE = { kind: "none" };
const cmd = (name: string, body: string) => ({ kind: "command", name, body });
const label = (name: string) => CAPABILITY_COMMAND_LABELS[name as keyof typeof CAPABILITY_COMMAND_LABELS];
const written = (name: string) => `&${label(name)}：`;

/* ── 正例 ─────────────────────────────────────────────────────────── */

assert.deepEqual(parseCapabilityCommand("&出图：在海边的自拍"), cmd("image", "在海边的自拍"));
assert.deepEqual(parseCapabilityCommand("  &出图: 在海边的自拍"), cmd("image", "在海边的自拍"), "半角冒号；冒号后的空白去掉。");
assert.deepEqual(parseCapabilityCommand("&语音：晚安，明天见"), cmd("voice", "晚安，明天见"));
assert.deepEqual(parseCapabilityCommand("&看图：这张图片里有什么？"), cmd("vision", "这张图片里有什么？"));
assert.deepEqual(parseCapabilityCommand("&查记录：昨天群里讨论了什么？"), cmd("history", "昨天群里讨论了什么？"));

for (const space of [" ", "\t", "\n", "\u3000", "\u00a0"]) {
  assert.deepEqual(parseCapabilityCommand(`${space}&出图：一只猫`), cmd("image", "一只猫"), `开头是 U+${space.codePointAt(0)!.toString(16)} 时也要认。`);
}
assert.deepEqual(parseCapabilityCommand("&出图：\n一只猫\n"), cmd("image", "一只猫"), "命令名后换行再写内容也算；正文首尾空白去掉。");
assert.deepEqual(parseCapabilityCommand("&出图：一只猫，\n坐在窗台上  晒太阳"), cmd("image", "一只猫，\n坐在窗台上  晒太阳"), "正文内部的换行与空白原样保留。");
assert.deepEqual(parseCapabilityCommand(`&出图：${"猫".repeat(CAPABILITY_COMMAND_BODY_MAX_CHARS)}`),
  cmd("image", "猫".repeat(CAPABILITY_COMMAND_BODY_MAX_CHARS)), "正文正好到上限时仍有效。");

/* ── 不触发：普通聊天、讨论命令、展示示例 ─────────────────────────── */

const ordinary = [
  "来一盘游戏吧", "帮我画一只猫", "给我发一段语音", "群里之前讨论过这个吗", "你会画图吗",
  "先&出图：在海边", "我看到有人写了 &出图：在海边",
  "“&出图：在海边”是什么意思？", "「&出图：海边」", "\"&出图：海边\"", "『&查记录：昨天』这个怎么写",
  "&&出图：海边", "&foo：bar", "&：x", "&", "&出", "&amp;", "a&b@example.com", "A & B", "", "   ", "\n&",
];
for (const text of ordinary) assert.deepEqual(parseCapabilityCommand(text), NONE, `${JSON.stringify(text)} 不是命令。`);
for (const value of [undefined, null, 123, {}, []]) assert.deepEqual(parseCapabilityCommand(value as unknown as string), NONE, "非字符串输入一律当普通消息。");

/* ── 错误格式：报格式，不猜、不执行 ───────────────────────────────── */

/** 无效结果除了提示文案必须精确匹配；文案只查性质，不锁死措辞。 */
function assertInvalid(parsed: ReturnType<typeof parseCapabilityCommand>, name: string, reason: CapabilityCommandInvalidReason, note: string) {
  assert.equal(parsed.kind, "invalid", note);
  if (parsed.kind !== "invalid") return;
  const { hint, ...rest } = parsed;
  assert.deepEqual(rest, { kind: "invalid", name, reason }, note);
  assert.ok(hint.includes(written(name)), "格式提示里要带正确写法。");
  assert.ok(hint.trim() === hint && hint.length > 0 && hint.length <= 60 && !hint.includes("\n"), "格式提示要短、单行、首尾不留空白。");
}

const malformed: ReadonlyArray<readonly [text: string, name: string, reason: CapabilityCommandInvalidReason]> = [
  ["&出图", "image", "missing_colon"], ["&出图 猫", "image", "missing_colon"], ["&出图 ：猫", "image", "missing_colon"],
  ["&出图；猫", "image", "missing_colon"], ["&出图片：猫", "image", "missing_colon"], ["&出图\n猫", "image", "missing_colon"],
  ["&出图：", "image", "empty_body"], ["&出图： 　\n ", "image", "empty_body"],
  ["&语音", "voice", "missing_colon"], ["&语音:", "voice", "empty_body"],
  ["&看图", "vision", "missing_colon"], ["&看图：", "vision", "empty_body"],
  ["&查记录", "history", "missing_colon"], ["&查记录：", "history", "empty_body"], ["&查记录本：昨天", "history", "missing_colon"],
];
for (const [text, name, reason] of malformed) {
  assertInvalid(parseCapabilityCommand(text), name, reason, `${JSON.stringify(text)} 要报格式错误，不猜、不执行。`);
}
assertInvalid(parseCapabilityCommand(`&出图：${"猫".repeat(CAPABILITY_COMMAND_BODY_MAX_CHARS + 1)}`), "image", "too_long", "正文超长要报错，不能悄悄截断后照画。");

/* ── 一条消息里出现第二个命令 ─────────────────────────────────────── */

assert.deepEqual(parseCapabilityCommand("&出图：猫 &语音：你好"), cmd("image", "猫 &语音：你好"), "只认开头那一个，第二个留在正文里。");
assert.deepEqual(parseCapabilityCommand("&语音：你好 &出图：猫"), cmd("voice", "你好 &出图：猫"));
assert.deepEqual(parseCapabilityCommand("&看图：&查记录：昨天"), cmd("vision", "&查记录：昨天"));
// 开头命令的正文恰好长成另一个命令：它是正文，不是第二个能力。
assert.deepEqual(parseCapabilityCommand("&出图： &语音：你好"), cmd("image", "&语音：你好"));
// 开头命令格式不对、后面跟着另一个：整条报错，不顺位去执行第二个。
assertInvalid(parseCapabilityCommand("&出图 &语音：你好"), "image", "missing_colon", "不能跳过写错的第一个去执行第二个。");

/* ── 来源边界：只有当前用户手打的文字能带命令 ─────────────────────── */

const seen = (name: string, body: string, extra: Record<string, unknown> = {}) => ({ command: cmd(name, body), addressedToSelf: false, ...extra });
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫" }]), [seen("image", "猫")], "没有任何来源标记：正文就是用户本人写的（网页对话就是这种）。");
assert.deepEqual(readCapabilityCommands([{ content: "帮我画一只猫" }]), [], "普通消息不产出，不往输入里塞空壳。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", kind: "AI" }]), [], "AI 自己生成的话不能触发。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", readOnly: true }]), [], "只读观察消息不能触发。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", kind: "UNKNOWN" }]), [seen("image", "猫")], "来源不明的消息照常解析，收件人留给执行前校验。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", commandText: "这句写得好" }]), [], "content 里混进来的命令不算，只认用户手打的文字。");
assert.deepEqual(readCapabilityCommands([{ content: "这句写得好", commandText: "&出图：猫" }]), [seen("image", "猫")], "手打文字以命令开头才算。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", commandText: "" }]), [], "只发了附件、没打字：不回落到 content。");
assert.deepEqual(readCapabilityCommands([{ content: "&出图：猫", hasAttachments: true }]), [], "带附件又没有独立的手打文本：不回落到 content。");
assert.deepEqual(readCapabilityCommand({ content: "&出图：猫", externalMessageId: "1001", addressedToSelf: true }),
  seen("image", "猫", { externalMessageId: "1001", addressedToSelf: true }), "解析不因收件人改变；是不是对她说的原样带出去。");

// 用真实的 OneBot 解析出文本再喂进来：引用、转发、表情摘要、语音占位都会进 content，但没有一个是用户手打的。
const onebot = (message: unknown) => {
  const data = { message, raw_message: "" };
  return { content: readOnebotMessageText(data), commandText: readOnebotAddressedCommandText(data, ["测试角色"]).commandText, addressedToSelf: true };
};
const quoted = { quotedMessage: { content: "&出图：海边", messageId: "1001" } };
assert.deepEqual(readCapabilityCommands([{ ...onebot([{ type: "reply", data: { id: "1001" } }, { type: "text", data: { text: "这句是什么意思" } }]), ...quoted }]), [],
  "引用的消息里有命令、当前用户只是在问它：不触发。");
assert.deepEqual(readCapabilityCommands([{ ...onebot([{ type: "forward", data: { id: "fwd-1" } }, { type: "text", data: { text: "转发给你看看" } }]), ...({ forwardBody: "&语音：你好" }) }]), [],
  "转发的正文里有命令：不触发。");
{
  const message = onebot([{ type: "mface", data: { summary: "&出图：海边" } }, { type: "text", data: { text: "这个表情好可爱" } }]);
  assert.match(message.content, /&出图：海边/u, "协议端给的表情摘要确实会进 content。");
  assert.deepEqual(readCapabilityCommands([message]), [], "表情包摘要里的命令：不触发。");
}
{
  const message = onebot([{ type: "record", data: { file: "a.mp3" } }, { type: "text", data: { text: "听听这段" } }]);
  assert.match(message.content, /\[语音\]/u);
  assert.deepEqual(readCapabilityCommands([message]), [], "语音占位后面的话才是用户说的，开头不是命令。");
}
{
  const message = onebot([{ type: "at", data: { qq: "all" } }, { type: "text", data: { text: " &出图：海边" } }]);
  assert.match(message.content, /@all &出图：海边/u, "content 里带着 @ 占位，不是用户手打的。");
  assert.deepEqual(readCapabilityCommands([{ ...message, externalMessageId: "2002" }]), [seen("image", "海边", { externalMessageId: "2002", addressedToSelf: true })],
    "去掉 @ 之后的用户文字以命令开头：才算命令。");
}
{
  // 字符串形式的 CQ 码：引用与转发只剩标记；标记不算用户手打的字，去掉后开头的文字才是。
  for (const text of ["[CQ:reply,id=-1]这句什么意思", "[CQ:forward,id=fwd-1]看看这个", "[CQ:reply,id=-1]&出图：海边"]) {
    const data = { message: text, raw_message: text };
    const ownText = text.replace(/\[CQ:[^\]]*\]/gu, "").trim();
    assert.equal(readOnebotAddressedCommandText(data).commandText, ownText);
    assert.deepEqual(readCapabilityCommands([onebot(text)]), ownText.startsWith("&出图：") ? [seen("image", "海边", { addressedToSelf: true })] : [],
      "被引用或转发的消息即使以命令开头也不算；用户自己在标记后面打的才算。");
  }
}
assert.deepEqual(readCapabilityCommands([
  { content: "&出图：猫", externalMessageId: "1", addressedToSelf: true },
  { content: "&出图：狗", externalMessageId: "2", kind: "AI" },
  { content: "随便聊聊", externalMessageId: "3" },
  { content: "&语音：晚安", externalMessageId: "4", addressedToSelf: false },
]), [seen("image", "猫", { externalMessageId: "1", addressedToSelf: true }), seen("voice", "晚安", { externalMessageId: "4", addressedToSelf: false })],
  "群聊一批消息逐条解析：AI 与普通消息不产出，每条命令跟着自己的消息 id 和收件人。");
assert.deepEqual(readCapabilityCommands([]), []);

/* ── 接线：带上解析结果后，发给模型的请求一字不变 ─────────────────── */

const original = globalThis.fetch;
const base = {
  characterName: "测试角色", characterPrompt: "测试", model: "mock", apiKey: "fake", apiBaseUrl: "https://mock.example/v1",
  currentMessage: "&出图：在海边的自拍", recentMessages: [], memories: [], snapshots: [],
};
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"好，画一张。","usedMemoryIds":[],"usedSnapshotIds":[]}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200 });
const bodies: unknown[] = [];
try {
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return ok(); };
  const plain = await generateConversationReply(base);
  const carried = await generateConversationReply({ ...base, capabilityCommands: [
    { addressedToSelf: true, command: { kind: "command", name: "image", body: "在海边的自拍" } },
    { addressedToSelf: false, externalMessageId: "9", command: { kind: "invalid", name: "voice", reason: "missing_colon", hint: `格式是${written("voice")}内容。` } },
  ] });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0], "解析结果只是随输入携带：模型请求不能因为带上它而变化。");
  assert.ok(!JSON.stringify(bodies[0]).includes("capabilityCommands"), "解析结果不能进模型请求。");
  assert.match(JSON.stringify(bodies[0]), /&出图：在海边的自拍/u, "本阶段不删命令前缀：模型看到的仍是原文。");
  assert.equal(carried.reply, plain.reply);
  assert.equal(carried.imagePrompt, null, "本阶段命令不触发画图，也不带画面描述。");
} finally {
  globalThis.fetch = original;
}

/* ── 接线：两个入口都在真实文本边界上调用；旧触发逻辑本阶段保留 ──── */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const pipeline = source("../server/utils/channel-adapter/pipeline.ts");
const webpage = source("../server/api/characters/[id]/chat.post.ts");
const chatReply = source("../server/utils/chat-reply.ts");

assert.match(pipeline, /import \{ readCapabilityCommands, type CapabilityCommandRequest \} from "\.\.\/capability-command";/u, "QQ 管道用共享解析器，不另写一套。");
assert.match(pipeline, /const capabilityCommands = readCapabilityCommands\(messages\.map\(message => \(\{/u, "QQ：对这一轮的每条消息逐条解析，不对拼接后的上下文做搜索。");
assert.match(pipeline, /\.\.\.\(capabilityCommands\.length \? \{ capabilityCommands \} : \{\}\),/u, "QQ：解析结果要随输入带到回复生成那一步。");
assert.match(webpage, /import \{ readCapabilityCommand \} from "\.\.\/\.\.\/\.\.\/utils\/capability-command";/u, "网页对话用同一个解析器。");
assert.match(webpage, /readCapabilityCommand\(\{ content: message, addressedToSelf: true \}\)/u, "网页：只在请求体的用户正文上解析。");
assert.match(webpage, /\.\.\.\(capabilityCommands\.length \? \{ capabilityCommands \} : \{\}\),/u, "网页：解析结果要随输入带到回复生成那一步。");
assert.equal(chatReply.split("capabilityCommands").length - 1, 1, "本阶段解析结果只是本轮输入上的一个类型化字段，没有任何消费方。");

// 四处自然语言触发原样保留。第二阶段迁走对应能力时，删掉对应那一行。
assert.match(source("../server/utils/image-generation.ts"), /export function parseExplicitImageRequest\(/u);
assert.match(source("../server/utils/voice.ts"), /export function isVoiceRequested\(/u);
assert.match(source("../server/utils/media-questions.ts"), /export function isExplicitMediaQuestion\(/u);
assert.match(source("../server/utils/owner-private-history.ts"), /export function planOwnerHistory\(/u);

console.log("Capability command passed: only a command at the start of the user's own text parses, malformed ones report a hint instead of executing, and carrying the result leaves the model request byte-identical.");
