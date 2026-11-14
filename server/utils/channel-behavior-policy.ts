import { createError } from "h3";
import type { Prisma, PrismaClient, ChannelBehaviorPolicy } from "../../src/generated/prisma/client";
import { validateEducationTransferSources } from "./education-transfer";
import { assertPreferenceOwner, lockPreferenceOwner } from "./preferences-sources";
import { parsePreferenceListQuery, preferencePage } from "./preferences-domain";
export const CHANNEL_POLICY_KIND = "GROUP_AT_DISABLED";
export const CHANNEL_POLICY_CONTENT = "被动群聊回复不发送 @ 提醒，引用仍保留。";
export const CHANNEL_POLICY_SOURCE_KINDS = ["EXPRESSION", "SITUATION", "STRATEGY"] as const;
type Owner = { ownerId: string; characterId: string };
export const parseChannelPolicyListQuery = parsePreferenceListQuery;
export function parseChannelPolicyPatch(value: unknown) {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({statusCode:400,statusMessage:"渠道策略请求无效。"});
 const row=value as Record<string,unknown>;
 if(Object.keys(row).some(k=>!["operation","expectedRevision"].includes(k)) || !["ACTIVATE","DISABLE","REJECT"].includes(String(row.operation)) || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision)<1) throw createError({statusCode:400,statusMessage:"渠道策略只支持按版本采纳、停用或驳回。"});
 return {operation:String(row.operation),expectedRevision:Number(row.expectedRevision)};
}
async function snapshot(tx:Prisma.TransactionClient,row:ChannelBehaviorPolicy,actorId:string,action:string){
 await tx.channelBehaviorPolicyRevision.create({data:{policyId:row.id,revision:row.revision,action,kind:row.kind,content:row.content,chatScope:row.chatScope,status:row.status,sourceRefs:row.sourceRefs as Prisma.InputJsonValue,actorId}});
 await tx.auditLog.create({data:{actorType:action==="CREATE"?"SYSTEM":"USER",actorId,characterId:row.characterId,action:`channel_policy.${action.toLowerCase()}`,entityType:"ChannelBehaviorPolicy",entityId:row.id,details:{revision:row.revision,status:row.status,kind:row.kind}}});
}
export async function createChannelPolicyCandidate(tx:Prisma.TransactionClient,input:{characterId:string;actorId:string;sourceRefs:Prisma.InputJsonValue}){
 if(!Array.isArray(input.sourceRefs)||input.sourceRefs.length<1||input.sourceRefs.length>30)throw createError({statusCode:400,statusMessage:"渠道策略缺少有效来源。"});
 const row=await tx.channelBehaviorPolicy.create({data:{characterId:input.characterId,kind:CHANNEL_POLICY_KIND,content:CHANNEL_POLICY_CONTENT,chatScope:"GROUP",status:"PENDING",sourceRefs:input.sourceRefs}});
 await snapshot(tx,row,input.actorId,"CREATE");return row;
}
export async function listChannelPolicies(prisma:PrismaClient,input:Owner&{status:string;q:string;page:number;pageSize:number}){
 await assertPreferenceOwner(prisma,input.ownerId,input.characterId);
 const where={characterId:input.characterId,...(input.status!=="ALL"?{status:input.status}:{})};
 const [items,total]=await Promise.all([prisma.channelBehaviorPolicy.findMany({where,orderBy:{updatedAt:"desc"},skip:(input.page-1)*input.pageSize,take:input.pageSize}),prisma.channelBehaviorPolicy.count({where})]);return preferencePage(items,total,input.page,input.pageSize);
}
export async function updateChannelPolicy(prisma:PrismaClient,input:Owner&{policyId:string;body:unknown}){
 const parsed=parseChannelPolicyPatch(input.body);return prisma.$transaction(async tx=>{
 await lockPreferenceOwner(tx,input.ownerId,input.characterId);
 const row=await tx.channelBehaviorPolicy.findFirst({where:{id:input.policyId,characterId:input.characterId}});
 if(!row)throw createError({statusCode:404,statusMessage:"渠道策略不存在。"});
 if(row.revision!==parsed.expectedRevision)throw createError({statusCode:409,statusMessage:"渠道策略版本已变化。"});
 const status=parsed.operation==="ACTIVATE"&&["PENDING","DISABLED"].includes(row.status)?"ACTIVE":parsed.operation==="DISABLE"&&row.status==="ACTIVE"?"DISABLED":parsed.operation==="REJECT"&&row.status==="PENDING"?"REJECTED":null;
 if(!status)throw createError({statusCode:409,statusMessage:"当前状态不支持此操作。"});
 if(parsed.operation==="ACTIVATE"&&row.status==="PENDING"&&(!Array.isArray(row.sourceRefs)||!row.sourceRefs.every(ref=>ref&&typeof ref==="object"&&!Array.isArray(ref)&&ref.educationMode==="explicit")||!await validateEducationTransferSources(tx,input.characterId,row.sourceRefs,CHANNEL_POLICY_SOURCE_KINDS)))throw createError({statusCode:409,statusMessage:"教育来源或权限已变化。"});
 const changed=await tx.channelBehaviorPolicy.updateMany({where:{id:row.id,characterId:input.characterId,revision:row.revision,status:row.status},data:{status,revision:{increment:1}}});
 if(changed.count!==1)throw createError({statusCode:409,statusMessage:"渠道策略刚刚发生变化。"});
 const policy=await tx.channelBehaviorPolicy.findUniqueOrThrow({where:{id:row.id}});await snapshot(tx,policy,input.ownerId,parsed.operation);return {policy};
 });
}
export async function listChannelPolicyHistory(prisma:PrismaClient,input:Owner&{policyId:string;page:number;pageSize:number}){
 await assertPreferenceOwner(prisma,input.ownerId,input.characterId);if(!await prisma.channelBehaviorPolicy.findFirst({where:{id:input.policyId,characterId:input.characterId},select:{id:true}}))throw createError({statusCode:404,statusMessage:"渠道策略不存在。"});
 const where={policyId:input.policyId,policy:{characterId:input.characterId,character:{ownerId:input.ownerId}}};const [items,total]=await Promise.all([prisma.channelBehaviorPolicyRevision.findMany({where,orderBy:{revision:"desc"},skip:(input.page-1)*input.pageSize,take:input.pageSize}),prisma.channelBehaviorPolicyRevision.count({where})]);return preferencePage(items,total,input.page,input.pageSize);
}
/** Only passive QQ group at segments use this gate. A failed read removes at, never the reply or quote. */
export async function filterPassiveGroupAt(prisma:PrismaClient,characterId:string,atTarget:string|undefined):Promise<string|undefined>{
 if(!atTarget)return undefined;
 try{return await prisma.channelBehaviorPolicy.findFirst({where:{characterId,kind:CHANNEL_POLICY_KIND,chatScope:"GROUP",status:"ACTIVE"},select:{id:true}})?undefined:atTarget;}
 catch{console.error("[channel-policy] policy_read_failed; passive group at suppressed");return undefined;}
}
