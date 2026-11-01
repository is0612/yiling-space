import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { OnebotConnectionConfig } from "../server/utils/channel-adapter/onebot/client";
import { md5FromEmojiId, type QqCustomFace } from "../server/utils/qq-custom-face";
import { syncStickersWithQq } from "../server/utils/qq-sticker-sync";
import { saveStickerFile, stickerCharacterDir } from "../server/utils/stickers";

/**
 * 双向同步的落库端到端（不连 QQ、不下载图）。
 *
 * 纯函数那半边（`test-qq-sticker-sync.ts`）管「该做什么」，这里管「真做下去对不对」：
 * 唯一约束会不会撞、软删的字段写没写、按内容认领是不是真的没多存一张图、安全阀有没有真的拦住。
 * QQ 调用与图片下载都注入假实现 —— 真机链路要一个小号并且会改账号数据，不适合进 verify:local。
 *
 * **自己造一个临时角色**（不拿库里现成的）：现成的角色可能已经有几十张表情，
 * 第一次同步会把它们全推到（假的）QQ 上，第二次就全成了「QQ 里没有」→ 断言全是噪声。
 */

const { getPrisma } = await import("../server/utils/prisma");
const prisma = getPrisma();

const owner = await prisma.user.findFirst({ select: { id: true } });
if (!owner) {
  console.log("（无用户，跳过落库端到端）qq-sticker-sync-db：跳过");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

const temp = await prisma.character.create({
  data: { ownerId: owner.id, name: "同步测试-临时角色", basePrompt: "" },
  select: { id: true },
});
const characterId = temp.id;

const connection = {
  connectionId: "00000000-0000-0000-0000-0000000000aa",
  config: { wsUrl: "ws://127.0.0.1:0", httpUrl: "http://127.0.0.1:0" } satisfies OnebotConnectionConfig,
};

/** 一张「图」：内容随便，但每张必须不同 —— 相同内容会被 contentHash 认领掉。 */
function imageBytes(seed: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([seed, seed, seed])]);
}

const md5 = (n: number) => n.toString(16).padStart(32, "0");
const emojiIdOf = (n: number) => `10001_0_0_0_${md5(n)}_0_0`;

function faceOf(n: number, desc = ""): QqCustomFace {
  const emojiId = emojiIdOf(n);
  return { emojiId, md5: md5FromEmojiId(emojiId), url: `https://p.qpic.cn/fake/${n}`, desc };
}

/** 假的 QQ 侧：把每次调用都记下来，断言「真的调了 / 真的没调」。 */
function makeQq(faces: QqCustomFace[], images: Map<string, Buffer>) {
  const deleted: string[] = [];
  const added: Buffer[] = [];
  const descs: Array<{ emojiId: string; desc: string }> = [];
  return {
    deleted,
    added,
    descs,
    fake: {
      fetchFaces: async () => faces,
      addFace: async (_config, image: Buffer) => {
        added.push(image);
        return emojiIdOf(900 + added.length);
      },
      deleteFace: async (_config, emojiId: string) => {
        deleted.push(emojiId);
      },
      modifyDesc: async (_config, emojiId: string, desc: string) => {
        descs.push({ emojiId, desc });
      },
    },
    download: async (url: string) => {
      const seed = Number(url.split("/").pop());
      const buffer = images.get(url) ?? imageBytes(seed);
      return { buffer, mime: "image/png" };
    },
  };
}

async function rowsOf() {
  return prisma.characterSticker.findMany({
    where: { characterId },
    select: {
      id: true,
      name: true,
      fileName: true,
      source: true,
      qqEmojiId: true,
      qqMd5: true,
      deletedAt: true,
      deletedReason: true,
      enabled: true,
    },
  });
}

