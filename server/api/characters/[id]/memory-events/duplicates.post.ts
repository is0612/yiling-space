import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { archiveDuplicate } from "../../../../utils/memory-event-duplicates";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object" || typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) throw createError({ statusCode: 400, statusMessage: "缺少有效预览凭证。" });
  const keepId = requireUuid(typeof body.keepId === "string" ? body.keepId : "", "保留忆泡");
  const candidateId = requireUuid(typeof body.candidateId === "string" ? body.candidateId : "", "隐藏忆泡");
  if (keepId === candidateId) throw createError({ statusCode: 400, statusMessage: "不能隐藏同一条忆泡。" });
  return archiveDuplicate(getPrisma(), { ownerId, characterId, keepId, candidateId, token: body.token });
});
