import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { loadSelfUnderstanding } from "../../../../utils/self-understanding-reader";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id, ownerId },
    select: { id: true, memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  // This owner-only page reads derived global records, never a conversation's originals.
  const view = await loadSelfUnderstanding(prisma, {
    characterId: character.id,
    readableScopeIds: character.memoryScopes.map((scope) => scope.id),
    groupChat: false,
    profileOwner: true,
    includeHistory: true,
    includeAllExpressionScenes: true,
  });
  return { characterId: character.id, view };
});
