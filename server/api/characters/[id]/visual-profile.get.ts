import { createError } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const profile = await prisma.characterVisualProfile.findUnique({
    where: { characterId },
    include: {
      assets: { orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] },
      outfits: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!profile) return { characterId, profile: null };

  const [recentVersions, currentPublished] = await Promise.all([
    prisma.characterVisualVersion.findMany({
      where: { profileId: profile.id },
      orderBy: { revision: "desc" },
      take: 50,
    }),
    profile.currentPublishedRevision > 0
      ? prisma.characterVisualVersion.findFirst({
          where: { profileId: profile.id, revision: profile.currentPublishedRevision, status: "PUBLISHED" },
        })
      : Promise.resolve(null),
  ]);
  const versions = new Map(recentVersions.map(version => [version.id, version]));
  if (currentPublished) versions.set(currentPublished.id, currentPublished);
  return {
    characterId,
    profile: { ...profile, versions: [...versions.values()].sort((a, b) => b.revision - a.revision) },
  };
});
