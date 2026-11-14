import {getQuery,getRouterParam} from "h3";
import {requireActorUserId} from "../../../../../utils/auth";
import {requireUuid} from "../../../../../utils/local-api";
import {getPrisma} from "../../../../../utils/prisma";
import {listChannelPolicies,parseChannelPolicyListQuery} from "../../../../../utils/channel-behavior-policy";
export default defineEventHandler(async event=>listChannelPolicies(getPrisma(),{ownerId:await requireActorUserId(event),characterId:requireUuid(getRouterParam(event,"id")??"","角色"),...parseChannelPolicyListQuery(getQuery(event))}));
