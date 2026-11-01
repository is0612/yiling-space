import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * 把 `scripts/data/*.json` 里的台词灌进某个角色的梗语录。
 *
 * 用法：
 *   yarn catchphrases:import --character <角色id或角色名>            # dry-run，只打印
 *   yarn catchphrases:import --character <角色id或角色名> --apply     # 真写库
 *   yarn catchphrases:import --character <id> --apply --limit 20      # 只导前 20 条
 *   yarn catchphrases:import --character <id> --file scripts/data/sample-stage-host.json
 *
 * 两份示例素材（说明见 docs/catchphrase-samples.md）：
 *   - `sample-cold-jokes.json`  冷笑话型 47 条（默认）
 *   - `sample-stage-host.json`  点评型 53 条
 *
 * 素材只是模板，不是成品角色卡。正式使用前请按自己角色的说话方式改写，
 * 尤其 `usage` 要换成她真实会遇到的场景，否则命中率很低。
 *
 * 三条约束（与梗语录的产品逻辑对齐）：
 *   - 一律 status = ACTIVE、source = manual：手填梗不需要用户点头。
 *   - 按 phrase 去重：同一句话导两次不会变成两条，重复导只会跳过。
 *   - 不覆盖已有的 usage / enabled / useCount。已在库里的那句话，用户改过的时机就留着。
 *
 * 注意：提示词一次只装 15 条（CATCHPHRASE_PROMPT_LIMIT），全部导进来并不会
 * 一次全说出来 —— 挑选按「没用过的排最前」，所以刚导完会连续听到新梗，
 * 之后才按冷却轮转。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，请先配置 .env。");

const args = process.argv.slice(2);
const apply = args.includes("--apply");

function readFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const characterRef = readFlag("--character") || process.env.CATCHPHRASE_CHARACTER;
if (!characterRef) {
  throw new Error("缺少目标角色：用 --character <角色id或角色名> 指定，或设 CATCHPHRASE_CHARACTER。");
}

const limitRaw = readFlag("--limit");
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 0;

type JokeEntry = {
  phrase: string;
  usage: string;
  source?: "meme" | "original";
  group?: string;
};

const fileArg = readFlag("--file") || "scripts/data/sample-cold-jokes.json";
const dataPath = resolve(process.cwd(), fileArg);
const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as JokeEntry[];

const entries = parsed
  .map((entry) => ({ phrase: entry.phrase.trim(), usage: entry.usage.trim(), source: entry.source }))
  .filter((entry) => entry.phrase.length > 0)
  .filter((entry) => entry.phrase.length <= 200);

if (entries.length !== parsed.length) {
  console.log(`跳过 ${parsed.length - entries.length} 条空台词或超长台词（上限 200 字）。`);
}

const targets = limit > 0 ? entries.slice(0, limit) : entries;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

try {
  const character = uuidPattern.test(characterRef)
    ? await prisma.character.findUnique({ where: { id: characterRef }, select: { id: true, name: true } })
    : await prisma.character.findFirst({ where: { name: characterRef }, select: { id: true, name: true } });

  if (!character) throw new Error(`找不到角色：${characterRef}（按 id 和 name 都查过了）`);

  const existing = await prisma.characterCatchphrase.findMany({
    where: { characterId: character.id },
    select: { phrase: true },
  });
  const existingPhrases = new Set(existing.map((row) => row.phrase));

  const toCreate = targets.filter((entry) => !existingPhrases.has(entry.phrase));
  const duplicates = targets.length - toCreate.length;

  console.log(`角色：${character.name}（${character.id}）`);
  console.log(`数据：${dataPath}，共 ${targets.length} 条，其中已在库 ${duplicates} 条`);
  console.log(`将新增：${toCreate.length} 条${apply ? "" : "（dry-run，不写库）"}`);

  for (const entry of toCreate.slice(0, 10)) {
    console.log(`  + ${entry.phrase}`);
    console.log(`    时机：${entry.usage}`);
  }
  if (toCreate.length > 10) console.log(`  … 其余 ${toCreate.length - 10} 条省略`);

  if (!apply) {
    console.log("\n确认无误后加 --apply 真正写入。");
  } else if (toCreate.length > 0) {
    const result = await prisma.characterCatchphrase.createMany({
      data: toCreate.map((entry) => ({
        characterId: character.id,
        phrase: entry.phrase,
        usage: entry.usage,
        status: "ACTIVE",
        source: "manual",
      })),
    });
    console.log(`\n已写入 ${result.count} 条。`);
  }
} finally {
  await prisma.$disconnect();
}
