import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createApp, createRouter, toNodeListener } from "h3";
import { createSession, SESSION_COOKIE_NAME } from "../server/utils/auth";
import { dataPath } from "../server/utils/data-dir";
import { getPrisma } from "../server/utils/prisma";
import {
  readVisualProfileReferences,
  selectSnapshotReferenceAssets,
} from "../server/utils/visual-profile-references";
import { toSnapshotAssets } from "../server/utils/visual-profile-snapshot";

// 路由文件用的是 Nuxt 自动导入的 defineEventHandler / getRouterParam / readBody，
// 静态 import 时拿不到这些全局符号，所以先注入再动态导入（同 test-knowledge-lifecycle-db.ts）。
const h3 = await import("h3");
const globals = globalThis as Record<string, unknown>;
globals.defineEventHandler = (handler: unknown) => handler;
globals.getRouterParam = h3.getRouterParam;
globals.readBody = h3.readBody;
const routeModule = async (path: string) => (await import(path)).default;
const deleteAssetHandler = await routeModule("../server/api/characters/[id]/visual-profile/assets/[assetId].delete");
const publishHandler = await routeModule("../server/api/characters/[id]/visual-profile/publish.post");

/**
 * 参考图删除保护 —— 生图读的是「正式版本快照里选中的素材」，删除保护必须守同一批素材。
 *
 * 守的是一条不变量：**当前正式版本选中的参考图，永远不能变成指的到、读不到**。
 * 于是这里验六件事：
 *   1. 正式版本正在用的素材，删除返回 409，且库里的行、磁盘上的文件、版本快照都没动；
 *   2. 快照里存在但没被选中的素材（同一用途的旧图、非参考用途的图）可以删；
 *   3. 删除只作用于本角色：兄弟角色和别人的角色素材都不受影响；
 *   4. 删除失败不留半截状态（行还在、文件还在）；
 *   5. 发布新版本与删除并发时，正式版本不会留下指向已删文件的引用；
 *   6. 万一某个旧草稿在删除前就记下了那张图，发布后生图会跳过它而不是报错。
 *
 * 全程走真实的 h3 路由与真实的数据库、真实的数据目录；图片字节是合成的小文件。
 * 跑法：yarn test:visual-profile-references-db（需要 DATABASE_URL 与可写 .data）
 */

const prisma = getPrisma();
const ownerId = randomUUID();
const strangerId = randomUUID();
const characterA = randomUUID();
const characterB = randomUUID();
const characterC = randomUUID();
const profileIds: string[] = [];
const characterIds = [characterA, characterB, characterC];
const createdUserIds = [ownerId, strangerId];

const app = createApp();
const router = createRouter();
router.delete("/characters/:id/visual-profile/assets/:assetId", deleteAssetHandler);
router.post("/characters/:id/visual-profile/publish", publishHandler);
app.use(router);
const server = createServer(toNodeListener(app));

const PIXEL = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

type AssetRow = {
  id: string;
  kind: string;
  label: string;
  relativePath: string;
  sortOrder: number;
  createdAt: Date;
};

async function createAsset(
  characterId: string,
  profileId: string,
  kind: "STANDARD" | "FRONT_VIEW" | "SIDE_VIEW" | "BACK_VIEW" | "EXPRESSION",
  label: string,
  createdAt: Date,
  sortOrder = 0,
): Promise<AssetRow> {
  const fileName = `${randomUUID()}.jpg`;
  const relativePath = `visual-profile/${characterId}/${fileName}`;
  const directory = dataPath("visual-profile", characterId);
  await mkdir(directory, { recursive: true });
  await writeFile(dataPath(relativePath), PIXEL, { flag: "wx" });
  const row = await prisma.characterVisualAsset.create({
    data: {
      profileId, kind, label, relativePath, mime: "image/jpeg", sizeBytes: PIXEL.length,
      sortOrder, createdAt,
    },
    select: { id: true, kind: true, label: true, relativePath: true, sortOrder: true, createdAt: true },
  });
  return row;
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    const info = await stat(dataPath(relativePath));
    return info.isFile();
  } catch {
    return false;
  }
}

