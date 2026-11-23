import { createError, readBody, setHeader } from "h3";
import { isAbsolute, normalize, resolve } from "node:path";
import { requireAdminActor } from "../../utils/auth";
import { generateImageWithComfy } from "../../utils/comfyui-image";

/** 提示词上限，跟 image-generation.ts 保持一致。 */
const PROMPT_MAX_CHARS = 1200;

/**
 * 允许读取参考图的根目录。
 * 这是个只读本机文件的口子，所以只放行显式列出的目录，不做「任意路径」。
 *
 * 默认只有项目自己这一层（`.data`、`public` 都在里面），够本机自测用；
 * 想读别处的图（比如模型目录里的示例图）就设 DRAW_ALLOWED_ROOTS（逗号分隔）。
 * 不写死任何绝对路径：这个仓库是公开的，别人机器上的目录结构和这里不一样。
 */
const ALLOWED_ROOTS = (process.env.DRAW_ALLOWED_ROOTS || process.cwd())
  .split(",")
  .map(item => item.trim())
  .filter(Boolean)
  .map(item => normalize(resolve(item)).toLowerCase());

function assertAllowedPath(input: string): string {
  if (!isAbsolute(input)) throw createError({ statusCode: 400, message: "参考图请给绝对路径。" });
  const normalized = normalize(resolve(input));
  const lowered = normalized.toLowerCase();
  const allowed = ALLOWED_ROOTS.some(root => lowered === root || lowered.startsWith(root.endsWith("\\") ? root : `${root}\\`));
  if (!allowed) {
    throw createError({
      statusCode: 403,
      message: `参考图只允许读这些目录下的文件：${ALLOWED_ROOTS.join("、")}。需要更多目录请设置 DRAW_ALLOWED_ROOTS。`,
    });
  }
  return normalized;
}

/**
 * 用本机 ComfyUI + Anima 画一张图。
 *
 * POST /api/local/draw
 * {
 *   "prompt": "1girl, solo, rainy neon street at night",   // 英文/标签，中文无效
 *   "quality": false,        // true = 30 步精修（约 50 秒），默认 12 步（约 12 秒）
 *   "width": 896, "height": 1152,
 *   "referencePath": "D:\\\\AI\\\\some.png",  // 可选，给了就是图生图
 *   "denoise": 0.6,          // 可选，仅图生图生效
 *   "seed": 12345            // 可选，固定复现
 * }
 *
 * 返回 dataUrl 而不是文件路径：调用方存哪儿由它自己决定，这个路由不往 .data 写东西。
 */
export default defineEventHandler(async event => {
  await requireAdminActor(event);
  setHeader(event, "Cache-Control", "no-store");

  const body = await readBody<Record<string, unknown>>(event).catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw createError({ statusCode: 400, message: "请填写画面描述（英文或 Danbooru 标签）。" });
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw createError({ statusCode: 400, message: `画面描述最多 ${PROMPT_MAX_CHARS} 个字符。` });
  }

  const referencePath = typeof body?.referencePath === "string" && body.referencePath.trim()
    ? assertAllowedPath(body.referencePath.trim())
    : undefined;

  const result = await generateImageWithComfy({
    prompt,
    quality: body?.quality === true,
    width: typeof body?.width === "number" ? body.width : undefined,
    height: typeof body?.height === "number" ? body.height : undefined,
    referencePath,
    denoise: typeof body?.denoise === "number" ? body.denoise : undefined,
    seed: typeof body?.seed === "number" ? body.seed : undefined,
  });

  if (!result.ok) {
    // 502：上游（本机引擎）没给出图，不是这个接口自己的错。
    throw createError({ statusCode: 502, message: result.reason });
  }

  return {
    ok: true,
    mode: result.mode,
    dataUrl: `data:${result.mime};base64,${result.buffer.toString("base64")}`,
    bytes: result.buffer.length,
    width: result.width,
    height: result.height,
    seed: result.seed,
    elapsedMs: result.elapsedMs,
  };
});
