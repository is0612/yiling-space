import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { runProactiveTick } from "../server/utils/proactive";
import { goalDedupeKey, proactiveDayKey } from "../server/utils/proactive-settings";

/**
 * 主动找话的数据库侧测试：闸门分支、去重约束、按日计数。
 *
 * 故意不测「真发一条」—— 那要能连上的 OneBot，一旦红在「本机没开 QQ」上，
 * 两次之后大家就开始忽略这个测试了。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，主动找话数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const otherCharacterId = randomUUID();

  await prisma.user.create({
    data: { id: ownerId, username: `proactive-test-${randomUUID().slice(0, 8)}`, passwordHash: "test", role: "USER" },
  });

  try {
    await prisma.character.create({
      data: {
        id: characterId,
        ownerId,
        name: "proactive-test-character",
        basePrompt: "test persona",
        modelConfig: { proactive: { enabled: false } },
      },
    });
    await prisma.character.create({
      data: { id: otherCharacterId, ownerId, name: "proactive-test-other", basePrompt: "test persona" },
    });
    await prisma.memoryScope.create({
      data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
    });

    // 1. 关着的时候一次 token 都不该花：连模型都不会碰，直接给 disabled。
    const disabled = await runProactiveTick({ characterId });
    assert.equal(disabled.length, 1, "每个角色都应有一条结果，不能静默跳过");
    assert.equal(disabled[0]!.status, "skipped");
    assert.equal(disabled[0]!.reason, "disabled");

    // 2. 开了但没有任何 QQ 私聊 → no_recipient（而不是「试着发一下再说」）。
    await prisma.character.update({
      where: { id: characterId },
      data: { modelConfig: { proactive: { enabled: true, dailyMax: 2 } } },
    });
    const noRecipient = await runProactiveTick({ characterId });
    assert.equal(noRecipient[0]!.reason, "no_recipient");

    // 3. force 不跳过「收件人」这条：它是配置性问题，不是时间性问题。
    const forced = await runProactiveTick({ characterId, force: true });
    assert.equal(forced[0]!.reason, "no_recipient", "「立即试一次」也不该在没有收件人时硬发");

    // 4. 同一角色同一目的只入一条（靠 @@unique(characterId, dedupeKey) + skipDuplicates）。
    const goal = "想问问他昨天说的那个项目到底卡在哪";
    const dedupeKey = goalDedupeKey("ASK", goal);
    const insert = () => prisma.proactiveIntent.createMany({
      data: [{ characterId, kind: "ASK", goal, confidence: 0.7, urgency: 0.6, origin: "memory", dedupeKey }],
      skipDuplicates: true,
    });
    assert.equal((await insert()).count, 1);
    assert.equal((await insert()).count, 0, "重复目的不该再入库");
    assert.equal(await prisma.proactiveIntent.count({ where: { characterId } }), 1);

    // 5. 同一目的换到另一个角色可以各说一次（唯一键带 characterId）。
    const other = await prisma.proactiveIntent.createMany({
      data: [{ characterId: otherCharacterId, kind: "ASK", goal, confidence: 0.7, urgency: 0.6, origin: "memory", dedupeKey }],
      skipDuplicates: true,
    });
    assert.equal(other.count, 1);

    // 6. 「今天发了几条」按东八区日界算：昨天那条不算今天的。
    const dayStart = new Date(`${proactiveDayKey(new Date())}T00:00:00+08:00`);
    await prisma.proactiveIntent.create({
      data: { characterId, kind: "SHARE", goal: "昨天发的", origin: "memory", sentAt: new Date(dayStart.getTime() - 60_000), status: "SENT", dedupeKey: "SHARE:昨天发的" },
    });
    await prisma.proactiveIntent.create({
      data: { characterId, kind: "SHARE", goal: "今天发的", origin: "memory", sentAt: new Date(dayStart.getTime() + 60_000), status: "SENT", dedupeKey: "SHARE:今天发的" },
    });
    assert.equal(
      await prisma.proactiveIntent.count({ where: { characterId, status: "SENT", sentAt: { gte: dayStart } } }),
      1,
      "昨天那条不该算进今天的额度",
    );

    // 7. 待发池只数 PENDING：SENT / SKIPPED / EXPIRED 都不该被再挑一次。
    assert.equal(await prisma.proactiveIntent.count({ where: { characterId, status: "PENDING" } }), 1);
    await prisma.proactiveIntent.updateMany({ where: { characterId, goal }, data: { status: "EXPIRED" } });
    assert.equal(await prisma.proactiveIntent.count({ where: { characterId, status: "PENDING" } }), 0);

    console.log("✅ test-proactive-db 全部通过");
  } finally {
    // 清理：ProactiveIntent 有外键，先删子表。
    await prisma.proactiveIntent.deleteMany({ where: { characterId: { in: [characterId, otherCharacterId] } } }).catch(() => undefined);
    await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
    await prisma.character.deleteMany({ where: { id: { in: [characterId, otherCharacterId] } } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

void main();
