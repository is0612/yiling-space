import {getQuery,getRouterParam} from "h3";
import {requireActorUserId} from "../../../../../../utils/auth";
import {requireUuid} from "../../../../../../utils/local-api";
import {getPrisma} from "../../../../../../utils/prisma";
import {listChannelPolicyHistory,parseChannelPolicyListQuery} from "../../../../../../utils/channel-behavior-policy";
export default defineEventHandler(async event=>{const {page,pageSize}=parseChannelPolicyListQuery(getQuery(event));return listChannelPolicyHistory(getPrisma(),{ownerId:await requireActorUserId(event),characterId:requireUuid(getRouterParam(event,"id")??"","角色"),policyId:requireUuid(getRouterParam(event,"policyId")??"","渠道策略"),page,pageSize});});
