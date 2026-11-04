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
  /** 数据已删除，但磁盘清理未完成；固定安全文案，不包含内部错误。 */
  cleanupWarning?: string;
};

const CLEANUP_WARNING = "角色已删除，但表情包文件清理未完成，请联系管理员处理。";

type DeleteAuditDetails = CharacterDeleteResult["purged"] & {
  name: string;
  removedStickerDirs: boolean;
  cleanupWarning?: string;
};
type DeleteAuditData = {
  actorType: "USER";
  actorId: string;
  characterId: null;
  action: string;
  entityType: string;
  entityId: string;
  details: DeleteAuditDetails;
};
type DeleteMany = {
  deleteMany(args: { where: { characterId: string } }): Promise<{ count: number }>;
};
/** 只暴露本操作所需的方法，纯 mock 测试不必构造 Prisma Client 或连接数据库。 */
type CharacterDeleteTransaction = {
  character: {
    findFirst(args: { where: { id: string; ownerId: string } }): Promise<{ name: string } | null>;
    delete(args: { where: { id: string; ownerId: string } }): Promise<unknown>;
  };
  conversation: DeleteMany;
  memoryScope: DeleteMany;
  chatRequest: DeleteMany;
  groupActivity: DeleteMany;
  onebotGroupAnnouncement: DeleteMany;
  auditLog: { create(args: { data: DeleteAuditData }): Promise<{ id: string }> };
};
type CharacterDeleteDatabase = {
  $transaction<T>(run: (tx: CharacterDeleteTransaction) => Promise<T>): Promise<T>;
  auditLog: {
    update(args: { where: { id: string }; data: { details: DeleteAuditDetails } }): Promise<unknown>;
  };
};
type StickerDirectoryDependencies = {
  stat(target: string): Promise<unknown>;
  rm(target: string, options: { recursive: true; force: true }): Promise<unknown>;
  invalidate(characterId: string): void;
};
const stickerDirectoryDependencies: StickerDirectoryDependencies = {
  stat: (target) => fs.stat(target),
  rm: (target, options) => fs.rm(target, options),
  invalidate: invalidateStickerCache,
};
type CharacterDeleteDependencies = {
  prisma?: CharacterDeleteDatabase;
  stickerDirectories?: StickerDirectoryDependencies;
  warn?: (message: string, metadata: { characterId: string; stage: "sticker-cleanup" | "audit-cleanup-update" }) => void;
};

function warnSafely(
  warn: NonNullable<CharacterDeleteDependencies["warn"]>,
  characterId: string,
  stage: "sticker-cleanup" | "audit-cleanup-update",
) {
  // 不记录原始异常、角色名、路径或凭据。日志设施自身失败也不能让已提交的删除报错。
  try {
    warn("[character-delete] 角色删除后的收尾未完成", {
      characterId: /^[0-9a-f-]{36}$/i.test(characterId) ? characterId : "invalid",
      stage,
    });
  } catch { /* best effort */ }
}

/**
 * 删角色表情包的整个目录。
 *
 * 单张删除走 `deleteStickerFile`，那是给「删掉这一张」用的；角色都没了，
 * 留着目录等于每次换角色都往 `.data/stickers` 里留一份垃圾。
 *
 * 目录名取自库里存的 characterId（服务端生成的 uuid），但还是过一遍 uuid 形状校验 ——
 * 这个函数会 `rm -rf`，路径里混进 `..` 就是灾难。
 */
export async function removeCharacterStickerDirs(
  characterId: string,
  dependencies: StickerDirectoryDependencies = stickerDirectoryDependencies,
): Promise<boolean> {
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
  try {
    for (const target of targets) {
      const existed = await dependencies.stat(target).then(() => true).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
        throw error;
      });
      if (!existed) continue;
      await dependencies.rm(target, { recursive: true, force: true });
      removed = true;
    }
    return removed;
  } finally {
    // 即使 stat / rm 失败，已删角色的目录清单也不得继续命中缓存。
    dependencies.invalidate(characterId);
  }
}

export async function deleteCharacterCompletely(options: {
  characterId: string;
  ownerId: string;
}, dependencies: CharacterDeleteDependencies = {}): Promise<CharacterDeleteResult | null> {
  const prisma: CharacterDeleteDatabase = dependencies.prisma ?? getPrisma();
  const warn = dependencies.warn ?? console.warn;
  const { characterId, ownerId } = options;

  const deleted = await prisma.$transaction(async (tx) => {
    // 所有权检查与删除在同一事务内，最终 delete 也带 ownerId 防止所有权变化。
    const existing = await tx.character.findFirst({ where: { id: characterId, ownerId } });
    if (!existing) return null;
    // 1. Restrict 的两张必须先删，否则第 5 步删角色会被外键挡住
    await tx.conversation.deleteMany({ where: { characterId } });
    await tx.memoryScope.deleteMany({ where: { characterId } });
    // 2. 没有外键的三张手动删
    const chatRequests = await tx.chatRequest.deleteMany({ where: { characterId } });
    const groupActivities = await tx.groupActivity.deleteMany({ where: { characterId } });
    const announcements = await tx.onebotGroupAnnouncement.deleteMany({ where: { characterId } });
    // 3. 剩下的交给 cascade / SetNull
    await tx.character.delete({ where: { id: characterId, ownerId } });
    const purged = {
      chatRequests: chatRequests.count,
      groupActivities: groupActivities.count,
      announcements: announcements.count,
    };
    // 核心审计必须和删除一起提交；失败直接抛出，事务回滚且不触碰磁盘。
    // characterId 已无对应角色行，置 null，靠 entityId 保留目标身份。
    const audit = await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId: null,
        action: "character.deleted",
        entityType: "Character",
        entityId: characterId,
        details: { name: existing.name, ...purged, removedStickerDirs: false },
      },
    });
    return { name: existing.name, purged, auditId: audit.id };
  });
  if (!deleted) return null;

  let removedStickerDirs = false;
  let cleanupWarning: string | undefined;
  try {
    removedStickerDirs = await removeCharacterStickerDirs(characterId, dependencies.stickerDirectories);
  } catch {
    // 可能已有一个目录删掉；只要没全部完成就保守返回 false，不能把已提交的删除变成 500。
    cleanupWarning = CLEANUP_WARNING;
    warnSafely(warn, characterId, "sticker-cleanup");
  }

  // 兼容成功路径的审计详情：这里只补充磁盘结果，绝不能取代事务内的核心审计。
  try {
    await prisma.auditLog.update({
      where: { id: deleted.auditId },
      data: {
        details: {
          name: deleted.name,
          ...deleted.purged,
          removedStickerDirs,
          ...(cleanupWarning ? { cleanupWarning } : {}),
        },
      },
    });
  } catch {
    warnSafely(warn, characterId, "audit-cleanup-update");
  }

  return {
    id: characterId,
    name: deleted.name,
    purged: deleted.purged,
    removedStickerDirs,
    ...(cleanupWarning ? { cleanupWarning } : {}),
  };
}
