import assert from "node:assert/strict";
import { isBiliRunCommand } from "../server/utils/channel-adapter/onebot/bili-run";

// 正常指令：刷/跑/逛/看 + B站，@ 号不算内容。
assert.equal(isBiliRunCommand("去刷一轮B站"), true);
assert.equal(isBiliRunCommand("@10000001 去刷一轮B站"), true);
assert.equal(isBiliRunCommand("刷 B 站"), true);
assert.equal(isBiliRunCommand("跑一轮 bilibili"), true);
assert.equal(isBiliRunCommand("B站刷一轮"), true);
assert.equal(isBiliRunCommand("逛一圈B站"), true);
assert.equal(isBiliRunCommand("帮我刷一轮B站"), true);

// 否定句和普通聊天不能触发。
assert.equal(isBiliRunCommand("别刷B站"), false);
assert.equal(isBiliRunCommand("不要跑B站"), false);
assert.equal(isBiliRunCommand("B站那个视频挺好看"), false);
assert.equal(isBiliRunCommand("今天群里好安静"), false);
assert.equal(isBiliRunCommand("@10000001"), false);

// 提到「刷B站」但不是叫她去刷：另有动词做谓语，「刷B站」是宾语。
assert.equal(isBiliRunCommand("帮你优化了刷B站的功能和添加了好友备注的功能"), false);
assert.equal(isBiliRunCommand("优化了刷B站的功能"), false);
assert.equal(isBiliRunCommand("我把刷B站的功能改好了"), false);
assert.equal(isBiliRunCommand("刷B站的功能坏了"), false);
assert.equal(isBiliRunCommand("添加了好友备注的功能"), false);
assert.equal(isBiliRunCommand("测试一下刷B站的流程"), false);
assert.equal(isBiliRunCommand("刷B站的 bug 修好了"), false);
assert.equal(isBiliRunCommand("你刷过B站了吗"), false);
assert.equal(isBiliRunCommand("我今天刷B站了"), false);

console.log("OneBot 群聊 B站 指令测试通过：正向指令、否定句、误触拦截（提到「刷B站」但另有谓语）。");
