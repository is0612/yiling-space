/**
 * 把 modelConfig 里的加密 API Key 迁移成明文。
 *
 * 背景：2026-11-12 起凭据改为明文存储（理由见 `server/utils/credential-encryption.ts` 顶部）。
 * 读取侧对新旧两种格式都能认，所以这个脚本**不是**为了让功能能用 ——
 * 它是为了让「页面上能看见 Key」这件事对存量角色也成立：密文回显不出内容，
 * 用户在输入框里只会看到空白 + 一句「已配置」，想核对还得重填一遍。
 *
 * 做法（幂等，可反复跑）：
 *   对每把 Key，若存在 `xxxApiKeyEncrypted` 且明文字段为空，
 *   解密后写入 `xxxApiKey`，再删掉 `xxxApiKeyEncrypted`。
 *
 * 解不开的密文不删、不覆盖，只在报告里列出来 ——
 * 密钥文件换过机器就会这样，那种情况只能让用户重填，脚本不该替他抹掉记录。
 *
 * 用法：
 *   tsx scripts/migrate-api-keys-to-plaintext.ts          # 只看会改什么
 *   tsx scripts/migrate-api-keys-to-plaintext.ts --apply  # 真写库
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { API_KEY_FIELDS, decryptApiKey } from "../server/utils/credential-encryption";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，迁移脚本无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

type FieldPair = { plain: string; legacy: string };
const KEY_FIELDS: Array<{ label: string; fields: FieldPair }> = [
  { label: "对话模型", fields: API_KEY_FIELDS.chat },
  { label: "语音合成", fields: API_KEY_FIELDS.voice },
  { label: "语音识别", fields: API_KEY_FIELDS.asr },
  { label: "图片模型", fields: API_KEY_FIELDS.vision },
  { label: "记忆助手", fields: API_KEY_FIELDS.memoryAssistant },
  { label: "语境助手", fields: API_KEY_FIELDS.contextAssistant },
  { label: "知识助手", fields: API_KEY_FIELDS.knowledgeAssistant },
  { label: "关系评估助手", fields: API_KEY_FIELDS.socialRelationshipAssessmentAssistant },
];

type Plan = {
  characterId: string;
  characterName: string;
  label: string;
  field: string;
  action: "convert" | "undecryptable";
};

async function main() {
  const characters = await prisma.character.findMany({
    select: { id: true, name: true, modelConfig: true },
    orderBy: { createdAt: "asc" },
  });

  const plans: Plan[] = [];
  const updates = new Map<string, Record<string, unknown>>();

  for (const character of characters) {
    const config = character.modelConfig !== null
      && typeof character.modelConfig === "object"
      && !Array.isArray(character.modelConfig)
      ? { ...(character.modelConfig as Record<string, unknown>) }
      : {};
    let changed = false;

    for (const { label, fields } of KEY_FIELDS) {
      const legacy = config[fields.legacy];
      if (typeof legacy !== "string" || !legacy.startsWith("v1.")) continue;

      const existingPlain = config[fields.plain];
      if (typeof existingPlain === "string" && existingPlain.trim()) {
        // 明文已经有了，密文只是残留 —— 直接清掉，不需要解密。
        delete config[fields.legacy];
        changed = true;
        plans.push({ characterId: character.id, characterName: character.name, label, field: fields.plain, action: "convert" });
        continue;
      }

      try {
        const plaintext = (await decryptApiKey(legacy)).trim();
        if (!plaintext) {
          plans.push({ characterId: character.id, characterName: character.name, label, field: fields.plain, action: "undecryptable" });
          continue;
        }
        config[fields.plain] = plaintext;
        delete config[fields.legacy];
        changed = true;
        plans.push({ characterId: character.id, characterName: character.name, label, field: fields.plain, action: "convert" });
      } catch {
        plans.push({ characterId: character.id, characterName: character.name, label, field: fields.plain, action: "undecryptable" });
      }
    }

    if (changed) updates.set(character.id, config);
  }

  if (!plans.length) {
    console.log("没有需要迁移的加密 Key。");
    return;
  }

  const convertCount = plans.filter(p => p.action === "convert").length;
  const brokenCount = plans.length - convertCount;
  console.log(`扫描 ${characters.length} 个角色：${convertCount} 把 Key 可转明文，${brokenCount} 把解不开。`);
  for (const plan of plans) {
    const mark = plan.action === "convert" ? "→ 明文" : "! 解不开";
    console.log(`  ${mark}  ${plan.characterName} · ${plan.label} (${plan.field})`);
  }

  if (!apply) {
    console.log("\n这是干跑。加 --apply 才会写库。");
    return;
  }

  let written = 0;
  for (const [characterId, modelConfig] of updates) {
    await prisma.character.update({
      where: { id: characterId },
      data: { modelConfig: modelConfig as never },
    });
    written += 1;
  }
  console.log(`\n已更新 ${written} 个角色。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
