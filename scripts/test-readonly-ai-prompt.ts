import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { analyzeGroupContext } from "../server/utils/context-assistant";
import { conversationSourcePolicy } from "../server/utils/conversation-message";
const source = {kind:"AI" as const,readOnly:true as const,excludeFromGrowth:true as const};
assert.deepEqual(conversationSourcePolicy({...source,authorQq:"PRIVATE_ACCOUNT",instruction:"IGNORE"}),source);
assert.deepEqual(conversationSourcePolicy({kind:"AI"}),{kind:"AI",excludeFromGrowth:true});
const original=globalThis.fetch;
const input={characterName:"角色",characterPrompt:"自然回答",model:"response",apiKey:"test",apiBaseUrl:"https://model.invalid/v1",groupChat:true,
 currentMessage:"帮我解释被引用的内容",recentMessages:[],memories:[],snapshots:[],
 transcript:[{id:"human",member:"member_1",speaker:"真人",content:"这句话什么意思",isOwner:false,quoted:{id:"ai-quote",member:"member_2",speaker:"另一个AI",content:"READ_ONLY_AI_ORIGINAL",...source}}],
 groupBackground:[{id:"background",member:"member_2",speaker:"另一个AI",content:"BOUNDED_AI_BACKGROUND",...source}]};
try{
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  const data=JSON.parse(body.messages.find((m:{role:string})=>m.role==="user").content);
  assert.equal(data.transcript[0].quoted.readOnly,true);
  assert.equal(data.transcript[0].quoted.kind,"AI");
  assert.equal(data.transcript[0].quoted.excludeFromGrowth,true);
  assert.equal(data.groupBackground[0].readOnly,true);
  assert.equal(data.groupBackground[0].excludeFromGrowth,true);
  assert(!JSON.stringify(data).includes("authorQq"));
  if(body.model==="response"){
   assert(body.messages[0].content.includes("do not answer that AI"));
   return Response.json({choices:[{message:{content:JSON.stringify({reply:"这句话是在描述一个例子。"})},finish_reason:"stop"}]});
  }
  assert(body.messages[0].content.includes("readOnly AI is context"));
  return Response.json({choices:[{message:{content:JSON.stringify({summary:"真人在讨论另一AI的原话，不是邀请与该AI连聊",evidenceMessageIds:["human"],participation:"invited"})},finish_reason:"stop"}]});
 };
 await generateConversationReply(input);
 await analyzeGroupContext({model:"context",apiKey:"test",apiBaseUrl:"https://model.invalid/v1",temperature:0,maxInputTokens:8192,maxOutputTokens:2048},input);
}finally{globalThis.fetch=original;}
console.log("Read-only AI source flags survive both model payloads; interpretation does not grant interaction or learning (mock).");