try {
  /* ---------- 1. 导入：QQ 有、本地没有 ---------- */

  {
    const { fake, download } = makeQq([faceOf(1, "委屈"), faceOf(2)], new Map());
    const report = await syncStickersWithQq({
      characterId,
      connection,
      qq: fake,
      download,
    });
    assert.equal(report.ok, true);
    assert.equal(report.imported, 2, "两张新图都要导下来");
    assert.equal(report.qqTotal, 2);

    const fresh = await rowsOf();
    assert.equal(fresh.length, 2, "临时角色一开始是空的，导完就该正好两张");
    assert.equal(fresh[0]!.source, "qq");
    assert.ok(fresh.every((row) => row.qqEmojiId && row.qqMd5), "导入的行必须带上 QQ 身份，否则下次同步又会当成新图");
    const named = fresh.find((row) => row.qqEmojiId === emojiIdOf(1));
    assert.equal(named?.name, "委屈", "QQ 备注直接当名字");
    const untitled = fresh.find((row) => row.qqEmojiId === emojiIdOf(2));
    assert.equal(untitled?.name, "未命名表情", "QQ 没备注就用占位名，别造一个假场景");
  }

  /* ---------- 2. 再跑一次：不该有任何动作 ---------- */

  {
    const { fake, download } = makeQq([faceOf(1, "委屈"), faceOf(2)], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.imported, 0, "已经在库里的不该再导一遍");
    assert.equal(report.pushed, 0);
    assert.equal(report.trashed, 0, "两边都在，不能被判定成「QQ 删了」");
    assert.equal(report.adopted, 0);
  }

  /* ---------- 3. 按内容认领：本地已有同一张图，不重复存 ---------- */

  {
    // 手动传过一张「本地图」，QQ 里也收藏了同一张（不同 id、不同备注）。
    const bytes = imageBytes(77);
    const fileName = await saveStickerFile(characterId, "png", bytes);
    const localRow = await prisma.characterSticker.create({
      data: {
        characterId,
        name: "本地起的名",
        usage: "",
        fileName,
        mimeType: "image/png",
        sizeBytes: bytes.length,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        source: "manual",
      },
      select: { id: true },
    });

    const url = "https://p.qpic.cn/fake/77";
    const { fake, download } = makeQq([faceOf(1, "委屈"), faceOf(2), faceOf(77, "重复的")], new Map([[url, bytes]]));
    const before = (await rowsOf()).length;
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });

    assert.equal(report.adopted, 1, "本地已有同图就该认领，不该再导一份");
    assert.equal((await rowsOf()).length, before, "行数不能变 —— 变了就是存了第二份同样的图");
    const adopted = await prisma.characterSticker.findUnique({ where: { id: localRow.id } });
    assert.equal(adopted?.qqEmojiId, emojiIdOf(77), "认领要把 QQ 的 id 绑到已有的行上");
    assert.equal(adopted?.name, "本地起的名", "认领不改名字 —— 本地打过标的就是对的");
  }

  /* ---------- 4. 安全阀：QQ 回 0 条但本地有一堆挂着的 ---------- */

  {
    const before = await rowsOf();
    const linked = before.filter((row) => row.qqEmojiId && !row.deletedAt).length;
    assert.ok(linked > 0, "前面几步应该已经造出挂着 QQ id 的行");

    const { fake, download } = makeQq([], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.ok, false, "这种结果必须报「没同步」，不能当成功");
    assert.equal(report.warnings.length, 1);
    assert.equal(report.trashed, 0, "空列表绝不能当成「全被删了」");
    assert.equal(report.imported, 0);
    assert.equal(report.pushed, 0, "也不该趁机把本地那些推上去（可能是网关没登录）");

    const after = await rowsOf();
    assert.equal(after.filter((row) => !row.deletedAt).length, before.filter((row) => !row.deletedAt).length);
  }

  /* ---------- 5. QQ 那边删了 → 本地进回收站 ---------- */

  {
    const all = await rowsOf();
    const linkedRows = all.filter((row) => row.qqEmojiId && !row.deletedAt);
    assert.ok(linkedRows.length >= 2, "需要至少两张才能「留一张、删一张」");
    const victim = linkedRows.find((row) => row.qqEmojiId === emojiIdOf(2))!;
    const survivor = linkedRows.find((row) => row.qqEmojiId === emojiIdOf(1))!;

    // 列表非空（不然会触发安全阀），但少了受害的那一张。
    const { fake, download } = makeQq([faceOf(1, "委屈"), faceOf(77, "重复的")], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.trashed, 1);

    const trashed = await prisma.characterSticker.findUnique({ where: { id: victim.id } });
    assert.ok(trashed?.deletedAt, "要软删（进回收站），不能硬删");
    assert.equal(trashed?.deletedReason, "qq", "来源要记清楚：这是 QQ 那边没的，不是用户删的");
    assert.equal(trashed?.enabled, false, "删掉的不该还出现在候选里");

    const kept = await prisma.characterSticker.findUnique({ where: { id: survivor.id } });
    assert.equal(kept?.deletedAt, null, "还在 QQ 里的那张不能被误伤");
  }

  /* ---------- 6. QQ 里又出现了 → 从回收站恢复 ---------- */

  {
    const victim = (await rowsOf()).find((row) => row.qqEmojiId === emojiIdOf(2))!;
    assert.ok(victim.deletedAt, "上一步应该已经把它删掉了");

    const { fake, download } = makeQq([faceOf(1, "委屈"), faceOf(2, "委屈2"), faceOf(77, "重复的")], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.restored, 1, "用户自己在 QQ 里加回来，就该恢复原来那行");

    const restored = await prisma.characterSticker.findUnique({ where: { id: victim.id } });
    assert.equal(restored?.deletedAt, null);
    assert.equal(restored?.enabled, true);
    assert.equal(restored?.name, "未命名表情", "恢复保留原来的名字，不按 QQ 的备注重打");
  }

  /* ---------- 7. 本地删了、QQ 还在 → 补删一次 ---------- */

  {
    const target = (await rowsOf()).find((row) => row.qqEmojiId === emojiIdOf(1))!;
    await prisma.characterSticker.update({
      where: { id: target.id },
      data: { deletedAt: new Date(), deletedReason: "local", enabled: false },
    });

    const { fake, download, deleted } = makeQq([faceOf(1, "委屈"), faceOf(77, "重复的")], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.retriedDelete, 1);
    assert.deepEqual(deleted, [emojiIdOf(1)], "本地删过的那张要在 QQ 上也删掉");
    assert.equal(report.restored, 0, "本地删的不能被「QQ 里还有」给恢复回来");
    assert.equal(report.imported, 0, "更不能当成 QQ 新增再导一份");
  }

  /* ---------- 8. 本地有、QQ 没有 → 推上去 ---------- */

  {
    const bytes = imageBytes(88);
    const fileName = await saveStickerFile(characterId, "png", bytes);
    const localRow = await prisma.characterSticker.create({
      data: {
        characterId,
        name: "要推上去的",
        usage: "",
        fileName,
        mimeType: "image/png",
        sizeBytes: bytes.length,
        source: "manual",
      },
      select: { id: true },
    });

    const { fake, download, added, descs } = makeQq([faceOf(1, "委屈"), faceOf(77, "重复的")], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.pushed, 1);
    assert.equal(added.length, 1);
    assert.ok(
      descs.some((item) => item.emojiId === emojiIdOf(901) && item.desc === "要推上去的"),
      "推上去之后要把名字写成 QQ 备注",
    );
    assert.ok(
      descs.some((item) => item.emojiId === emojiIdOf(77) && item.desc === "本地起的名"),
      "认领过的那张也要把本地名字写过去（QQ 那边原来叫「重复的」）",
    );

    const pushed = await prisma.characterSticker.findUnique({ where: { id: localRow.id } });
    assert.equal(pushed?.qqEmojiId, emojiIdOf(901), "回传的 emoji_id 必须存下来，否则下次同步会再推一份");
    assert.equal(pushed?.qqMd5, md5(901), "md5 从 emoji_id 拆出来，用来认「id 变了还是同一张」");
  }

  /* ---------- 9. 已存在的行不能再推一次 ---------- */

  {
    const { fake, download, added } = makeQq([faceOf(1, "委屈"), faceOf(77, "重复的"), faceOf(901, "要推上去的")], new Map());
    const report = await syncStickersWithQq({ characterId, connection, qq: fake, download });
    assert.equal(report.pushed, 0, "已经有 emoji_id 的不该再推");
    assert.deepEqual(added, []);
  }

  console.log("qq-sticker-sync-db: 全部通过");
} finally {
  // 删角色会连带删表情行（onDelete: Cascade），文件在 `.data/stickers/<临时角色>/` 里，
  // 整个目录删掉即可 —— 这个 id 是刚建出来的，不会碰到别人的图。
  await prisma.character.delete({ where: { id: characterId } }).catch(() => undefined);
  await fs.rm(stickerCharacterDir(characterId), { recursive: true, force: true }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}
