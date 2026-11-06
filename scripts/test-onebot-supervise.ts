import assert from "node:assert/strict";
import type { OnebotHandlers, OnebotResolvedEvent } from "../server/utils/channel-adapter/onebot/client";
import type { OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
import { describeHandlerError, onebotBackoffMs, superviseOnebotConnection } from "../server/utils/channel-adapter/onebot/supervise";

const record: OnebotConnectionRecord = {
  id: "conn-test",
  platform: "qq-onebot",
  accountQq: "10000",
  config: { wsUrl: "ws://127.0.0.1:1", httpUrl: "http://127.0.0.1:1" },
  replyOnlyWhenMentioned: false,
  bindings: [],
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noopLog = () => {};

// 退避序列：1s 起步，30s 封顶，不能溢出成 Infinity。
assert.equal(onebotBackoffMs(0), 1000);
assert.equal(onebotBackoffMs(3), 8000);
assert.equal(onebotBackoffMs(5), 30_000);
assert.equal(onebotBackoffMs(99), 30_000);

// 1. 连上之后必须待着不动 —— 回归那个「每秒重连一次、socket 一直漏」的循环。
{
  let connectCalls = 0;
  const handlers: OnebotHandlers[] = [];
  const statuses: string[] = [];
  let stop = false;

  const loop = superviseOnebotConnection({
    record,
    handleEvent: async () => ({}),
    log: noopLog,
    onStatusChange: (status) => statuses.push(status),
    connect: (_config, incoming) => {
      connectCalls += 1;
      handlers.push(incoming);
      return Promise.resolve(() => {});
    },
    sleep: () => delay(5),
    shouldStop: () => stop,
  });

  // 连上（connectOnebot 在 open 时 resolve，但这里故意只 resolve、不触发 onStatus）。
  await delay(150);
  assert.equal(connectCalls, 1, "连接成功后不许再发起新连接。");

  handlers[0]!.onStatus?.("ready");
  assert.deepEqual(statuses, ["ready"], "就绪要上报一次。");

  // 断开后要重连。
  handlers[0]!.onStatus?.("disconnected", "code=1006");
  await delay(150);
  assert.equal(connectCalls, 2, "断开后必须重连。");

  stop = true;
  handlers[1]!.onStatus?.("disconnected", "code=1006");
  await loop;
  assert.equal(connectCalls, 2, "停止后不再重连。");
}

// 2. 连接失败也要继续退避重试，且 error 要上报（不代表配置错，只代表掉线）。
{
  let connectCalls = 0;
  const statuses: string[] = [];
  let stop = false;

  const loop = superviseOnebotConnection({
    record,
    handleEvent: async () => ({}),
    log: noopLog,
    onStatusChange: (status) => statuses.push(status),
    connect: () => {
      connectCalls += 1;
      return Promise.reject(new Error("ECONNREFUSED"));
    },
    sleep: () => delay(5),
    shouldStop: () => stop,
  });

  await delay(120);
  stop = true;
  await loop;
  assert(connectCalls >= 2, "连不上要继续重试。");
  assert.deepEqual(statuses, [], "连不上不该把自己标成 ready。");
}

// 3. onclose 会连发 disconnected + error，一轮里只算一次断开。
{
  const logEntries: Record<string, unknown>[] = [];
  let stop = false;
  const handlers: OnebotHandlers[] = [];
  let connectCalls = 0;

  const loop = superviseOnebotConnection({
    record,
    handleEvent: async () => ({}),
    log: (entry) => logEntries.push(entry),
    connect: (_config, incoming) => {
      connectCalls += 1;
      handlers.push(incoming);
      return Promise.resolve(() => {});
    },
    sleep: () => delay(5),
    shouldStop: () => stop,
  });

  await delay(50);
  handlers[0]!.onStatus?.("ready");
  handlers[0]!.onStatus?.("disconnected", "code=1006");
  handlers[0]!.onStatus?.("error", "ONEBOT_WS_CLOSED");
  await delay(150);
  assert.equal(connectCalls, 2, "一次断开只触发一次重连，不能重连两次。");
  assert.equal(
    logEntries.filter((entry) => entry.event === "onebot-disconnected").length,
    1,
    "同一轮断开只记录一次。",
  );
  assert(
    logEntries.some((entry) => entry.event === "onebot-disconnected" && String(entry.detail).includes("code=1006")),
    "断开日志要带关闭码，1006 和 1008 排查方向不同。",
  );

  stop = true;
  handlers[1]!.onStatus?.("disconnected", "code=1006");
  await loop;

  const connected = logEntries.filter((entry) => entry.event === "onebot-connected").length;
  assert.equal(connected, 1, "ready 只应记录一次。");
}

// 4. 某条消息处理失败：留痕、不重连、不把直链里的 rkey 抄进日志。
{
  const logEntries: Record<string, unknown>[] = [];
  const handlers: OnebotHandlers[] = [];
  let connectCalls = 0;
  let stop = false;

  const loop = superviseOnebotConnection({
    record,
    handleEvent: () => Promise.reject(new Error(
      "IMAGE_HTTP_403 https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=CAMSsecretkeyvalue&fileid=abc",
    )),
    log: (entry) => logEntries.push(entry),
    connect: (_config, incoming) => {
      connectCalls += 1;
      handlers.push(incoming);
      return Promise.resolve(() => {});
    },
    sleep: () => delay(5),
    shouldStop: () => stop,
  });

  await delay(50);
  handlers[0]!.onStatus?.("ready");
  await handlers[0]!.onMessage?.({ messageType: "private" } as unknown as OnebotResolvedEvent);

  assert.equal(connectCalls, 1, "一条消息处理失败不该把整条连接拆掉重连。");
  assert.equal(
    logEntries.filter((entry) => entry.event === "onebot-error").length,
    0,
    "处理失败不能上报成连接错误 —— 那正是「一条不回、整条掉线」的来源。",
  );
  const failed = logEntries.find((entry) => entry.event === "onebot-message-failed");
  assert(failed, "处理失败必须留痕，否则又回到静默不回。");
  assert.equal(failed!.messageType, "private", "要能看出是哪一类消息失败的。");
  const reason = String(failed!.reason);
  assert(reason.includes("multimedia.nt.qq.com.cn"), "主机名要留着，不然不知道该找谁。");
  assert(!reason.includes("rkey"), "直链里的 rkey 不能进日志。");
  assert(!reason.includes("CAMSsecretkeyvalue"), "凭据片段不能进日志。");

  stop = true;
  handlers[0]!.onStatus?.("disconnected", "code=1006");
  await loop;
}

// 5. 脱敏本身：QQ 号、Bearer、key= 都要被吞掉，长度有上限。
{
  const reason = describeHandlerError(new Error("request failed for 123456789: Bearer sk-abcdef, apiKey=deadbeef"));
  assert(!/\d{6,}/.test(reason), "6 位以上的数字串（QQ 号/群号/消息 id）不进日志。");
  assert(!reason.includes("sk-abcdef") && !reason.includes("deadbeef"), "凭据不进日志。");
  assert(reason.length <= 200, "日志行要有长度上限。");
  assert.equal(describeHandlerError(undefined), "unknown", "不是 Error 也要给个词，不能空着。");
}

console.log("OneBot 守护循环测试通过：连上不重复连、断开才重连、失败退避重试、关闭码上报、处理失败不断连且脱敏。");
