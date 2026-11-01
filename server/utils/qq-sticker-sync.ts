/**
 * 表情包 ⇄ QQ 收藏夹的双向同步。
 *
 * 目标是一句话：**两边是同一批表情，一边改了另一边跟着变，一边删了另一边也没了。**
 *
 * 拆成两步，第二步才是重点：
 *   1. `planStickerSync()` —— 纯函数。拿「本地所有行（含回收站）」和「QQ 收藏列表」对账，
 *      输出一份「要做什么」的清单。不碰网络、不碰库，所以每种分支都能单测。
 *   2. `syncStickersWithQq()` —— 按清单执行。慢操作（下载图、上传图、删 QQ）都在这里。
 *
 * 匹配顺序（先严后松）：
 *   - `qqEmojiId` 相等 → 就是同一张，什么都不用做；
 *   - `qqMd5` 相等 → 同一张图但 QQ 里 id 换了（删了又加），只回填 id，**不重新导入**，
 *     否则本地辛苦打的标签会被一张「新图」顶掉；
 *   - 都没有 → 本地有就推上去，QQ 有就导下来。
 *
 * 几条刻意为之的取舍：
 *   - **拉不到列表 ≠ 全被删了**。QQ 收藏这次回 0 条、而本地还有一堆挂着的，
 *     不做任何删除也不推新（见 `qqEmptySafety`）——否则一次网关抖动就把几十张图的标签清空。
 *   - **删除一律软删**。QQ 那边一删，本地的标签跟着没了就白打了；进回收站还能捞回来。
 *   - **导入不调模型**。一次可能导几十张，逐张打标等于一次同步烧掉几十次视觉请求。
 *     导入只带 QQ 的备注当名字，打标交给页面上的「补标签」（用户点一次才花钱）。
 */

import { createHash } from "node:crypto";
import type { OnebotConnectionConfig } from "./channel-adapter/onebot/client";
import { loadOnebotConnections } from "./channel-adapter/onebot/configure";
import { downloadImage } from "./image-understanding";
import { getPrisma } from "./prisma";
import {
  QqCustomFaceError,
  addQqCustomFace,
  deleteQqCustomFace,
  fetchQqCustomFaces,
  md5FromEmojiId,
  modifyQqCustomFaceDesc,
  type QqCustomFace,
} from "./qq-custom-face";
import { normalizeStickerImage } from "./sticker-image";
import {
  MAX_STICKER_BYTES,
  deleteStickerFile,
  invalidateStickerCache,
  readStickerFile,
  resolveStickerExtension,
  saveStickerFile,
} from "./stickers";

/** 一次同步最多导几张。导一张 = 一次下载 + 一次缩图，几十张已经要十几秒。 */
export const MAX_IMPORT_PER_RUN = 60;
/** 一次同步最多推几张。每张都要等 QQ 那边回一个 emoji_id。 */
export const MAX_PUSH_PER_RUN = 30;
/**
 * 一次同步最多回写多少个备注。
 *
 * 改备注是一次一个 HTTP 调用，几十张一起写会让「同步」按钮卡上半分钟。
 * 而且名字本来就不常变，分批写完就行 —— 这一条主要是给「重新识别」批量打标之后补漂移用的。
 */
export const MAX_NAME_SYNC_PER_RUN = 20;

/** 从 QQ 收藏同步下来的行的来源标记。 */
export const QQ_STICKER_SOURCE = "qq";
/** QQ 里没备注的表情导进来叫这个名字 —— 一眼能看出「这张还没打标」。 */
export const UNTITLED_STICKER_NAME = "未命名表情";

export type SyncLocalRow = {
  id: string;
  name: string;
  qqEmojiId: string | null;
  qqMd5: string | null;
  deletedAt: Date | null;
  deletedReason: string | null;
  enabled: boolean;
};

export type StickerSyncPlan = {
  /** 要新导下来的 QQ 表情。 */
  importFaces: QqCustomFace[];
  /** 超出本次导入上限、留到下次的条数。 */
  importOverflow: number;
  /** id 变了但还是同一张图：只回填 emoji_id / md5。 */
  rebind: Array<{ id: string; emojiId: string; md5: string }>;
  /** QQ 那边没了：本地进回收站。 */
  trashLocal: Array<{ id: string; name: string }>;
  /** 本地删过、QQ 还在：补删一次，把两边收敛到「都没有」。 */
  retryDelete: string[];
  /** 回收站里那张又在 QQ 上出现了（自己加回去的）：恢复，标签还在。 */
  restoreFromTrash: Array<{ id: string }>;
  /** 本地有、QQ 没有：推上去。 */
  push: Array<{ id: string; name: string }>;
  /** 超出本次推送上限的条数。 */
  pushOverflow: number;
  /** 名字和 QQ 备注对不上：把本地的名字写过去（本地为准）。 */
  syncName: Array<{ emojiId: string; name: string; previous: string }>;
};

