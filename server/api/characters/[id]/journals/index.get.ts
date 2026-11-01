import { createError, getQuery, getRouterParam } from "h3";
import type { Prisma } from "../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { buildPage, readPageQuery } from "../../../../utils/pagination";
import { journalRevisionSelect, toJournalListItem, type JournalPageDto } from "../../../../utils/journal-dto";
import { journalCalendarContext } from "../../../../utils/journal-service";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 日记 / 手账列表：一天一条，倒序。
 *
 * 列表同时带日记首句和手账那句，页面不用为了列表再请求一次详情。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const month = String(query.month ?? "").trim();
  if (month && !MONTH_PATTERN.test(month)) {
    throw createError({ statusCode: 400, statusMessage: "month 必须是 YYYY-MM。" });
  }
  const page = readPageQuery(query as Record<string, unknown>, { defaultPageSize: 20, maxPageSize: 60 });

  const where: Prisma.CharacterJournalWhereInput = {
    memoryScope: { is: { characterId, scopeType: "CHARACTER_GLOBAL" } },
    ...(month ? { dayKey: { startsWith: `${month}-` } } : {}),
  };

  const [total, journals] = await Promise.all([
    prisma.characterJournal.count({ where }),
    prisma.characterJournal.findMany({
      where,
      orderBy: [{ dayKey: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.pageSize,
      select: {
        id: true,
        dayKey: true,
        status: true,
        skipReason: true,
        createdAt: true,
        updatedAt: true,
        // 版本按 version 倒序；DTO 取每种 kind 的第一条作为最新版。
        revisions: {
          orderBy: { version: "desc" },
          select: journalRevisionSelect,
        },
      },
    }),
  ]);

  const calendar = journalCalendarContext(new Date(), character.memorySetting?.timezone ?? "Asia/Shanghai");
  const result: JournalPageDto = {
    ...buildPage(journals.map(toJournalListItem), total, page.page, page.pageSize),
    ...calendar,
  };
  return result;
});
