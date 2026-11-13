import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPrisma } from '../server/utils/prisma';
import { enqueueExperienceReflections, collectExperienceReflectionSources, hasRepeatedExperienceEvidence } from '../server/utils/experience-reflection';
import { processNextReflectionRun } from '../server/utils/reflection-worker';
import { updateExpressionHabit } from '../server/utils/expression-habits';
import { loadExpressionHabitsForPrompt } from '../server/utils/expression-habit-retrieval';
const db = new URL(process.env.DATABASE_URL ?? '');
assert(/^yiling_reflection_test_[a-f0-9]{32}$/.test(db.pathname.slice(1)));
const prisma=getPrisma(), original=globalThis.fetch;
const ownerId=randomUUID(),characterId=randomUUID();
process.env.LLM_API_KEY='mock';process.env.LLM_MODEL='mock';process.env.LLM_BASE_URL='http://127.0.0.1:4010/v1';
try {
 await prisma.user.create({data:{id:ownerId,username:`chain-${ownerId}`,passwordHash:'test'}});
 await prisma.character.create({data:{id:characterId,ownerId,name:'Chain',basePrompt:'test',modelConfig:{interactionExperienceAutoEnabled:true}}});
 const scope=await prisma.memoryScope.create({data:{characterId,scopeType:'USER_PRIVATE',userId:ownerId,scopeKey:randomUUID()}});
 const room=await prisma.conversation.create({data:{characterId,memoryScopeId:scope.id}});
 const base=Date.now()-3*86400000;
 for(let i=0;i<3;i++){const feedback=await prisma.message.create({data:{conversationId:room.id,role:'USER',content:'先说结论更好',occurredAt:new Date(base+i*86400000)}});await prisma.interactionExperience.create({data:{characterId,conversationId:room.id,memoryScopeId:scope.id,assistantMessageId:randomUUID(),feedbackMessageId:feedback.id,evidenceHash:'a'.repeat(64),status:'ACTIVE',content:'先说结论',context:'讨论方案',feedbackQuote:'先说结论更好',learning:{kind:'EXPRESSION'},createdAt:new Date(base+i*86400000)}});}
 assert(!hasRepeatedExperienceEvidence([{feedbackMessageId:'same',createdAt:new Date()},{feedbackMessageId:'same',createdAt:new Date()},{feedbackMessageId:'same',createdAt:new Date()}]));
 assert.equal(await enqueueExperienceReflections(prisma),1);
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));const payload=JSON.parse(body.messages[1].content);assert(payload.sources.every((s:{type:string})=>s.type==='experience'));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({suggestions:[{title:'表达组织',observation:'多次要求结论先行',inference:'讨论方案时可能更适合',recommendation:'保留先给结论的表达倾向',sourceRefs:payload.sources.map((s:{key:string})=>s.key),expression:{kind:'LENGTH',content:'先说结论',context:'讨论方案'}}]})}}]}));};
 assert.equal((await processNextReflectionRun(prisma,{workerId:'test'})).status,'SUCCEEDED');
 const habit=await prisma.characterExpressionHabit.findFirstOrThrow({where:{characterId}});assert.equal(habit.status,'PENDING');assert.equal(habit.conversationId,room.id);
 await updateExpressionHabit(prisma,{ownerId,characterId,habitId:habit.id,body:{operation:'ACTIVATE',expectedRevision:1}});
 assert.equal((await loadExpressionHabitsForPrompt(prisma,characterId,'讨论方案')).length,0);
 assert.equal((await loadExpressionHabitsForPrompt(prisma,characterId,'讨论方案',undefined,{conversationId:room.id,memoryScopeId:scope.id})).length,1);
 const sources=await collectExperienceReflectionSources(prisma,characterId,{conversationId:room.id,memoryScopeId:scope.id},new Date(base-1),new Date());
 await prisma.interactionExperience.update({where:{id:sources[0]!.id},data:{status:'DISABLED'}});
 assert.equal((await loadExpressionHabitsForPrompt(prisma,characterId,'讨论方案',undefined,{conversationId:room.id,memoryScopeId:scope.id})).length,0);
 console.log('Experience reflection language DB chain passed: scoped queue, model execution, PENDING habit, human activation, global exclusion and stale evidence rejection.');
} finally {globalThis.fetch=original;await prisma.$disconnect();}
