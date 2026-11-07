import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, setResponseStatus, toNodeListener } from "h3";

/**
 * 稳定同步根的端到端验收（隔离数据库）。
 *
 * 覆盖用户列出的五件事：
 *   1. 新建角色自动把自己的 id 写成同步根；
 *   2. 无 origin 的旧卡导入后以新实例 id 建立独立同步根；
 *   3. 家里 → 公司 → 家里的往返合并；
 *   4. 同一根存在多个副本时，必须显式指定合并目标；
 *   5. 同一张卡重复合并仍然幂等。
 *
 * 只能通过 `test:character-isolated` 进入：那里会建一个一次性数据库。
 */
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_character_test_[a-f0-9]{32}$/.test(database), "Run through test:character-isolated only.");

// handler 用的是 Nitro 自动导入的 defineEventHandler / setResponseStatus；tsx 下补等价实现。
(globalThis as unknown as { defineEventHandler: unknown }).defineEventHandler = (handler: unknown) => handler;
(globalThis as unknown as { setResponseStatus: unknown }).setResponseStatus = setResponseStatus;

const { getPrisma } = await import("../server/utils/prisma");
const { createSession } = await import("../server/utils/auth");
const { loadCharacterExportBundle } = await import("../server/utils/character-transfer");
const createCharacter = (await import("../server/api/characters/index.post")).default;
const importCharacter = (await import("../server/api/characters/import.post")).default;
const listCharacters = (await import("../server/api/characters/index.get")).default;

const prisma = getPrisma();
const homeId = randomUUID();
const officeId = randomUUID();
const characterIds: string[] = [];

type CharacterCard = {
  origin?: { characterId?: string };
  memories?: Array<Record<string, unknown>>;
};

type CharacterSummary = { id: string; originId: string; name: string };
type ImportResult = {
  character: CharacterSummary;
  mode: "new" | "merge";
  added: {
    memories: number;
    events: number;
    eventDays: number;
    snapshots: number;
    journals: number;
    journalRevisions: number;
    catchphrases: number;
    friends: number;
  };
};