/**
 * 对账。纯函数 —— 不读库、不走网络，`random` 之类的依赖也没有，同样的输入永远同样的输出。
 *
 * 这里最怕的是「误删」和「重复导入」，所以两个方向都设了兜底：
 * 已经属于回收站行的 emoji_id 不会被重复导入（否则撞唯一约束），
 * 已经被某张在用的行认领的表情也不会被再导一份。
 */
export function planStickerSync(input: {
  local: readonly SyncLocalRow[];
  faces: readonly QqCustomFace[];
  importLimit?: number;
  pushLimit?: number;
  nameSyncLimit?: number;
}): StickerSyncPlan {
  const importLimit = input.importLimit ?? MAX_IMPORT_PER_RUN;
  const pushLimit = input.pushLimit ?? MAX_PUSH_PER_RUN;
  const nameSyncLimit = input.nameSyncLimit ?? MAX_NAME_SYNC_PER_RUN;

  const faceByEmoji = new Map<string, QqCustomFace>();
  const faceByMd5 = new Map<string, QqCustomFace>();
  for (const face of input.faces) {
    faceByEmoji.set(face.emojiId, face);
    if (face.md5 && !faceByMd5.has(face.md5)) faceByMd5.set(face.md5, face);
  }

  /** 已被认领的表情（按 id 和 md5 各记一份，避免同一张被算两次）。 */
  const claimedEmoji = new Set<string>();
  const claimedMd5 = new Set<string>();
  const claim = (face: QqCustomFace): void => {
    claimedEmoji.add(face.emojiId);
    if (face.md5) claimedMd5.add(face.md5);
  };

  const plan: StickerSyncPlan = {
    importFaces: [],
    importOverflow: 0,
    rebind: [],
    trashLocal: [],
    retryDelete: [],
    restoreFromTrash: [],
    push: [],
    pushOverflow: 0,
    syncName: [],
  };

  const active = input.local.filter((row) => !row.deletedAt);
  const trashed = input.local.filter((row) => row.deletedAt);

  // 1. 回收站里的：分两种。
  //    local（用户在本地删的）→ QQ 还在就补删，意图是「两边都不要」；
  //    qq（QQ 那边先没的）→ 现在又出现了，说明用户自己加回去了，恢复原来的行（标签还在）。
  for (const row of trashed) {
    if (!row.qqEmojiId) continue;
    const face = faceByEmoji.get(row.qqEmojiId);
    if (!face) continue;
    if (row.deletedReason === "local") {
      plan.retryDelete.push(face.emojiId);
    } else {
      plan.restoreFromTrash.push({ id: row.id });
    }
    claim(face);
  }

  // 2. 在用的：一条条对着 QQ 现状决定「留 / 改绑 / 进回收站 / 推上去」。
  for (const row of active) {
    const byId = row.qqEmojiId ? faceByEmoji.get(row.qqEmojiId) : undefined;
    if (byId) {
      claim(byId);
      continue;
    }

    // emoji_id 对不上（或本来就没有）：再用内容指纹认一次。
    const byMd5 = row.qqMd5 ? faceByMd5.get(row.qqMd5) : undefined;
    if (byMd5 && !claimedEmoji.has(byMd5.emojiId) && !(byMd5.md5 && claimedMd5.has(byMd5.md5))) {
      claim(byMd5);
      plan.rebind.push({ id: row.id, emojiId: byMd5.emojiId, md5: byMd5.md5 || (row.qqMd5 ?? "") });
      continue;
    }

    if (row.qqEmojiId) {
      // 有 id、QQ 里查不到、内容指纹也对不上 —— 只在一种情况下成立：QQ 那边真删了。
      plan.trashLocal.push({ id: row.id, name: row.name });
      continue;
    }

    // 从来没同步过：推上去。停用的不推 —— 停用是「暂时别用」，不是「也别收藏」。
    if (!row.enabled) continue;
    if (plan.push.length >= pushLimit) {
      plan.pushOverflow += 1;
      continue;
    }
    plan.push.push({ id: row.id, name: row.name });
  }

  // 3. 名字对不上的，把本地的名字写回 QQ 备注。
  //    单独一遍是因为改绑的行也要算（它们此刻的 qqEmojiId 还是旧值）。
  //    空备注 + 「未命名表情」算一致：那是我们没打标，不该把这个占位名写进 QQ。
  const rebindByRow = new Map(plan.rebind.map((item) => [item.id, item.emojiId]));
  for (const row of active) {
    if (plan.syncName.length >= nameSyncLimit) break;
    const emojiId = rebindByRow.get(row.id) ?? row.qqEmojiId;
    if (!emojiId) continue;
    const face = faceByEmoji.get(emojiId);
    if (!face) continue;
    if (face.desc === row.name) continue;
    if (!face.desc && row.name === UNTITLED_STICKER_NAME) continue;
    plan.syncName.push({ emojiId, name: row.name, previous: face.desc });
  }

  // 4. 剩下的 QQ 表情 = QQ 有、本地没有 → 导下来。
  for (const face of input.faces) {
    if (claimedEmoji.has(face.emojiId)) continue;
    if (face.md5 && claimedMd5.has(face.md5)) continue;
    if (plan.importFaces.length >= importLimit) {
      plan.importOverflow += 1;
      continue;
    }
    claim(face);
    plan.importFaces.push(face);
  }

  return plan;
}

