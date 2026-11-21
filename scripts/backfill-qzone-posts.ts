/**
 * 补记：把「已经发布成功、但没写进消息链路」的说说补进记忆。
 *
 * 背景：写说说记忆是后来才接上的，之前发出去的只留在 `onebot_qzone_actions`，
 * 所以「我发过一条关于雨的说说」她自己不知道。这里按动作 ID 幂等补一遍，
 * **不会重新发布任何内容**。
 *
 * 用法：`yarn backfill:qzone-posts`（预演，只报会补哪几条）
 *      `yarn backfill:qzone-posts --apply`（真写）
 *      `--character=<id>` / `--connection=<id>` 只补某个角色或某个连接。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { backfillQzonePostMemories } from "../server/utils/qzone-memory";

const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
  const matched = /^--([^=]+)(?:=([\s\S]*))?$/u.exec(raw);
  return matched ? [matched[1], matched[2] ?? "true"] : [raw.replace(/^--/u, ""), "true"];
}));

const result = await backfillQzonePostMemories(getPrisma(), {
  apply: args.apply === "true",
  ...(typeof args.character === "string" && args.character.trim() ? { characterId: args.character.trim() } : {}),
  ...(typeof args.connection === "string" && args.connection.trim() ? { connectionId: args.connection.trim() } : {}),
});

console.log(`扫到已发布的说说：${result.scanned}`);
if (args.apply === "true") {
  console.log(`已补记：${result.recorded}；跳过：${result.skipped}`);
} else {
  console.log(`会补记：${result.wouldRecord.length}；跳过（已记过/不可记）：${result.skipped}`);
  for (const item of result.wouldRecord.slice(0, 20)) {
    console.log(`  - 动作 ${item.actionId}（角色 ${item.characterId ?? "无"}）：${item.content}`);
  }
  console.log("这是预演，未写入；加 --apply 才写。");
}
if (result.wouldRecord.length && args.apply === "true") {
  console.log("另有写了但被跳过的条目（例如非公开可见）：");
  for (const item of result.wouldRecord.slice(0, 10)) console.log(`  - ${item.actionId}：${item.content}`);
}
await getPrisma().$disconnect();