/** 只挂本次验收要用的三个 handler，避免把整个 Nuxt 应用拉起来。 */
const app = createApp({ onError: () => undefined });
const router = createRouter();
router.post("/api/characters", createCharacter);
router.post("/api/characters/import", importCharacter);
router.get("/api/characters", listCharacters);
app.use(router);
const server = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(
  path: string,
  input: { method?: string; body?: unknown; cookie: string },
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(baseUrl + path, {
    method: input.method ?? "GET",
    headers: {
      cookie: input.cookie,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function seedUsers(): Promise<{ homeCookie: string; officeCookie: string }> {
  await prisma.user.createMany({
    data: [
      { id: homeId, username: `sync-home-${homeId}`, passwordHash: "test-only" },
      { id: officeId, username: `sync-office-${officeId}`, passwordHash: "test-only" },
    ],
  });
  const home = await createSession({ userId: homeId, ip: "127.0.0.1", userAgent: "sync-root-test" });
  const office = await createSession({ userId: officeId, ip: "127.0.0.1", userAgent: "sync-root-test" });
  return {
    homeCookie: `yiling_session=${home.token}`,
    officeCookie: `yiling_session=${office.token}`,
  };
}

async function addMemory(characterId: string, content: string): Promise<void> {
  const scope = await prisma.memoryScope.findFirstOrThrow({
    where: { characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  await prisma.memoryItem.create({
    data: {
      memoryScopeId: scope.id,
      originId: randomUUID(),
      category: "FACT",
      content,
      importance: 0.5,
    },
  });
}

async function readMemories(characterId: string): Promise<string[]> {
  const rows = await prisma.memoryItem.findMany({
    where: {
      memoryScope: { characterId, scopeType: "CHARACTER_GLOBAL" },
      status: "ACTIVE",
    },
    select: { content: true },
  });
  return rows.map((row) => row.content);
}

async function exportCard(characterId: string, ownerId: string): Promise<CharacterCard> {
  const result = await loadCharacterExportBundle({ characterId, ownerId });
  assert.ok(result, "角色卡导出不能返回空");
  return JSON.parse(JSON.stringify(result.bundle)) as CharacterCard;
}

async function importCard(
  card: CharacterCard,
  cookie: string,
  targetCharacterId?: string,
): Promise<ImportResult> {
  const path = targetCharacterId
    ? `/api/characters/import?target=${encodeURIComponent(targetCharacterId)}`
    : "/api/characters/import";
  const result = await api(path, { method: "POST", body: card, cookie });
  assert.equal(result.status, targetCharacterId ? 200 : 201, JSON.stringify(result.body));
  return result.body as ImportResult;
}

function assertEmptyAdded(added: ImportResult["added"], label: string): void {
  for (const [key, value] of Object.entries(added)) {
    assert.equal(value, 0, `${label}：${key} 应为 0，实际 ${value}`);
  }
}

async function main(): Promise<void> {
  const { homeCookie, officeCookie } = await seedUsers();

  // ── 1. 新建角色自动生成同步根 ──────────────────────────────
  const created = await api("/api/characters", {
    method: "POST",
    body: { name: "同步根验收角色" },
    cookie: homeCookie,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // 新建接口直接返回 Character DTO；导入接口才包一层 { character, mode, ... }。
  const homeCharacter = created.body as CharacterSummary;
  characterIds.push(homeCharacter.id);
  assert.equal(homeCharacter.originId, homeCharacter.id, "新建角色应自动把同步根设为自己的 id");
  assert.equal(
    (await prisma.character.findUniqueOrThrow({
      where: { id: homeCharacter.id },
      select: { originCharacterId: true },
    })).originCharacterId,
    homeCharacter.id,
    "新建角色的同步根必须落库，不能只在 DTO 里临时回落",
  );

  await addMemory(homeCharacter.id, "家里记住的第一件事");
  const homeCard = await exportCard(homeCharacter.id, homeId);
  assert.equal(homeCard.origin?.characterId, homeCharacter.id, "导出必须携带家里的同步根");

  // ── 2. 无 origin 的旧卡建立独立同步根 ──────────────────────
  const oldCard = JSON.parse(JSON.stringify(homeCard)) as CharacterCard;
  delete oldCard.origin;
  const legacy = await importCard(oldCard, officeCookie);
  characterIds.push(legacy.character.id);
  assert.equal(legacy.mode, "new");
  assert.notEqual(legacy.character.id, homeCharacter.id);
  assert.equal(legacy.character.originId, legacy.character.id, "旧卡应以新实例 id 建立独立同步根");
  assert.equal(
    (await prisma.character.findUniqueOrThrow({
      where: { id: legacy.character.id },
      select: { originCharacterId: true },
    })).originCharacterId,
    legacy.character.id,
    "旧卡的独立同步根必须落库",
  );
  const legacyReexport = await exportCard(legacy.character.id, officeId);
  assert.equal(legacyReexport.origin?.characterId, legacy.character.id, "旧卡再次导出时携带自己的独立根");

  // ── 3. 家里 → 公司 → 家里 ─────────────────────────────────
  const office = await importCard(homeCard, officeCookie);
  characterIds.push(office.character.id);
  assert.equal(office.mode, "new");
  assert.equal(office.character.originId, homeCharacter.id, "带 origin 的卡应继承家里的同步根");
  await addMemory(office.character.id, "公司在办公室养的");
  const officeCard = await exportCard(office.character.id, officeId);

  const homeMerge = await importCard(officeCard, homeCookie, homeCharacter.id);
  assert.equal(homeMerge.mode, "merge");
  assert.equal(homeMerge.character.id, homeCharacter.id);
  assert.equal(homeMerge.added.memories, 1, "公司新增的一条记忆应合并回家里");
  assert.deepEqual(
    (await readMemories(homeCharacter.id)).sort(),
    ["公司在办公室养的", "家里记住的第一件事"].sort(),
    "家里的角色应同时拥有两边的新记忆",
  );

  const homeCardAfterMerge = await exportCard(homeCharacter.id, homeId);
  const officeMerge = await importCard(homeCardAfterMerge, officeCookie, office.character.id);
  assert.equal(officeMerge.mode, "merge");
  assert.equal(officeMerge.added.memories, 0, "家里回导不应在公司产生重复记忆");
  assert.deepEqual(
    (await readMemories(office.character.id)).sort(),
    ["公司在办公室养的", "家里记住的第一件事"].sort(),
    "公司的角色也应同时拥有两边的新记忆",
  );

  // ── 5. 重复合并仍然幂等 ───────────────────────────────────
  const repeated = await importCard(officeCard, homeCookie, homeCharacter.id);
  assertEmptyAdded(repeated.added, "同一张公司卡第二次合并回家里");

  // ── 4. 多个同源副本必须显式选择目标 ───────────────────────
  const copy = await importCard(homeCardAfterMerge, officeCookie);
  characterIds.push(copy.character.id);
  assert.equal(copy.mode, "new");
  assert.equal(copy.character.originId, homeCharacter.id, "新建副本仍应共享同一个同步根");
  assert.notEqual(copy.character.id, office.character.id, "同一根允许再建一个独立副本");

  const list = await api("/api/characters", { cookie: officeCookie });
  assert.equal(list.status, 200);
  const sameRoot = (list.body as CharacterSummary[]).filter((item) => item.originId === homeCharacter.id);
  assert.equal(sameRoot.length, 2, "公司侧应看到两个同源副本");
  assert.deepEqual(
    new Set(sameRoot.map((item) => item.id)),
    new Set([office.character.id, copy.character.id]),
    "两个副本都必须出现在候选列表里",
  );

  const targetedCard = JSON.parse(JSON.stringify(officeCard)) as CharacterCard;
  targetedCard.memories = [
    ...(targetedCard.memories ?? []),
    {
      scope: "character",
      originId: randomUUID(),
      category: "FACT",
      content: "只写进指定副本",
      confidence: null,
      importance: 0.5,
      validFrom: null,
      validTo: null,
      dedupeKey: null,
    },
  ];
  const targetedCopy = await importCard(targetedCard, officeCookie, copy.character.id);
  assert.equal(targetedCopy.added.memories, 1, "显式指定副本后，新记忆应只进该副本");
  assert.deepEqual(
    (await readMemories(copy.character.id)).sort(),
    ["公司在办公室养的", "家里记住的第一件事", "只写进指定副本"].sort(),
    "目标副本应收到新记忆",
  );
  assert.deepEqual(
    (await readMemories(office.character.id)).sort(),
    ["公司在办公室养的", "家里记住的第一件事"].sort(),
    "未指定的另一个副本不应被写入",
  );

  const targetedOther = await importCard(targetedCard, officeCookie, office.character.id);
  assert.equal(targetedOther.added.memories, 1, "同一个包合并到另一个副本时应各自判断去重");
  assert.deepEqual(
    (await readMemories(office.character.id)).sort(),
    ["公司在办公室养的", "家里记住的第一件事", "只写进指定副本"].sort(),
    "另一个副本也收到新记忆",
  );

  const targetedRepeat = await importCard(targetedCard, officeCookie, office.character.id);
  assertEmptyAdded(targetedRepeat.added, "同一张卡第三次合并到同一副本");

  console.log(
    "同步根数据库测试通过：新建自动生根、旧卡独立生根、家里→公司→家里往返合并、多副本显式选目标、重复合并幂等。",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 失败可能发生在「行已写入、响应还没返回」的窗口里，所以按 owner 再兜一次，
    // 不能只依赖成功路径收集到的 characterIds。
    const owned = await prisma.character.findMany({
      where: { ownerId: { in: [homeId, officeId] } },
      select: { id: true },
    });
    const ids = [...new Set([...characterIds, ...owned.map((row) => row.id)])];
    const scoped = { memoryScope: { characterId: { in: ids } } };
    await prisma.message.deleteMany({ where: { conversation: { characterId: { in: ids } } } });
    await prisma.conversation.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.memoryItem.deleteMany({ where: scoped });
    await prisma.memoryEvent.deleteMany({ where: scoped });
    await prisma.memorySnapshotSource.deleteMany({
      where: { snapshot: { memoryScope: { characterId: { in: ids } } } },
    });
    await prisma.memorySnapshot.deleteMany({ where: scoped });
    await prisma.memoryJob.deleteMany({ where: scoped });
    await prisma.characterCatchphrase.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: ids } } });
    await prisma.character.deleteMany({ where: { id: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: [homeId, officeId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [homeId, officeId] } } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
