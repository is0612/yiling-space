import {getRouterParam,readBody} from "h3";
import {requireActorUserId} from "../../../../../utils/auth";
import {requireUuid} from "../../../../../utils/local-api";
import {getPrisma} from "../../../../../utils/prisma";
import {updateChannelPolicy} from "../../../../../utils/channel-behavior-policy";
export default defineEventHandler(async event=>updateChannelPolicy(getPrisma(),{ownerId:await requireActorUserId(event),characterId:requireUuid(getRouterParam(event,"id")??"","角色"),policyId:requireUuid(getRouterParam(event,"policyId")??"","渠道策略"),body:await readBody(event)}));
