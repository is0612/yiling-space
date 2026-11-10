import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readPageQuery } from "../../../../../utils/pagination";
import { listReflectionRuns } from "../../../../../utils/reflection-service";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const { page, pageSize } = readPageQuery(getQuery(event), { defaultPageSize: 20, maxPageSize: 50 });
  return listReflectionRuns(getPrisma(), { ownerId, characterId, page, pageSize });
});
