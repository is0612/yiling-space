import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid, readTrimmedString } from "../../../../utils/local-api";
import { buildUserPrivateScopeKey } from "../../../../utils/memory-scope-access";
import { getPrisma } from "../../../../utils/prisma";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryItem } from "../../../../../shared/types/memory";
import { toMemoryItem } from "../../../../utils/memory-item-dto";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const content = readTrimmedString(body?.content, "记忆内容", 12000, { required: true });
  const categoryInput = body?.category;
  if (typeof categoryInput !== "string" || !(MEMORY_CATEGORIES as readonly string[]).includes(categoryInput)) {
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

  // 返回形状与列表同源（MemoryItem）：前端拿到这条可以直接进列表，不用再补字段。
  // 额外带一个 scope 作为入参回显，标明这次写进了哪个范围。
  const memory = await prisma.memoryItem.create({
    data: { memoryScopeId, category, content, status: "ACTIVE" },
    select: {
      id: true, category: true, content: true, status: true, importance: true, validTo: true,
      createdAt: true, updatedAt: true,
      memoryScope: { select: { scopeType: true } },
    },
  });
  setResponseStatus(event, 201);
  return {
    ...toMemoryItem(memory),
    scope: scopeInput,
  } satisfies MemoryItem & { scope: "character" | "private" };
});
