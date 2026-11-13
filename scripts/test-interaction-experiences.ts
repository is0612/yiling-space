import assert from "node:assert/strict";
import { validateInteractionEvidence, interactionExperienceWeight, interactionExperienceNextStatus } from "../server/utils/interaction-experience-domain";
import { parseInteractionSuggestion, interactionExperiencePrompt, readInteractionExperiences, updateInteractionExperience, listInteractionExperiences } from "../server/utils/interaction-experiences";
import type { PrismaClient } from "../src/generated/prisma/client";
const assistant = { role:"ASSISTANT", conversationId:"room", occurredAt:new Date(1000) };
const feedback = { role:"USER", conversationId:"room", occurredAt:new Date(2000) };
validateInteractionEvidence(assistant,feedback);
for(const invalid of [{...feedback,role:"ASSISTANT"},{...feedback,conversationId:"other"},{...feedback,occurredAt:new Date(500)}]) assert.throws(()=>validateInteractionEvidence(assistant,invalid));
assert.equal(interactionExperienceWeight(new Date(0),new Date(7*86400000)),0.5);
assert.equal(interactionExperienceWeight(new Date(2000),new Date(1000)),1);
assert.equal(interactionExperienceNextStatus("PENDING","ACCEPT"),"ACTIVE");
assert.throws(()=>interactionExperienceNextStatus("REJECTED","ACCEPT"));
assert.deepEqual(parseInteractionSuggestion('{"skip":"no_feedback"}',"嗯"),{skip:"no_feedback"});
assert.deepEqual(parseInteractionSuggestion('{"skip":"boundary"}',"不要公开"),{skip:"boundary"});
assert.throws(()=>parseInteractionSuggestion('{"content":"短一点","context":"讨论时","feedbackQuote":"不存在"}',"这次解释太长了"));
assert.deepEqual(parseInteractionSuggestion('{"content":"先给结论","context":"这次讨论","feedbackQuote":"先给结论更好"}',"我觉得先给结论更好。"),{content:"先给结论",context:"这次讨论",feedbackQuote:"先给结论更好"});
assert.match(interactionExperiencePrompt,/不把模型自评、沉默、换话题、普通附和当成事实/);
assert.match(interactionExperiencePrompt,/稳定边界/);
let query: unknown;
const prisma = {interactionExperience:{findMany:async (input:unknown)=>{query=input;return [{id:"old",content:"先给结论",context:"讨论方案",createdAt:new Date(0)},{id:"new",content:"先给结论",context:"讨论方案",createdAt:new Date(7*86400000)}];}}} as unknown as PrismaClient;
const rows = await readInteractionExperiences(prisma,{characterId:"role",conversationId:"private-room",memoryScopeId:"private-scope",now:new Date(7*86400000),query:"讨论方案，先给结论"});
assert.deepEqual(await readInteractionExperiences(prisma,{characterId:"role",conversationId:"private-room",memoryScopeId:"private-scope",query:"天气预报"}),[]);
assert.deepEqual(await readInteractionExperiences(prisma,{characterId:"role",conversationId:"private-room",memoryScopeId:"private-scope"}),[]);
assert.equal(rows[0]!.id,"new");
assert.deepEqual((query as {where:unknown}).where,{characterId:"role",conversationId:"private-room",memoryScopeId:"private-scope",status:"ACTIVE",conversation:{characterId:"role",memoryScopeId:"private-scope"}});
let experienceWhere: unknown;
let writes = 0;
const serviceMock = {
 character:{findFirst:async()=>({id:"role"})},
 interactionExperience:{findFirst:async (args:unknown)=>{experienceWhere=args;return {id:"card",characterId:"role",conversationId:"room",memoryScopeId:"private",assistantMessageId:"a",feedbackMessageId:"f",feedbackQuote:"这次很好",evidenceHash:"stale-hash",status:"PENDING",revision:1};},findMany:async(args:unknown)=>{experienceWhere=args;return [];},updateMany:async()=>{writes++;return {count:1};}},
 message:{findMany:async()=>[{id:"a",...assistant,content:"已被修改的回复"},{id:"f",...feedback,content:"这次很好"}]},
 conversation:{findFirst:async()=>({id:"room",memoryScopeId:"private"}),findMany:async()=>[]},
  auditLog:{findFirst:async()=>null},
  interactionExperienceProgress:{findFirst:async()=>null},
 $transaction:async(fn:(tx:unknown)=>unknown)=>fn(serviceMock),
} as unknown as PrismaClient;
await assert.rejects(updateInteractionExperience(serviceMock,{ownerId:"owner",characterId:"role",id:"card",revision:1,operation:"ACCEPT"}),/证据已失效/);
assert.equal(writes,0,"Changed assistant evidence must not activate a candidate");
assert(JSON.stringify(experienceWhere).includes("linkedUserId"),"Review must include readable-scope restriction");
await listInteractionExperiences(serviceMock,{ownerId:"owner",characterId:"role"});
assert(JSON.stringify(experienceWhere).includes('"userId":"owner"'),"List must restrict user-private scope");
assert(JSON.stringify(experienceWhere).includes('"status":"VERIFIED"'),"Unverified identity must not be readable");
console.log("Interaction experience tests passed: source order, no silence, quote evidence, privacy boundary, state review, decay, strict room/scope retrieval and service-level stale evidence rejection (mock only).");
const understanding = {kind:"UNDERSTANDING", situation:"对方倾诉时先倾听", misunderstanding:"把诉说当求方案", correction:"只是想说说", nextJudgment:"辨别情绪需要，不急着建议"};
assert.deepEqual(parseInteractionSuggestion(JSON.stringify({content:"先辨别需要",context:"倾诉",feedbackQuote:"只是想说说",learning:understanding}),"我只是想说说" ).learning,understanding);
assert.throws(()=>parseInteractionSuggestion(JSON.stringify({content:"x",context:"x",feedbackQuote:"只是想说说",learning:{...understanding,kind:"INVENTED"}}),"只是想说说"));
const semanticMock = {interactionExperience:{findMany:async()=>[{id:"understanding",content:"辨别诉求",context:"情绪表达",learning:understanding,createdAt:new Date()}]}} as unknown as PrismaClient;
assert.equal((await readInteractionExperiences(semanticMock,{characterId:"role",conversationId:"room",memoryScopeId:"private",query:"心烦得很，陪我待一会儿"}))[0]?.id,"understanding","Paraphrased emotional context recalls supported understanding without identical keywords");
assert.deepEqual(await readInteractionExperiences(semanticMock,{characterId:"role",conversationId:"room",memoryScopeId:"private",query:"今天气温多少"}),[],"Unrelated topic must not always inject judgment card");
