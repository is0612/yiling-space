/**
 * 历史社交经历回填的数据库级验收（不调模型、不动业务库）。
 *
 * 配套 `test-backfill-social-experiences-isolated.ts`：那边建一个一次性库、跑完就 DROP；
 * 这里只负责造数据、跑脚本、核对结果。
 *
 * **拒绝在非一次性库上运行** —— 脚本会带 `--apply` 真写库，误连业务库就是脏数据。
 *
 * 覆盖五件事：
 *   1. 预演不写库；
 *   2. `--apply` 关联到**当前角色**的那条 EXTERNAL_IDENTITY 关系；
 *   3. 两个角色认识同一个账号时不串数据；
 *   4. 重复运行不重复累计（唯一键 + skipDuplicates）；
 *   5. 缺可靠参与者信息（无 refs / platform=unknown / 无关系 / 无证据）的忆泡跳过。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";

const databaseName = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.replace(/^\//, "");
assert(
  /^yiling_social_bf_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性回填测试库。请用 yarn test:backfill-social-experiences-isolated。`,
);

const prisma = getPrisma();

let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log("  ✅", name);
  } else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

type BackfillStats = {
  scanned: number;
  eligible: number;
  inserted?: number;
  previewOnly: boolean;
  skippedWithoutSourceEvidence: number;
  skippedWithoutParticipantRefs: number;
};

function runBackfill(args: string[]): BackfillStats {
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/backfill-social-experiences.ts", ...args],
    { env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `回填脚本失败：\n${result.stdout}\n${result.stderr}`);
  const pick = (key: string) => {
    // 脚本每 5 批会打一行进度 {scanned, eligible, inserted}，所以取**最后一次**出现，
    // 那才是收尾的统计块。
    const matches = [...result.stdout.matchAll(new RegExp(`${key}: (\\d+|undefined)`, "g"))];
    const last = matches.at(-1);
    assert.ok(last, `没在输出里找到 ${key}：\n${result.stdout}`);
    return last[1] === "undefined" ? undefined : Number(last[1]);
  };
  return {
    scanned: pick("scanned")!,
    eligible: pick("eligible")!,
    inserted: pick("inserted"),
    previewOnly: /previewOnly: true/.test(result.stdout),
    skippedWithoutSourceEvidence: pick("skippedWithoutSourceEvidence")!,
    skippedWithoutParticipantRefs: pick("skippedWithoutParticipantRefs")!,
  };
}

const runId = Date.now().toString(36);
const platform = "qq-onebot";
const sharedUid = "bf-shared-" + runId; // 两个角色都认识
const onlyInAUid = "bf-only-a-" + runId; // 只有 A 认识
const noScopeUid = "bf-no-scope-" + runId; // 平台账号存在，但两个角色都没建关系
const ghostUid = "bf-ghost-" + runId; // 只出现在 platform=unknown 的引用里

const owner = await prisma.user.create({
  data: { username: `backfill-${runId}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});

const makeCharacter = async (name: string) => {
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name,
      basePrompt: "回填自检用",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `global:${name}:${runId}` } },
    },
    select: { id: true },
  });
  const globalScope = await prisma.memoryScope.findFirstOrThrow({
    where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  return { id: character.id, globalScopeId: globalScope.id };
};

const charA = await makeCharacter("__回填自检A__");
const charB = await makeCharacter("__回填自检B__");

const makeIdentity = (uid: string) =>
  prisma.externalIdentity.create({
    data: { platform, platformUid: uid, status: "UNVERIFIED" },
    select: { id: true },
  });

const sharedIdentity = await makeIdentity(sharedUid);
const onlyAIdentity = await makeIdentity(onlyInAUid);
await makeIdentity(noScopeUid);

const scopeA1 = (await ensureExternalIdentityScope(charA.id, platform, sharedUid, sharedIdentity.id)).scopeId;
const scopeA2 = (await ensureExternalIdentityScope(charA.id, platform, onlyInAUid, onlyAIdentity.id)).scopeId;
const scopeB1 = (await ensureExternalIdentityScope(charB.id, platform, sharedUid, sharedIdentity.id)).scopeId;

const conversation = await prisma.conversation.create({
  data: { characterId: charA.id, memoryScopeId: charA.globalScopeId, title: "回填自检会话" },
  select: { id: true },
});
const legacyMessage = await prisma.message.create({
  data: {
    conversationId: conversation.id,
    role: "USER",
    content: "只有 sourceMessageId 的旧忆泡",
    occurredAt: new Date("2026-11-01T12:00:00Z"),
    metadata: { authorOpenId: sharedUid, platform },
  },
  select: { id: true },
});

const external = (uid: string) => ({ kind: "external", platform, externalId: uid, displayName: "某人" });
type ParticipantRefFixture = {
  kind: string;
  platform: string;
  externalId: string;
  displayName: string;
};

type Fixture = {
  key: string;
  characterId: string;
  scopeId: string;
  sourceMessageIds: string[];
  sourceMessageId?: string;
  participantRefs?: ParticipantRefFixture[];
  status?: "ACTIVE" | "ARCHIVED";
};

const evidenceOne = [randomUUID(), randomUUID()];
const fixtures: Fixture[] = [
  // 正常：单账号
  { key: "eA1", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: evidenceOne, participantRefs: [external(sharedUid)] },
  // 正常：一个忆泡带多个账号，能resolve的各落一条，没关系的那个跳过、不拖累其他人
  { key: "eA2", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [randomUUID()], participantRefs: [external(sharedUid), external(onlyInAUid), external(noScopeUid)] },
  // 跳过：没有 participantRefs
  { key: "eA3", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [randomUUID()] },
  // 跳过：platform=unknown，不可靠
  { key: "eA4", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [randomUUID()], participantRefs: [{ kind: "external", platform: "unknown", externalId: ghostUid, displayName: "某人" }] },
  // 跳过：没有任何证据消息 id
  { key: "eA5", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [], participantRefs: [external(sharedUid)] },
  // 正常：旧数据只有 sourceMessageId
  { key: "eA6", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [], sourceMessageId: legacyMessage.id, participantRefs: [external(sharedUid)] },
  // 跳过：账号存在但当前角色没建关系
  { key: "eA7", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [randomUUID()], participantRefs: [external(noScopeUid)] },
  // 跳过：已归档
  { key: "eA8", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [randomUUID()], participantRefs: [external(sharedUid)], status: "ARCHIVED" },
  // 去重：与 eA1 同一批证据消息（顺序不同），不得再累计一条
  { key: "eA9", characterId: charA.id, scopeId: charA.globalScopeId, sourceMessageIds: [...evidenceOne].reverse(), participantRefs: [external(sharedUid)] },
  // 串库观察点：B 也认识这个账号，必须落到 B 自己的关系上
  { key: "eB1", characterId: charB.id, scopeId: charB.globalScopeId, sourceMessageIds: [randomUUID()], participantRefs: [external(sharedUid)] },
];

const eventIds = new Map<string, string>();
for (const fixture of fixtures) {
  const event = await prisma.memoryEvent.create({
    data: {
      memoryScopeId: fixture.scopeId,
      dayKey: "2026-11-01",
      occurredAt: new Date("2026-11-01T12:00:00Z"),
      title: `自检 ${fixture.key}`,
      detail: "回填自检",
      dedupeKey: `${fixture.key}:${runId}`,
      sourceMessageIds: fixture.sourceMessageIds,
      ...(fixture.sourceMessageId ? { sourceMessageId: fixture.sourceMessageId } : {}),
      ...(fixture.participantRefs === undefined
        ? {}
        : { participantRefs: fixture.participantRefs }),
      ...(fixture.status ? { status: fixture.status } : {}),
    },
    select: { id: true },
  });
  eventIds.set(fixture.key, event.id);
}

const totalExperiences = () => prisma.socialExperience.count();
const scopesInPlay = [scopeA1, scopeA2, scopeB1];

try {
  console.log("\n[1] 预演不写库");
  const before = await totalExperiences();
  const preview = runBackfill(["--page-size=1"]); // 小分页顺带验游标
  const afterPreview = await totalExperiences();
  check("预演没有新增任何社交经历", before === 0 && afterPreview === 0, { before, afterPreview });
  check("预演标记 previewOnly、不回报 inserted", preview.previewOnly && preview.inserted === undefined, preview);
  check("预演扫到 9 条 ACTIVE 忆泡（归档那条不参与）", preview.scanned === 9, preview);
  check("跳过计数：1 条无证据、2 条无可靠参与者",
    preview.skippedWithoutSourceEvidence === 1 && preview.skippedWithoutParticipantRefs === 2, preview);

  console.log("\n[2] --apply 关联到正确的关系");
  const applyA = runBackfill(["--apply", "--page-size=1"]);
  const rows = await prisma.socialExperience.findMany({
    where: { scopeId: { in: scopesInPlay } },
    select: { id: true, scopeId: true, memoryEventId: true, sourceKey: true },
  });
  check("写入 5 条（eA1 / eA2 两条 / eA6 / eB1）", rows.length === 5, { count: rows.length, inserted: applyA.inserted });
  check("脚本回报的 inserted 与实际落库一致", applyA.inserted === rows.length, applyA);

  const byEvent = (key: string) => rows.filter((row) => row.memoryEventId === eventIds.get(key));
  // eA1 与 eA9 是同一批证据消息的两条忆泡，唯一键只允许留一条。
  // 具体留哪条取决于扫描顺序（id 升序 = 随机 UUID），所以这里只断言「只留一条且挂在正确关系上」。
  const evidenceRows = [...byEvent("eA1"), ...byEvent("eA9")];
  check("同一批证据在同一关系下只累计一条",
    evidenceRows.length === 1 && evidenceRows[0]!.scopeId === scopeA1,
    { eA1: byEvent("eA1").length, eA9: byEvent("eA9").length });
  check("eA2 两个账号各一条，落在两条不同关系上",
    byEvent("eA2").length === 2
    && new Set(byEvent("eA2").map((row) => row.scopeId)).size === 2
    && byEvent("eA2").some((row) => row.scopeId === scopeA1)
    && byEvent("eA2").some((row) => row.scopeId === scopeA2),
    byEvent("eA2"));
  check("eA2 里没建关系的那个账号被跳过，只落 2 条（不拖累另外两人）",
    byEvent("eA2").length === 2, byEvent("eA2"));
  check("eA6 用旧的 sourceMessageId 也能落库",
    byEvent("eA6").length === 1 && byEvent("eA6")[0]!.scopeId === scopeA1);
  check("A 的 shared 关系共 3 条（evidence / eA2 / eA6）",
    rows.filter((row) => row.scopeId === scopeA1).length === 3,
    rows.filter((row) => row.scopeId === scopeA1).length);

  console.log("\n[3] 不同角色之间不串数据");
  const scopeOwner = new Map<string, string>([
    [scopeA1, charA.id], [scopeA2, charA.id], [scopeB1, charB.id],
  ]);
  const eventOwner = new Map<string, string>(
    fixtures.map((fixture) => [eventIds.get(fixture.key)!, fixture.characterId]),
  );
  const crossCharacter = rows.filter((row) =>
    scopeOwner.get(row.scopeId) !== eventOwner.get(row.memoryEventId));
  check("没有任何一条挂在别人的关系上", crossCharacter.length === 0, crossCharacter);
  check("B 的忆泡只落在 B 的关系上",
    byEvent("eB1").length === 1 && byEvent("eB1")[0]!.scopeId === scopeB1, byEvent("eB1"));
  check("A 的关系里没有 B 的忆泡",
    rows.filter((row) => row.scopeId === scopeA1 || row.scopeId === scopeA2)
      .every((row) => eventOwner.get(row.memoryEventId) === charA.id));
  check("同一个账号在两个角色下各自一条，互不覆盖",
    byEvent("eB1").length === 1
    && evidenceRows.length === 1
    && rows.filter((row) => row.scopeId === scopeB1).length === 1,
    { sharedUid, b: byEvent("eB1").length, a: evidenceRows.length });

  console.log("\n[4] 重复运行不重复累计");
  const applyB = runBackfill(["--apply"]);
  check("第二次 --apply 新增 0 条", applyB.inserted === 0, applyB);
  check("总条数不变", (await totalExperiences()) === 5);
  const applyC = runBackfill(["--apply", "--page-size=2000"]);
  check("换分页大小再跑仍然幂等", applyC.inserted === 0 && (await totalExperiences()) === 5, applyC);

  console.log("\n[5] 缺可靠参与者信息的忆泡被跳过");
  for (const key of ["eA3", "eA4", "eA5", "eA7", "eA8"]) {
    check(`${key} 没有产生社交经历`, byEvent(key).length === 0, byEvent(key));
  }
} finally {
  // 按外键顺序清掉本次造的数据；隔离库随后整个 DROP，单独跑也能收干净。
  await prisma.socialExperience.deleteMany({ where: { scopeId: { in: scopesInPlay } } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: { in: [charA.globalScopeId, charB.globalScopeId] } } });
  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { characterId: charA.id } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [charA.id, charB.id] } } });
  await prisma.externalIdentity.deleteMany({ where: { platformUid: { in: [sharedUid, onlyInAUid, noScopeUid] } } });
  await prisma.character.deleteMany({ where: { id: { in: [charA.id, charB.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  const leftovers = await totalExperiences();
  console.log(`\n清理：剩余社交经历 ${leftovers} 条（应为 0）`);
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n历史社交经历回填自检：${failures} 项未通过。`);
  process.exit(1);
}
console.log("\n历史社交经历回填自检通过：预演只读、关系匹配、角色隔离、重复幂等、缺信息跳过。");
