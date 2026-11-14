import assert from "node:assert/strict";
import { parseExpressionHabitCreate, parseExpressionHabitPatch } from "../server/utils/expression-habits-domain";
import { selectExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { parseEducationDecisions } from "../server/utils/education-transfer";
const base={kind:"TONE",content:"自然表达",context:"",reason:"人工确认"};
assert.equal(parseExpressionHabitCreate(base).chatScope,"ALL");
for(const chatScope of ["GROUP","PRIVATE","ALL"]){assert.equal(parseExpressionHabitCreate({...base,chatScope}).chatScope,chatScope);assert.equal(parseExpressionHabitPatch({operation:"EDIT",expectedRevision:1,chatScope}).chatScope,chatScope);}
for(const chatScope of ["group","unknown",null,true])assert.throws(()=>parseExpressionHabitCreate({...base,chatScope}));
assert.throws(()=>parseExpressionHabitPatch({operation:"ACTIVATE",expectedRevision:1,chatScope:"GROUP"}));
const rows=[{...base,id:"a",revision:1,status:"ACTIVE",chatScope:"ALL" as const},{...base,id:"g",revision:1,status:"ACTIVE",chatScope:"GROUP" as const},{...base,id:"p",revision:1,status:"ACTIVE",chatScope:"PRIVATE" as const}];
assert.deepEqual(selectExpressionHabitsForPrompt("私聊",rows,800,undefined,"GROUP").map(x=>x.id),["a","g"]);
assert.deepEqual(selectExpressionHabitsForPrompt("群聊",rows,800,undefined,"PRIVATE").map(x=>x.id),["a","p"]);
assert.deepEqual(selectExpressionHabitsForPrompt("群聊私聊",rows).map(x=>x.id),["a"]);
assert.equal(selectExpressionHabitsForPrompt("你好",[{...rows[1]!,context:"严肃讨论"}],800,undefined,"GROUP").length,0);
const candidate={kind:"WORDING",mode:"explicit",content:"减少机械反问",sourceIds:["a"],privacySafe:true,consistent:true,general:true};
assert.equal(parseEducationDecisions(JSON.stringify({candidates:[candidate]}),new Set(["a"]))[0]!.chatScope,"ALL");
for(const chatScope of ["GROUP","PRIVATE"]){const x=parseEducationDecisions(JSON.stringify({candidates:[{...candidate,general:false,chatScope,context:"严肃讨论"}]}),new Set(["a"]))[0]!;assert.equal(x.chatScope,chatScope);assert.equal(x.context,"严肃讨论");}
assert.throws(()=>parseEducationDecisions(JSON.stringify({candidates:[{...candidate,chatScope:"OTHER"}]}),new Set(["a"])));
console.log("Expression scope tests passed: defaults, edit whitelist, real scene filtering, lexical contexts and scoped education payloads.");
