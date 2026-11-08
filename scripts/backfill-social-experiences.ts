/**
 * 将历史忆泡补入对应角色的社交经历。
 *
 * 默认只预演；传 --apply 才写入。按 MemoryEvent.id 游标分页，重复运行安全：
 * SocialExperience 的 (scopeId, sourceKey) 唯一约束负责最终幂等。
 *
 * 只使用 participantRefs 中的稳定 platform + externalId；不按昵称猜测。
 * 只关联 EXTERNAL_IDENTITY 关系，不复制忆泡正文，不调用模型，不改写 MemoryEvent。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { readExternalParticipantRefs } from "../server/utils/participant-names";
import { buildSocialExperienceSourceKey } from "../server/utils/social-experiences";

const apply = process.argv.includes("--apply");
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const pageSize = pageSizeArg ? Number(pageSizeArg.slice("--page-size=".length)) : 200;
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 2000) {
  throw new Error("--page-size 必须是 1 到 2000 之间的整数");
}

const prisma = getPrisma();
let afterId: string | undefined;
let scanned = 0;
let eligible = 0;
let inserted = 0;
let noEvidence = 0;
let noIdentity = 0;
let noRelation = 0;

console.log(apply ? "模式：写入" : "模式：预演（不会写入）");
console.log(`每批：${pageSize}`);

while (true) {
  const events = await prisma.memoryEvent.findMany({
    where: {
      status: "ACTIVE",
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: pageSize,
    select: {
      id: true,
      sourceMessageId: true,
      sourceMessageIds: true,
      participantRefs: true,
      memoryScope: { select: { characterId: true } },
    },
  });
  if (!events.length) break;
  afterId = events[events.length - 1]!.id;
  scanned += events.length;

  const candidates = events.flatMap((event) => {
    const sourceIds = event.sourceMessageIds.length
      ? event.sourceMessageIds
      : event.sourceMessageId ? [event.sourceMessageId] : [];
    const sourceKey = buildSocialExperienceSourceKey(sourceIds);
    if (!sourceKey) {
      noEvidence += 1;
      return [];
    }
    const refs = readExternalParticipantRefs(event.participantRefs)
      .filter((ref) => ref.platform !== "unknown");
    if (!refs.length) {
      noIdentity += 1;
      return [];
    }
    return refs.map((ref) => ({
      characterId: event.memoryScope.characterId,
      platform: ref.platform,
      platformUid: ref.externalId,
      memoryEventId: event.id,
      sourceKey,
    }));
  });
  if (!candidates.length) continue;

  const identities = await prisma.externalIdentity.findMany({
    where: {
      OR: candidates.map((candidate) => ({
        platform: candidate.platform,
        platformUid: candidate.platformUid,
      })),
    },
    select: {
      platform: true,
      platformUid: true,
      memoryScopes: {
        where: {
          scopeType: "EXTERNAL_IDENTITY",
          characterId: { in: [...new Set(candidates.map((candidate) => candidate.characterId))] },
        },
        select: { id: true, characterId: true },
      },
    },
  });

  const scopeByOwner = new Map<string, string>();
  for (const identity of identities) {
    for (const scope of identity.memoryScopes) {
      scopeByOwner.set(
        [scope.characterId, identity.platform, identity.platformUid].join("\u0000"),
        scope.id,
      );
    }
  }

  const rows = candidates.flatMap((candidate) => {
    const scopeId = scopeByOwner.get([
      candidate.characterId,
      candidate.platform,
      candidate.platformUid,
    ].join("\u0000"));
    if (!scopeId) {
      noRelation += 1;
      return [];
    }
    return [{
      scopeId,
      memoryEventId: candidate.memoryEventId,
      sourceKey: candidate.sourceKey,
    }];
  });

  eligible += rows.length;
  if (apply && rows.length) {
    const result = await prisma.socialExperience.createMany({
      data: rows,
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  if (scanned % (pageSize * 5) === 0) {
    console.log({ scanned, eligible, inserted });
  }
}

console.log("\n历史社交经历回填统计");
console.log({
  scanned,
  eligible,
  inserted: apply ? inserted : undefined,
  previewOnly: !apply,
  skippedWithoutSourceEvidence: noEvidence,
  skippedWithoutParticipantRefs: noIdentity,
  skippedWithoutRelation: noRelation,
});
if (!apply) console.log("确认预演统计无误后，使用 --apply 执行写入。");
await prisma.$disconnect();
