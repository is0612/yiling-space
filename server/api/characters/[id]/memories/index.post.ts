import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid, readTrimmedString } from "../../../../utils/local-api";
import { buildUserPrivateScopeKey } from "../../../../utils/memory-scope-access";
import { getPrisma } from "../../../../utils/prisma";

const memoryCategories = [
  "FACT",
  "PREFERENCE",
  "RELATIONSHIP",
  "COMMITMENT",
  "GOAL",
  "EVENT",
  "SUMMARY",
  "OTHER",
] as const;

type MemoryCategory = (typeof memoryCategories)[number];

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const content = readTrimmedString(body?.content, "记忆内容", 12000, { required: true });
  const categoryInput = body?.category;
  if (typeof categoryInput !== "string" || !(memoryCategories as readonly string[]).includes(categoryInput)) {
    throw createError({ statusCode: 400, statusMessage: "记忆分类无效。" });
  }
  const category = categoryInput as MemoryCategory;
  const scopeInput = body?.scope ?? "character";
  if (scopeInput !== "character" && scopeInput !== "private") {
    throw createError({ statusCode: 400, statusMessage: "记忆范围只支持 character（角色全局）或 private（当前用户私人）。" });
  }
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  let memoryScopeId: string;
  if (scopeInput === "private") {
    // Private memory belongs to the acting user. The scope key encodes character + user, so one
    // record is shared by every conversation this user has with this character.
    const scopeKey = buildUserPrivateScopeKey(characterId, ownerId);
    const privateScope = await prisma.memoryScope.upsert({
      where: { scopeKey },
      create: { characterId, scopeType: "USER_PRIVATE", scopeKey, userId: ownerId },
      update: {},
      select: { id: true, characterId: true, userId: true },
    });
    if (privateScope.characterId !== characterId || privateScope.userId !== ownerId) {
      throw createError({ statusCode: 409, statusMessage: "私人记忆范围的归属与当前用户不一致，已拒绝写入。" });
    }
    memoryScopeId = privateScope.id;
  } else {
    const globalScopeId = character.memoryScopes[0]?.id;
    if (!globalScopeId) {
      throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围，请先重新保存角色档案。" });
    }
    memoryScopeId = globalScopeId;
  }

  const memory = await prisma.memoryItem.create({
    data: { memoryScopeId, category, content, status: "ACTIVE" },
    select: { id: true, category: true, content: true, status: true, createdAt: true, updatedAt: true },
  });
  setResponseStatus(event, 201);
  return { ...memory, scope: scopeInput };
});
