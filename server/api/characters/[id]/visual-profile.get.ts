import { createError } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const profile = await getPrisma().characterVisualProfile.findUnique({
    where: { characterId },
    include: {
      assets: { orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] },
      outfits: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      versions: { orderBy: { revision: "desc" }, take: 20 },
    },
  });
  return { characterId, profile };
});