async function rowExists(assetId: string): Promise<boolean> {
  const row = await prisma.characterVisualAsset.findUnique({ where: { id: assetId }, select: { id: true } });
  return Boolean(row);
}

/** 正式版本快照：只有「选中」的那几张才算被使用。 */
async function publishedSnapshotOf(characterId: string) {
  const profile = await prisma.characterVisualProfile.findUnique({
    where: { characterId },
    select: { id: true, currentPublishedRevision: true },
  });
  assert.ok(profile, "角色必须有形象档案");
  const version = await prisma.characterVisualVersion.findFirst({
    where: { profileId: profile.id, revision: profile.currentPublishedRevision, status: "PUBLISHED" },
    select: { snapshot: true, revision: true },
  });
  assert.ok(version, "currentPublishedRevision 必须指向一个 PUBLISHED 版本");
  return version;
}

let sessionCookie = "";
function cookie(token: string) {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

type Address = { port: number };
let address: Address;

async function deleteAsset(assetId: string, options: { token?: string; characterId?: string } = {}) {
  const response = await fetch(
    `http://127.0.0.1:${address.port}/characters/${options.characterId ?? characterA}/visual-profile/assets/${assetId}`,
    { method: "DELETE", headers: { cookie: options.token ? cookie(options.token) : sessionCookie } },
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function publish(revision: number, characterId = characterA) {
  const response = await fetch(
    `http://127.0.0.1:${address.port}/characters/${characterId}/visual-profile/publish`,
    { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ revision }) },
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/**
 * Serializable 事务在并发下允许被数据库中止（P2034），真实客户端会重试。
 * 这里只对 5xx 重试发布，别把「并发冲突」误当成「引用关系坏了」。
 */
async function publishWithRetry(revision: number, attempts = 4) {
  let last = await publish(revision);
  for (let attempt = 1; attempt < attempts && last.status >= 500; attempt += 1) {
    last = await publish(revision);
  }
  return last;
}

try {
  for (const id of createdUserIds) {
    await prisma.user.create({ data: { id, username: `visual-ref-${id}`, passwordHash: "test-only" } });
  }
  for (const [id, name, owner] of [
    [characterA, "Visual refs A", ownerId],
    [characterB, "Visual refs B", ownerId],
    [characterC, "Visual refs C", strangerId],
  ] as const) {
    await prisma.character.create({ data: { id, ownerId: owner, name, basePrompt: "test" } });
    const profile = await prisma.characterVisualProfile.create({ data: { characterId: id }, select: { id: true } });
    profileIds.push(profile.id);
  }

  const profileA = profileIds[0]!;
  const profileB = profileIds[1]!;
  const profileC = profileIds[2]!;
  const old = new Date("2026-01-01T00:00:00Z");
  const recent = new Date("2026-02-01T00:00:00Z");

  // A：同一用途两张标准图（只有新的一张会被选中）、三视图各一张、一张非参考用途的表情图。
  const standardOld = await createAsset(characterA, profileA, "STANDARD", "旧标准图", old, 0);
  const standardNew = await createAsset(characterA, profileA, "STANDARD", "新标准图", recent, 1);
  const front = await createAsset(characterA, profileA, "FRONT_VIEW", "正面", recent, 2);
  const side = await createAsset(characterA, profileA, "SIDE_VIEW", "侧面", recent, 3);
  const back = await createAsset(characterA, profileA, "BACK_VIEW", "背面", recent, 4);
  const expression = await createAsset(characterA, profileA, "EXPRESSION", "笑", recent, 5);
  const assetsA = [standardOld, standardNew, front, side, back, expression];

  // B 是同一个主人的另一个角色，C 是别人的角色：两边都有正式版本正在用的参考图。
  const assetB = await createAsset(characterB, profileB, "STANDARD", "B 的标准图", recent);
  const assetC = await createAsset(characterC, profileC, "STANDARD", "C 的标准图", recent);

  const versionA1 = await prisma.characterVisualVersion.create({
    data: {
      profileId: profileA, revision: 1, status: "PUBLISHED", publishedAt: new Date(),
      note: "初版", snapshot: { coreAppearance: "蓝紫色长发", assets: toSnapshotAssets(assetsA) },
    },
    select: { id: true, snapshot: true },
  });
  await prisma.characterVisualProfile.update({ where: { id: profileA }, data: { currentPublishedRevision: 1 } });
  await prisma.characterVisualVersion.create({
    data: {
      profileId: profileB, revision: 1, status: "PUBLISHED", publishedAt: new Date(),
      snapshot: { coreAppearance: "B", assets: toSnapshotAssets([assetB]) },
    },
  });
  await prisma.characterVisualProfile.update({ where: { id: profileB }, data: { currentPublishedRevision: 1 } });
  await prisma.characterVisualVersion.create({
    data: {
      profileId: profileC, revision: 1, status: "PUBLISHED", publishedAt: new Date(),
      snapshot: { coreAppearance: "C", assets: toSnapshotAssets([assetC]) },
    },
  });
  await prisma.characterVisualProfile.update({ where: { id: profileC }, data: { currentPublishedRevision: 1 } });

  // 前提：选片规则确实把「新标准图 + 三视图」选中，旧标准图与表情图落在选中之外。
  const selected = selectSnapshotReferenceAssets(toSnapshotAssets(assetsA));
  assert.deepEqual(selected.map(item => item.id), [standardNew.id, front.id, side.id, back.id],
    "前提：正式版本选中的是新标准图与三视图");
  assert(!selected.some(item => item.id === standardOld.id), "前提：同用途旧图不被选中");
  assert(!selected.some(item => item.id === expression.id), "前提：非参考用途不进参考图");

  sessionCookie = cookie((await createSession({ userId: ownerId })).token);
  const strangerCookie = cookie((await createSession({ userId: strangerId })).token);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  assert.ok(bound && typeof bound === "object");
  address = bound as Address;

  // ── ① 正式版本正在使用的素材：409，且行、文件、快照都原样 ─────────────────
  const snapshotBefore = (await publishedSnapshotOf(characterA)).snapshot;
  const blocked = await deleteAsset(front.id);
  assert.equal(blocked.status, 409, "正在被正式版本引用的参考图必须拒绝删除");
  assert.match(String(blocked.body?.statusMessage ?? blocked.body?.message ?? ""), /仍被当前正式形象版本引用/u,
    "拒绝理由要说清是「被当前正式版本引用」");
  assert.equal(await rowExists(front.id), true, "删除失败后素材行必须还在");
  assert.equal(await fileExists(front.relativePath), true, "删除失败后图片文件必须还在");
  assert.deepEqual((await publishedSnapshotOf(characterA)).snapshot, snapshotBefore,
    "删除失败不能改动正式版本快照");
  assert.equal(await prisma.characterVisualProfile.findUnique({ where: { id: profileA }, select: { currentPublishedRevision: true } })
    .then(row => row?.currentPublishedRevision), 1, "删除失败不能移动正式版本指针");

  // 三视图逐张都要挡住，别只挡住列表里的第一张。
  for (const view of [side, back, standardNew]) {
    assert.equal((await deleteAsset(view.id)).status, 409, `${view.label} 同样受保护`);
    assert.equal(await fileExists(view.relativePath), true);
  }

  // ── ② 快照里存在但没被选中的素材：可以删 ────────────────────────────────
  const oldStandard = await deleteAsset(standardOld.id);
  assert.equal(oldStandard.status, 200, "同用途的旧标准图没被选中，应当允许删除");
  assert.equal(await rowExists(standardOld.id), false, "允许删除的素材行必须真的消失");
  assert.equal(await fileExists(standardOld.relativePath), false, "允许删除的素材文件必须真的消失");

  const expressionDelete = await deleteAsset(expression.id);
  assert.equal(expressionDelete.status, 200, "非参考用途的素材不参与生图，应当允许删除");
  assert.equal(await fileExists(expression.relativePath), false);

  // ── ③ 只作用于本角色：兄弟角色与别人的角色都不受影响 ───────────────────────
  const crossCharacter = await deleteAsset(assetB.id);
  assert.equal(crossCharacter.status, 404, "不能拿 A 的角色路径删 B 的素材");
  assert.equal(await rowExists(assetB.id), true, "跨角色删除失败后 B 的素材行必须还在");
  assert.equal(await fileExists(assetB.relativePath), true, "跨角色删除失败后 B 的文件必须还在");

  const foreignCharacter = await deleteAsset(assetC.id, { characterId: characterC, token: (await createSession({ userId: ownerId })).token });
  assert.equal(foreignCharacter.status, 404, "别人的角色不能删");
  assert.equal(await rowExists(assetC.id), true, "越权删除失败后 C 的素材行必须还在");
  assert.equal(await fileExists(assetC.relativePath), true, "越权删除失败后 C 的文件必须还在");

  const anonymous = await deleteAsset(assetB.id, { characterId: characterB, token: "not-a-session" });
  assert.equal(anonymous.status, 401, "没有会话不能删素材");
  assert.equal(await fileExists(assetB.relativePath), true);

  // B 自己的正式版本选中的图仍然删不掉 —— 保护不是只对 A 生效。
  const bProtected = await deleteAsset(assetB.id, { characterId: characterB });
  assert.equal(bProtected.status, 409, "B 的正式版本引用同样受保护");
  assert.equal(await fileExists(assetB.relativePath), true);
  assert.equal(await fileExists(assetC.relativePath), true, "上述失败都不该碰到 C 的文件");

  // ── ④ 发布新版本 + 删除并发：正式版本不留悬空引用 ─────────────────────────
  // 先起草一个不再引用背面图的版本，但**不发布**：此时正式版本仍然引用着它。
  const draft2Rows = await prisma.characterVisualAsset.findMany({
    where: { profileId: profileA }, orderBy: [{ sortOrder: "asc" }],
    select: { id: true, kind: true, label: true, relativePath: true, sortOrder: true, createdAt: true },
  });
  await prisma.characterVisualVersion.create({
    data: {
      profileId: profileA, revision: 2, status: "DRAFT", note: "去掉背面图",
      snapshot: { coreAppearance: "蓝紫色长发", assets: toSnapshotAssets(draft2Rows.filter(item => item.id !== back.id)) },
    },
  });
  // 只有草稿、还没发布：正式版本依旧引用背面图，删除必须被挡住（409 这条路要确定性走到）。
  assert.equal((await deleteAsset(back.id)).status, 409, "草稿里不引用不等于可以删，正式版本还在用");
  assert.equal(await fileExists(back.relativePath), true);

  // 发布与删除同时发起：删除先发出、发布晚 10ms，于是删除多半读到旧版本被挡（409），
  // 也可能读到已提交的新版本而直接成功（200）。两种落地顺序都不许破坏引用关系。
  const deleteRace = deleteAsset(back.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  const publishRace = publishWithRetry(2);
  const [deleteResult, publishResult] = await Promise.all([deleteRace, publishRace]);
  assert.equal(publishResult.status, 200, `并发发布必须成功（实际 ${publishResult.status}）`);
  assert([200, 409].includes(deleteResult.status),
    `并发删除只能是成功或被正式版本挡住，实际 ${deleteResult.status}`);

  const publishedNow = await publishedSnapshotOf(characterA);
  assert.equal(publishedNow.revision, 2, "正式版本必须已经推进到新版本");
  assert(!selectSnapshotReferenceAssets(publishedNow.snapshot.assets).some(item => item.id === back.id),
    "新正式版本快照不再引用背面图");

  // 无论两个事务谁先落地，正式版本解析出来的每一张参考图都必须指的到、读的到。
  const resolved = await readVisualProfileReferences(prisma, characterA, publishedNow.snapshot.assets);
  assert.equal(resolved.length, 3, "新正式版本应当解析出三张参考图");
  for (const reference of resolved) {
    const row = await prisma.characterVisualAsset.findUnique({
      where: { id: reference.assetId }, select: { id: true, relativePath: true },
    });
    assert.ok(row, `解析出的参考图 ${reference.label} 必须有素材行`);
    assert.equal(await fileExists(row.relativePath), true, `解析出的参考图 ${reference.label} 必须能读到文件`);
    assert.ok(reference.buffer.length > 0, "参考图必须带得动真实字节");
  }
  assert(!resolved.some(reference => reference.assetId === back.id), "背面图不能被当成参考图带上");

  if (deleteResult.status === 409) {
    // 删除先读到了旧版本，于是被挡住；新版本发布后同一张图必须已经可以删。
    const retried = await deleteAsset(back.id);
    assert.equal(retried.status, 200, "正式版本不再引用之后，素材必须能删掉");
  }
  assert.equal(await rowExists(back.id), false, "背面图最终应当被删除");
  assert.equal(await fileExists(back.relativePath), false, "背面图文件最终应当被删除");

  // 删完之后再解析一次：不许抛错，也不许把不存在的图当成参考图。
  const afterDelete = await readVisualProfileReferences(prisma, characterA, publishedNow.snapshot.assets);
  assert.equal(afterDelete.length, 3, "已删素材不能混进参考图列表");

  // ── ⑤ 已删素材又出现在后来发布的快照里：生图必须安全跳过 ──────────────────
  // 真实的时序漏洞：草稿在删除之前就存好了（快照里还记着那张图），删除当时合法通过，
  // 之后再发布这个旧草稿，正式版本就指向了一个不存在的文件。这里钉住兜底行为 ——
  // 跳过缺失的图、其余照常带上，而不是抛错让整轮生图失败，也不能拿错图。
  await prisma.characterVisualVersion.create({
    data: {
      profileId: profileA, revision: 3, status: "DRAFT", note: "删除前保存的旧草稿",
      snapshot: { coreAppearance: "蓝紫色长发", assets: toSnapshotAssets(draft2Rows) },
    },
  });
  assert.equal((await publishWithRetry(3)).status, 200, "旧草稿仍然可以发布");
  const stale = await publishedSnapshotOf(characterA);
  assert.ok(selectSnapshotReferenceAssets(stale.snapshot.assets).some(item => item.id === back.id),
    "前提：这个版本确实引用了已删的背面图");
  const tolerated = await readVisualProfileReferences(prisma, characterA, stale.snapshot.assets);
  assert.equal(tolerated.length, 3, "缺失的素材被跳过，其余三张照常带上");
  assert(!tolerated.some(reference => reference.assetId === back.id), "不存在的图不能变成参考图");

  // ── ⑥ 收尾：B / C 的正式引用仍然完整 ─────────────────────────────────────
  const resolverB = await readVisualProfileReferences(prisma, characterB, (await publishedSnapshotOf(characterB)).snapshot.assets);
  assert.equal(resolverB.length, 1, "B 的正式参考图仍在");
  assert.equal(resolverB[0]!.assetId, assetB.id);
  const resolverC = await readVisualProfileReferences(prisma, characterC, (await publishedSnapshotOf(characterC)).snapshot.assets);
  assert.equal(resolverC.length, 1, "C 的正式参考图仍在");
  assert.equal(resolverC[0]!.assetId, assetC.id);
  // 旧正式版本作为历史保留，不被删除也不被改写。
  const history = await prisma.characterVisualVersion.findUnique({
    where: { id: versionA1.id }, select: { revision: true, status: true },
  });
  assert.deepEqual(history, { revision: 1, status: "PUBLISHED" }, "旧版本保留为历史，指向它的删除一律被拒");

  console.log(`visual-profile-references-db: 删除保护、选中边界、跨角色隔离、并发发布与陈旧快照兜底全部通过（并发删除返回 ${deleteResult.status}）`);
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.character.deleteMany({ where: { id: { in: characterIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  for (const characterId of characterIds) {
    await rm(dataPath("visual-profile", characterId), { recursive: true, force: true }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
}
