/**
 * QQ 链路轨「断在哪一环」的纯逻辑测试。
 *
 * 这一屏唯一会骗人的地方就是断点归属：四个环节里只要有两个不同时健康，
 * 就容易把「适配器没启动」显示成「小号掉线」，把人指去重新登录 QQ。
 * 下面几条主要就是在钉这件事。
 *
 * 不连数据库、不调模型、不挂 DOM —— 跑一次几十毫秒。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { chainToneAt, resolveChainRoot, selectRuntimeConnection, type ChainConditions } from "../app/utils/qq-channel";

const allOk: ChainConditions = { accountOk: true, gatewayOk: true, adapterOk: true, bindingOk: true };
const rootOf = (patch: Partial<ChainConditions>) => resolveChainRoot({ ...allOk, ...patch });

/** 把四段成色拼成字符串，读起来比一个个 assert 清楚 */
const tones = (root: number, conditions: ChainConditions) =>
  [0, 1, 2, 3]
    .map((index) => chainToneAt(index, root, [conditions.accountOk, conditions.gatewayOk, conditions.adapterOk, conditions.bindingOk][index]!))
    .join(",");

// ── 1. 全通 ─────────────────────────────────────────────
assert.equal(rootOf({}), -1, "四段都健康时没有断点。");
assert.equal(tones(-1, allOk), "live,live,live,live");

// ── 2. 网关不通是根因，小号不跟着红 ──────────────────────
// 网关没起的时候适配器必然连不上、小号 status 也停在旧值上，
// 但屏幕上只能有一个红点，否则看不出该修哪个。
const noGateway: ChainConditions = { ...allOk, gatewayOk: false, accountOk: false };
assert.equal(resolveChainRoot(noGateway), 1, "网关不通时根因在网关。");
assert.equal(tones(1, noGateway), "idle,break,idle,idle", "小号只是「还没轮到」，不能跟着标红。");

// ── 3. 适配器没跑 > 小号未连接（关键回归）─────────────────
// platform_connections.status 只有适配器会写，进程一停就停在最后那个值上（多半是 DISCONNECTED）。
// 只按显示顺序找第一个 false 的话，这里会报「小号未连接」，而用户真正要做的只是启动适配器。
const noAdapter: ChainConditions = { ...allOk, adapterOk: false, accountOk: false };
assert.equal(resolveChainRoot(noAdapter), 2, "适配器没跑时不能把锅甩给小号。");
assert.equal(tones(2, noAdapter), "idle,live,break,idle", "网关是通的，应当照实显示成绿色。");

// ── 4. 网关适配器都在，才轮到小号 ────────────────────────
const noAccount: ChainConditions = { ...allOk, accountOk: false };
assert.equal(rootOf({ accountOk: false }), 0, "网关和适配器都正常时才可能是号掉线。");
assert.equal(tones(0, noAccount), "break,idle,idle,idle", "断点之后的段落一律灰掉。");

// ── 5. 全通只差角色 ─────────────────────────────────────
assert.equal(rootOf({ bindingOk: false }), 3);
assert.equal(tones(3, { ...allOk, bindingOk: false }), "live,live,live,break", "前三段照实显示，只有角色标红。");

// ── 6. 断点之后即使条件成立也是灰的 ──────────────────────
// 网关没开，但角色早就绑好了 —— 那个绿色此刻没有任何意义。
assert.equal(chainToneAt(3, 1, true), "idle", "断点之后的段落不该显示成绿色。");
// 断点之前的段落照实显示。
assert.equal(chainToneAt(1, 3, true), "live", "断点之前的健康段落仍是绿的。");

// ── 7. 多个条件同时不成立时，只报最先卡住的那个 ──────────
const nothingOk: ChainConditions = { accountOk: false, gatewayOk: false, adapterOk: false, bindingOk: false };
assert.equal(resolveChainRoot(nothingOk), 1, "全崩时从链路最上游报起。");
assert.equal(tones(1, nothingOk), "idle,break,idle,idle");

const waiting: ChainConditions = { ...nothingOk, waitingLogin: true };
assert.equal(resolveChainRoot(waiting), -2, "Known logged-out account is waiting, not a failed gateway");
assert.equal(tones(-2, waiting), "idle,idle,idle,idle");
const multiple = [{ id: "logged-out", status: "ERROR" }, { id: "connected", status: "CONNECTED" }];
assert.equal(selectRuntimeConnection(multiple)?.id, "connected");
assert.equal(selectRuntimeConnection(multiple, "logged-out")?.id, "logged-out");
assert.equal(selectRuntimeConnection(multiple, "missing")?.id, "connected");
assert.equal(selectRuntimeConnection([]), null);

const component = readFileSync(new URL("../app/components/QqChannelChain.vue", import.meta.url), "utf8");
const setup = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
const parsed = ts.createSourceFile("chain.ts", setup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const body = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(parsed)).join("\n");
const code = ts.transpileModule(`(function(){${body};return {rootIndex,hops,verdict,allGood,fix,gatewayState};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const props = { connection: { appId: "synthetic", displayName: "待登录账号", status: "ERROR" }, binding: { characterName: "角色", routingKey: null, groupChat: { mode: "ambient" } }, adapter: { running: true }, snowluma: { running: true, installed: true, panelPort: 5099, home: "test" }, gateway: { reachable: true, host: "localhost", port: 3001, wsUrl: "ws://localhost:3001", accountState: "waiting_login" }, ready: true, panelUrl: "http://localhost:5099" };
const view = new Script(code).runInContext(createContext({ defineProps: () => props, defineEmits: () => () => {}, computed: (get: () => unknown) => Object.defineProperty({}, "value", { get }), chainToneAt, resolveChainRoot })) as { rootIndex: { value: number }; hops: { value: Array<{ tone: string }> }; verdict: { value: { text: string; tone: string } }; allGood: { value: boolean }; fix: { value: { detail: string } } };
assert.equal(view.rootIndex.value, -2); assert.equal(view.allGood.value, false, "Shared reachable port cannot make a logged-out account look connected");
assert.equal(view.verdict.value.tone, "idle"); assert.equal(view.verdict.value.text, "当前账号未登录，暂不连接");
assert.equal(view.hops.value.map(item => item.tone).join(","), "idle,idle,idle,idle");
assert.match(view.fix.value.detail, /其他已登录账号不受影响/);

console.log("QQ 链路轨测试通过：全通、网关断点、适配器断点（关键回归）、号离线、未绑角色、断点后置灰、全崩取上游。");
