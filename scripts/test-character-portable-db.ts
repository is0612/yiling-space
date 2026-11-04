import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { buildUserPrivateScopeKey } from "../server/utils/memory-scope-access";
import {
  importCharacterCard,
  loadCharacterExportBundle,
} from "../server/utils/character-transfer";


/**
 * 角色卡导出 / 导入的数据库回环测试。
 *
 * 重点验证三件事，而不是「字段都搬过去了」：
 *   1. 别人的私人记忆（USER_PRIVATE 属于其他用户）和外部身份记忆（QQ/B站 群友）不出包；
 *   2. 密钥字段不出包、导入后也不认；
 *   3. 导入只新增，不动原角色；原文没随包走时来源字段确实为空。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，角色卡测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const ownerA = randomUUID();
const userB = randomUUID();
const characterIds: string[] = [];
/** 测试里建的外部身份，收尾时要一起删干净：qq 号是全局唯一的，留着会污染后续测试。 */
const identityIds: string[] = [];

async function main() {
  await prisma.user.createMany({
    data: [
      { id: ownerA, username: `card-test-a-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "ADMIN" },
      { id: userB, username: `card-test-b-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "USER" },
    ],
  });

  // ── 造一个「养了一阵子」的角色 ────────────────────────────
  const characterId = randomUUID();
  characterIds.push(characterId);
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: ownerA,
      name: "小鱼",
      basePrompt: "你是小鱼，说话很短。",
      styleExamples: "主人：在吗\n小鱼：在。",
      userAddress: "主人",
      modelConfig: {
        alias: "小鱼",
        description: "一条鱼",
        avatarTone: "purple",
        chatModel: "deepseek-chat",
        chatApiKeyEncrypted: "v1.aaa.bbb.ccc",
        emojiEnabled: true,
      },
      memorySetting: {
        create: { snapshotIntervalDays: 8, timezone: "Asia/Shanghai", autoSnapshotEnabled: true },
      },
    },
  });

  const globalScopeId = randomUUID();
  const privateAId = randomUUID();
  const privateBId = randomUUID();
  const externalScopeId = randomUUID();
  // 「她的朋友」：一个真实的外部身份（QQ 号）+ 一条关系范围。
  // 这里故意把它绑定到 userB，用来验证导入不会顺手改掉已有身份的验证绑定。
  const friendIdentityId = randomUUID();
  const strangerIdentityId = randomUUID();
  identityIds.push(friendIdentityId, strangerIdentityId);
  await prisma.externalIdentity.create({
    data: {
      id: friendIdentityId,
      platform: "qq-onebot",
      platformUid: "888888",
      displayName: "小明",
      status: "VERIFIED",
      linkedUserId: userB,
    },
  });
  await prisma.externalIdentity.create({
    data: { id: strangerIdentityId, platform: "qq-onebot", platformUid: "999999", displayName: "路人", status: "UNVERIFIED" },
  });
  await prisma.memoryScope.createMany({
    data: [
      { id: globalScopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
      { id: privateAId, characterId, scopeType: "USER_PRIVATE", scopeKey: buildUserPrivateScopeKey(characterId, ownerA), userId: ownerA },
      { id: privateBId, characterId, scopeType: "USER_PRIVATE", scopeKey: buildUserPrivateScopeKey(characterId, userB), userId: userB },
      {
        id: externalScopeId,
        characterId,
        scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:qq-onebot:888888`,
        externalIdentityId: friendIdentityId,
        // 备注（她私底下怎么叫他）也是关系的一部分，必须跟着卡走。
        aliases: ["小鱼干", "阿明"],
        firstSource: "GROUP",
        interactionCount: 7,
        lastInteractedAt: new Date("2026-10-30T10:00:00Z"),
      },
      // 群里出现过但没被搭理的残留：interactionCount = 0，不算朋友，也不该进包。
      {
        characterId,
        scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:qq-onebot:999999`,
        externalIdentityId: strangerIdentityId,
      },
    ],
  });

  const conversationId = randomUUID();
  await prisma.conversation.create({
    data: { id: conversationId, characterId, memoryScopeId: globalScopeId, title: "旧会话" },
  });
  const messageId = randomUUID();
  await prisma.message.create({
    data: {
      id: messageId,
      conversationId,
      role: "USER",
      content: "我住杭州",
      occurredAt: new Date("2026-10-01T10:00:00Z"),
    },
  });

  await prisma.memoryItem.createMany({
    data: [
      { memoryScopeId: globalScopeId, category: "FACT", content: "主人住在杭州", confidence: 0.9, importance: 0.7, sourceMessageId: messageId, dedupeKey: "fact-hz" },
      { memoryScopeId: globalScopeId, category: "PREFERENCE", content: "主人怕辣", importance: 0.6 },
      { memoryScopeId: privateAId, category: "PREFERENCE", content: "主人喜欢冰美式", importance: 0.5 },
      { memoryScopeId: privateBId, category: "FACT", content: "B 的秘密：他姓王", importance: 0.9 },
      { memoryScopeId: externalScopeId, category: "FACT", content: "小明住在北海，怕冷", importance: 0.9 },
    ],
  });

  await prisma.memoryEvent.createMany({
    data: [
      {
        memoryScopeId: globalScopeId,
        dayKey: "2026-10-30",
        state: "FINAL",
        occurredAt: new Date("2026-10-30T12:00:00Z"),
        precision: "part_of_day",
        timeOfDay: "下午",
        place: "海边",
        title: "去海边游泳",
        detail: "和小明一起",
        keywords: ["海边"],
        participants: ["小明"],
        sourceMessageId: messageId,
        sourceMessageIds: [messageId],
        dedupeKey: "evt-swim",
      },
      {
        memoryScopeId: privateAId,
        dayKey: "2026-10-29",
        state: "FINAL",
        occurredAt: new Date("2026-10-29T12:00:00Z"),
        title: "主人加班到很晚",
        detail: "她说很累",
        dedupeKey: "evt-ot",
      },
    ],
  });

  // 忆泡日历：一天一行进度。日历页读这张表，所以它必须进包。
  await prisma.memoryEventDay.createMany({
    data: [
      {
        memoryScopeId: globalScopeId,
        dayKey: "2026-10-30",
        state: "FINAL",
        eventCount: 4,
        extractedAt: new Date("2026-10-31T01:00:00Z"),
      },
      {
        memoryScopeId: privateAId,
        dayKey: "2026-10-29",
        state: "DRAFT",
        eventCount: 1,
      },
    ],
  });

  // 日记 / 手账：全局范围一天一条，手账的「今日一句」摘自第 1 版日记。
  const journalId = randomUUID();
  await prisma.characterJournal.create({
    data: {
      id: journalId,
      memoryScopeId: globalScopeId,
      dayKey: "2026-10-30",
      status: "ACTIVE",
      diaryState: "GENERATED",
      handbookState: "GENERATED",
      diaryDecidedAt: new Date("2026-10-31T02:00:00Z"),
      handbookDecidedAt: new Date("2026-10-31T02:00:00Z"),
    },
  });
  const diaryRevisionId = randomUUID();
  await prisma.journalRevision.createMany({
    data: [
      {
        id: diaryRevisionId,
        journalId,
        kind: "DIARY",
        version: 1,
        title: "海边的风",
        content: "今天和小明去了海边。",
        sourceMessageIds: [messageId],
        revisionType: "AI_GENERATED",
        promptVersion: "v1",
        model: "deepseek-chat",
      },
      {
        journalId,
        kind: "HANDBOOK",
        version: 1,
        content: "上午：读了两页书。",
        thought: "想再去一次。",
        quote: "今天和小明去了海边。",
        tags: ["海边"],
        sourceDiaryRevisionId: diaryRevisionId,
        sourceMessageIds: [messageId],
        revisionType: "AI_GENERATED",
        promptVersion: "v1",
        model: "deepseek-chat",
      },
    ],
  });

  await prisma.memorySnapshot.createMany({    data: [
      {
        snapshotKey: `auto-snapshot:${globalScopeId}:p1`,
        memoryScopeId: globalScopeId,
        kind: "AUTOMATIC",
        version: 1,
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-10-08T00:00:00Z"),
        summary: "这一段她学会了游泳。",
        structuredContent: { highlights: ["游泳"] },
        status: "CURRENT",
        generatedAt: new Date("2026-10-08T01:00:00Z"),
      },
      {
        snapshotKey: `auto-snapshot:${globalScopeId}:p0`,
        memoryScopeId: globalScopeId,
        kind: "AUTOMATIC",
        version: 1,
        periodStart: new Date("2026-09-24T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        summary: "更早的旧版本总结。",
        structuredContent: {},
        status: "SUPERSEDED",
      },
    ],
  });

  await prisma.characterCatchphrase.createMany({
    data: [
      { characterId, phrase: "不烧心吗", usage: "吃到辣的", status: "ACTIVE", enabled: true },
      { characterId, phrase: "待确认的梗", usage: "还没点头", status: "PENDING", enabled: true },
    ],
  });

  // ── 1. 导出 ───────────────────────────────────────────────
  const exported = await loadCharacterExportBundle({ characterId, ownerId: ownerA });
  assert.ok(exported, "本人导出应该拿得到包");
  const bundle = exported.bundle;

  assert.equal(bundle.character.name, "小鱼");
  assert.ok(bundle.memories.find((item) => item.content === "主人住在杭州")?.originId, "导出必须携带长期记忆血缘 ID");
  assert.ok(bundle.events.find((item) => item.title === "去海边游泳")?.originId, "导出必须携带忆泡血缘 ID");
  assert.ok(bundle.snapshots.find((item) => item.summary === "这一段她学会了游泳。")?.originId, "导出必须携带阶段总结血缘 ID");
  assert.equal(bundle.counts.memories, 3, "只有角色全局 + 自己的私人记忆进包");
  assert.equal(bundle.counts.privateMemories, 1, "私人记忆要单独计数，导入时要提示");
  assert.equal(bundle.counts.events, 2, "忆泡同样按范围过滤");
  assert.equal(bundle.counts.eventDays, 2, "忆泡日历的天要跟着走，否则导入后日历是空的");
  assert.equal(bundle.counts.journals, 1, "日记/手账一天一条");
  assert.equal(bundle.counts.journalRevisions, 2, "日记与手账各一版都要带走");
  assert.equal(bundle.counts.snapshots, 1, "只带 CURRENT 版本，旧版本不进包");
  assert.equal(bundle.counts.catchphrases, 1, "待确认的梗不进包");

  assert.equal(bundle.journals[0]?.dayKey, "2026-10-30");
  assert.equal(bundle.journals[0]?.revisions[1]?.quote, "今天和小明去了海边。", "今日一句要带走");
  assert.equal(
    bundle.journals[0]?.revisions[1]?.sourceDiaryVersion,
    1,
    "今日一句的出处用版本号表达，不用旧机器的 revision id",
  );

  const contents = bundle.memories.map((item) => item.content);
  assert.ok(contents.includes("主人住在杭州"));
  assert.ok(contents.includes("主人喜欢冰美式"));
  assert.ok(!contents.includes("B 的秘密：他姓王"), "别的用户的私人记忆绝对不能进包");
  assert.ok(
    !contents.includes("小明住在北海，怕冷"),
    "朋友的记忆走 friends 段，不混进角色自己的记忆列表",
  );

  // 她的朋友：只有真的互动过的才算
  assert.equal(bundle.counts.friends, 1, "只有 interactionCount > 0 的关系才算朋友");
  assert.equal(bundle.counts.friendMemories, 1);
  assert.equal(bundle.counts.friendAliases, 2, "备注条数也要如实声明");
  assert.equal(bundle.friends[0]?.platform, "qq-onebot");
  assert.equal(bundle.friends[0]?.platformUid, "888888");
  assert.equal(bundle.friends[0]?.displayName, "小明");
  assert.deepEqual(bundle.friends[0]?.aliases, ["小鱼干", "阿明"], "她怎么叫他，要跟着卡走");
  assert.equal(bundle.friends[0]?.interactionCount, 7, "聊过几次要带过去");
  assert.equal(bundle.friends[0]?.firstSource, "GROUP", "在哪儿认识的要带过去");
  assert.equal(bundle.friends[0]?.lastInteractedAt, "2026-10-30T10:00:00.000Z");
  assert.equal(bundle.friends[0]?.memories[0]?.content, "小明住在北海，怕冷");
  assert.ok(
    !bundle.friends.some((friend) => friend.platformUid === "999999"),
    "0 次互动的残留不是朋友，不该进包",
  );

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes("v1.aaa.bbb.ccc"), "导出的 JSON 里不能出现 API Key 密文");
  assert.ok(!serialized.includes("chatApiKeyEncrypted"));
  assert.ok(!serialized.includes("linkedUserId"), "账号绑定不随包走");

  // 分享型导出：朋友整段清空（QQ 号是别人的，发出去前应当由人决定）
  const shareable = await loadCharacterExportBundle({ characterId, ownerId: ownerA, includeFriends: false });
  assert.equal(shareable?.bundle.counts.friends, 0, "includeFriends=false 时不带朋友");
  assert.deepEqual(shareable?.bundle.friends, []);
  assert.ok(!JSON.stringify(shareable?.bundle).includes("888888"), "分享型导出里不能残留朋友的 QQ 号");

  // 非本人导出 = 查不到
  assert.equal(
    await loadCharacterExportBundle({ characterId, ownerId: userB }),
    null,
    "别人的角色导不出来",
  );

  // ── 2. 导入（同一个人另一台机器）────────────────────────────
  const first = await importCharacterCard({ raw: JSON.parse(serialized), ownerId: ownerA });
  characterIds.push(first.characterId);
  assert.equal(first.name, "小鱼 副本", "撞名加后缀，不覆盖原角色");
  assert.deepEqual(first.counts, bundle.counts, "导入条数与包内声明一致");

  const imported = await prisma.character.findUniqueOrThrow({
    where: { id: first.characterId },
    include: {
      memorySetting: true,
      memoryScopes: { include: { memoryItems: true, events: true, snapshots: true } },
      catchphrases: true,
    },
  });
  assert.equal(imported.status, "ACTIVE", "导入后可直接对话");
  assert.equal(imported.modelConfig && (imported.modelConfig as Record<string, unknown>).chatModel, "deepseek-chat");
  assert.equal(
    (imported.modelConfig as Record<string, unknown>).chatApiKeyEncrypted,
    undefined,
    "导入不认密钥字段，必须重新配置",
  );
  assert.equal(imported.memorySetting?.nextSnapshotAt, null, "周期边界不继承旧机器");
  assert.equal(imported.memorySetting?.rawMessageCleanupEnabled, false, "清理开关不能跟着包走");

  const importedGlobal = imported.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL");
  const importedPrivate = imported.memoryScopes.find((scope) => scope.scopeType === "USER_PRIVATE");
  assert.ok(importedGlobal, "必须新建角色全局范围");
  assert.ok(importedPrivate, "有私人记忆时要建私人范围");
  assert.equal(importedPrivate?.userId, ownerA, "私人记忆归属导入者");
  assert.equal(importedGlobal?.memoryItems.length, 2);
  assert.equal(importedPrivate?.memoryItems.length, 1);
  assert.equal(importedGlobal?.events.length, 1);
  assert.equal(importedGlobal?.snapshots.length, 1);
  assert.equal(importedGlobal?.snapshots[0]?.version, 1, "只带当前版本，导入后记为第 1 版");
  assert.ok(
    importedGlobal?.snapshots[0]?.snapshotKey.startsWith("imported-snapshot:"),
    "导入的总结用独立 key，不冒充自动生成的那一条",
  );
  assert.equal(imported.catchphrases.length, 1);

  const importedEvent = importedGlobal?.events[0];
  assert.deepEqual(importedEvent?.sourceMessageIds, [], "原文没跟过来，来源数组必须为空");
  assert.equal(importedEvent?.sourceMessageId, null, "来源指针必须置空，不能指向别的消息");
  assert.equal(importedEvent?.participants[0], "小明", "参与者照常保留");

  // 忆泡日历：两天的进度行都要落地，状态与整理时间保留
  const importedDays = await prisma.memoryEventDay.findMany({
    where: { memoryScopeId: { in: imported.memoryScopes.map((scope) => scope.id) } },
    orderBy: { dayKey: "asc" },
  });
  assert.equal(importedDays.length, 2, "两个记忆范围各一天的进度行都要建");
  const importedFinalDay = importedDays.find((day) => day.dayKey === "2026-10-30");
  assert.equal(importedFinalDay?.state, "FINAL", "已收口的天不能变成 DRAFT");
  assert.equal(importedFinalDay?.eventCount, 4, "当天的忆泡条数保留原值");
  assert.equal(
    importedFinalDay?.extractedAt?.toISOString(),
    "2026-10-31T01:00:00.000Z",
    "上次整理时间要保住，否则日历页显示「还没整理过」",
  );
  assert.equal(importedDays.find((day) => day.dayKey === "2026-10-29")?.state, "DRAFT");

  // 日记 / 手账：正文、版本、今日一句的指向都要回来
  const importedJournals = await prisma.characterJournal.findMany({
    where: { memoryScopeId: importedGlobal.id },
    include: { revisions: { orderBy: { version: "asc" } } },
  });
  assert.equal(importedJournals.length, 1, "手账主体要落库");
  const importedJournal = importedJournals[0];
  assert.equal(importedJournal?.dayKey, "2026-10-30");
  assert.equal(importedJournal?.diaryState, "GENERATED", "有正文就必须是 GENERATED，否则会被自动任务重写");
  assert.equal(importedJournal?.revisions.length, 2);
  const importedDiary = importedJournal?.revisions.find((revision) => revision.kind === "DIARY");
  const importedHandbook = importedJournal?.revisions.find((revision) => revision.kind === "HANDBOOK");
  assert.equal(importedDiary?.content, "今天和小明去了海边。");
  assert.equal(importedDiary?.version, 1, "版本号原样保留");
  assert.equal(importedHandbook?.quote, "今天和小明去了海边。");
  assert.equal(importedHandbook?.thought, "想再去一次。");
  assert.equal(
    importedHandbook?.sourceDiaryRevisionId,
    importedDiary?.id,
    "今日一句要重新指向本机新建的那一版日记，不能留旧 id",
  );
  assert.deepEqual(importedHandbook?.sourceMessageIds, [], "旧机器的原文指针不能跟过来");
  assert.deepEqual(importedDiary?.sourceMessageIds, []);

  // 朋友：关系、计数和记忆都要回来，但身份不能重复建、绑定不能被改写
  const importedFriend = imported.memoryScopes.find((scope) => scope.scopeType === "EXTERNAL_IDENTITY");
  assert.ok(importedFriend, "朋友要建一条 EXTERNAL_IDENTITY 范围");
  assert.equal(importedFriend?.externalIdentityId, friendIdentityId, "沿用已存在的外部身份，不新建");
  assert.equal(importedFriend?.interactionCount, 7, "聊过几次要保住");
  assert.equal(importedFriend?.firstSource, "GROUP", "在哪儿认识的保住");
  assert.deepEqual(importedFriend?.aliases, ["小鱼干", "阿明"], "备注不能丢：丢了她就只会喊平台昵称");
  assert.equal(importedFriend?.lastInteractedAt?.toISOString(), "2026-10-30T10:00:00.000Z");
  assert.equal(importedFriend?.memoryItems.length, 1);
  assert.equal(importedFriend?.memoryItems[0]?.content, "小明住在北海，怕冷");
  assert.ok(
    importedFriend?.scopeKey.endsWith(`qq-onebot:888888`),
    "scopeKey 按新角色重建，指向同一个人",
  );

  const identities = await prisma.externalIdentity.findMany({
    where: { platform: "qq-onebot", platformUid: "888888" },
  });
  assert.equal(identities.length, 1, "同一个 QQ 号不能因为导入多出一行身份");
  assert.equal(identities[0]?.linkedUserId, userB, "导入不能改写已有身份的验证绑定");
  assert.equal(identities[0]?.status, "VERIFIED", "导入不能把已验证身份改回未验证");

  // 原角色一条记忆都不能少
  const originalMemoryCount = await prisma.memoryItem.count({
    where: { memoryScope: { characterId } },
  });
  assert.equal(originalMemoryCount, 5, "导入不动原角色（5 条记忆仍在）");

  // ── 2.5 合并：同一个她的另一台机器上的数据 ──────────────────
  assert.equal(
    imported.originCharacterId,
    characterId,
    "导入要把血缘带过来，否则以后再导回来就认不出是同一个她",
  );

  // 模拟两台设备分叉：本地改写同一条记忆，但 originId 不变；合并时必须认出是同一条并保留本地。
  const localLineageMemory = importedGlobal?.memoryItems.find((item) => item.content === "主人住在杭州");
  assert.ok(localLineageMemory?.originId, "导入后必须保留源记忆血缘 ID");
  await prisma.memoryItem.update({ where: { id: localLineageMemory.id }, data: { content: "本机后来修订的住址记忆。" } });

  // 第一次合并：即使正文已在本机改写，也应按 originId 识别为同一条，不新增副本。
  const reconciled = await importCharacterCard({
    raw: JSON.parse(serialized),
    ownerId: ownerA,
    targetCharacterId: first.characterId,
  });
  assert.equal(reconciled.mode, "merge", "指定目标时走合并");
  assert.equal(reconciled.characterId, first.characterId, "合并进目标角色，不新建");
  assert.equal(reconciled.added.memories, 0, "同一 originId 即使正文分叉也不该长出重复记忆");
  assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: localLineageMemory.id } })).content, "本机后来修订的住址记忆。", "合并必须保留本机对同一记忆的修订");
  assert.equal(reconciled.added.events, 0);
  assert.equal(reconciled.added.journalRevisions, 0);
  const mergedMemoryCount = await prisma.memoryItem.count({
    where: {
      memoryScope: {
        characterId: first.characterId,
        scopeType: { in: ["CHARACTER_GLOBAL", "USER_PRIVATE"] },
      },
    },
  });
  assert.equal(mergedMemoryCount, 3, "合并后条数没变（2 条全局 + 1 条私人）");

  // 让两边「各长一段时间」：本地改写日记、删掉手账，再合并 → 导入的接成新版本
  const localJournal = await prisma.characterJournal.findFirstOrThrow({
    where: { memoryScopeId: importedGlobal.id, dayKey: "2026-10-30" },
    include: { revisions: true },
  });
  const localDiary = localJournal.revisions.find((revision) => revision.kind === "DIARY");
  assert.ok(localDiary, "本地要有日记版本");
  await prisma.journalRevision.update({
    where: { id: localDiary.id },
    data: { content: "本地后来改写过的日记。" },
  });
  await prisma.journalRevision.deleteMany({ where: { journalId: localJournal.id, kind: "HANDBOOK" } });

  // 备注也「各自长了一段时间」：本地新起了一个叫法，合并后应当两边都在、本地在前。
  assert.ok(importedFriend, "后面要改本地备注，先确认这条关系范围在");
  await prisma.memoryScope.update({
    where: { id: importedFriend.id },
    data: { aliases: ["本地叫法", "小鱼干"] },
  });

  const merged = await importCharacterCard({
    raw: JSON.parse(serialized),
    ownerId: ownerA,
    targetCharacterId: first.characterId,
  });
  assert.equal(merged.added.journalRevisions, 2, "日记与手账各补一版");
  assert.equal(merged.added.journals, 0, "那一天本来就在，不该再建一条主体");

  const mergedFriend = await prisma.memoryScope.findUniqueOrThrow({
    where: { id: importedFriend.id },
    select: { aliases: true },
  });
  assert.deepEqual(
    mergedFriend.aliases,
    ["本地叫法", "小鱼干", "阿明"],
    "合并时备注取并集：本地叫法在前，导入的补在后面，重复的不重复出现",
  );

  const mergedJournal = await prisma.characterJournal.findUniqueOrThrow({
    where: { id: localJournal.id },
    include: { revisions: { orderBy: { version: "asc" } } },
  });
  const diaries = mergedJournal.revisions.filter((revision) => revision.kind === "DIARY");
  const handbooks = mergedJournal.revisions.filter((revision) => revision.kind === "HANDBOOK");
  assert.equal(diaries.length, 2, "本地那版不动，导入的接成第 2 版");
  assert.equal(diaries[0]?.content, "本地后来改写过的日记。", "本地内容必须原样保住");
  assert.equal(diaries[1]?.content, "今天和小明去了海边。", "导入的接在后面");
  assert.equal(diaries[1]?.version, 2, "版本号从本地最大值继续排");
  assert.equal(handbooks.length, 1, "被删掉的手账重新补进来");
  assert.equal(handbooks[0]?.version, 1);
  assert.equal(
    handbooks[0]?.sourceDiaryRevisionId,
    diaries[1]?.id,
    "今日一句要指向导入进来的那一版日记，而不是本地改写的那版",
  );

  // 同名但不同源：不猜名字，直接拒绝
  const stranger = await prisma.character.create({
    data: { id: randomUUID(), ownerId: ownerA, name: "小鱼", basePrompt: "另一个同名角色" },
  });
  characterIds.push(stranger.id);
  await assert.rejects(
    () => importCharacterCard({
      raw: JSON.parse(serialized),
      ownerId: ownerA,
      targetCharacterId: stranger.id,
    }),
    /不是同一份数据来的/,
    "同名但不同源的角色不能合并",
  );

  // ── 3. 导入到另一个人手上 ─────────────────────────────────
  const forB = await importCharacterCard({ raw: JSON.parse(serialized), ownerId: userB });
  characterIds.push(forB.characterId);
  assert.equal(forB.name, "小鱼", "B 没有同名角色，用原名");

  const bPrivate = await prisma.memoryScope.findFirst({
    where: { characterId: forB.characterId, scopeType: "USER_PRIVATE" },
    select: { userId: true, memoryItems: { select: { content: true } } },
  });
  assert.equal(bPrivate?.userId, userB, "私人记忆换人后归导入者，不串给导出者");
  assert.ok(bPrivate?.memoryItems.some((item) => item.content === "主人喜欢冰美式"));

  console.log("角色卡数据库测试通过：他人私人记忆不出包、朋友段只收互动过的关系、分享型导出清空朋友、身份复用且不改绑定、导入只新增、来源置空、双人导入归属正确、重复合并不长数据、合并追加手账版本并重指向今日一句、同名不同源拒绝合并。");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const scoped = { memoryScope: { characterId: { in: characterIds } } };
    await prisma.message.deleteMany({ where: { conversation: { characterId: { in: characterIds } } } });
    await prisma.conversation.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.memoryItem.deleteMany({ where: scoped });
    await prisma.memoryEvent.deleteMany({ where: scoped });
    await prisma.memorySnapshotSource.deleteMany({ where: { snapshot: { memoryScope: { characterId: { in: characterIds } } } } });
    await prisma.memorySnapshot.deleteMany({ where: scoped });
    await prisma.memoryJob.deleteMany({ where: scoped });
    await prisma.characterCatchphrase.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.externalIdentity.deleteMany({ where: { id: { in: identityIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, userB] } } });
    await prisma.$disconnect();
  });
