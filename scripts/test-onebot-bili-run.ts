import assert from "node:assert/strict";
import { isBiliRunCommand } from "../server/utils/channel-adapter/onebot/bili-run";

// 正常指令：刷/跑/逛/看 + B站，@ 号不算内容。
assert.equal(isBiliRunCommand("去刷一轮B站"), true);
assert.equal(isBiliRunCommand("@10000001 去刷一轮B站"), true);
assert.equal(isBiliRunCommand("刷 B 站"), true);
assert.equal(isBiliRunCommand("跑一轮 bilibili"), true);
assert.equal(isBiliRunCommand("B站刷一轮"), true);
assert.equal(isBiliRunCommand("逛一圈B站"), true);

// 否定句和普通聊天不能触发。
assert.equal(isBiliRunCommand("别刷B站"), false);
assert.equal(isBiliRunCommand("不要跑B站"), false);
assert.equal(isBiliRunCommand("B站那个视频挺好看"), false);
assert.equal(isBiliRunCommand("今天群里好安静"), false);
assert.equal(isBiliRunCommand("@10000001"), false);

console.log("OneBot 群聊 B站 指令测试通过：正向指令、否定句与误触拦截。");
