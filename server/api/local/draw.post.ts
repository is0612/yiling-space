import { createError, readBody, setHeader } from "h3";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { requireAdminActor } from "../../utils/auth";
import { generateImageWithComfy } from "../../utils/comfyui-image";

/** 提示词上限，跟 image-generation.ts 保持一致。 */
const PROMPT_MAX_CHARS = 1200;

/**
 * 模型名上限，跟 image-generation.ts 的 `MODEL_MAX_CHARS` 一致。
 * 这个名字会原样进 `UNETLoader.unet_name`，引擎那边按白名单校验（不在列表里就报错），
 * 所以不需要额外做字符过滤，只要卡住长度。
 */
const MODEL_MAX_CHARS = 200;

/** 参考图上限：图生图只用一张立绘，16MB 留足了高分辨率余量。 */
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

/**
 * 允许读取参考图的根目录。
 * 这是个只读本机文件的口子，所以只放行显式列出的目录，不做「任意路径」。
 *
 * 默认只有项目自己这一层（`.data`、`public` 都在里面），够本机自测用；
 * 想读别处的图（比如模型目录里的示例图）就设 DRAW_ALLOWED_ROOTS（逗号分隔）。
 * 不写死任何绝对路径：这个仓库是公开的，别人机器上的目录结构和这里不一样。
 *
 * 这里不做大小写归一：Windows 的 `path.relative` 本身就不区分大小写，
 * 而 Linux 上的路径区分大小写，提前转小写反而会把合法路径认成另一个。
 */
const ALLOWED_ROOTS = (process.env.DRAW_ALLOWED_ROOTS || process.cwd())
  .split(",")
  .map(item => item.trim())
  .filter(Boolean)
  .map(item => normalize(resolve(item)));

/**
 * 根目录本身也可能是指向别处的符号链接（macOS 的 `/tmp` → `/private/tmp`），
 * 所以比较时用真实路径。只在第一次用到时解析，失败就退回配置值。
 */
let realRoots: string[] | null = null;
async function resolvedRoots(): Promise<string[]> {
  if (!realRoots) {
    realRoots = await Promise.all(ALLOWED_ROOTS.map(async root => {
      try { return await realpath(root); } catch { return root; }
    }));
  }
  return realRoots;
}

/**
 * target 是否落在 root 之内。
 *
 * 用 `relative` 判断，而不是拼 `${root}\\` 再 startsWith：分隔符写死反斜杠时，
 * Linux/macOS 上 `/home/x/a.png` 永远不以 `/home/x\` 开头，合法子路径会被全部拒绝。
 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 校验参考图并返回可读的真实路径。
 *
 * 只看规范化后的字符串是不够的：允许目录里如果有指向外部的符号链接，
 * 字符串还是「在目录内」，真正打开却读到了目录外。所以先 realpath 再判断。
 */
async function assertAllowedPath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw createError({ statusCode: 400, message: "参考图请给绝对路径。" });
  let real: string;
  try {
    real = await realpath(normalize(resolve(input)));
  } catch {
    throw createError({ statusCode: 404, message: "参考图不存在或无法读取。" });
  }
  const roots = await resolvedRoots();
  if (!roots.some(root => isInside(root, real))) {
    throw createError({
      statusCode: 403,
      message: `参考图只允许读这些目录下的文件：${ALLOWED_ROOTS.join("、")}。需要更多目录请设置 DRAW_ALLOWED_ROOTS。`,
    });
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw createError({ statusCode: 400, message: "参考图必须是一个文件。" });
  if (info.size > MAX_REFERENCE_BYTES) {
    throw createError({ statusCode: 400, message: `参考图不能超过 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB。` });
  }
  return real;
}

/**
 * 用本机 ComfyUI 画一张图（Anima 或 MOSS，看 `model`）。
 *
 * POST /api/local/draw
 * {
 *   "prompt": "1girl, solo, rainy neon street at night",   // anima 要英文/标签；MOSS 中文也行
 *   "model": "moss_image_sft_int8_convrot.safetensors",    // 选填，留空按档位走 anima
 *   "quality": false,        // true = 精修档（anima 30 步 / MOSS 25 步）
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
  if (!prompt) throw createError({ statusCode: 400, message: "请填写画面描述（Anima 只认英文标签，MOSS 中文也行）。" });
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw createError({ statusCode: 400, message: `画面描述最多 ${PROMPT_MAX_CHARS} 个字符。` });
  }

  const requestedReference = typeof body?.referencePath === "string" ? body.referencePath.trim() : "";
  const referencePath = requestedReference ? await assertAllowedPath(requestedReference) : undefined;

  const result = await generateImageWithComfy({
    prompt,
    /**
     * 选填模型文件。不给就按档位走 anima 默认值；给了 `moss_image_*` 会自动切到
     * MOSS 那套节点组合（CLIP type、VAE、latent 全换），见 `resolveImageFamily`。
     */
    model: typeof body?.model === "string" ? body.model.trim().slice(0, MODEL_MAX_CHARS) || undefined : undefined,
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
