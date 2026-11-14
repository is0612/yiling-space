import "dotenv/config";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {Client} from "pg";
import {getPrisma} from "../server/utils/prisma";
import {processEducationTransfer} from "../server/utils/education-transfer";
import {filterPassiveGroupAt,updateChannelPolicy,CHANNEL_POLICY_CONTENT,listChannelPolicyHistory} from "../server/utils/channel-behavior-policy";
import {buildOnebotReplyMessage} from "../server/utils/channel-adapter/onebot/serve";
const source=new URL(process.env.DATABASE_URL!);assert(["localhost","127.0.0.1","[::1]"].includes(source.hostname));source.pathname="/postgres";
const name=`yiling_channel_test_${randomUUID().replaceAll("-","")}`;assert(/^yiling_channel_test_[a-f0-9]{32}$/.test(name));const target=new URL(source);target.pathname=`/${name}`;
const admin=new Client({connectionString:source.toString()});await admin.connect();let created=false;const original=globalThis.fetch;
try{
 await admin.query(`CREATE DATABASE "${name}"`);created=true;process.env.DATABASE_URL=target.toString();assert.equal(spawnSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:process.env,stdio:"inherit"}).status,0);
 process.env.LLM_API_KEY="mock";process.env.LLM_MODEL="mock";process.env.LLM_BASE_URL="http://127.0.0.1:4010/v1";
 const db=getPrisma();try{
 const owner=await db.user.create({data:{username:randomUUID(),passwordHash:"test"}});const c=await db.character.create({data:{ownerId:owner.id,name:"测试",basePrompt:"test",modelConfig:{interactionExperienceAutoEnabled:true}}});const scope=await db.memoryScope.create({data:{characterId:c.id,scopeType:"USER_PRIVATE",scopeKey:"private",userId:owner.id}});const room=await db.conversation.create({data:{characterId:c.id,memoryScopeId:scope.id}});
 const a=await db.message.create({data:{conversationId:room.id,role:"ASSISTANT",content:"示例",occurredAt:new Date("2026-11-14T01:00:00Z")}});const f=await db.message.create({data:{conversationId:room.id,role:"USER",content:"以后被动群聊回复不要再@任何人，引用可以保留",occurredAt:new Date("2026-11-14T01:01:00Z")}});const e=await db.interactionExperience.create({data:{characterId:c.id,conversationId:room.id,memoryScopeId:scope.id,assistantMessageId:a.id,feedbackMessageId:f.id,evidenceHash:"a".repeat(64),status:"ACTIVE",content:"避免提醒",context:"群回复",feedbackQuote:f.content,learning:{kind:"SITUATION",situation:"群回复",misunderstanding:"",correction:"禁用提醒",nextJudgment:"保留引用不at"}}});
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({candidates:[{domain:"channel",kind:"GROUP_AT_DISABLED",mode:"explicit",intent:"disable_all_passive_group_at",chatScope:"GROUP",content:"模型正文不能更改固定动作",context:"",sourceIds:[e.id],privacySafe:true,consistent:true}]})}}]}));};
 assert.equal((await processEducationTransfer(db)).status,"SUCCEEDED");const p=await db.channelBehaviorPolicy.findFirstOrThrow({where:{characterId:c.id}});assert.equal(p.status,"PENDING");assert.equal(p.content,CHANNEL_POLICY_CONTENT);assert.equal(await filterPassiveGroupAt(db,c.id,"target"),"target");
 await assert.rejects(updateChannelPolicy(db,{ownerId:randomUUID(),characterId:c.id,policyId:p.id,body:{operation:"ACTIVATE",expectedRevision:1}}));
 await updateChannelPolicy(db,{ownerId:owner.id,characterId:c.id,policyId:p.id,body:{operation:"ACTIVATE",expectedRevision:1}});assert.equal(await filterPassiveGroupAt(db,c.id,"target"),undefined);assert.equal(await filterPassiveGroupAt(db,randomUUID(),"target"),"target");
 const segments=buildOnebotReplyMessage("正文保留","123",await filterPassiveGroupAt(db,c.id,"456"));assert(Array.isArray(segments));assert.deepEqual(segments.map(s=>s.type),["reply","text"]);
 await db.interactionExperience.delete({where:{id:e.id}});await updateChannelPolicy(db,{ownerId:owner.id,characterId:c.id,policyId:p.id,body:{operation:"DISABLE",expectedRevision:2}});assert.equal(await filterPassiveGroupAt(db,c.id,"target"),"target");await updateChannelPolicy(db,{ownerId:owner.id,characterId:c.id,policyId:p.id,body:{operation:"ACTIVATE",expectedRevision:3}});assert.equal((await listChannelPolicyHistory(db,{ownerId:owner.id,characterId:c.id,policyId:p.id,page:1,pageSize:20})).pagination.total,4);assert.equal(calls,1);
 console.log("Channel policy isolated DB: pending/owner activation/role isolation/at-only suppression/quote retained/version/independent reactivation passed.");
 }finally{await db.$disconnect();}
}finally{globalThis.fetch=original;if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
