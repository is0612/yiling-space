import "dotenv/config";
import assert from "node:assert/strict";
import { runBili, biliJson, resolveBiliBin } from "../server/utils/channel-adapter/bili/runner";
import { BILI_CATALOG, findBiliCatalogItem } from "../server/utils/channel-adapter/bili/catalog";
import { biliHomeEnv, biliOptions, type BiliConnectionRecord } from "../server/utils/channel-adapter/bili/configure";

async function main() {
  // 1. 空命令：应返回 code=2，不抛异常
  const empty = await runBili([]);
  assert.equal(empty.code, 2, "空命令应返回 code=2");
  assert.equal(empty.stderr, "空命令");

  // 2. 找不到可执行文件：用一个几乎不存在的命令名，应返回 code=127 且 stderr 提示找不到
  const missing = await runBili(["definitely-not-a-real-bili-command-xyz"], { bin: "__no_such_bili_bin__", timeoutMs: 5000 });
  assert.equal(missing.code, 127, `找不到可执行文件应返回 127，实际 ${missing.code}`);
  assert.match(missing.stderr, /找不到 bili 可执行文件/);

  // 3. resolveBiliBin：默认应返回环境变量 BILI_BIN 或 "bili"
  const bin = resolveBiliBin();
  assert.equal(typeof bin, "string");
  assert.ok(bin.length > 0);

  // 4. biliJson：空命令返回 null（JSON 解析失败）
  const nullJson = await biliJson([]);
  assert.equal(nullJson, null);

  // 5. 命令目录完整性：迁移自 bili-desk，应有 9 组、写操作带 write 标记
  assert.equal(BILI_CATALOG.length, 9, `应有 9 组命令，实际 ${BILI_CATALOG.length}`);
  const writeItems = BILI_CATALOG.flatMap((g) => g.items).filter((i) => i.write);
  assert.ok(writeItems.length > 0, "应有写操作命令标记 write=true");
  // 写操作应包含点赞/收藏/投币/三连/评论/私信/动态
  const writeIds = new Set(writeItems.map((i) => i.id));
  for (const id of ["video.like", "video.fav", "video.coin", "video.triple", "comment.post", "dm.send", "dynamic.post"]) {
    assert.ok(writeIds.has(id), `写操作 ${id} 应存在`);
  }

  // 6. findBiliCatalogItem 能定位到已知命令
  const videoWatch = findBiliCatalogItem("video.watch");
  assert.ok(videoWatch, "video.watch 应存在");
  assert.deepEqual(videoWatch?.argv, ["video", "watch"]);

  // 7. 分区排行参数里应含分区选择与 choices
  const hotRank = findBiliCatalogItem("hot.rank");
  assert.ok(hotRank?.params?.some((param) => param.key === "zone" && param.type === "select"));

  // 8. 配置目录：CLI 只认 BILI_CLI_HOME（bili_cli/config.py 的 home()），
  //    BILI_DESK_HOME 是老名字、v0.6.0 不认 —— 只传老变量等于没传，多账号会共用一个 profile。
  assert.deepEqual(biliHomeEnv("D:/bili-profiles/a"), {
    BILI_CLI_HOME: "D:/bili-profiles/a",
    BILI_DESK_HOME: "D:/bili-profiles/a",
  });
  assert.equal(biliHomeEnv("   "), undefined, "空目录不该往子进程里塞环境变量");

  const record = {
    id: "c1", platform: "bili", dataHome: "D:/bili-profiles/a", biliBin: "D:/bili.exe",
    duty: {} as BiliConnectionRecord["duty"], bindings: [],
  } satisfies BiliConnectionRecord;
  const opts = biliOptions(record);
  assert.equal(opts.bin, "D:/bili.exe");
  assert.equal(opts.env?.BILI_CLI_HOME, "D:/bili-profiles/a", "必须传 BILI_CLI_HOME，否则等于没隔离");

  console.log("✅ test-bili-runner 全部通过");
  console.log(`   命令目录：${BILI_CATALOG.length} 组，共 ${BILI_CATALOG.flatMap((g) => g.items).length} 条命令`);
  console.log(`   写操作命令：${writeIds.size} 条（默认 --dry-run）`);
  console.log("   配置目录环境变量（BILI_CLI_HOME）：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-runner 失败：", error);
  process.exit(1);
});
