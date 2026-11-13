import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../app/pages/growth/memory/interaction-experiences.vue", import.meta.url), "utf8");
assert(!source.includes("生成候选（调用模型）"));
assert(!source.includes("assistantMessageId"));
assert.match(source, /空闲 30 分钟后，后台自动收尾/u);
assert.match(source, /ACTIVE: "已生效"/u);
assert.match(source, /没有明确反馈，不对回应效果下结论/u);
assert.match(source, /旧版待审核候选/u);
assert.match(source, /el-pagination/u);
const ast = ts.createSourceFile("page.ts", source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(n => !ts.isImportDeclaration(n) && !n.getText(ast).startsWith("await useCharacterListData"));
const names = statements.flatMap(n => ts.isVariableStatement(n) ? n.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []) : ts.isFunctionDeclaration(n) && n.name ? [n.name.text] : []);
const compiled = ts.transpileModule(`(function(){${statements.map(n => n.getText(ast)).join("\n")}\nreturn {${names.join(",")}}})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Options = { method?: string; body?: Record<string, unknown>; query?: Record<string, unknown> };
type Request = { url: string; options?: Options; resolve: (v: unknown) => void; reject: (e: unknown) => void };
function harness() {
 const role={value:{id:"a"}}; const requests:Request[]=[]; let watcher=()=>{}; let unmount=()=>{}; let notices=0;
 const context=createContext({ref:(v:unknown)=>({value:v}),reactive:(v:unknown)=>v,computed:(get:()=>unknown)=>({get value(){return get();}}),useRoute:()=>({path:"/growth/memory/interaction-experiences"}),useCharacterSelection:()=>({character:role}),definePageMeta:()=>{},watch:(_:unknown,cb:()=>void)=>{watcher=cb;cb();},onBeforeUnmount:(cb:()=>void)=>{unmount=cb;},ElMessage:{success(){notices++;}},$fetch:(url:string,options:Options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))});
 const bindings=new Script(compiled).runInContext(context) as Record<string,any>;
 return {get:(key:string)=>bindings[key].value,call:(key:string,...args:unknown[])=>bindings[key](...args),draft:bindings.draft,take:()=>{assert(requests.length);return requests.shift()!;},switch:(id:string)=>{role.value={id};watcher();},unmount:()=>unmount(),notices:()=>notices,remaining:()=>requests.length};
}
const item=(id="card",status="ACTIVE")=>({id,status,revision:3,content:"先给结论",context:"讨论方案",feedbackQuote:"这样更清楚",weight:0.5});
const page=(current:number,pageCount:number,total:number,items:unknown[]=[])=>({items,pagination:{page:current,pageSize:20,total,pageCount}});
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
{
 const h=harness();const old=h.take();h.switch("b");const b=h.take();h.switch("a");const fresh=h.take();fresh.resolve(page(1,1,2,[item("fresh"),item("legacy","PENDING")]));await tick();old.resolve({items:[item("stale")]});b.reject(new Error("old"));await tick();assert.equal(h.get("items")[0].id,"fresh");assert.equal(h.get("items").length,2);assert.equal(h.get("error"),"");assert.equal(h.get("loading"),false);
}
{
 const h=harness();h.take().resolve({items:[item()]});await tick();const refresh=h.call("load");h.take().reject({data:{statusMessage:"读取失败"}});await refresh;assert.equal(h.get("items").length,1);assert.equal(h.get("error"),"读取失败");assert.equal(h.get("loading"),false);
 h.call("edit",item());h.draft.content="";await h.call("operate",item(),"EDIT");assert.match(h.get("editorError"),/请填写/u);assert.equal(h.remaining(),0);
 h.draft.content="先说重点";const save=h.call("operate",item(),"EDIT");const req=h.take();assert.equal(req.options?.method,"PATCH");assert.equal(req.options?.body?.revision,3);assert.equal(req.options?.body?.content,"先说重点");h.switch("b");const list=h.take();req.resolve({});await save;assert.equal(h.notices(),0);assert.equal(h.get("busy"),false);list.resolve({items:[]});await tick();
}
{
 const h=harness();const req=h.take();h.unmount();req.resolve({items:[item()]});await tick();assert.equal(h.get("items").length,0);
}
{
 const h=harness();h.take().resolve({items:[],automation:{enabled:false,status:"IDLE",lastError:null}});await tick();assert.equal(h.get("automationLabel"),"互动经验自动整理已关闭");
 const refresh=h.call("load");h.take().resolve({items:[],automation:{enabled:true,status:"running",lastError:null}});await refresh;assert.equal(h.get("automationLabel"),"正在整理互动经验");
 h.switch("b");assert.equal(h.get("automation"),null);h.take().resolve({items:[],automation:{enabled:true,status:"future-status",lastError:null}});await tick();assert.equal(h.get("automationLabel"),"自动收尾已开启");
}
{
 const h=harness();h.take().resolve({items:[],automation:{enabled:false,status:"WAITING",lastError:"MODEL_FAILED"}});await tick();assert.match(h.get("automationError"),/模型整理失败/u);
 const toggle=h.call("toggleAutomation");const request=h.take();assert(request.url.endsWith("/settings"));assert.equal(request.options?.method,"PATCH");assert.equal(request.options?.body?.enabled,true);h.switch("b");h.take().resolve({items:[],automation:{enabled:false,status:"WAITING",lastError:null}});request.resolve({enabled:true});await toggle;assert.equal(h.notices(),0);assert.equal(h.get("automation").enabled,false);
}
assert.match(source, /不是必须照做的语言规则/u);
for (const label of ["当时情境", "原误解", "纠正", "下次判断"]) assert(source.includes(label));
{
 const h=harness();h.take().resolve({items:[]});await tick();
 const learning={kind:"REFERENCE",situation:"两人谈到另一个成员",misunderstanding:"误以为在说自己",correction:"对方澄清是另一个人",nextJudgment:"先确认指代再接话"};
 const structured={...item(),learning};
 assert.equal(h.call("learningLabel",learning),"指代识别");
 assert.equal(h.call("readLearning",{...learning,kind:"UNKNOWN"}),null);
 assert.equal(h.call("readLearning",{...learning,correction:"x".repeat(401)}),null);
 assert.equal(h.call("headline",structured),"先确认指代再接话");
 assert.equal(h.call("headline",item()),"先给结论");
 h.call("edit",structured);assert.equal(h.draft.structured,true);assert.equal(h.draft.misunderstanding,learning.misunderstanding);
 h.draft.correction="";await h.call("operate",structured,"EDIT");assert.match(h.get("editorError"),/请填写当时情境/u);assert.equal(h.remaining(),0);
 h.draft.correction="明确指向另一位成员";h.draft.nextJudgment="先确定对象，再判断是否接话";
 const save=h.call("operate",structured,"EDIT");const request=h.take();
 assert.equal(request.options?.body?.content,h.draft.nextJudgment);assert.equal(request.options?.body?.context,learning.situation);
 assert.equal((request.options?.body?.learning as Record<string,unknown>).correction,h.draft.correction);
 h.unmount();request.resolve({});await save;
 const old=harness();old.take().resolve({items:[]});await tick();old.call("edit",item());assert.equal(old.draft.structured,false);
 const legacySave=old.call("operate",item(),"EDIT");const legacyRequest=old.take();assert.equal(legacyRequest.options?.body?.learning,null);old.unmount();legacyRequest.resolve({});await legacySave;
}
{
 // 分页：默认第一页已生效；翻页带 page；切状态回到第 1 页并带上 status。
 const h=harness();const first=h.take();
 assert.equal(first.options?.query?.status,"ACTIVE");assert.equal(first.options?.query?.page,1);assert.equal(first.options?.query?.pageSize,20);
 first.resolve(page(1,3,41,[item()]));await flush();
 assert.equal(h.get("total"),41);assert.equal(h.get("pageCount"),3);assert.equal(h.get("status"),"ACTIVE");
 h.call("changePage",2);const second=h.take();assert.equal(second.options?.query?.page,2);
 second.resolve(page(2,3,41,[]));await flush();assert.equal(h.get("page"),2);
 h.call("changeStatus","DISABLED");const third=h.take();assert.equal(third.options?.query?.status,"DISABLED");assert.equal(third.options?.query?.page,1);
 third.resolve(page(1,1,0,[]));await flush();assert.equal(h.get("page"),1);assert.equal(h.remaining(),0);
 h.call("changeStatus","DELETED");assert.equal(h.remaining(),0,"Unknown status must not trigger a request");
}
{
 // 停在越界页（例如停用了最后一页的最后一条）要回退到最后一个有效页，而不是空白页。
 const h=harness();h.take().resolve(page(1,1,0,[]));await flush();
 h.call("changePage",9);const beyond=h.take();beyond.resolve(page(9,3,41,[]));await flush();
 const refill=h.take();assert.equal(refill.options?.query?.page,3);refill.resolve(page(3,3,41,[item("last")]));await flush();
 assert.equal(h.get("page"),3);assert.equal(h.get("items").length,1);assert.equal(h.remaining(),0);
}
assert(!source.includes("settings/memory"));
assert.match(source,/开启后会调用角色模型/u);
assert.match(source,/关闭只停止新整理，已生效经验仍可读取/u);
console.log("Interaction experience page regression passed: paginated status-filtered list, page clamp after removal, automatic UI contract, independent settings, legacy separation, automation status, refresh/error retention, A-B-A races, validation/revision writes and stale mutation/unmount rejection (script-level, no API writes).");
