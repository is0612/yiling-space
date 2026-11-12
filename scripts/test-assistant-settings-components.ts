/**
 * 助手配置面板的契约。
 *
 * 2026-11-12 之前这里有四份几乎一样的表单、四个独立页签、四套「必须先填独立 Key」的校验。
 * 合并之后这些行为都收进 `AssistantOverridePanel` 一个组件，所以这个测试从
 * 「四个组件各自的行为」改成「一份面板的契约 + 旧入口还能不能进来」。
 *
 * 覆盖的是几条改坏了最难查的约定：
 *   1. 留空就跟随对话模型 —— 占位符必须写出实际会用的值，不能只说「可留空」；
 *   2. 地址换了别家就不许继承 Key —— 否则拿 A 家 Key 打 B 家，只换回一个 401；
 *   3. 拉模型 / 测试连接前必须先落库 —— 那两个接口读的是已保存配置；
 *   4. 旧书签（?section=knowledge / social）仍然能进到对话模型页。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const panel = read("../app/components/AssistantOverridePanel.vue");

// 1. 留空即继承：占位符把对话模型的实际值写出来
assert(panel.includes("跟随对话模型：${chatModel}"), "模型名输入框应在留空时显示对话模型的模型名");
assert(panel.includes("跟随对话模型：${chatApiBaseUrl}"), "地址输入框应在留空时显示对话模型的地址");
assert(panel.includes("留空 = 使用对话模型的 Key"), "Key 输入框应说明留空会继承对话模型的 Key");

// 2. 地址换别家就不能继承 Key —— 这条是「填了地址没填 Key」时唯一的拦截
assert(panel.includes("apiBaseUrl.trim() && !apiKey.trim()"), "单独填地址却没填 Key 时应有提示");
assert(panel.includes("401"), "提示里要说清为什么不共用：不同服务商拿错 Key 只会 401");

// 3. 拉模型 / 测试前先保存
assert(panel.includes("props.requestSave && !(await props.requestSave())"), "拉模型与测试前必须先落库");

// 4. 四个助手只剩一份实现
assert(existsSync(new URL("../app/components/AssistantOverridePanel.vue", import.meta.url)));
assert(
  !existsSync(new URL("../app/components/KnowledgeAssistantSettings.vue", import.meta.url)),
  "知识助手已并入对话模型页，不该再有独立组件",
);
assert(
  !existsSync(new URL("../app/components/SocialAssessmentSettings.vue", import.meta.url)),
  "关系评估助手已并入对话模型页，不该再有独立组件",
);

// 5. 对话模型页确实挂了四个面板，且都传了继承所需的对话模型信息
const settings = read("../app/components/CharacterModelSettings.vue");
for (const title of ["记忆助手", "语境助手", "知识处理助手", "关系评估助手"]) {
  assert(settings.includes(`title="${title}"`), `对话模型页缺少「${title}」分节`);
}
const panelUses = settings.match(/<AssistantOverridePanel/g) ?? [];
assert.equal(panelUses.length, 4, "对话模型页应有且只有四个助手面板");
assert.equal(
  (settings.match(/:chat-api-base-url="draftChatApiBaseUrl"/g) ?? []).length,
  4,
  "四个面板都要拿到对话模型的地址，否则继承提示会是空的",
);

// 6. 侧边栏只剩三项，助手不再是并列能力
const models = read("../app/pages/models.vue");
assert(models.includes("3 项"), "侧边栏应显示 3 项");
for (const gone of ["memoryAssistant", "contextAssistant", "knowledge", "social"]) {
  assert(!models.includes(`key: "${gone}"`), `侧边栏不该再有 ${gone} 这一项`);
}

// 7. 旧书签仍能进来，并且落到对话模型页
for (const path of ["../app/pages/growth/knowledge/settings.vue", "../app/pages/growth/social/assessment-settings.vue"]) {
  const text = read(path);
  assert(text.includes('path: "/models"'), `${path} 应重定向到模型设置页`);
  assert(text.includes('section: "chat"'), `${path} 应落到对话模型页`);
  assert(text.includes("...route.query"), `${path} 应保留角色参数`);
}

console.log("助手面板契约：继承占位符、跨服务商拦截、先存再拉、旧入口重定向，全部通过（script-level）。");
