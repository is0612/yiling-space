import { requireActorUserId } from "../../utils/auth";
import { TEMPLATE_FILE_NAME, loadWorkflowTemplate, resolveTemplatePath, targetTemplatePath } from "../../utils/comfy-workflow-template";

/**
 * 读当前生效的本机工作流模板。
 *
 * 只给「正在用的那一份」：环境变量指到别处时，数据目录里就算还躺着旧文件也不回显 ——
 * 否则页面上看到的和引擎实际提交的不是同一份，排查会绕远路。
 */
export default defineEventHandler(async (event) => {
  await requireActorUserId(event);
  const loaded = await loadWorkflowTemplate();
  if (!loaded) {
    return {
      exists: false,
      fileName: TEMPLATE_FILE_NAME,
      source: process.env.COMFYUI_TEMPLATE_PATH?.trim() ? "env" : "data",
      path: resolveTemplatePath() || targetTemplatePath(),
      updatedAt: null,
      bytes: 0,
      template: null,
    };
  }
  return {
    exists: true,
    fileName: TEMPLATE_FILE_NAME,
    source: process.env.COMFYUI_TEMPLATE_PATH?.trim() ? "env" : "data",
    path: loaded.path,
    updatedAt: loaded.updatedAt,
    bytes: loaded.bytes,
    template: loaded.template,
  };
});
