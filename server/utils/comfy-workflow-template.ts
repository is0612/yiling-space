import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dataPath } from "./data-dir";

/**
 * 本机 ComfyUI 工作流模板：**本地数据**，不是代码。
 *
 * 它记的是这台机器 `models/loras` 下的真实目录、LoRA 配比、采样器和分辨率。
 * 跟着仓库发出去，别人要么风格全变，要么因为文件名不存在直接失败 —— 所以只落在
 * 数据目录里，通过接口读写，不进 git。
 *
 * 桌面端从开始菜单启动时 cwd 不可控，路径一律走 `dataPath()`，不要自己拼 `.data`。
 */
export const TEMPLATE_FILE_NAME = "comfyui-workflow.json";

/** 一份工作流 JSON 正常几十 KB；给到 512KB 已经远超任何真实工序单。 */
const MAX_TEMPLATE_BYTES = 512 * 1024;

export type TemplateNode = { class_type: string; inputs: Record<string, unknown> };
export type WorkflowTemplate = Record<string, TemplateNode>;

/**
 * 模板位置。
 *
 * `COMFYUI_TEMPLATE_PATH` 优先（给别人预留「放在任意位置」的口子），否则数据目录下的
 * 固定文件名。两者都没命中就返回空串 —— 调用方据此退回现拼模式。
 */
export function resolveTemplatePath(): string {
  const configured = process.env.COMFYUI_TEMPLATE_PATH?.trim();
  if (configured) return resolve(configured);
  const local = dataPath(TEMPLATE_FILE_NAME);
  return existsSync(local) ? local : "";
}

/** 写入时用的目标路径：文件还不存在也要有个确定位置。 */
export function targetTemplatePath(): string {
  const configured = process.env.COMFYUI_TEMPLATE_PATH?.trim();
  return configured ? resolve(configured) : dataPath(TEMPLATE_FILE_NAME);
}

export type TemplateParseResult =
  | { ok: true; template: WorkflowTemplate }
  | { ok: false; reason: string };

/**
 * 只认 ComfyUI 的 **API 格式**（节点 id → 节点），不认 UI 格式（带坐标颜色的 workflow）。
 *
 * 除了「是不是对象」，还必须验一件事：**提示词能不能注入**。模板的价值就是把工序单
 * 交给用户，但项目仍然要往正向文本节点里写她的场景描述；找不到 KSampler 或它的
 * positive 没连到带 `text` 的节点，这份模板提交上去只会画出一张与描述无关的图，
 * 而且不报错。这种模板要在保存时就拒掉，不能等到出图才发现。
 */
export function parseWorkflowTemplate(text: string): TemplateParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BYTES) {
    return { ok: false, reason: `模板超过 ${Math.round(MAX_TEMPLATE_BYTES / 1024)}KB` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "顶层必须是「节点 id → 节点」的对象（API 格式，不是界面导出的 UI 格式）" };
  }
  const graph = parsed as Record<string, unknown>;
  const entries = Object.entries(graph).filter(
    (entry): entry is [string, TemplateNode] => {
      const node = entry[1];
      return Boolean(node) && typeof node === "object" && !Array.isArray(node);
    },
  );
  if (!entries.length) return { ok: false, reason: "没有任何节点" };

  for (const [id, node] of entries) {
    if (typeof node.class_type !== "string" || !node.class_type.trim()) {
      return { ok: false, reason: `节点 ${id} 缺少 class_type` };
    }
    if (!node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      return { ok: false, reason: `节点 ${id} 缺少 inputs` };
    }
  }

  const sampler = entries.find(([, node]) => node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced");
  if (!sampler) return { ok: false, reason: "没有 KSampler / KSamplerAdvanced" };
  const [samplerId, samplerNode] = sampler;
  const positive = samplerNode.inputs.positive;
  const positiveId = Array.isArray(positive) ? String(positive[0]) : "";
  if (!positiveId) return { ok: false, reason: `采样器 ${samplerId} 的 positive 没有连线` };
  const target = graph[positiveId] as TemplateNode | undefined;
  if (!target || typeof target !== "object") {
    return { ok: false, reason: `采样器 ${samplerId} 的 positive 指向不存在的节点 ${positiveId}` };
  }
  if (typeof target.inputs?.text !== "string") {
    return { ok: false, reason: `positive 连到的节点 ${positiveId} 没有 text 输入，提示词注入不进去` };
  }
  return { ok: true, template: graph as WorkflowTemplate };
}

export type LoadedTemplate = {
  template: WorkflowTemplate;
  path: string;
  updatedAt: string;
  bytes: number;
};

/**
 * 缓存按 **mtime** 失效，而不是按进程生命周期。
 *
 * QQ 适配器和 Web 服务是两个进程：接口刚写完模板，适配器如果只在启动时读一次，
 * 那就得手动重启才生效 —— 用户看到的是「保存了没反应」。每次出图多一次 `stat`
 * 的代价可以忽略，换来的是「保存即生效」。
 */
let cache: { path: string; mtimeMs: number; value: LoadedTemplate } | null = null;

export async function loadWorkflowTemplate(): Promise<LoadedTemplate | null> {
  const path = resolveTemplatePath();
  if (!path) {
    cache = null;
    return null;
  }
  try {
    const info = await stat(path);
    if (cache && cache.path === path && cache.mtimeMs === info.mtimeMs) return cache.value;
    const parsed = parseWorkflowTemplate(await readFile(path, "utf8"));
    if (!parsed.ok) {
      console.warn("[image] 工作流模板不可用，回到现拼模式：", parsed.reason, path);
      cache = null;
      return null;
    }
    const value: LoadedTemplate = {
      template: parsed.template,
      path,
      updatedAt: info.mtime.toISOString(),
      bytes: info.size,
    };
    cache = { path, mtimeMs: info.mtimeMs, value };
    console.info(`[image] 工作流模板已载入：${path}`);
    return value;
  } catch (error) {
    // 文件不在是默认状态，不是错误；读不动才值得留一条记录。
    cache = null;
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[image] 工作流模板读取失败，回到现拼模式", error instanceof Error ? error.message : error);
    }
    return null;
  }
}

export type TemplateWriteResult =
  | { ok: true; path: string; updatedAt: string; bytes: number }
  | { ok: false; reason: string };

/** 先写临时文件再 rename：半个文件被引擎读到的后果比「没保存上」更麻烦。 */
export async function writeWorkflowTemplate(text: string): Promise<TemplateWriteResult> {
  const parsed = parseWorkflowTemplate(text);
  if (!parsed.ok) return parsed;
  const target = targetTemplatePath();
  try {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, target);
    cache = null;
    const info = await stat(target);
    return { ok: true, path: target, updatedAt: info.mtime.toISOString(), bytes: info.size };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteWorkflowTemplate(): Promise<{ ok: true; removed: boolean } | { ok: false; reason: string }> {
  const path = resolveTemplatePath();
  if (!path) return { ok: true, removed: false };
  try {
    await unlink(path);
    cache = null;
    return { ok: true, removed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, removed: false };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 给测试和「换模板后立刻生效」用：丢掉进程内的缓存。 */
export function invalidateWorkflowTemplateCache(): void {
  cache = null;
}
