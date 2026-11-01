import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid, readTrimmedString } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

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
const memoryStatuses = ["ACTIVE", "SUPERSEDED", "ARCHIVED", "INVALIDATED"] as const;
type MemoryCategory = (typeof memoryCategories)[number];
type MemoryStatus = (typeof memoryStatuses)[number];

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const body = await readBody<Record<string, unknown>>(event);
  const data: { content?: string; category?: MemoryCategory; status?: MemoryStatus } = {};

  if (Object.hasOwn(body ?? {}, "content")) {
    data.content = readTrimmedString(body.content, "记忆内容", 12000, { required: true });
  }
  if (Object.hasOwn(body ?? {}, "category")) {
    if (typeof body.category !== "string" || !(memoryCategories as readonly string[]).includes(body.category)) {
      throw createError({ statusCode: 400, statusMessage: "记忆分类无效。" });
    }
    data.category = body.category as MemoryCategory;
  }
  if (Object.hasOwn(body ?? {}, "status")) {
    if (typeof body.status !== "string") {
      throw createError({ statusCode: 400, statusMessage: "记忆状态无效。" });
    }
    const normalizedStatus = body.status.toUpperCase();
    if (!(memoryStatuses as readonly string[]).includes(normalizedStatus)) {
      throw createError({ statusCode: 400, statusMessage: "记忆状态无效。" });
    }
    data.status = normalizedStatus as MemoryStatus;
  }
  if (Object.keys(data).length === 0) {
    throw createError({ statusCode: 400, statusMessage: "请至少提供要修改的内容、分类或状态。" });
  }

  const prisma = getPrisma();
  const existing = await prisma.memoryItem.findFirst({
    where: {
      id: memoryId,
      memoryScope: { is: { character: { is: { ownerId } } } },
    },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
  }
  if (existing.status === "TRASHED") {
    throw createError({ statusCode: 409, statusMessage: "该记忆已在回收站，请先恢复后再编辑。" });
  }

  return prisma.memoryItem.update({
    where: { id: memoryId },
    data,
    select: {
      id: true,
      category: true,
      content: true,
      status: true,
      confidence: true,
      createdAt: true,
      updatedAt: true,
    },
  });
});
