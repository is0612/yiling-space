import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 角色自己的表情包（贴图）。
 *
 * 与 QQ 内置表情（`onebot/faces.ts` 的 face 段）是两回事：内置表情是 QQ 客户端自带的那几十张脸，
 * 谁发都一样；表情包是用户自己存的图，走 `image` 段发出去 —— 这才是「她自己的表情」。
 *
 * 存储约定：
 *   - 图片本体在 `.data/stickers/<characterId>/<uuid>.<ext>`（`.data/` 已在 .gitignore 内）；
 *   - 库里只存清单与文件名，二进制不进数据库（迁移时按目录拷走即可）；
 *   - 文件名一律服务端生成，客户端传来的文件名只用来取扩展名，绝不直接拼路径。
 */

export type StickerCatalogEntry = {
  id: string;
  /** 模型看到的名字。 */
  name: string;
  /** 使用场景，进提示词。 */
  usage: string;
  /** 磁盘绝对路径。只有发送侧需要，不进提示词。 */
  filePath: string;
  /** 已发送次数。用来让没用过的那几张先露面，不进提示词。 */
  useCount?: number;
  /**
   * 对应的 QQ 收藏 id。有值就优先走「收藏表情」通道发（原生表情段），
   * 而不是当成一张普通图片上传 —— 观感和长按菜单都不一样。取不到才退回图片段。
   */
  qqEmojiId?: string | null;
};

/** 允许的图片类型。QQ 的表情包基本是 png / jpg / gif，webp 也收下。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 单张上限 2MB：表情包没有更大的必要，base64 之后还要再涨三分之一。 */
export const MAX_STICKER_BYTES = 2 * 1024 * 1024;

/**
 * 回收站保留天数。
 *
 * 不设定期任务，而是「打开回收站时顺手清掉过期的」—— 回收站是个低频页面，
 * 挂个定时器只为删几张图不划算，而没人打开的时候那些文件也不碍事。
 */
export const STICKER_TRASH_RETENTION_DAYS = 30;

/** 早于这个时间点的回收站条目已经过期。 */
export function trashExpiredBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - STICKER_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 彻底删掉过期的回收站条目：行和文件一起清。
 *
 * 先删行再删文件 —— 反过来一旦中途崩了就是「文件没了、行还在」，
 * 回收站里会出现一张点开是坏图的条目。返回清掉几条，给接口回个数字。
 */
export async function purgeTrashedStickers(characterId: string, before: Date): Promise<number> {
  const { getPrisma } = await import("./prisma");
  const prisma = getPrisma();
  const rows = await prisma.characterSticker.findMany({
    where: { characterId, deletedAt: { not: null, lt: before } },
    select: { id: true, fileName: true },
  });
  if (!rows.length) return 0;
  await prisma.characterSticker.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  for (const row of rows) await deleteStickerFile(characterId, row.fileName);
  invalidateStickerCache(characterId);
  return rows.length;
}

export const STICKER_MIME_TYPES = Object.keys(MIME_EXTENSIONS);

export function stickerRootDir(): string {
  return path.join(process.cwd(), ".data", "stickers");
}

export function stickerCharacterDir(characterId: string): string {
  return path.join(stickerRootDir(), characterId);
}

/**
 * 贴图的绝对路径。文件名必须先过 `safeFileName()` —— 直接拿库里的值拼路径，
 * 一条被改过的记录就能读到目录之外的文件。
 */
export function stickerFilePath(characterId: string, fileName: string): string | null {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  return path.join(stickerCharacterDir(characterId), safe);
}

/** 只放行 `uuid.ext` 这种我们自己生成过的形状。 */
export function safeFileName(fileName: unknown): string | null {
  if (typeof fileName !== "string") return null;
  if (!/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(fileName)) return null;
  return fileName;
}

/** 扩展名 → mime。缩图时要用它告诉 sharp 输出成什么格式（必须与扩展名一致）。 */
export function stickerMimeForExtension(extension: string): string {
  const found = Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension);
  return found ? found[0] : "application/octet-stream";
}

