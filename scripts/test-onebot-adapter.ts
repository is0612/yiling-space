import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { markOnebotReloadApplied } from "../server/utils/channel-adapter/onebot/runtime";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { connectOnebot, POKE_CONTENT, resolveOnebotEvent, resolveOnebotPokeEvent } from "../server/utils/channel-adapter/onebot/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，OneBot 渠道测试无法运行。");

process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
process.env.LLM_API_KEY = "ci-only";
process.env.LLM_MODEL = "ci-channel-test";
process.env.ONEBOT_WS_URL = "ws://127.0.0.1:4030";
process.env.ONEBOT_HTTP_URL = "http://127.0.0.1:4031";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(script: string, env: NodeJS.ProcessEnv, readyMarker: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (data: Buffer) => {
      out += data.toString("utf8");
      if (out.includes(readyMarker)) {
        cleanup();
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${script} 未在超时内就绪。输出：${out.slice(0, 500)}`));
    }, 20_000);
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    }
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error("等待条件超时。");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = randomUUID();
const characterId = randomUUID();
const connectionId = randomUUID();
let conversationId = "";
let bindingId = "";

/**
 * 闸门早退只留一行 `[onebot] 群聊 {...}`，既没有消息落库也没有回执可查。
 * 所以把这一行接住 —— 否则「被闸门拦了」和「事件压根没进来」在断言层面长得一模一样。
 */
const roundLogs: string[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  roundLogs.push(args.map((value) => String(value)).join(" "));
  originalConsoleLog(...args);
};
const sawGroupRoundLog = (groupId: number, reason: string) => roundLogs.some(
  (line) => line.includes("[onebot] 群聊") && line.includes(`"groupId":"${groupId}"`) && line.includes(`"reason":"${reason}"`),
);
/**
 * 等一条闸门日志出现。
 *
 * 适配器是子进程，日志经 stdout 回传，有几十毫秒的缓冲。原来紧跟回复断言「必须按 direct 放行」，
 * 等于和日志赛跑 —— CI 上偶发红过一次（2026-10-31 实测：同一份代码重跑就绿）。
 * 断言本身的意图是「这一轮走了哪个闸门」，不是「日志什么时候到」，所以这里等到超时为止。
 */
const waitForGroupRoundLog = async (groupId: number, reason: string, timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sawGroupRoundLog(groupId, reason)) return true;
    await sleep(100);
  }
  return sawGroupRoundLog(groupId, reason);
};

const children: ChildProcess[] = [];
try {
  children.push(await spawnServer("scripts/mock-llm-server.mjs", { LLM_MOCK_PORT: "4010", LLM_MOCK_API_KEY: "ci-only" }, "mock-llm-ready"));
  children.push(await spawnServer("scripts/mock-onebot-gateway.mjs", { ONEBOT_MOCK_HTTP_PORT: "4031", ONEBOT_MOCK_WS_PORT: "4030", ONEBOT_MOCK_REQUIRE_TOKEN: "mock-ws-token" }, "mock-onebot-ready"));

  // 1. Seed a character (with a global scope) and an OneBot connection + default binding.
  const user = await prisma.user.create({ data: { username: `onebot-test-${suffix}`, passwordHash: "x", role: "ADMIN" }, select: { id: true } });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: user.id,
      name: "测试角色",
      avatar: "测",
      basePrompt: "你是一个用于 OneBot 渠道联调的测试角色。",
      modelConfig: {},
      status: "ACTIVE",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } },
    },
  });
  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({
    wsUrl: "ws://127.0.0.1:4030",
    httpUrl: "http://127.0.0.1:4031",
    accessToken: "mock-ws-token",
    httpToken: "mock-http-token",
  })), "utf8");
  await prisma.platformConnection.create({
    data: {
      id: connectionId,
      platform: "qq-onebot",
      platformAccountKey: "123456789",
      displayName: "测试 QQ 小号",
      // 本机可能正跑着真实适配器；DISABLED 让它不会被 runner 加载，测试用直连验证协议层。
      status: "DISABLED",
      credentialsCiphertext,
      metadata: { onebotReloadRequestedAt: "2026-10-29T00:00:00.000Z", keep: { nested: true }, replyOnlyWhenMentioned: false },
    },
  });
  // 端到端这部分验证的是「消息能不能走通」，所以把群聊策略设成 all（每句都回、不攒批），
  // 攒批与闸门另有 test-onebot-group-chat.ts 专门测。
  const binding = await prisma.characterChannelBinding.create({
    data: { characterId, connectionId, status: "ACTIVE", routingKey: null, config: { groupChatMode: "all" } },
    select: { id: true },
  });
  bindingId = binding.id;

  // 2. The adapter discovers the connection and decrypts its credentials.
  // 只按本用例自己建的 id 找：库里可能还躺着真实连接（本地联调用的那个），断言总数会被它带偏。
  const records = await loadOnebotConnections(undefined, { includeDisabled: true });
  const record = records.find((item) => item.id === connectionId);
  assert(record, "The adapter must discover the OneBot connection.");
  assert.equal(record.config.wsUrl, "ws://127.0.0.1:4030");
  assert.equal(record.config.httpUrl, "http://127.0.0.1:4031");
  assert.equal(record.config.accessToken, "mock-ws-token");
  assert.equal(record.config.httpToken, "mock-http-token");
  // 这个用例显式设了「所有消息都回复」，后面才好用「不 @ 也回」的群消息验证端到端链路。
  // 「默认仅 @ 回复」这个安全默认值由 configure.ts 兜底（没写时取 true），不在这里重复断言。
  assert.equal(record.replyOnlyWhenMentioned, false);
  // self_id 缺失时靠它判断「@ 的是不是她」，所以连接上必须带着小号自己的号。
  assert.equal(record.accountQq, "123456789");
  assert.equal(record.reloadRequestedAt, "2026-10-29T00:00:00.000Z");
  // A newer request/config save must survive acknowledgment of the initial loaded request.
  await prisma.platformConnection.update({ where: { id: connectionId }, data: {
    metadata: { onebotReloadRequestedAt: "2026-10-29T00:00:01.000Z", keep: { nested: true }, replyOnlyWhenMentioned: true },
  } });
  await markOnebotReloadApplied(connectionId, record.reloadRequestedAt!);
  const acknowledged = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connectionId } });
  assert.deepEqual(acknowledged.metadata, {
    onebotReloadRequestedAt: "2026-10-29T00:00:01.000Z",
    onebotReloadAppliedAt: "2026-10-29T00:00:00.000Z",
    keep: { nested: true }, replyOnlyWhenMentioned: true,
  });

  // 3. Unit-check the segment flattening + event resolution before the live round-trip.
  const resolved = resolveOnebotEvent({
    post_type: "message",
    message_type: "group",
    self_id: 123456789,
    message_id: 42,
    user_id: 111,
    group_id: 999,
    sender: { user_id: 111, nickname: "小明", card: "小明(群)" },
    message: [
      { type: "text", data: { text: "你好" } },
      { type: "at", data: { qq: 123456789 } },
      { type: "image", data: { url: "http://x/y.png" } },
    ],
  });
  assert(resolved, "A group message must resolve.");
  assert.equal(resolved.conversationKey, "g:999");
  assert.equal(resolved.content, "你好@123456789[图片]");
  assert.equal(resolved.displayName, "小明(群)");

  // 3a. 戳一戳：notice 不是 message，但戳的是她本人时要翻译成一条可处理的入站事件。
  const pokeAtSelf = resolveOnebotPokeEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    self_id: 123456789,
    group_id: 999,
    user_id: 111,
    target_id: 123456789,
    action: "拍了拍",
    suffix: "我的脑袋",
  });
  assert(pokeAtSelf, "戳她本人要能解析出来。");
  assert.equal(pokeAtSelf.messageType, "group");
  assert.equal(pokeAtSelf.conversationKey, "g:999");
  assert.equal(pokeAtSelf.content, POKE_CONTENT, "正文统一成动作，模型才知道这是戳不是说话。");
  assert.equal(pokeAtSelf.poke?.targetId, "123456789");
  assert.equal(pokeAtSelf.userId, "111", "发件人是戳她的那个人。");
  assert(
    resolveOnebotPokeEvent({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      self_id: 123456789,
      group_id: 999,
      user_id: 111,
      target_id: 666,
    }) === null,
    "戳的是别人 → 直接丢掉，连背景都不进。",
  );
  assert(
    resolveOnebotPokeEvent({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      group_id: 999,
      user_id: 111,
      target_id: 666,
    }) === null,
    "没有 self_id 就不知道自己是不是被戳的那个。",
  );
  assert.equal(resolveOnebotPokeEvent(resolved.data), null, "普通消息不该被当成戳。");
  const privatePoke = resolveOnebotPokeEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    self_id: 123456789,
    user_id: 111,
    sender_id: 111,
    target_id: 123456789,
  });
  assert(privatePoke, "私聊里的戳同样要叫她。");
  assert.equal(privatePoke.messageType, "private");
  assert.equal(privatePoke.conversationKey, "c:111");

  const handler = createOnebotMessageHandler(record);
  const closeGateway = await connectOnebot(record.config, { onMessage: handler });

  // 3b. WS 鉴权与握手次数：token 只能挂查询参数（Node 内置 WebSocket 加不了自定义头），
  // 且一次连接只该有一次握手 —— 反复重连会在这条断言上炸。
  const readHandshakes = async () => ((await (await fetch("http://127.0.0.1:4031/__mock/handshakes")).json()) as {
    handshakes: Array<{ url: string; query: Record<string, string>; authorization: string | null; authorized: boolean }>;
  }).handshakes;
  const firstHandshakes = await readHandshakes();
  assert.equal(firstHandshakes.length, 1, "连上一次就够，不能反复握手。");
  assert.equal(firstHandshakes[0]!.authorized, true, "握手必须带上 WS token。");
  assert.equal(
    firstHandshakes[0]!.query.access_token,
    "mock-ws-token",
    "token 必须拼成 ?access_token= 查询参数。",
  );

  // 4. Emit a group message event and wait for a reply.
  await fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: 1,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text: "你好呀" } }],
      },
    }),
  });

  await waitFor(async () => {
    const res = await fetch("http://127.0.0.1:4031/__mock/messages");
    const payload = await res.json() as { messages: unknown[] };
    return payload.messages.length >= 1;
  });

  const sent = (await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as { messages: Array<Record<string, unknown>> };
  assert.equal(sent.messages.length, 1, "Exactly one reply must be sent for one event.");
  const sentMessage = sent.messages[0]!;
  assert.equal(sentMessage.action, "send_group_msg");
  assert.equal((sentMessage.body as Record<string, unknown>).group_id, 999);
  assert(String((sentMessage.body as Record<string, unknown>).message).includes("CI 模拟模型回复"), "The reply must come from the mock LLM.");

  // 5. The conversation and both messages are persisted, with an ExternalIdentity created.
  const conversation = await prisma.conversation.findFirst({
    where: { channelBindingId: bindingId, externalConversationId: "g:999" },
    select: { id: true },
  });
  assert(conversation, "A channel conversation must be persisted.");
  conversationId = conversation.id;
  const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { occurredAt: "asc" } });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "USER");
  assert.equal(messages[1]!.role, "ASSISTANT");

  const identity = await prisma.externalIdentity.findUnique({
    where: { platform_platformUid: { platform: "qq-onebot", platformUid: "111" } },
  });
  assert(identity, "An ExternalIdentity must be upserted for the OneBot author.");

  // 6. A re-delivered event with the same message id is deduplicated.
  await fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: 1,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text: "重复消息" } }],
      },
    }),
  });
  await sleep(1500);
  const afterDuplicate = (await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as { messages: unknown[] };
  assert.equal(afterDuplicate.messages.length, 1, "A duplicate event must not trigger a second reply.");

  // 7. 表情：开关打开后正文一条、表情单独一条；额度用完后只发正文（不再跟表情）。
  // 额度显式配成「1 分钟 1 张」：默认 10 分钟 3 张的话，下面两条回复都还在额度里，
  // 断言就验不到「用完就停」这件事了。
  const readSent = async () => ((await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as {
    messages: Array<{ action: string; body: Record<string, unknown> }>;
  }).messages;
  const emitText = (messageId: number, text: string) => fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: messageId,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text } }],
      },
    }),
  });

  const beforeFaces = (await readSent()).length;
  await prisma.character.update({
    where: { id: characterId },
    data: { modelConfig: { emojiEnabled: true, emojiWindowMinutes: 1, emojiPerWindow: 1 } },
  });

  await emitText(2, "你猜");
  await waitFor(async () => (await readSent()).length >= beforeFaces + 2);
  const withFace = await readSent();
  assert.equal(withFace.length, beforeFaces + 2, "一次回复带表情时，恰好是正文加表情两条。");
  assert(String(withFace[beforeFaces]!.body.message).includes("CI 模拟模型回复"), "正文必须先发。");
  assert.deepEqual(
    withFace[beforeFaces + 1]!.body.message,
    [{ type: "face", data: { id: "0" } }],
    "表情必须是独立的 face 段，不能拼进正文。",
  );

  await emitText(3, "然后呢");
  await waitFor(async () => (await readSent()).length >= beforeFaces + 3);
  await sleep(800);
  const cooled = await readSent();
  assert.equal(cooled.length, beforeFaces + 3, "额度用完后只发正文，不再跟一张表情。");
  assert.equal(typeof cooled[beforeFaces + 2]!.body.message, "string", "额度用完时发出去的必须是纯文本。");

  // 表情段不进 content（否则会被当成用户打的字），只记在 metadata 里。
  const assistantMeta = await prisma.message.findMany({
    where: { conversationId, role: "ASSISTANT" },
    orderBy: { occurredAt: "asc" },
    select: { content: true, metadata: true },
  });
  const faceIdsPerReply = assistantMeta.map((item) => (item.metadata as { faceIds?: string[] } | null)?.faceIds ?? []);
  assert.deepEqual(faceIdsPerReply, [[], ["0"], []], "只有开了开关的那一条带 faceIds。");
  assert(
    assistantMeta.every((item) => !item.content.includes("face")),
    "正文里不能残留任何段标记。",
  );

  const stillOneHandshake = await readHandshakes();
  assert.equal(
    stillOneHandshake.length,
    1,
    `整个用例期间连接一直活着，不该再有第二次握手。握手记录：${JSON.stringify(stillOneHandshake)}`,
  );

  // 8. 群公告：管理员拟稿 → 回复草稿 → 确认发布才真正调用公告接口。普通成员不能触发。
  await prisma.platformConnection.update({
    where: { id: connectionId },
    data: { metadata: { onebotReloadRequestedAt: "2026-10-29T00:00:01.000Z", keep: { nested: true }, replyOnlyWhenMentioned: false, groupAnnouncementEnabled: true } },
  });
  record.groupAnnouncementEnabled = true;

  const readNotices = async () => ((await (await fetch("http://127.0.0.1:4031/__mock/notices")).json()) as {
    notices: Array<{ body: Record<string, unknown> }>;
  }).notices;
  const emitAs = (messageId: number, userId: number, role: string, text: string) => fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: messageId,
        user_id: userId,
        group_id: 999,
        sender: { user_id: userId, nickname: role === "owner" ? "群主" : role === "admin" ? "管理员" : "群友", role },
        message: [{ type: "at", data: { qq: 123456789 } }, { type: "text", data: { text } }],
      },
    }),
  });

  const beforeAnnouncement = (await readSent()).length;
  await emitAs(10, 222, "owner", " 写个群公告：周末活动");
  await waitFor(async () => (await readSent()).length >= beforeAnnouncement + 1);
  const draftReply = String((await readSent())[beforeAnnouncement]!.body.message);
  assert(draftReply.includes("公告草稿"), "管理员请求后必须先回复草稿，而不是直接发公告。");
  assert(draftReply.includes("CI 公告草稿"), "草稿正文来自模型。");
  assert.equal((await readNotices()).length, 0, "未确认前不能调用公告接口。");

  const pendingRows = await prisma.onebotGroupAnnouncement.findMany({ where: { connectionId } });
  assert.equal(pendingRows.length, 1, "必须落一条待确认草稿。");
  assert.equal(pendingRows[0]!.status, "PENDING");
  assert.equal(pendingRows[0]!.requestedBy, "222");

  await emitAs(11, 222, "owner", "确认发布");
  await waitFor(async () => (await readNotices()).length >= 1);
  const notices = await readNotices();
  assert.equal(notices.length, 1, "确认一次只发一条公告。");
  assert.equal(notices[0]!.body.group_id, 999);
  assert(String(notices[0]!.body.content).includes("CI 公告草稿"), "公告内容必须是确认过的那份草稿。");
  const published = await prisma.onebotGroupAnnouncement.findUniqueOrThrow({ where: { id: pendingRows[0]!.id } });
  assert.equal(published.status, "PUBLISHED");
  assert(published.publishedAt, "发布成功必须记录时间。");
  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "PlatformConnection", entityId: connectionId, action: "channel.group_announcement_published" },
  });
  assert(audit, "群公告发布必须留审计记录。");

  // 普通成员即使 @ 她也只能走普通聊天，不能产生草稿或公告。
  const beforeMember = (await readSent()).length;
  await emitAs(12, 333, "member", "写个群公告：我来发");
  await waitFor(async () => (await readSent()).length >= beforeMember + 1);
  assert.equal((await prisma.onebotGroupAnnouncement.count({ where: { connectionId } })), 1, "普通成员不能新增草稿。");
  assert.equal((await readNotices()).length, 1, "普通成员不能发布公告。");

  // 重复投递确认事件不能二次发布。
  await emitAs(11, 222, "owner", "确认发布");
  await sleep(1200);
  assert.equal((await readNotices()).length, 1, "重复确认不能重复发布。");

  // 9. 群发言频率：每 10 分钟最多 2 条时，第 3 条必须静默（不调模型、不发消息）。
  await prisma.characterChannelBinding.update({
    where: { id: bindingId },
    data: { config: { groupChatMode: "all", replyWindowMinutes: 10, replyLimitPerWindow: 2 } },
  });
  record.bindings[0]!.replyWindowMinutes = 10;
  record.bindings[0]!.replyLimitPerWindow = 2;

  /** `mention` 传 `true` = @ 她本人，传数字 = @ 那个 QQ，传 `"all"` = @ 全体。 */
  const emitToGroup = (
    groupId: number,
    messageId: number,
    text: string,
    userId = 444,
    mention: boolean | number | "all" = false,
  ) => fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: messageId,
        user_id: userId,
        group_id: groupId,
        sender: { user_id: userId, nickname: userId === 222 ? "主人" : "群友", role: "member" },
        message: mention === false
          ? [{ type: "text", data: { text } }]
          : [
            { type: "at", data: { qq: mention === true ? 123456789 : mention } },
            { type: "text", data: { text } },
          ],
      },
    }),
  });
  const groupReplies = async () => (await readSent()).filter(
    (item) => item.action === "send_group_msg" && Number(item.body.group_id) === 1001,
  );
  const assistantCount = async (groupId: number) => {
    const conversation = await prisma.conversation.findFirst({
      where: { channelBindingId: bindingId, externalConversationId: `g:${groupId}` },
      select: { id: true },
    });
    return conversation
      ? prisma.message.count({ where: { conversationId: conversation.id, role: "ASSISTANT" } })
      : 0;
  };
  const groupAssistantCount = () => assistantCount(1001);
  const userCount = async (groupId: number) => {
    const conversation = await prisma.conversation.findFirst({
      where: { channelBindingId: bindingId, externalConversationId: `g:${groupId}` },
      select: { id: true },
    });
    return conversation
      ? prisma.message.count({ where: { conversationId: conversation.id, role: "USER" } })
      : 0;
  };

  // 三条消息分三轮发：群聊统一攒批后，「同时涌入」会合成一轮，
  // 这里要验证的是「已经说到上限后还要静默」，所以一条一条等回执。
  record.bindings[0]!.groupChat.mentionWindowSeconds = 1;
  await emitToGroup(1001, 20, "第一条");
  await waitFor(async () => (await groupAssistantCount()) >= 1);
  await emitToGroup(1001, 21, "第二条");
  await waitFor(async () => (await groupAssistantCount()) >= 2);
  await emitToGroup(1001, 22, "第三条应该被静默");
  await sleep(2500);
  assert.equal(await groupAssistantCount(), 2, "达到上限后的消息必须被限流挡住，不能一起放行。");
  const sentTexts = (await groupReplies()).map((item) => String(item.body.message));
  assert(!sentTexts.some((text) => text.includes("第三条应该被静默")), "被静默的请求不能发出回复。");
  const rateConversation = await prisma.conversation.findFirst({
    where: { channelBindingId: bindingId, externalConversationId: "g:1001" },
    select: { id: true },
  });
  assert(rateConversation, "限流群也要有会话记录。");

  // 9.5 群聊只回 @ 她的：别人的闲聊不能进模型，@ 了才回。
  record.bindings[0]!.groupChat.mode = "mention";
  await emitToGroup(1003, 40, "这是别人在聊天", 555, false);
  await sleep(1500);
  assert.equal(await assistantCount(1003), 0, "没有被 @ 时不能落助手消息。");
  await emitToGroup(1003, 41, "叫她一声", 555, true);
  await waitFor(async () => (await assistantCount(1003)) >= 1);
  record.bindings[0]!.groupChat.mode = "all";

  // 9.6 自然接话：一段连发合成一轮只回一条；闸门不过时整轮不进模型。
  const ambientSettings = {
    mode: "ambient" as const,
    batchWindowSeconds: 3,
    mentionWindowSeconds: 1,
    minGapSeconds: 0,
    dailyMax: 0,
    quietStart: "00:00",
    quietEnd: "00:00",
    ambientChance: 1,
    aliases: [],
  };
  await prisma.characterChannelBinding.update({
    where: { id: bindingId },
    data: { config: { groupChatMode: "ambient", batchWindowSeconds: 3, mentionWindowSeconds: 1, minGapSeconds: 0, dailyMax: 0, quietStart: "00:00", quietEnd: "00:00", ambientChance: 1 } },
  });
  record.bindings[0]!.groupChat = { ...ambientSettings };
  await Promise.all([
    emitToGroup(1004, 50, "今天好热", 555, false),
    emitToGroup(1004, 51, "热死了", 556, false),
  ]);
  await sleep(6500);
  assert.equal(await assistantCount(1004), 1, "同一轮里的几条消息只该回一条，不能一句一答。");
  assert.equal(await userCount(1004), 2, "这一轮的每条用户消息都要落库，不能只留第一条。");

  // 9.6.1 被闸门挡下、但确实是 @ 她的轮次：原文仍要落库（storedReason=mentioned）。
  // 用「每日上限」挡：@ 能绕过安静时段和最短间隔，但绕不过 dailyMax，所以这是
  // 唯一能稳定制造的「@ 了她、却没回」的场景。
  {
    const limitedConfig = {
      groupChatMode: "mention",
      batchWindowSeconds: 3,
      mentionWindowSeconds: 1,
      minGapSeconds: 0,
      dailyMax: 1,
      quietStart: "00:00",
      quietEnd: "00:00",
      ambientChance: 1,
    };
    await prisma.characterChannelBinding.update({ where: { id: bindingId }, data: { config: limitedConfig } });
    record.bindings[0]!.groupChat = { ...ambientSettings, mode: "mention", dailyMax: 1 };
    await emitToGroup(1009, 90, "先回我一句", 555, true);
    await waitFor(async () => (await assistantCount(1009)) >= 1);
    // 额度已用满：这一条仍然 @ 她，但闸门会以 daily_limit 挡下。
    await emitToGroup(1009, 91, "再叫你一声", 555, true);
    await sleep(4000);
    assert.equal(await assistantCount(1009), 1, "额度用完后再 @ 也不该回。");
    assert.equal(await userCount(1009), 2, "@ 她被额度挡下时，这一轮原文仍要落库。");
    const mentioned = await prisma.message.findFirst({
      where: {
        conversation: { is: { channelBindingId: bindingId, externalConversationId: "g:1009" } },
        metadata: { path: ["storedReason"], equals: "mentioned" },
      },
      select: { id: true },
    });
    assert(mentioned, "被挡下的点名轮次要标 storedReason=mentioned，方便按原因做保留策略。");
    await prisma.characterChannelBinding.update({
      where: { id: bindingId },
      data: {
        config: {
          groupChatMode: "ambient",
          batchWindowSeconds: 3,
          mentionWindowSeconds: 1,
          minGapSeconds: 0,
          dailyMax: 0,
          quietStart: "00:00",
          quietEnd: "00:00",
          ambientChance: 1,
        },
      },
    });
    record.bindings[0]!.groupChat = { ...ambientSettings };
  }

  // 闸门不通过（抽中概率 0）时，整轮直接丢掉：不调模型、不落库、不发消息。
  record.bindings[0]!.groupChat.ambientChance = 0;
  await emitToGroup(1005, 60, "跟他完全无关的闲聊", 555, false);
  await sleep(5000);
  assert.equal(await assistantCount(1005), 0, "闸门不过时不该落助手消息。");
  assert.equal(await userCount(1005), 0, "闸门不过时连用户消息都不落库，省得下次重投再判一遍。");
  record.bindings[0]!.groupChat = { ...ambientSettings, mode: "all" };

  // 9.7 按群覆盖模式：同一条绑定挂多个群时，各群走自己那一档。
  // 默认档设成「自然接话 + 抽签概率 0」= 无关闲聊一律不接，只有被覆盖的群例外。
  record.bindings[0]!.groupChat = { ...ambientSettings, ambientChance: 0 };
  record.bindings[0]!.groupChatModes = { "1006": "all" };
  await emitToGroup(1006, 70, "这个群设了全都回", 555, false);
  await waitFor(async () => (await assistantCount(1006)) >= 1);
  assert.equal(await assistantCount(1006), 1, "覆盖成「全都回」的群必须回，哪怕默认档抽签不过。");
  await emitToGroup(1007, 71, "这个群沿默认档", 555, false);
  await sleep(5000);
  assert.equal(await assistantCount(1007), 0, "没被覆盖的群仍沿默认档：抽签不过就该静默。");
  record.bindings[0]!.groupChatModes = {};
  record.bindings[0]!.groupChat = { ...ambientSettings, mode: "all" };

  /**
   * 9.8 引用与 @ 分开管：
   *   - 回「中间夹了别人话」的那句 → 引用，但**不** @（用户原话：经常 @ 也不好）；
   *   - 回的就是最新一条 → 连引用都不要，纯文本；
   *   - 主动点名某人 → 只 @，不引用。
   */
  const groupSends = async (groupId: number) => (await readSent()).filter(
    (item) => item.action === "send_group_msg" && Number(item.body.group_id) === groupId,
  );
  const findSegments = (sends: Array<{ body: Record<string, unknown> }>, type: string) => sends
    .map((item) => item.body.message as unknown)
    .find((message): message is Array<{ type: string; data: Record<string, unknown> }> =>
      Array.isArray(message) && message.some((segment) => segment.type === type));

  // 同一批里两条：CI_QUOTE_REPLY 那条不是最新，所以该引用；最新那条不需要引用。
  await emitToGroup(1008, 80, "CI_QUOTE_REPLY 你刚说的那句什么意思", 555, false);
  await emitToGroup(1008, 81, "对了我明天请假", 556, false);
  await waitFor(async () => (await assistantCount(1008)) >= 1);
  const quotedSegments = findSegments(await groupSends(1008), "reply");
  assert.ok(quotedSegments, "接的不是最新一条时必须引用，否则认不出接的是哪句。");
  assert.deepEqual(
    quotedSegments.map((segment) => segment.type),
    ["reply", "text"],
    "只引用、不 @：引用已经指明接哪句，再 @ 一次就是多余提醒。",
  );
  assert.equal(String(quotedSegments[0]!.data.id), "80", "引用的是她决定接的那条消息。");

  // 回的就是最新一条：模型照惯例给了 replyToMessageId，代码要把它丢掉。
  await emitToGroup(1009, 90, "CI_QUOTE_REPLY 在吗", 557, false);
  await waitFor(async () => (await assistantCount(1009)) >= 1);
  const adjacentSends = (await groupSends(1009)).map((item) => item.body.message as unknown);
  const hasQuoteOrAt = (message: unknown) => Array.isArray(message)
    && message.some((segment) => segment.type === "reply" || segment.type === "at");
  assert.ok(adjacentSends.some((message) => typeof message === "string"), "回上一条时正文要按纯文本发。");
  assert.ok(adjacentSends.every((message) => !hasQuoteOrAt(message)), "回上一条不该带引用块，也不该带 @。");

  // 主动点名：只 @ 那个人，不引用。
  await emitToGroup(1010, 95, "CI_AT_REPLY 你们都在干嘛", 558, false);
  await waitFor(async () => (await assistantCount(1010)) >= 1);
  const atSegments = findSegments(await groupSends(1010), "at");
  assert.ok(atSegments, "主动点名必须发 at 段 —— 这是唯一会给对方亮提醒的方式。");
  assert.deepEqual(
    atSegments.map((segment) => segment.type),
    ["at", "text"],
    "点名不需要引用：引用回答「接哪句」，这里是在叫人。",
  );
  assert.equal(String(atSegments[0]!.data.qq), "558", "@ 的必须是那条消息的作者。");

  /**
   * 9.9 别人 @ 别人，不是 @ 她：「全都回」档也不该抢话。
   *
   * 「全都回」的原意是「每一轮都接」，不是「连别人的私事也插一嘴」。
   * 判据只认 at 段：@all 里有她，算叫她；只 @ 了第三个人，才算「这轮不是找她的」。
   */
  record.bindings[0]!.groupChat = { ...ambientSettings, mode: "all" };
  await emitToGroup(1011, 96, "你那边迁移是怎么做的，我需要适配一下", 555, 666);
  await sleep(5000);
  assert.equal(await assistantCount(1011), 0, "别人 @ 别人时不能抢话，哪怕这个群设的是「全都回」。");
  assert.equal((await groupSends(1011)).length, 0, "被闸门挡下的一轮不该有任何 send_group_msg。");
  assert.ok(await waitForGroupRoundLog(1011, "addressed_to_others"), "日志要写明是被「@ 的是别人」挡下的，否则事后无法区分是没收到还是被拦了。");

  // 对照：同一个群、同一个说话人，只要 @ 的是她，就照常回 —— 证明上面挡下来的原因是 at 段指向，不是群本身哑了。
  await emitToGroup(1011, 97, "那你说说看", 555, true);
  await waitFor(async () => (await assistantCount(1011)) >= 1);
  assert.equal(await assistantCount(1011), 1, "@ 她本人时照常回，说明差别只在 at 段指向谁。");

  // @all 是冲着所有人说的，她也是其中之一，不能被当成「别人的私事」挡掉。
  await emitToGroup(1012, 98, "全体注意一下", 555, "all");
  await waitFor(async () => (await assistantCount(1012)) >= 1);
  assert.equal(await assistantCount(1012), 1, "@all 不能算「@ 的是别人」，否则群里喊话她永远不接。");

  /**
   * 9.10 模型把 JSON 套在 ```json 围栏里回来 —— 必须照常回，不能整轮丢掉。
   *
   * 这条以前是「该说的时候她没说话」的一大来源：内容完全正确，只是我们自己的
   * `JSON.parse` 解不动。假模型用 `plainCompletion` 原样吐围栏文本，走完整条管道。
   */
  await emitToGroup(1013, 99, "CI_FENCED_JSON 这条你要回我", 559, false);
  // 等不到就交给下面的断言报错：`waitFor` 超时只会说「等待条件超时」，看不出是哪种失败。
  await waitFor(async () => (await assistantCount(1013)) >= 1).catch(() => undefined);
  assert.equal(await assistantCount(1013), 1, "围栏里的 JSON 要解开并发出正文，不能当模型失败把整轮丢掉。");
  const fencedReply = (await groupSends(1013)).map((item) => String(item.body.message)).join(" ");
  assert(fencedReply.includes("CI 围栏里的模型回复"), "发出去的必须是从围栏里解出来的正文。");

  /**
   * 9.11 戳一戳 = 叫她一声。
   *
   * 用户的实际用法：问了话、她没接（群里别的机器人抢答了，或者档位是 mention），
   * 他就戳她一下 —— 这比再打一遍字轻得多。所以「戳她」必须能把她叫醒，
   * 而「戳别人」跟她毫无关系，连背景都不该进。
   */
  const emitPoke = (groupId: number, userId: number, targetId: number) => fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        self_id: 123456789,
        group_id: groupId,
        user_id: userId,
        target_id: targetId,
        action: "拍了拍",
        suffix: "我的脑袋",
      },
    }),
  });

  // 退到最严格的一档（只认被叫到）：戳她一戳照样要能叫醒。
  record.bindings[0]!.groupChat = { ...ambientSettings, mode: "mention" };
  await emitPoke(1014, 555, 666);
  await sleep(5000);
  assert.equal(await assistantCount(1014), 0, "戳的是别人，跟她无关，不能有任何反应。");
  assert.equal(await userCount(1014), 0, "更不该落库：这条消息连背景都不该进。");
  assert.equal((await groupSends(1014)).length, 0, "当然也不能发消息。");

  await emitPoke(1014, 555, 123456789);
  await waitFor(async () => (await assistantCount(1014)) >= 1).catch(() => undefined);
  assert.equal(await assistantCount(1014), 1, "戳她本人 = 叫她一声，mention 档也要回。");
  assert.equal(await userCount(1014), 1, "那次戳要落成一条可追溯的记录，不能只活在内存里。");
  const pokeSends = (await groupSends(1014)).map((item) => String(item.body.message)).join(" ");
  assert(pokeSends.includes(POKE_CONTENT), "戳这个动作本身要进到她看到的那一轮里。");
  assert.ok(await waitForGroupRoundLog(1014, "direct"), "这一轮必须是按 direct 放行的。");
  assert(
    roundLogs.some((line) => line.includes(`"groupId":"1014"`) && line.includes('"poked":true')),
    "日志还要能看出是被戳醒的，而不是被 @ 的 —— 两者都能让 direct 为真。",
  );
  /**
   * 9.12 被澄清的 @ 可以沉默。
   *
   * 「没说你呢」在协议层和「点名叫她办事」一模一样：at 段指向她，`direct` 必然为真。
   * 但对人的含义相反 —— 那是递台阶。逼她必须开口，她只能把台阶踢回去
   * （2026-10-31 16:08 实况：「没说我你@我干嘛，手滑啊」）。
   * 所以这一档**放行但不强制回**：她看得到这一轮，说不说由她。
   */
  await emitToGroup(1015, 110, "CI_SILENT 没说你呢", 555, true);
  await sleep(5000);
  assert.equal(await assistantCount(1015), 0, "被澄清时允许沉默：假模型这轮选了 silent，就不该冒出一句反击。");
  assert.equal((await groupSends(1015)).length, 0, "沉默的一轮不能有任何 send_group_msg。");
  assert.ok(await waitForGroupRoundLog(1015, "clarification"), "日志要能把「被澄清」和「被点名」分开，否则事后分不清她为什么没吭声。");

  // 对照一：同样是 @ 她，但真的在跟她说话 —— 照旧不允许沉默。
  await emitToGroup(1015, 111, "那你说说看", 555, true);
  await waitFor(async () => (await assistantCount(1015)) >= 1);
  assert.equal(await assistantCount(1015), 1, "真的点名时不给沉默这条路。");
  assert.ok(await waitForGroupRoundLog(1015, "direct"), "这一轮必须是按 direct 放行的。");

  // 对照二：长句里出现「没说你」后面还跟着正事 —— 仍然必须回，判据不能松成「见到词就放」。
  await emitToGroup(1015, 112, "没说你呢，你那边迁移是怎么做的，我这边要适配一下新协议", 555, true);
  await waitFor(async () => (await assistantCount(1015)) >= 2);
  assert.equal(await assistantCount(1015), 2, "长句里的「没说你」后面还有正事，不能当澄清放成可沉默。");

  record.bindings[0]!.groupChat = { ...ambientSettings, mode: "all" };

  // 10. 群聊 B站 指令只认主人：群友触发被忽略，主人触发才得到回执/提示。
  record.groupBiliRunEnabled = true;
  record.bindings[0]!.groupBiliRunEnabled = true;
  record.ownerQq = "222";
  const biliReplies = async () => (await readSent()).filter(
    (item) => item.action === "send_group_msg" && Number(item.body.group_id) === 1002,
  );
  await emitToGroup(1002, 30, "去刷一轮B站", 333);
  await sleep(1000);
  assert.equal((await biliReplies()).length, 0, "非主人发 B站 指令不能有任何回复。");

  await emitToGroup(1002, 31, "去刷一轮B站", 222);
  await waitFor(async () => (await biliReplies()).length >= 1);
  const biliReply = String((await biliReplies())[0]!.body.message);
  assert(biliReply.includes("B站"), "主人触发后必须给出 B站 相关回执。");
  assert(biliReply.includes("还没绑定"), "测试角色没有 B站 绑定时必须明确提示，不能假装跑了。");

  /**
   * 临时会话（通过群发起的私聊，非好友）：OneBot 仍报 `message_type: "private"`，
   * 群号挂在 **`sender.group_id`** 上（SnowLuma 的 `convertPrivateMessage` 就是这么写的）。
   * 回复必须带回去，否则网关按普通好友私聊发，被拒成「请先添加对方为好友」——
   * 表现是「她生成了回复、库里也有，对方却收不到」，用户看到的就是「她不会回私信」。
   *
   * 事件形状按网关真实下发来造：**顶层没有 group_id**，只有 sender 里那个。
   * 上一版按顶层 group_id 解析，这个用例照样通过，线上却一条都发不出去。
   */
  await fetch("http://127.0.0.1:4031/__mock/reset", { method: "POST" });
  await fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "private",
        sub_type: "group",
        self_id: 123456789,
        message_id: 99001,
        user_id: 222,
        sender: { user_id: 222, nickname: "临时会话的人", group_id: 777 },
        message: [{ type: "text", data: { text: "临时会话测试" } }],
      },
    }),
  });
  await waitFor(async () => {
    const res = await fetch("http://127.0.0.1:4031/__mock/messages");
    const payload = await res.json() as { messages: Array<{ action: string }> };
    // 等「私聊回复」本身，而不是「有任意消息」—— reset 之后可能还有上一条用例的回执飘进来。
    return payload.messages.some((item) => item.action === "send_private_msg");
  });
  const tempSent = (await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as {
    messages: Array<{ action: string; body: Record<string, unknown> }>;
  };
  // 按 action 找，不按顺序取第一条：上一条用例的回执可能晚于 reset 落到这个数组里。
  const tempReply = tempSent.messages.find((item) => item.action === "send_private_msg");
  assert(tempReply, "临时会话必须走 send_private_msg 发回复。");
  assert.equal(tempReply.body.user_id, 222, "临时会话回给发起者。");
  assert.equal(tempReply.body.group_id, 777, "临时会话的回复必须带上来源群号，否则协议端拒绝、对方收不到。");

  // ── 主人在群里说的话，即使这一轮没接她，也要落库（storedReason=context）──
  // 群聊和私聊是两个会话，私聊的最近对话窗口只回看自己那一条。这一句不落库，
  // 「他刚在群里说的」在私聊里就不存在，她只能回「这边真没接到」。
  // 用「概率抽签为 0」制造「该挡下」：它排在日上限之后、语义机会那一步，
  // 是最稳的挡法 —— 日上限按群算，新群第一轮是 0，挡不住。
  {
    const ownerRoundConfig = {
      groupChatMode: "ambient",
      batchWindowSeconds: 3,
      mentionWindowSeconds: 1,
      minGapSeconds: 0,
      dailyMax: 0,
      quietStart: "00:00",
      quietEnd: "00:00",
      ambientChance: 0,
    };
    await prisma.characterChannelBinding.update({ where: { id: bindingId }, data: { config: ownerRoundConfig } });
    record.bindings[0]!.groupChat = { ...ambientSettings, ambientChance: 0 };
    record.ownerQq = "222";
    const before = await userCount(1016);
    await emitToGroup(1016, 120, "我先在群里说一句", 222, false);
    await sleep(4000);
    assert.equal(await assistantCount(1016), 0, "概率抽签为 0，这一轮不该回。");
    assert.equal(await userCount(1016), before + 1, "主人在群里说的话要落库，私聊才接得上。");
    const ownerRow = await prisma.message.findFirst({
      where: {
        conversation: { is: { channelBindingId: bindingId, externalConversationId: "g:1016" } },
        metadata: { path: ["storedReason"], equals: "context" },
      },
      select: { metadata: true },
    });
    assert(ownerRow, "主人发言的轮次要标 storedReason=context（7 天清理档，不当证据类留 30 天）。");
    assert.equal(
      (ownerRow.metadata as Record<string, unknown> | null)?.isOwner,
      true,
      "落库要带 isOwner，提炼忆泡时才认得出这句是主人说的。",
    );
    await prisma.characterChannelBinding.update({ where: { id: bindingId }, data: { config: { ...ambientSettings } } });
    record.bindings[0]!.groupChat = { ...ambientSettings };
  }

  closeGateway();

  console.log("OneBot 渠道端到端测试通过：WS token 鉴权与单次握手、事件接入、CQ 码解析、凭据解密、角色绑定路由、记忆检索、模型回复、表情段发送与表情额度、消息持久化、外部身份 upsert、回发平台与幂等去重、群公告草稿与确认发布、普通成员越权拦截、按群滚动 10 分钟回复上限、群聊统一攒批（mention 档只在被叫到时进管道）、自然接话闸门、按群覆盖群聊模式、引用与 @ 的分工（回上一条不加、接旧句才引用、点名才 @）、别人 @ 别人时不抢话（@all 例外）、围栏 JSON 照常回、戳一戳能叫醒她（戳别人不算）、B站 指令主人专属、临时会话的回复带上来源群号。");
} finally {
  for (const child of children) child.kill();
  await prisma.onebotGroupAnnouncement.deleteMany({ where: { connectionId } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { entityType: "PlatformConnection", entityId: connectionId } }).catch(() => undefined);
  if (conversationId) await prisma.conversation.deleteMany({ where: { channelBindingId: bindingId } }).catch(() => undefined);
  await prisma.characterChannelBinding.deleteMany({ where: { connectionId } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
  // 只删本用例造的假作者（111 群聊、222 临时会话），别把真实连接的 external identity 一起端掉。
  await prisma.externalIdentity.deleteMany({ where: { platform: "qq-onebot", platformUid: { in: ["111", "222"] } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: characterId } }).catch(() => undefined);
  await prisma.platformConnection.deleteMany({ where: { id: connectionId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { username: { startsWith: "onebot-test-" } } }).catch(() => undefined);
  await prisma.$disconnect();
}
