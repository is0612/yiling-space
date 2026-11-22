import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { getPrisma } from "../server/utils/prisma";
import { purgeTrashedMemories } from "../server/utils/memory-trash";
import { clampPage, normalizeStickerSort, parseStickerListParams, stickerOrderBy, totalPagesOf } from "../server/utils/sticker-list";
import { purgeTrashedStickers, readStickerFile, saveStickerFile, stickerCharacterDir } from "../server/utils/stickers";

/**
 * 表情包分页排序 + 两个回收站的「清空」落库端到端。
 *
 * 纯函数那半边放在 `test-stickers.ts`（参数解析、orderBy 形状）；这里管真下库之后对不对：
 *   - `orderBy` 是不是真被 Postgres 接受（`nulls: "last"` 这种尤其容易只在运行时炸）；
 *   - 清空只清本角色回收站，活跃表情和别的角色一概不碰；
 *   - 收起文件也一并删掉，不留 `.data/stickers/<角色>/` 里的孤儿；
 *   - 记忆清空只删 TRASHED，别的状态不动。
 *
 * 自己建临时角色：拿库里现成的角色会把人家几十张表情一起扫进来，断言全是噪声。
 */

const prisma = getPrisma();
const owner = await prisma.user.findFirst({ select: { id: true } });
if (!owner) {
  console.log("（无用户，跳过落库端到端）sticker-trash-db：跳过");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
const ownerId = owner.id;

const characterIds: string[] = [];

async function makeCharacter(name: string): Promise<string> {
  const row = await prisma.character.create({ data: { ownerId, name, basePrompt: "" }, select: { id: true } });
  characterIds.push(row.id);
  return row.id;
}

type StickerOptions = {
  deletedAt?: Date | null;
  createdAt?: Date;
  useCount?: number;
  lastUsedAt?: Date | null;
  usage?: string;
};

async function makeSticker(characterId: string, name: string, options: StickerOptions = {}) {
  const fileName = await saveStickerFile(characterId, "png", Buffer.from([0x89, 0x50, 0x4e, 0x47, name.length]));
  const row = await prisma.characterSticker.create({
    data: {
      characterId,
      name,
      usage: options.usage ?? "测试场景",
      fileName,
      mimeType: "image/png",
      sizeBytes: 4,
      useCount: options.useCount ?? 0,
      lastUsedAt: options.lastUsedAt ?? null,
      deletedAt: options.deletedAt ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
    select: { id: true, fileName: true },
  });
  return row;
}

const day = 24 * 60 * 60 * 1000;
const now = Date.now();

const activeId = await makeCharacter("分页清空测试-活跃");
const otherId = await makeCharacter("分页清空测试-另一个");

try {
  /* ---------- 1. 参数与页数（纯函数，但和库里的真实数据一起断言更容易读懂） ---------- */

  assert.equal(normalizeStickerSort("mostUsed"), "mostUsed");
  assert.equal(normalizeStickerSort("nonsense"), "recent", "认不出的排序键回默认，不能报错");
  assert.equal(normalizeStickerSort(undefined), "recent");

  const defaults = parseStickerListParams({});
  assert.deepEqual(defaults, { sort: "recent", page: 1, pageSize: 12, untaggedOnly: false });
  assert.equal(parseStickerListParams({ page: "0" }).page, 1, "0 不是合法页码");
  assert.equal(parseStickerListParams({ page: "-3" }).page, 1);
  assert.equal(parseStickerListParams({ page: "abc" }).page, 1);
  assert.equal(parseStickerListParams({ pageSize: "9999" }).pageSize, 100, "pageSize 上限 100");
  assert.equal(parseStickerListParams({ untagged: "1" }).untaggedOnly, true);
  assert.equal(parseStickerListParams({ untagged: "0" }).untaggedOnly, false);

  assert.equal(totalPagesOf(0, 12), 1, "0 条也要算一页，否则页面显示「第 1/0 页」");
  assert.equal(totalPagesOf(13, 12), 2);
  assert.equal(clampPage(5, 2), 2, "删到只剩一页时页码要回夹");
  assert.equal(clampPage(0, 2), 1);

  for (const sort of ["recent", "oldest", "mostUsed", "lastUsed", "fresh"] as const) {
    const terms = stickerOrderBy(sort);
    const last = terms[terms.length - 1] as Record<string, unknown>;
    assert.ok("id" in last, `${sort} 必须用 id 兜底 —— 排序值相等时 Postgres 顺序不定，翻页会重影`);
  }

  /* ---------- 2. 排序真的下库之后对不对 ---------- */

  await makeSticker(activeId, "最早-用过2次", { createdAt: new Date(now - 5 * day), useCount: 2, lastUsedAt: new Date(now - 1 * day) });
  await makeSticker(activeId, "中间-没用过", { createdAt: new Date(now - 3 * day), useCount: 0, lastUsedAt: null });
  await makeSticker(activeId, "最新-用过5次", { createdAt: new Date(now - 1 * day), useCount: 5, lastUsedAt: null });
  await makeSticker(activeId, "次新-用过2次", { createdAt: new Date(now - 2 * day), useCount: 2, lastUsedAt: new Date(now - 2 * day) });

  async function names(sort: Parameters<typeof stickerOrderBy>[0]): Promise<string[]> {
    const rows = await prisma.characterSticker.findMany({
      where: { characterId: activeId, deletedAt: null },
      orderBy: stickerOrderBy(sort),
      select: { name: true },
    });
    return rows.map((row) => row.name);
  }

  assert.deepEqual(await names("recent"), ["最新-用过5次", "次新-用过2次", "中间-没用过", "最早-用过2次"]);
  assert.deepEqual(await names("oldest"), ["最早-用过2次", "中间-没用过", "次新-用过2次", "最新-用过5次"]);
  assert.deepEqual(
    await names("mostUsed"),
    ["最新-用过5次", "次新-用过2次", "最早-用过2次", "中间-没用过"],
    "次数降序，同次数按新到旧",
  );
  assert.deepEqual(
    await names("fresh"),
    ["中间-没用过", "次新-用过2次", "最早-用过2次", "最新-用过5次"],
    "没用过的排最前，其余按次数升序 —— 用得越少越靠前，正是这一档要找的「白占名额」",
  );
  assert.deepEqual(
    await names("lastUsed"),
    ["最早-用过2次", "次新-用过2次", "最新-用过5次", "中间-没用过"],
    "最近用过的在前，从没用过的沉到最后（nulls last）",
  );

  /* ---------- 3. 清空回收站：只清本角色的、只清已删的 ---------- */

  const expired = await makeSticker(activeId, "过期回收站", { deletedAt: new Date(now - 31 * day) });
  const freshTrash = await makeSticker(activeId, "今天删的", { deletedAt: new Date(now - 1 * 60 * 1000) });
  const otherTrash = await makeSticker(otherId, "别的角色的回收站", { deletedAt: new Date(now - 1 * day) });

  // 先只清过期的（打开回收站时的顺手清理），确认「按时间清」和「清空」是两条不同的边界。
  assert.equal(await purgeTrashedStickers(activeId, new Date(now - 30 * day)), 1, "只该清掉超过 30 天的那一条");
  assert.equal(await prisma.characterSticker.count({ where: { characterId: activeId, deletedAt: { not: null } } }), 1);
  assert.equal(await readStickerFile(activeId, expired.fileName), null, "过期那条的文件也要一起删掉");

  assert.equal(await purgeTrashedStickers(activeId), 1, "清空时把剩下那条也清掉");
  assert.equal(await prisma.characterSticker.count({ where: { characterId: activeId, deletedAt: { not: null } } }), 0);
  assert.equal(await readStickerFile(activeId, freshTrash.fileName), null, "清空要连文件一起收走，不留孤儿");
  assert.equal(
    await prisma.characterSticker.count({ where: { characterId: activeId, deletedAt: null } }),
    4,
    "活跃表情一张都不能少",
  );
  assert.equal(
    await prisma.characterSticker.count({ where: { characterId: otherId, deletedAt: { not: null } } }),
    1,
    "别的角色的回收站不能被清空（多角色共用一个库）",
  );
  assert.ok(await readStickerFile(otherId, otherTrash.fileName), "别的角色的图还在");

  assert.equal(await purgeTrashedStickers(activeId), 0, "已经是空的再点一次：0，不报错");

  /* ---------- 4. 记忆回收站清空 ---------- */

  const scope = await prisma.memoryScope.create({
    data: { characterId: activeId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test-trash:${activeId}` },
    select: { id: true },
  });
  const otherScope = await prisma.memoryScope.create({
    data: { characterId: otherId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test-trash:${otherId}` },
    select: { id: true },
  });

  const activeMemory = await prisma.memoryItem.create({
    data: { memoryScopeId: scope.id, category: "FACT", content: "活跃记忆，不该被清掉", status: "ACTIVE" },
    select: { id: true },
  });
  const trashedOne = await prisma.memoryItem.create({
    data: {
      memoryScopeId: scope.id, category: "FACT", content: "回收站一",
      status: "TRASHED", statusBeforeTrash: "ACTIVE", deletedAt: new Date(),
    },
    select: { id: true },
  });
  const trashedTwo = await prisma.memoryItem.create({
    data: {
      memoryScopeId: scope.id, category: "EVENT", content: "回收站二",
      status: "TRASHED", statusBeforeTrash: "SUPERSEDED", deletedAt: new Date(),
    },
    select: { id: true },
  });
  const otherTrashed = await prisma.memoryItem.create({
    data: {
      memoryScopeId: otherScope.id, category: "FACT", content: "别的角色的回收站",
      status: "TRASHED", statusBeforeTrash: "ACTIVE", deletedAt: new Date(),
    },
    select: { id: true },
  });

  const purged = await purgeTrashedMemories(activeId, ownerId);
  assert.equal(purged.deleted, 2, "只清本角色回收站里的两条");
  assert.equal(await prisma.memoryItem.count({ where: { id: activeMemory.id } }), 1, "活跃记忆不能跟着没");
  assert.equal(await prisma.memoryItem.count({ where: { id: { in: [trashedOne.id, trashedTwo.id] } } }), 0);
  assert.equal(await prisma.memoryItem.count({ where: { id: otherTrashed.id } }), 1, "别的角色的回收站不能动");

  const again = await purgeTrashedMemories(activeId, ownerId);
  assert.deepEqual(again, { deleted: 0, preservedSnapshotReferences: 0 }, "空回收站再清一次是 0，不报错");

  console.log("表情包分页与回收站清空（落库）：全部通过");
} finally {
  // 顺序不能反：`MemoryScope.character` 是 onDelete: Restrict，scope 还在就删不掉角色
  // （第一次写这个脚本时就是这样，两个临时角色留在了库里）。
  for (const id of characterIds) {
    const scopes = await prisma.memoryScope.findMany({ where: { characterId: id }, select: { id: true } }).catch(() => []);
    const scopeIds = scopes.map((scope) => scope.id);
    if (scopeIds.length) {
      await prisma.memoryItem.deleteMany({ where: { memoryScopeId: { in: scopeIds } } }).catch(() => undefined);
      await prisma.memoryScope.deleteMany({ where: { id: { in: scopeIds } } }).catch(() => undefined);
    }
    await prisma.character.delete({ where: { id } }).catch(() => undefined);
    await fs.rm(stickerCharacterDir(id), { recursive: true, force: true }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
}
