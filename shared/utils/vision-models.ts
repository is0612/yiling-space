/**
 * 看图模型的「名字判据」：纯字符串，不联网、不查库。
 *
 * 为什么需要它：**生图模型和看图模型的名字长得太像**（都带 image / 图），
 * 而服务商的 `GET /models` 把两类混在同一个列表里返回。用户按「看图」的直觉
 * 挑一个带 image 的，完全合情合理 —— 真正调用时才 404，而 404 的正文往往只有
 * `{"error":"not found"}`，读起来像「地址填错了」，于是开始怀疑 /v1、怀疑 Key。
 *
 * 2026-11-08 实测一台中转：`/models` 里 `gpt-image-2` 排第一位（是个生图模型），
 * `POST /v1/chat/completions` 直接 404（`upstream rejected the request: not found`），
 * 而同一个中转的其它模型全部 200、也都能读图。所以「模型在清单里」和
 * 「这个模型能读图」是两件事，中间还隔着「它在不在 chat 接口上」。
 *
 * 判据只看名字，所以**只能用来提前提醒，不能用来拦截**：
 * 认不出的新名字一律放行 —— 宁可让人撞一次 404，也不要把真能用的模型藏起来。
 */

/** 小写、含厂商前缀（`openai/gpt-image-1`）都能命中，所以用子串而不是全等 */
const IMAGE_GENERATION_NAME_HINTS = [
  // OpenAI
  "gpt-image",
  "dall-e",
  "dalle",
  // Google
  "imagen",
  "nano-banana",
  // Stability / 开源
  "stable-diffusion",
  "stablediffusion",
  "sdxl",
  "sd3",
  "flux",
  // 国内几家（万相 / 即梦 / 可图 / 混元生图）
  "seedream",
  "seededit",
  "qwen-image",
  "wanx",
  "hunyuan-image",
  "cogview",
  "kolors",
  // 视频 / 绘图方向的常见名字，同样不在 chat 接口上
  "kling",
  "midjourney",
  "recraft",
  "ideogram",
];

/**
 * 这个名字看着像「画图」模型吗？
 *
 * 只回答「要不要提醒」，不回答「能不能用」：真正的判据只有实测
 * （看它认不认得红 / 绿 / 蓝三条色带），这里做不了。
 */
export function isImageGenerationModel(model: string): boolean {
  const name = model.trim().toLowerCase();
  if (!name) return false;
  return IMAGE_GENERATION_NAME_HINTS.some((hint) => name.includes(hint));
}

/**
 * 给 404 用的那句话。
 *
 * 必须点明三件事，否则用户会去修错的地方：
 *   ① 名字没错、地址也没错 —— 这个模型确实存在（`/models` 里有）；
 *   ② 错在类别 —— 它只负责生成，不接受图片输入，挂在另一个接口上；
 *   ③ 该怎么办 —— 换一个能读图的对话模型，而不是继续调 Base URL。
 */
export function describeImageGenerationModel(model: string): string {
  return `「${model}」是画图（生图）模型，不是看图模型：它只负责生成图片，不接受图片输入，也不在 /chat/completions 这个接口上 —— 所以调用会失败（服务商常回 404 或 400）。这里的「看图模型」要换成一个能读图的对话模型。`;
}
