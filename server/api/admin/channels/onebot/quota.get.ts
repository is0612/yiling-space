import { requireAdminActor } from "../../../../utils/auth";
import { loadOnebotConnections } from "../../../../utils/channel-adapter/onebot/configure";
import { readDailyQuota, usageDayKey } from "../../../../utils/model-usage";
import { getPrisma } from "../../../../utils/prisma";

/**
 * QQ 渠道上「她今天还能不能说话」。
 *
 * 为什么要单独一个接口：链路轨只看得到四段通不通（小号 / 协议端 / 适配器 / 绑定），
 * 而这四段全通、她依然一句话不说的情况，最常见的原因就是**模型额度用完了**——
 * 额度检查在管道深处，只体现在返回的 `daily_quota_exceeded` 上，页面上完全看不见。
 * 2026-10-30 就是「四段全通 + @ 也不回」，查了半天才发现是 10 万 token 在 09:49 烧完了。
 *
 * 只算 QQ 渠道上真的绑了角色的那些号：没绑定的号不回话与额度无关。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const day = usageDayKey();
  const connections = await loadOnebotConnections();
  const characterIds = [...new Set(
    connections.flatMap((connection) => connection.bindings.map((binding) => binding.characterId)),
  )];
  if (!characterIds.length) return { day, characters: [] };

  const prisma = getPrisma();
  const characters = await prisma.character.findMany({
    where: { id: { in: characterIds } },
    select: { id: true, name: true, modelConfig: true },
  });

  // 一个号只出一行：同一角色绑了多个群时额度是共用的，重复列出反而看不出总量。
  const quota = await Promise.all(characters.map(async (character) => {
    const result = await readDailyQuota(character.id, character.modelConfig, day);
    return { id: character.id, name: character.name, ...result };
  }));

  return { day, characters: quota };
});
