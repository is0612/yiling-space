/**
 * 记忆回收站的清空动作。
 *
 * 从接口里抽出来只为一件事：这段逻辑（锁行 → 数引用 → 批量删）值得连库测，
 * 而 h3 handler 里的代码没法在测试里直接跑。接口只负责鉴权、取角色、调它。
 */
export type PurgeTrashedMemoriesResult = {
  /** 真删掉了几条。并发有人点「恢复」时可能小于锁住的行数。 */
  deleted: number;
  /** 被保留的历史来源记录数（快照里的来源行只是把 memoryItemId 置空，本身还在）。 */
  preservedSnapshotReferences: number;
};

export async function purgeTrashedMemories(characterId: string): Promise<PurgeTrashedMemoriesResult> {
  const { getPrisma } = await import("./prisma");
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    // 先把这批行锁住：并发有人点单条「恢复」时，锁等待结束后那条已经不是 TRASHED，
    // 下面的 deleteMany 会按最新状态再筛一次，不会把刚恢复的那条一起删掉。
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM memory_items m
      JOIN memory_scopes s ON s.id = m."memoryScopeId"
      WHERE s."characterId" = ${characterId}::uuid AND m.status::text = 'TRASHED'
      FOR UPDATE OF m
    `;
    const ids = locked.map((row) => row.id);
    if (!ids.length) return { deleted: 0, preservedSnapshotReferences: 0 };

    // 先数引用再删：删掉之后 memory_snapshot_sources.memoryItemId 会被置空（onDelete: SetNull），
    // 那些历史来源记录本身仍在，页面要告诉用户保留了多少条。
    const preservedSnapshotReferences = await tx.memorySnapshotSource.count({ where: { memoryItemId: { in: ids } } });
    const result = await tx.memoryItem.deleteMany({ where: { id: { in: ids }, status: "TRASHED" } });
    return { deleted: result.count, preservedSnapshotReferences };
  });
}
