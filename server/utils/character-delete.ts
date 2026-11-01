import fs from "node:fs/promises";
import path from "node:path";
import { getPrisma } from "./prisma";
import { stickerCharacterDir, stickerOriginalsDir, invalidateStickerCache } from "./stickers";

/**
 * 彻底删掉一个角色，包括那些**没有外键**、不会被自动级联的表和磁盘文件。
 *
 * 为什么单独抽出来：删除顺序和「哪些表要手动删」是这个操作最容易出错的地方，
 * 塞在 handler 里既没法测也没法复用（清理脚本要的是同一套语义）。
 *
 * 分两类：
 *
 *   A. 有外键的，交给数据库
 *      - Conversation → Message（Cascade）
 *      - MemoryScope → MemoryItem / MemorySnapshot / MemoryEvent / MemoryJob（Cascade）
 *      - CharacterChannelBinding → BiliRoundReport / BiliSeenVideo / BiliAction（Cascade）
 *      - CharacterSticker / CharacterCatchphrase / ProactiveIntent / CharacterMemorySetting（Cascade）
 *      - AuditLog → SetNull（记录本身留着，`characterId` 置空）
 *      - Conversation / MemoryScope 是 Restrict，所以必须先手动删，否则角色删不掉
 *
 *   B. 没有外键的，必须手动删（这几张表只在本文件里被清理）
 *      - ChatRequest：按 `ownerId + characterId + requestKey` 去重，角色没了就是废行
 *      - GroupActivity：群活跃度事实表，`characterId` 只是记录，schema 里没有 relation
 *      - OnebotGroupAnnouncement：群公告草稿，同上
 *
 *   故意**不删**的：
 *      - ModelUsage：token 账单不该因为删角色而消失（schema 注释里写明了），
 *        用量页按 `characterId` 聚合，孤儿行不会串到别的角色上
 *      - ExternalIdentity：`(platform, platformUid)` 全局唯一，同一个 QQ 号可能同时
 *        是几个角色的「朋友」，删一个角色不该动它；它对应的 MemoryScope 会按角色删掉
 *
 * 磁盘文件在事务**提交之后**才删 —— 事务回滚了却把图删了，角色会剩一堆空壳。
 */

export type CharacterDeleteResult = {
  id: string;
  name: string;
  /** 手动清掉的行数，给日志和测试看。 */
  purged: {
    chatRequests: number;
    groupActivities: number;
    announcements: number;
  };
  /** 是否真的删掉了磁盘目录（目录本来就不存在时是 false）。 */
  removedStickerDirs: boolean;
};

/**
 * 删角色表情包的整个目录。
 *
 * 单张删除走 `deleteStickerFile`，那是给「删掉这一张」用的；角色都没了，
 * 留着目录等于每次换角色都往 `.data/stickers` 里留一份垃圾。
 *
 * 目录名取自库里存的 characterId（服务端生成的 uuid），但还是过一遍 uuid 形状校验 ——
 * 这个函数会 `rm -rf`，路径里混进 `..` 就是灾难。
 */
export async function removeCharacterStickerDirs(characterId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(characterId)) {
    throw new Error(`拒绝删除非 uuid 目录：${characterId}`);
  }
  const root = path.join(process.cwd(), ".data");
  const targets = [stickerCharacterDir(characterId), stickerOriginalsDir(characterId)];
  // 双保险：目标必须真的落在 `.data` 下面，别因为 process.cwd() 变了就删到别处去。
  for (const target of targets) {
    if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) {
      throw new Error(`拒绝删除 .data 之外的目录：${target}`);
    }
  }
  let removed = false;
  for (const target of targets) {
    const existed = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false);
    if (!existed) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed = true;
  }
  invalidateStickerCache(characterId);
  return removed;
}

export async function deleteCharacterCompletely(options: {
  characterId: string;
  ownerId: string;
}): Promise<CharacterDeleteResult | null> {
  const prisma = getPrisma();
  const { characterId, ownerId } = options;

  const existing = await prisma.character.findFirst({ where: { id: characterId, ownerId } });
  if (!existing) return null;

  const purged = await prisma.$transaction(async (tx) => {
    // 1. Restrict 的两张必须先删，否则第 5 步删角色会被外键挡住
    await tx.conversation.deleteMany({ where: { characterId } });
    await tx.memoryScope.deleteMany({ where: { characterId } });
    // 2. 没有外键的三张手动删
    const chatRequests = await tx.chatRequest.deleteMany({ where: { characterId } });
    const groupActivities = await tx.groupActivity.deleteMany({ where: { characterId } });
    const announcements = await tx.onebotGroupAnnouncement.deleteMany({ where: { characterId } });
    // 3. 剩下的交给 cascade / SetNull
    await tx.character.delete({ where: { id: characterId } });
    return {
      chatRequests: chatRequests.count,
      groupActivities: groupActivities.count,
      announcements: announcements.count,
    };
  });

  const removedStickerDirs = await removeCharacterStickerDirs(characterId);

  // 删除是唯一不可逆的操作，**必须**留痕：没有这一条，「这个角色什么时候没的」
  // 事后完全查不到（导入导出都有审计，就这个没有）。`characterId` 只能是 null ——
  // 角色行已经没了，写 id 会被外键挡住；认出是哪个角色靠 `entityId`。
  await prisma.auditLog
    .create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId: null,
        action: "character.deleted",
        entityType: "Character",
        entityId: characterId,
        details: { name: existing.name, ...purged, removedStickerDirs },
      },
    })
    // 审计写不进去不该让删除「报失败」—— 数据其实已经删干净了，报错只会让人重复操作。
    .catch(() => undefined);

  return { id: characterId, name: existing.name, purged, removedStickerDirs };
}
