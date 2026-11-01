import { createError } from "h3";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const character = await getPrisma().character.findFirst({
    where: { id, ownerId },
    include: characterInclude,
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  return toCharacterDto(character);
});
