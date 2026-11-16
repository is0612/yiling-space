import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { parseStickerListParams, clampPage, stickerOrderBy, totalPagesOf } from "../../../../utils/sticker-list";
import { toStickerDto } from "../../../../utils/stickers";

/**
 * 这个角色的表情包清单（分页）。图片本体走 `/stickers/<id>/image` 单独取。
 *
 * 参数：`sort` = recent（默认）/ oldest / mostUsed / lastUsed / fresh，
 * `page`（默认 1）、`pageSize`（默认 12，上限 100）、`untagged=1` 只看没写场景的。
 *
 * 排序和分页都在库里做。原来一次全量返回、页面自己排 —— 一百多张时首屏要等整份 JSON，
 * 排序也只是浏览器里重排数组。现在页面只拿当前这一窗。
 *
 * `stats` 是给页面顶部那些计数用的（共几张、停用几张、几张没写场景、几张连了 QQ）：
 * 分页后页面手里只有一页，这些数必须由接口按全量算，否则「停用 3 张」会变成「本页停用 0 张」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const { sort, page: requestedPage, pageSize, untaggedOnly } = parseStickerListParams(getQuery(event));

  // 回收站里的不返回：删掉的表情不该还占着列表，翻回收站走 `/stickers/trash`。
  const baseWhere = { characterId: id, deletedAt: null };
  const where = untaggedOnly ? { ...baseWhere, usage: "" } : baseWhere;

  const [total, statsTotal, disabled, untagged, qqLinked] = await Promise.all([
    prisma.characterSticker.count({ where }),
    prisma.characterSticker.count({ where: baseWhere }),
    prisma.characterSticker.count({ where: { ...baseWhere, enabled: false } }),
    // 与页面判据一致：空串算没写。纯空白的 usage 极少见，按「写了」算（不 trim 是为了能走索引外的简单条件）。
    prisma.characterSticker.count({ where: { ...baseWhere, usage: "" } }),
    prisma.characterSticker.count({ where: { ...baseWhere, qqEmojiId: { not: null } } }),
  ]);

  const totalPages = totalPagesOf(total, pageSize);
  const page = clampPage(requestedPage, totalPages);

  const rows = await prisma.characterSticker.findMany({
    where,
    orderBy: stickerOrderBy(sort),
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return {
    items: rows.map(toStickerDto),
    total,
    page,
    pageSize,
    totalPages,
    stats: {
      // 筛选（untagged=1）时的总数会小于全量，两个都给，页面才不会把「筛出来的张数」当成「共有几张」。
      total: statsTotal,
      disabled,
      untagged,
      qqLinked,
    },
  };
});
