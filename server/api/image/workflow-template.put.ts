import { createError, readBody } from "h3";
import { requireAdminActor } from "../../utils/auth";
import { TEMPLATE_FILE_NAME, parseWorkflowTemplate, writeWorkflowTemplate } from "../../utils/comfy-workflow-template";

/**
 * 存一份工作流模板（ComfyUI 的 API 格式）。
 *
 * 三种入参都收，省得前端为了「粘贴一大段 JSON」和「传对象」写两套：
 *   - `{ template: { ... } }` —— 页面里编辑过的对象
 *   - 顶层直接就是节点对象 —— 直接把 ComfyUI 导出的 API JSON POST 过来
 *   - `{ text: "<json 字符串>" }` —— 用户在输入框里粘贴的原文
 *
 * 校验在 `parseWorkflowTemplate` 里：必须是 API 格式，且提示词真的注得进去
 * （有 KSampler、positive 连到带 text 的节点）。不合格的模板提交上去不会报错，
 * 只会画出一张与描述无关的图 —— 那种故障最难查，所以在保存这一刻就拦掉。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody(event).catch(() => null);
  const text = pickTemplateText(body);
  if (!text) {
    throw createError({ statusCode: 400, statusMessage: "请求里没有模板内容（需要 template / text，或直接提交节点对象）。" });
  }
  const result = await writeWorkflowTemplate(text);
  if (!result.ok) {
    throw createError({ statusCode: 400, statusMessage: `模板没通过校验：${result.reason}` });
  }
  return {
    ok: true,
    fileName: TEMPLATE_FILE_NAME,
    path: result.path,
    updatedAt: result.updatedAt,
    bytes: result.bytes,
  };
});

function pickTemplateText(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  // 传原文就原样落盘：用户自己排的缩进和换行是有用的，不要重排成一行。
  if (typeof record.text === "string") return record.text.trim() || null;
  if (record.template && typeof record.template === "object" && !Array.isArray(record.template)) {
    return JSON.stringify(record.template, null, 2);
  }
  // 看起来就是节点表本身（每个值都带 class_type）时，原样当成模板。
  const values = Object.values(record);
  const looksLikeGraph = values.length > 0 && values.every(item =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item)
    && typeof (item as { class_type?: unknown }).class_type === "string");
  return looksLikeGraph ? JSON.stringify(record, null, 2) : null;
}