/**
 * 起一个不重名的名字。
 *
 * QQ 备注通常是空的，一次导入几十张全叫「未命名表情」的话，页面上一排分不清谁是谁，
 * 提示词里模型也只会看到几十个一样的词。撞名时补个序号，至少能指着说「第 3 张」。
 */
export function uniqueStickerName(base: string, taken: ReadonlySet<string>): string {
  const trimmed = String(base ?? "").trim().slice(0, 60) || UNTITLED_STICKER_NAME;
  if (!taken.has(trimmed)) return trimmed;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${trimmed.slice(0, 55)} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${trimmed.slice(0, 50)} ${Date.now().toString(36)}`;
}

export type StickerSyncReport = {
  ok: boolean;
  connectionId: string;
  /** QQ 收藏夹这次拉到多少条。 */
  qqTotal: number;
  /** 本地一共多少行（含回收站）。 */
  localTotal: number;
  imported: number;
  /** 导下来时发现本地已有同一张图，改成把 QQ 的 id 绑上去（不重复存图）。 */
  adopted: number;
  importedFailed: number;
  rebound: number;
  restored: number;
  trashed: number;
  retriedDelete: number;
  retryDeleteFailed: number;
  pushed: number;
  pushFailed: number;
  pushMissingFile: number;
  /** 把本地名字写进 QQ 备注的条数。 */
  namesSynced: number;
  nameSyncFailed: number;
  importOverflow: number;
  pushOverflow: number;
  /** 说明性提示（安全阀触发、部分失败等）。非空时页面要按警告展示。 */
  warnings: string[];
};

/**
 * 找到这个角色绑的那个 QQ 连接。
 *
 * 一个角色理论上可以绑多个小号，但表情收藏是「号」级别的 —— 收藏夹里那张图属于哪个号，
 * 同步就该跟着那个号。多绑定时取第一个（绑定顺序），并在页面上说明只同步这一个号。
 */
export async function resolveStickerConnection(
  characterId: string,
): Promise<{ connectionId: string; config: OnebotConnectionConfig } | null> {
  const connections = await loadOnebotConnections();
  for (const connection of connections) {
    if (connection.bindings.some((binding) => binding.characterId === characterId)) {
      return { connectionId: connection.id, config: connection.config };
    }
  }
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof QqCustomFaceError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 跑一次完整同步。抛错的只有「连不上 / 网关不支持 / 参数不对」这几种 —— 单张图的失败只记账。
 */
export async function syncStickersWithQq(input: {
  characterId: string;
  /** 仅测试用：直接给定连接，跳过「从绑定里找 QQ 号」（DB 测试不该真建一个平台连接）。 */
  connection?: { connectionId: string; config: OnebotConnectionConfig };
  /** 仅测试用：换掉真实的 QQ 调用与图片下载。 */
  qq?: {
    fetchFaces: (config: OnebotConnectionConfig) => Promise<QqCustomFace[]>;
    addFace: (config: OnebotConnectionConfig, image: Buffer) => Promise<string>;
    deleteFace: (config: OnebotConnectionConfig, emojiId: string) => Promise<void>;
    modifyDesc: (config: OnebotConnectionConfig, emojiId: string, desc: string) => Promise<void>;
  };
  download?: (url: string) => Promise<{ buffer: Buffer; mime: string }>;
  now?: Date;
}): Promise<StickerSyncReport> {
  const prisma = getPrisma();
  const resolved = input.connection ?? (await resolveStickerConnection(input.characterId));
  if (!resolved) {
    throw new QqCustomFaceError("fetch_custom_face_detail", "这个角色还没绑 QQ 号，没法同步收藏表情。", null);
  }
  const { connectionId, config } = resolved;
  const qq = {
    fetchFaces: input.qq?.fetchFaces ?? ((cfg) => fetchQqCustomFaces(cfg)),
    addFace: input.qq?.addFace ?? addQqCustomFace,
    deleteFace: input.qq?.deleteFace ?? deleteQqCustomFace,
    modifyDesc: input.qq?.modifyDesc ?? modifyQqCustomFaceDesc,
  };
  const download = input.download ?? downloadImage;
  const now = input.now ?? new Date();

  const faces = await qq.fetchFaces(config);

  const local = await prisma.characterSticker.findMany({
    where: { characterId: input.characterId },
    select: {
      id: true,
      name: true,
      qqEmojiId: true,
      qqMd5: true,
      deletedAt: true,
      deletedReason: true,
      enabled: true,
      fileName: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const report: StickerSyncReport = {
    ok: true,
    connectionId,
    qqTotal: faces.length,
    localTotal: local.length,
    imported: 0,
    adopted: 0,
    importedFailed: 0,
    rebound: 0,
    restored: 0,
    trashed: 0,
    retriedDelete: 0,
    retryDeleteFailed: 0,
    pushed: 0,
    pushFailed: 0,
    pushMissingFile: 0,
    namesSynced: 0,
    nameSyncFailed: 0,
    importOverflow: 0,
    pushOverflow: 0,
    warnings: [],
  };

  /**
   * 安全阀：QQ 回了 0 条，而本地有一堆挂着 emoji_id 的行。
   *
   * 这两种情况在接口层面长得一模一样：「收藏真的被清空了」和「网关没登录 / 接口抽风」。
   * 分不清的时候一律不动 —— 误判成前者会把几十张图连同标签一起扫进回收站，
   * 而误判成后者最多是这次没同步上。
   */
  const linked = local.filter((row) => !row.deletedAt && row.qqEmojiId).length;
  if (!faces.length && linked > 0) {
    return {
      ...report,
      ok: false,
      warnings: [
        `QQ 收藏夹这次拉到 0 条，但本地有 ${linked} 张是从 QQ 同步来的。`
        + "这更像是网关没登录或接口出错，所以这次什么都没动（不删除、不新导、不推送）。",
      ],
    };
  }

  const plan = planStickerSync({
    local: local.map((row) => ({
      id: row.id,
      name: row.name,
      qqEmojiId: row.qqEmojiId,
      qqMd5: row.qqMd5,
      deletedAt: row.deletedAt,
      deletedReason: row.deletedReason,
      enabled: row.enabled,
    })),
    faces,
  });

  // ── 1. 补删：本地删过、QQ 还留着的，删掉 ──────────────
  for (const emojiId of plan.retryDelete) {
    try {
      await qq.deleteFace(config, emojiId);
      report.retriedDelete += 1;
    } catch (error) {
      report.retryDeleteFailed += 1;
      report.warnings.push(`QQ 那边还有一张该删的表情没删掉：${errorText(error)}`);
    }
  }

  // ── 2. 恢复：QQ 里又出现了，把回收站那行捞回来 ─────────
  for (const item of plan.restoreFromTrash) {
    const updated = await prisma.characterSticker.updateMany({
      where: { id: item.id, deletedAt: { not: null } },
      data: { deletedAt: null, deletedReason: null, enabled: true },
    });
    report.restored += updated.count;
  }

  // ── 3. 改绑：图没变、QQ 里 id 变了 ──────────────────
  for (const item of plan.rebind) {
    try {
      await prisma.characterSticker.update({
        where: { id: item.id },
        data: { qqEmojiId: item.emojiId, qqMd5: item.md5 || null },
      });
      report.rebound += 1;
    } catch {
      // 撞唯一约束说明这个 emoji_id 已经被另一行占着（并发同步）。不致命，跳过就好。
      report.warnings.push("有一张表情的 QQ id 回填失败（可能已经被另一条记录占用），下次同步会再试。");
    }
  }

  // ── 4. 改备注：名字以本地为准 ──────────────────────
  // 放在改绑之后，用的是回填后的 emoji_id。失败不逐条报，攒成一个数写在最后。
  for (const item of plan.syncName) {
    try {
      await qq.modifyDesc(config, item.emojiId, item.name);
      report.namesSynced += 1;
    } catch {
      report.nameSyncFailed += 1;
    }
  }

  // ── 5. 导入：QQ 有、本地没有 ────────────────────────
  const takenNames = new Set(local.map((row) => row.name));
  for (const face of plan.importFaces) {
    const outcome = await importOneFace({
      characterId: input.characterId,
      face,
      download,
      takenNames,
    });
    if (outcome === "imported") {
      report.imported += 1;
      continue;
    }
    if (outcome === "adopted") {
      report.adopted += 1;
      continue;
    }
    report.importedFailed += 1;
  }
  report.importOverflow = plan.importOverflow;

  // ── 6. 回收：QQ 那边删了，本地跟着进回收站 ─────────────
  for (const item of plan.trashLocal) {
    const updated = await prisma.characterSticker.updateMany({
      where: { id: item.id, deletedAt: null },
      data: { deletedAt: now, deletedReason: "qq", enabled: false },
    });
    report.trashed += updated.count;
  }

  // ── 7. 推送：本地有、QQ 没有 ────────────────────────
  for (const item of plan.push) {
    const row = await prisma.characterSticker.findFirst({
      where: { id: item.id },
      select: { id: true, name: true, fileName: true, qqEmojiId: true },
    });
    // 前面几步可能已经给这行绑上了 id（导入时的按内容认领），那就没必要再推一份。
    if (!row || row.qqEmojiId) continue;

    const image = await readStickerFile(input.characterId, row.fileName);
    if (!image) {
      report.pushMissingFile += 1;
      continue;
    }
    try {
      const emojiId = await qq.addFace(config, image);
      await prisma.characterSticker.update({
        where: { id: row.id },
        data: { qqEmojiId: emojiId, qqMd5: md5FromEmojiId(emojiId) || null },
      });
      report.pushed += 1;
      // 备注写失败不影响收藏本身，只是 QQ 里那张没名字，不值得打断整轮同步。
      await qq.modifyDesc(config, emojiId, row.name).catch(() => undefined);
    } catch (error) {
      report.pushFailed += 1;
      report.warnings.push(`「${row.name}」没能收藏到 QQ：${errorText(error)}`);
    }
  }
  report.pushOverflow = plan.pushOverflow;

  if (report.importedFailed) {
    report.warnings.push(`${report.importedFailed} 张 QQ 表情没能导进来（图下载失败或格式不支持），下次同步会再试。`);
  }
  if (report.nameSyncFailed) {
    report.warnings.push(`有 ${report.nameSyncFailed} 张表情的名字没写进 QQ 备注，下次同步会再写一次。`);
  }
  if (report.pushOverflow) {
    report.warnings.push(`还有 ${report.pushOverflow} 张本地表情没推到 QQ，点一次同步推一批。`);
  }
  if (report.importOverflow) {
    report.warnings.push(`还有 ${report.importOverflow} 张 QQ 表情没导完，点一次同步导一批。`);
  }

  invalidateStickerCache(input.characterId);
  return report;
}

type ImportOutcome = "imported" | "adopted" | "failed";/**
 * 导入一张。
 *
 * 「按内容认领」这一步是为了不重复存图：用户先在本地传了一张，又在 QQ 里手动收藏了同一张，
 * 对账时只会看到「本地有一张没推过的」+「QQ 有一张没导过的」。真按那个结果做，
 * 本地会多一张一样的图、QQ 也会多一张。所以导之前先算内容哈希，
 * 本地已有同图就把 QQ 的 id 绑上去（`adopted`），图不重复下载存盘。
 */
async function importOneFace(input: {
  characterId: string;
  face: QqCustomFace;
  download: (url: string) => Promise<{ buffer: Buffer; mime: string }>;
  takenNames: Set<string>;
}): Promise<ImportOutcome> {
  const prisma = getPrisma();
  const { characterId, face } = input;

  let image: { buffer: Buffer; mime: string };
  try {
    image = await input.download(face.url);
  } catch {
    // qpic 的直链带时效（rkey 过期就 403），失败就当这次没导，下次同步换新链接。
    return "failed";
  }

  const extension = resolveStickerExtension(image.mime);
  if (!extension) return "failed";

  const normalized = await normalizeStickerImage(image.buffer, image.mime);
  const stored = normalized?.resized ? normalized.buffer : image.buffer;
  if (stored.length > MAX_STICKER_BYTES) return "failed";

  const contentHash = createHash("sha256").update(stored).digest("hex");
  const sameContent = await prisma.characterSticker.findFirst({
    where: { characterId, contentHash, deletedAt: null },
    select: { id: true, qqEmojiId: true },
  });
  if (sameContent) {
    if (sameContent.qqEmojiId) return "failed";
    try {
      await prisma.characterSticker.update({
        where: { id: sameContent.id },
        data: { qqEmojiId: face.emojiId, qqMd5: face.md5 || null },
      });
      return "adopted";
    } catch {
      return "failed";
    }
  }

  const name = uniqueStickerName(face.desc, input.takenNames);
  input.takenNames.add(name);

  const fileName = await saveStickerFile(characterId, extension, stored);
  try {
    await prisma.characterSticker.create({
      data: {
        characterId,
        name,
        // 使用场景留空：这是给用户补的，自动填一句似是而非的话反而更难改。
        usage: "",
        fileName,
        mimeType: normalized?.mimeType || image.mime,
        sizeBytes: stored.length,
        contentHash,
        source: QQ_STICKER_SOURCE,
        qqEmojiId: face.emojiId,
        qqMd5: face.md5 || null,
      },
    });
    return "imported";
  } catch {
    // 撞唯一约束（同一个 emoji_id 并发导入两次）或别的写失败：把刚落盘的文件删掉，不留孤儿。
    await deleteStickerFile(characterId, fileName);
    return "failed";
  }
}

/**
 * 单张级别的三个操作：上传时顺手收藏、改名时回写备注、删除时连 QQ 一起删。
 *
 * 都不抛错，返回 `{ ok, error }` —— 这三个动作都是「主流程的附带动作」：
 * QQ 那边没连上不该让「在本地加一张表情」或「改个名字」直接失败。
 * 失败的信息交给页面提示，用户自己决定要不要点一次同步补上。
 */
export type QqSideEffectResult = {
  ok: boolean;
  emojiId?: string;
  error?: string;
  /** 这个角色根本没绑 QQ 号 —— 不是失败，页面不必为它弹警告。 */
  skipped?: boolean;
};

/** 把本地这张推到 QQ 收藏夹，成功后把 emoji_id 绑到行上。 */
export async function pushStickerToQq(characterId: string, stickerId: string): Promise<QqSideEffectResult> {
  const prisma = getPrisma();
  const row = await prisma.characterSticker.findFirst({
    where: { id: stickerId, characterId },
    select: { id: true, name: true, fileName: true, qqEmojiId: true },
  });
  if (!row) return { ok: false, error: "表情包不存在。" };
  if (row.qqEmojiId) return { ok: true, emojiId: row.qqEmojiId };

  const resolved = await resolveStickerConnection(characterId).catch(() => null);
  if (!resolved) return { ok: false, skipped: true, error: "这个角色还没绑 QQ 号。" };

  const image = await readStickerFile(characterId, row.fileName);
  if (!image) return { ok: false, error: "本地没有这张图的原文件，删掉重传一次吧。" };

  try {
    const emojiId = await addQqCustomFace(resolved.config, image);
    await prisma.characterSticker.update({
      where: { id: row.id },
      data: { qqEmojiId: emojiId, qqMd5: md5FromEmojiId(emojiId) || null },
    });
    invalidateStickerCache(characterId);
    await modifyQqCustomFaceDesc(resolved.config, emojiId, row.name).catch(() => undefined);
    return { ok: true, emojiId };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** 把本地的名字写成 QQ 里那张的备注，两边看着才是同一批。 */
export async function writeStickerNameToQq(
  characterId: string,
  qqEmojiId: string,
  name: string,
): Promise<QqSideEffectResult> {
  const resolved = await resolveStickerConnection(characterId).catch(() => null);
  if (!resolved) return { ok: false, skipped: true, error: "这个角色还没绑 QQ 号。" };
  try {
    await modifyQqCustomFaceDesc(resolved.config, qqEmojiId, name);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** 从 QQ 收藏里删掉对应那张。本地已经软删了，这一步只是让两边收敛。 */
export async function deleteStickerOnQq(
  characterId: string,
  qqEmojiId: string,
): Promise<QqSideEffectResult> {
  const resolved = await resolveStickerConnection(characterId).catch(() => null);
  if (!resolved) return { ok: false, error: "这个角色还没绑 QQ 号。" };
  try {
    await deleteQqCustomFace(resolved.config, qqEmojiId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