/** 客户端给的 mime / 文件名 → 扩展名。认不出来就返回 null，让调用方报「格式不支持」。 */
export function resolveStickerExtension(mimeType: unknown, originalName?: unknown): string | null {
  if (typeof mimeType === "string" && MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType]!;
  if (typeof originalName === "string") {
    const ext = path.extname(originalName).toLowerCase().slice(1);
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  }
  return null;
}

/** 写一张新贴图，返回生成的文件名。目录按需创建。 */
export async function saveStickerFile(characterId: string, extension: string, data: Buffer): Promise<string> {
  const fileName = `${randomUUID()}.${extension}`;
  const dir = stickerCharacterDir(characterId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), data);
  return fileName;
}

/**
 * 原件备份的落点。`stickers:normalize` 缩图前把原图存到这里（`<角色>/<文件名>`），
 * 好让「再缩一次」永远从原件出发、不在压缩过的图上叠压缩。
 */
export function stickerOriginalsDir(characterId: string): string {
  return path.join(process.cwd(), ".data", "sticker-originals", characterId);
}

export function stickerOriginalFilePath(characterId: string, fileName: string): string | null {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  return path.join(stickerOriginalsDir(characterId), safe);
}

/**
 * 删一张贴图的文件。**连带删原件备份** —— 否则每删一张，`.data/sticker-originals`
 * 就多留一份永远用不到的原图（实测删过的 4 张各留了几百 KB，21MB 的备份目录里一直在涨）。
 * 备份的意义只是「以后换个宽度重缩」，贴纸都没了就没有以后了。
 */
export async function deleteStickerFile(characterId: string, fileName: string): Promise<void> {
  const filePath = stickerFilePath(characterId, fileName);
  if (!filePath) return;
  await fs.rm(filePath, { force: true });
  const original = stickerOriginalFilePath(characterId, fileName);
  if (original) await fs.rm(original, { force: true });
}

