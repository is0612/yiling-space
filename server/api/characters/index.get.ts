import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { requireActorUserId } from "../../utils/auth";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characters = await getPrisma().character.findMany({
    where: { ownerId },
    include: characterInclude,
    orderBy: { updatedAt: "desc" },
  });

  return characters.map(toCharacterDto);
});
