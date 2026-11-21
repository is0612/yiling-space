import assert from "node:assert/strict";
import { announceCleanupTarget, readCleanupTarget } from "../server/utils/cleanup-guard";

const local = "postgresql://u:p@127.0.0.1:5434/yiling_hub?schema=public";
const localhost = "postgresql://u:p@localhost:5432/yiling_hub";
const remote = "postgresql://u:p@db.example.com:5432/yiling_hub";

// 本机库：默认可用，干跑 / 真删都只看 --apply。
const dry = readCleanupTarget(local, ["node", "script"]);
assert.equal(dry.apply, false);
assert.equal(dry.local, true);
assert.equal(dry.database, "yiling_hub");
assert.equal(dry.host, "127.0.0.1:5434");
assert.match(dry.label, /yiling_hub @ 127\.0\.0\.1:5434（本机）/u);
assert.equal(readCleanupTarget(local, ["node", "script", "--apply"]).apply, true);
assert.equal(readCleanupTarget(localhost, []).local, true, "localhost 也算本机");

// 远程库：默认拒绝，必须显式点头。
assert.throws(() => readCleanupTarget(remote, ["node", "script"]), /不在本机/u);
assert.throws(() => readCleanupTarget(remote, ["node", "script", "--apply"]), /--allow-remote/u);
const allowed = readCleanupTarget(remote, ["node", "script", "--apply", "--allow-remote"]);
assert.equal(allowed.local, false);
assert.equal(allowed.apply, true);
assert.match(allowed.label, /（远程）/u);

// 连接串本身有问题时也要拒绝，别带着半个目标去删数据。
assert.throws(() => readCleanupTarget(undefined, []), /缺少 DATABASE_URL/u);
assert.throws(() => readCleanupTarget("不是连接串", []), /不是合法的连接串/u);
assert.throws(() => readCleanupTarget("postgresql://u:p@127.0.0.1:5432", []), /没有库名/u);

// announce 只在干跑时提示「什么都没删」，真删时不说这句。
const lines: string[] = [];
const original = console.log;
console.log = (line?: unknown) => { lines.push(String(line)); };
try {
  announceCleanupTarget(readCleanupTarget(local, []));
  announceCleanupTarget(readCleanupTarget(local, ["--apply"]));
} finally {
  console.log = original;
}
assert.equal(lines[0], "目标库：yiling_hub @ 127.0.0.1:5434（本机）", "第一行必须先说清目标库");
assert.match(lines[1] ?? "", /干跑/u);
assert(!lines.slice(2).some(line => /干跑/u.test(line)), "真删时不该再说「干跑」");

console.log("清理护栏测试通过：本机库放行、远程库默认拒绝、缺库名/坏连接串报错、目标库先打印、干跑提示只在干跑时出现。");
