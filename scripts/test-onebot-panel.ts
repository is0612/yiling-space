/**
 * SnowLuma 节点对齐与「挂 QQ 进程」的回归测试。
 *
 * 「一键启动后自动配节点」最容易错的地方不是登录，而是**该改哪个节点**：
 * 端口对不上时是改端口还是新建、令牌该不该覆盖、新建的节点会不会撞名。
 * 这些判断一旦错，面板里就会悄悄多出一个废弃节点，或者把别的客户端在用的令牌换掉。
 *
 * 「挂 QQ 进程」同理：多开时挑错进程就是往别人的 QQ 里注入模块，比不回复严重得多。
 *
 * 跑法：npx tsx scripts/test-onebot-panel.ts
 */
import {
  alignNode,
  pickQqProcess,
  portFromUrl,
  type AdapterNode,
  type NodePlan,
  type PanelQqProcess,
} from "../server/utils/channel-adapter/onebot/panel";

const TOKEN = "rMbhvhvf0GPFWSTVFz-mr6YD6X51Oppg8pV8J5qmlPA";

function plan(over: Partial<NodePlan> = {}): NodePlan {
  return { kind: "ws", port: 3001, token: TOKEN, ...over };
}

function node(over: Partial<AdapterNode> = {}): AdapterNode {
  return {
    name: "ws-default",
    host: "127.0.0.1",
    port: 3001,
    path: "/",
    role: "Universal",
    accessToken: TOKEN,
    messageFormat: "array",
    reportSelfMessage: false,
    ...over,
  };
}

let checks = 0;
function equal(actual: unknown, expected: unknown, what: string): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n  实际 ${a}\n  期望 ${e}`);
}

function run(name: string, task: () => void): void {
  task();
  console.log(`  ok  ${name}`);
}

console.log("portFromUrl：从连接里填的地址取端口");
run("带端口", () => equal(portFromUrl("ws://127.0.0.1:3001", 9999), 3001, "应取地址里的端口"));
run("协议默认端口", () => equal(portFromUrl("ws://127.0.0.1/", 3001), 3001, "没写端口时用兜底"));
run("https 默认 443", () => equal(portFromUrl("https://example.com/api", 3002), 443, "https 不带端口是 443"));
run("坏地址不抛", () => equal(portFromUrl("这不是地址", 3002), 3002, "解析失败要退回兜底"));

console.log("alignNode：本来就对 → 一个字都不改");
run("不改动", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const list = [node()];
  const out = alignNode(list, plan(), changes, warnings);
  equal(changes, [], "不该记改动");
  equal(warnings, [], "不该报警告");
  equal(out, list, "节点应原样返回");
});

console.log("alignNode：端口不一致 → 改端口，别新建");
run("改端口", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const out = alignNode([node({ port: 3000 })], plan(), changes, warnings);
  equal(out.length, 1, "不能多出节点");
  equal(out[0]!.port, 3001, "端口应改成 3001");
  equal(changes, ["WS 节点端口 3000 → 3001"], "改动要写清楚从哪来到哪去");
});

console.log("alignNode：令牌不一致 → 覆盖成连接里的");
run("覆盖令牌", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const out = alignNode([node({ accessToken: "面板里原来的另一个令牌另一个令牌" })], plan(), changes, warnings);
  equal(out[0]!.accessToken, TOKEN, "应以连接里的令牌为准");
  equal(changes, ["WS 节点令牌改成连接里填的那个"], "要说明改了令牌");
});

console.log("alignNode：连接里的令牌太短 → 不动面板，只警告");
run("令牌太短", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const out = alignNode([node()], plan({ token: "short" }), changes, warnings);
  equal(out[0]!.accessToken, TOKEN, "面板的令牌不能被改短");
  equal(changes, [], "没有改动就不该写配置");
  equal(warnings.length, 1, "要提醒两边令牌对不上");
});

console.log("alignNode：一个节点都没有 → 新建");
run("新建", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const out = alignNode([], plan(), changes, warnings);
  equal(out.length, 1, "应新建一个");
  equal(out[0]!.host, "127.0.0.1", "新建节点绑本机");
  equal(out[0]!.name, "ws-3001", "名字带上端口");
  equal(out[0]!.accessToken, TOKEN, "新建时直接带上令牌");
  equal(changes, [
    "WS 节点消息格式改为 array",
    "WS 节点关掉「上报自己发的消息」",
    "WS 节点角色改为 Universal（收发共用一条连接）",
    "新建WS 节点（端口 3001）",
  ], "新建要说清楚补了哪些默认值");
});

console.log("alignNode：已有多个都不对 → 新建且避开撞名");
run("避开撞名", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const list = [node({ name: "ws-3001", port: 4001 }), node({ name: "别的", port: 4002 })];
  const out = alignNode(list, plan(), changes, warnings);
  equal(out.length, 3, "应追加而不是替换");
  equal(out[2]!.name, "ws-3001-2", "名字撞了要加后缀");
});

console.log("alignNode：http 节点不该被塞 role");
run("http 不带 role", () => {
  const changes: string[] = [];
  const warnings: string[] = [];
  const out = alignNode([], { kind: "http", port: 3002, token: TOKEN }, changes, warnings);
  equal("role" in out[0]!, false, "HTTP 节点没有 role 概念");
});

console.log("pickQqProcess：只认这个号，多开时别猜");

function proc(over: Partial<PanelQqProcess> = {}): PanelQqProcess {
  return { pid: 100, name: "QQ.exe", injected: false, connected: false, uin: "10000001", status: "available", ...over };
}

run("认账号", () => {
  const target = pickQqProcess([proc()], "10000001");
  equal(target?.pid, 100, "号对得上就该选它");
});

run("面板里没有这个号 → null", () => {
  // 这一步关系到「会不会往别人的 QQ 里注入」：没有就必须什么都不做
  equal(pickQqProcess([proc({ uin: "10000002" })], "10000001"), null, "别的号不能拿来凑数");
});

run("连接里没填号 → null", () => {
  equal(pickQqProcess([proc()], ""), null, "不知道要挂谁就不挂");
  equal(pickQqProcess([proc()], "   "), null, "空白也算没填");
});

run("同一号多开 → 优先已经连上的那个", () => {
  const list = [proc({ pid: 1, uin: "10000001" }), proc({ pid: 2, uin: "10000001", injected: true, connected: true })];
  equal(pickQqProcess(list, "10000001")?.pid, 2, "别往已经废弃的那个进程里再注入一遍");
});

run("多个号 → 只挑目标那个", () => {
  const list = [proc({ pid: 7, uin: "10000002" }), proc({ pid: 8, uin: "10000001" })];
  equal(pickQqProcess(list, "10000001")?.pid, 8, "多开时不能挑错");
});

console.log(`\nOneBot 节点对齐测试通过：${checks} 项断言。`);
