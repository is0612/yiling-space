import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 本机工作流模板：校验 → 读写 → 缓存失效 → 接线。
 *
 * 模板是本地数据（LoRA 路径是这台机器的真实目录），所以这里只动临时数据目录，
 * 不碰真实的 `.data`。断言分三层：
 *   1. `parseWorkflowTemplate` —— 什么样的模板能存、什么样的必须在保存时就拒掉；
 *   2. 读写与缓存 —— 保存后不重启也能读到新内容（Web 和 QQ 适配器是两个进程）；
 *   3. 接线 —— 引擎真的从这份文件读、接口真的鉴权、页面真的调这三个接口。
 */
const ROOT = process.cwd();
const DATA = path.join(ROOT, ".tmp", `test-workflow-template-${process.pid}`);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const savedEnv = process.env.YILING_DATA_DIR;
const savedTemplate = process.env.COMFYUI_TEMPLATE_PATH;
process.env.YILING_DATA_DIR = DATA;
delete process.env.COMFYUI_TEMPLATE_PATH;

// 读取失败时会打警告，那是被测行为的一部分，不该刷满测试输出。
const originalInfo = console.info;
const originalWarn = console.warn;
console.info = () => {};
console.warn = () => {};

try {
  const mod = await import("../server/utils/comfy-workflow-template");
  const { TEMPLATE_FILE_NAME, parseWorkflowTemplate, loadWorkflowTemplate, writeWorkflowTemplate, deleteWorkflowTemplate, resolveTemplatePath } = mod;

  /** 一份最小可用的 MOSS 图：采样器的 positive 连到一个带 text 的文本节点。 */
  const graph = () => ({
    "1": { class_type: "UNETLoader", inputs: { unet_name: "demo/model.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "demo/clip.safetensors", type: "moss_image" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "4": { class_type: "KSampler", inputs: { positive: ["3", 0], negative: ["3", 0], seed: 0, steps: 8, cfg: 1 } },
    "5": { class_type: "SaveImage", inputs: { filename_prefix: "demo" } },
  });

  // ── 1. 校验 ───────────────────────────────────────────────────────
  assert.equal(parseWorkflowTemplate(JSON.stringify(graph())).ok, true, "最小可用的图应当通过");
  const rejected = (text: string, reason: string) => {
    const result = parseWorkflowTemplate(text);
    assert.equal(result.ok, false, `应当拒绝：${reason}`);
    assert.ok(!result.ok && result.reason, `拒绝时必须带原因：${reason}`);
  };
  rejected("{oops", "非法 JSON");
  rejected("[]", "顶层是数组");
  rejected('"text"', "顶层不是对象");
  rejected("{}", "没有任何节点");
  rejected(JSON.stringify({ "1": { inputs: {} } }), "节点缺 class_type");
  rejected(JSON.stringify({ "1": { class_type: "UNETLoader" } }), "节点缺 inputs");
  rejected(JSON.stringify({ "1": { class_type: "LoadImage", inputs: {} } }), "没有 KSampler");
  rejected(JSON.stringify({ "4": { class_type: "KSampler", inputs: { seed: 0 } } }), "positive 没有连线");
  rejected(JSON.stringify({
    "4": { class_type: "KSampler", inputs: { positive: ["9", 0] } },
  }), "positive 指向不存在的节点");
  rejected(JSON.stringify({
    "3": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "4": { class_type: "KSampler", inputs: { positive: ["3", 0] } },
  }), "positive 连到的节点没有 text，提示词注入不进去");
  rejected(JSON.stringify({ ...graph(), "extra": "x".repeat(512 * 1024) }), "超过大小上限");

  // 界面导出的 UI 格式（数组 + 坐标）不是 API 格式，必须拒掉而不是画出一张无关的图。
  rejected(JSON.stringify({ nodes: [{ id: 1, type: "KSampler", pos: [0, 0] }] }), "UI 格式");

  // ── 2. 读写 ───────────────────────────────────────────────────────
  assert.equal(resolveTemplatePath(), "", "没有文件时不该解析出路径（走现拼）");
  assert.equal(await loadWorkflowTemplate(), null, "没有模板 → null");

  const tooBig = await writeWorkflowTemplate("{}");
  assert.equal(tooBig.ok, false, "不合格的模板不许落盘");
  assert.equal(existsSync(path.join(DATA, TEMPLATE_FILE_NAME)), false, "被拒的请求不能留下文件");

  const written = await writeWorkflowTemplate(JSON.stringify(graph(), null, 2));
  assert.equal(written.ok, true, `真实模板写入失败：${written.ok ? "" : written.reason}`);
  if (written.ok) assert.equal(written.bytes, statSync(path.join(DATA, TEMPLATE_FILE_NAME)).size, "回显的字节数要和落盘一致");

  const loaded = await loadWorkflowTemplate();
  assert.ok(loaded, "写入后应当读得到");
  assert.deepEqual(Object.keys(loaded!.template).sort(), ["1", "2", "3", "4", "5"], "节点原样读回");
  assert.equal(loaded!.path, path.join(DATA, TEMPLATE_FILE_NAME), "路径落在数据目录，不跟 cwd 走");

  // ── 3. 缓存按 mtime 失效 ──────────────────────────────────────────
  // 绕过 writeWorkflowTemplate 直接改文件（它自己会清缓存），只靠 mtime 让缓存失效 ——
  // 这才是 QQ 适配器那个进程看到的情形：另一个进程写了文件，它自己什么都没做。
  const changed = graph();
  changed["3"].inputs.text = "changed from another process";
  writeFileSync(path.join(DATA, TEMPLATE_FILE_NAME), JSON.stringify(changed));
  const past = new Date(statSync(path.join(DATA, TEMPLATE_FILE_NAME)).mtimeMs + 2000);
  utimesSync(path.join(DATA, TEMPLATE_FILE_NAME), past, past);
  const reloaded = await loadWorkflowTemplate();
  assert.equal((reloaded!.template["3"]!.inputs as { text: string }).text, "changed from another process", "文件变了不重启也要读到新内容");

  // 文件坏了：回到现拼，不抛。
  writeFileSync(path.join(DATA, TEMPLATE_FILE_NAME), "{broken");
  utimesSync(path.join(DATA, TEMPLATE_FILE_NAME), new Date(past.getTime() + 2000), new Date(past.getTime() + 2000));
  assert.equal(await loadWorkflowTemplate(), null, "模板坏了应当退回现拼，而不是抛错");

  // ── 4. 删除 ───────────────────────────────────────────────────────
  await writeWorkflowTemplate(JSON.stringify(graph()));
  assert.ok(await loadWorkflowTemplate(), "删除前模板在");
  const removed = await deleteWorkflowTemplate();
  assert.deepEqual(removed, { ok: true, removed: true }, "删除应当报告已删除");
  assert.equal(await loadWorkflowTemplate(), null, "删完 → 不走模板");
  assert.equal(existsSync(path.join(DATA, TEMPLATE_FILE_NAME)), false, "文件真的被删了");
  assert.deepEqual(await deleteWorkflowTemplate(), { ok: true, removed: false }, "本来就没有时报告未删除");

  // ── 5. 环境变量指到别处 ──────────────────────────────────────────
  const elsewhere = path.join(DATA, "elsewhere", "custom.json");
  process.env.COMFYUI_TEMPLATE_PATH = elsewhere;
  const external = await writeWorkflowTemplate(JSON.stringify(graph()));
  assert.equal(external.ok, true, "环境变量指定的位置也要能写");
  assert.equal(existsSync(elsewhere), true, "写到了环境变量指定的位置");
  assert.equal(existsSync(path.join(DATA, TEMPLATE_FILE_NAME)), false, "不该在数据目录里再多留一份");
  assert.ok(await loadWorkflowTemplate(), "环境变量指定的位置能读");
  delete process.env.COMFYUI_TEMPLATE_PATH;

  // ── 6. 接线 ───────────────────────────────────────────────────────
  const engine = readFileSync(path.join(ROOT, "server/utils/comfyui-image.ts"), "utf8");
  assert.match(engine, /from "\.\/comfy-workflow-template"/u, "引擎从同一个模块读模板");
  assert.doesNotMatch(engine, /server\/assets\/comfyui-templates/u, "仓库里不该再有默认模板路径");
  assert.equal(existsSync(path.join(ROOT, "server/assets/comfyui-templates")), false, "个人工作流不该留在仓库里");

  const apiDir = path.join(ROOT, "server/api/image");
  const read = readFileSync(path.join(apiDir, "workflow-template.get.ts"), "utf8");
  const write = readFileSync(path.join(apiDir, "workflow-template.put.ts"), "utf8");
  const remove = readFileSync(path.join(apiDir, "workflow-template.delete.ts"), "utf8");
  assert.match(read, /requireActorUserId/u, "读模板要登录");
  assert.match(write, /requireAdminActor/u, "改模板仅限管理员");
  assert.match(remove, /requireAdminActor/u, "删模板仅限管理员");
  assert.match(write, /parseWorkflowTemplate|writeWorkflowTemplate/u, "保存必须过校验");

  const contract = readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8");
  assert.match(contract, /\/image\/workflow-template:/u, "契约里有这个路径");
  for (const method of ["operationId: getImageWorkflowTemplate", "operationId: putImageWorkflowTemplate", "operationId: deleteImageWorkflowTemplate"]) {
    assert.ok(contract.includes(method), `契约缺 ${method}`);
  }

  const dialog = readFileSync(path.join(ROOT, "app/components/WorkflowTemplateDialog.vue"), "utf8");
  assert.match(dialog, /url: "\/image\/workflow-template"/u, "对话框读的是同一个接口");
  for (const method of ["put", "delete"]) assert.ok(dialog.includes(`method: "${method}"`), `对话框要能 ${method.toUpperCase()}`);
  assert.doesNotMatch(dialog, /class_type/u, "结构校验只留在服务端，页面不重复实现一套");
  const settings = readFileSync(path.join(ROOT, "app/components/CharacterModelSettings.vue"), "utf8");
  assert.match(settings, /<WorkflowTemplateDialog v-model="workflowTemplateOpen"/u, "入口要挂上对话框");
  assert.match(settings, /查看 \/ 替换模板/u, "本机引擎下要有入口");

  console.info = originalInfo;
  console.warn = originalWarn;
  console.log("Workflow template: validation rejects UI-format and non-injectable graphs, mtime cache reloads across processes, env override, admin-gated API and settings wiring passed (temp data dir only).");
} finally {
  console.info = originalInfo;
  console.warn = originalWarn;
  process.env.YILING_DATA_DIR = savedEnv;
  if (savedTemplate === undefined) delete process.env.COMFYUI_TEMPLATE_PATH; else process.env.COMFYUI_TEMPLATE_PATH = savedTemplate;
  rmSync(DATA, { recursive: true, force: true });
}
