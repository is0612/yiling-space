import { createError, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { EVENT_TIME_OF_DAY, type EventTimeOfDay } from "../../../../utils/memory-ai";

/**
 * 编辑 / 隐藏 / 恢复一条忆泡。
 *
 * 忆泡是「那天发生了什么」的事实记录，所以这里**只允许改描述性字段**（标题、详情、
 * 地点、人物、时段），不接受改 `occurredAt` 与来源消息 —— 那等于伪造时间线。
 * `dedupeKey` 也不随标题重算：它是身份键，重算可能与另一条撞上。
 *
 * 隐藏用软删除（ARCHIVED），不物理删除：时间线和「那天」都还要能回溯，
 * 恢复就是把状态改回 ACTIVE。
 */
function readParticipants(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value.slice(0, 8)) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, 40);
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const eventId = requireUuid(getRouterParam(event, "eventId") ?? "", "忆泡");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();

  const existing = await prisma.memoryEvent.findFirst({
    where: { id: eventId, memoryScope: { is: { characterId, character: { is: { ownerId } } } } },
    select: { id: true, title: true, status: true, memoryScopeId: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "忆泡不存在或不属于当前角色。" });

  const data: Prisma.MemoryEventUpdateInput = {};
  if (body.title !== undefined) {
    data.title = readTrimmedString(body.title, "事件标题", 200, { required: true });
  }
  if (body.detail !== undefined) {
    data.detail = readTrimmedString(body.detail, "事件详情", 4000, { required: true });
  }
  if (body.place !== undefined) {
    // 空字符串 = 清掉地点，所以不设 required。
    data.place = readTrimmedString(body.place, "地点", 200) || null;
  }
  if (body.participants !== undefined) {
    const participants = readParticipants(body.participants);
    if (!participants) throw createError({ statusCode: 400, statusMessage: "相关人物必须是字符串数组。" });
    data.participants = participants;
  }
  if (body.timeOfDay !== undefined) {
    const value = typeof body.timeOfDay === "string" ? body.timeOfDay.trim() : "";
    if (value && !(EVENT_TIME_OF_DAY as readonly string[]).includes(value)) {
      throw createError({ statusCode: 400, statusMessage: "时段只能是凌晨/早上/上午/中午/下午/傍晚/晚上/深夜。" });
    }
    data.timeOfDay = (value || null) as EventTimeOfDay | null;
  }
  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "ARCHIVED") {
      throw createError({ statusCode: 400, statusMessage: "状态只能是 ACTIVE 或 ARCHIVED。" });
    }
    data.status = body.status;
  }
  if (Object.keys(data).length === 0) {
    throw createError({ statusCode: 400, statusMessage: "没有需要修改的字段。" });
  }

  const updated = await prisma.memoryEvent.update({
    where: { id: eventId },
    data,
    select: {
      id: true,
      dayKey: true,
      occurredAt: true,
      timeOfDay: true,
      place: true,
      participants: true,
      title: true,
      detail: true,
      state: true,
      status: true,
      memoryScope: { select: { scopeType: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: ownerId,
      characterId,
      action: data.status === "ARCHIVED"
        ? "memory.event_archived"
        : data.status === "ACTIVE"
          ? "memory.event_restored"
          : "memory.event_updated",
      entityType: "MemoryEvent",
      entityId: eventId,
      details: {
        before: { title: existing.title, status: existing.status },
        changed: Object.keys(data),
      },
    },
  });

  return {
    id: updated.id,
    dayKey: updated.dayKey,
    occurredAt: updated.occurredAt.toISOString(),
    timeOfDay: updated.timeOfDay,
    place: updated.place,
    participants: updated.participants,
    title: updated.title,
    detail: updated.detail,
    state: updated.state,
    status: updated.status,
    scope: updated.memoryScope.scopeType === "USER_PRIVATE" ? "private" : "character",
  };
});