/** 读回图片字节。文件没了（换电脑只搬了库）返回 null，让发送侧静默跳过。 */
export async function readStickerFile(characterId: string, fileName: string): Promise<Buffer | null> {
  const filePath = stickerFilePath(characterId, fileName);
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

type StickerRow = {
  id: string;
  characterId: string;
  name: string;
  usage: string;
  fileName: string;
  enabled: boolean;
  useCount?: number;
  qqEmojiId?: string | null;
};

/**
 * 清单缓存：同一个角色的表情包每轮群聊都要读一次，而它几乎不变。
 * 60 秒过期 —— 上传/删除时主动失效，最坏情况也就是一分钟后生效。
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; entries: StickerCatalogEntry[] }>();

/**
 * 清单查询取哪些列。
 *
 * `useCount` 只用于「没用过的先露面」的排序，不进提示词 —— 但它必须在 select 里，
 * 否则挑表情时永远拿不到计数，24 张图里总有 12 张一辈子轮不上。
 */
const STICKER_CATALOG_SELECT = {
  id: true,
  characterId: true,
  name: true,
  usage: true,
  fileName: true,
  enabled: true,
  useCount: true,
  // 发送侧要靠它决定走「收藏表情」还是退成图片段，也必须出现在 select 里 ——
  // 漏了这一列，所有表情都会静默退回图片通道。
  qqEmojiId: true,
} as const;

export function invalidateStickerCache(characterId?: string): void {
  if (characterId) cache.delete(characterId);
  else cache.clear();
}

export function buildStickerCatalog(rows: readonly StickerRow[]): StickerCatalogEntry[] {
  const entries: StickerCatalogEntry[] = [];
  for (const row of rows) {
    const filePath = stickerFilePath(row.characterId, row.fileName);
    if (!filePath) continue;
    entries.push({
      id: row.id,
      name: row.name,
      usage: row.usage,
      filePath,
      useCount: row.useCount ?? 0,
      qqEmojiId: row.qqEmojiId ?? null,
    });
  }
  return entries;
}

/**
 * 取一个角色启用的表情包清单。
 *
 * 传了 `prisma` 就用它（便于测试注入假客户端），不传则取全局客户端 ——
 * 这条路径也会被常驻适配器进程调用，跟 Web 进程是同一个约定。
 */
export async function loadStickerCatalog(
  characterId: string,
  prisma?: { characterSticker: { findMany: (args: { where: { characterId: string; enabled?: boolean; deletedAt?: null }; orderBy?: unknown; select?: unknown }) => Promise<readonly StickerRow[]> } },
): Promise<StickerCatalogEntry[]> {
  const cached = cache.get(characterId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;
  let rows: readonly StickerRow[] = [];
  try {
    rows = await (prisma
      ? prisma.characterSticker.findMany({
          // ⚠️ `deletedAt: null` 不能漏：删掉的表情只是进了回收站，行还在库里，
          // 少了这个条件她会把刚删掉的图继续贴出去。
          where: { characterId, enabled: true, deletedAt: null },
          orderBy: { createdAt: "asc" },
          select: STICKER_CATALOG_SELECT,
        })
      : await defaultStickerQuery(characterId));
  } catch {
    // 表情包不是主流程：库查不动就当没有，不该让整条回复失败。
    rows = [];
  }
  const entries = buildStickerCatalog(rows);
  cache.set(characterId, { at: Date.now(), entries });
  return entries;
}

async function defaultStickerQuery(characterId: string): Promise<readonly StickerRow[]> {
  const { getPrisma } = await import("./prisma");
  return getPrisma().characterSticker.findMany({
    where: { characterId, enabled: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: STICKER_CATALOG_SELECT,
  }) as Promise<readonly StickerRow[]>;
}

export type StickerDto = {
  id: string;
  name: string;
  usage: string;
  enabled: boolean;
  mimeType: string;
  sizeBytes: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  /** 来源：manual 手动上传 / collected 群里自动收的 / qq 从 QQ 收藏夹同步来的。 */
  source: string;
  /** 对应的 QQ 收藏 id。有值 = 这张在 QQ 收藏夹里也有一份，改名字/删除会作用到两边。 */
  qqEmojiId: string | null;
  /** 进回收站的时间。非空 = 已删（列表接口不会返回，只有回收站接口会）。 */
  deletedAt: string | null;
};

/** 给页面的表情包条目。图片本体走 `/image` 接口单独取，不塞进 JSON。 */
export function toStickerDto(row: {
  id: string;
  name: string;
  usage: string;
  enabled: boolean;
  mimeType: string;
  sizeBytes: number;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  source?: string | null;
  qqEmojiId?: string | null;
  deletedAt?: Date | null;
}): StickerDto {
  return {
    id: row.id,
    name: row.name,
    usage: row.usage,
    enabled: row.enabled,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    source: row.source || "manual",
    qqEmojiId: row.qqEmojiId ?? null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/**
 * 挑表情包前先做减法：
 *   1. 上一张刚用过的剔掉 —— 不然十张里有一张「万能笑脸」，她会一直贴那张；
 *   2. 数量封顶 —— 清单进提示词是要花 token 的，30 张图全塞进去，模型反而挑不准；
 *   3. **没用过的排前面，其余打乱** —— 按库里的插入顺序切前 12 张（旧行为），
 *      等于第 13 张以后永远进不了提示词，新收的表情也就永远发不出来。
 *
 * 为什么要打乱而不是按 `useCount` 严格升序：严格升序每次给的还是同一批，
 * 只是换了一批「看起来最不常用」的；打乱才让模型每次都有不同的选择空间。
 * `random` 可注入，测试里用固定序列就能断言顺序。
 */
export function pickStickerCatalog(
  entries: readonly StickerCatalogEntry[],
  lastStickerId?: string | null,
  limit = 12,
  random: () => number = Math.random,
): StickerCatalogEntry[] {
  const usable = entries.filter((entry) => entry.id !== lastStickerId);
  const pool = usable.length ? usable : entries;
  const fresh = pool.filter((entry) => (entry.useCount ?? 0) === 0);
  const used = pool.filter((entry) => (entry.useCount ?? 0) > 0);
  return [...shuffle(fresh, random), ...shuffle(used, random)].slice(0, limit);
}

/** Fisher-Yates。不改原数组：清单对象是缓存里的同一份，就地打乱会让缓存本身变成乱序。 */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = result[index]!;
    result[index] = result[target]!;
    result[target] = current;
  }
  return result;
}
