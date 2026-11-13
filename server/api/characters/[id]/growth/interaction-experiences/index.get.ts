import { getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { listInteractionExperiences } from "../../../../../utils/interaction-experiences";
export default defineEventHandler(async event => listInteractionExperiences(getPrisma(), { ownerId: await requireActorUserId(event), characterId: requireUuid(getRouterParam(event, "id") ?? "", "角色") }));
