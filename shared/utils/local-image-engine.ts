/**
 * 本地生图引擎（ComfyUI + Anima）的公共约定：地址、默认模型文件名、出图档位。
 *
 * 前后端都要用同一份：
 *   - 服务端要按档位挑模型文件、拼工作流；
 *   - 设置页要在下拉里列出这两个默认文件名，且「留空 = 按档位自动选」得和
 *     服务端的判断一模一样 —— 两处各写一份名字，改一处就会对不上。
 *
 * 这里只放**常量与纯函数**，不碰 fs / fetch，客户端也能安全 import。
 */

/** 服务商标识。存进 `modelConfig.imageProvider`，也出现在日志与消息 metadata 里。 */
export const LOCAL_IMAGE_PROVIDER = "comfyui";

/** ComfyUI 默认端口 8188；和 `启动Anima.bat` 里那条命令一致。 */
export const LOCAL_IMAGE_DEFAULT_BASE_URL = "http://127.0.0.1:8188";

/**
 * 两个档位对应的默认模型文件。
 *
 * Turbo 是蒸馏版，8~12 步、CFG 1，一张十几秒，用来刷图；
 * Aesthetic 是精修版，30 步、CFG 4.5，慢四倍但细节和光影更好。
 * 文件名带 `.safetensors`，因为它们是要填进 ComfyUI `UNETLoader.unet_name` 的值。
 */
export const LOCAL_IMAGE_MODELS = {
  fast: "anima-turbo-v1.1.safetensors",
  quality: "anima-aesthetic-v1.1.safetensors",
} as const;

/** 出图档位：只影响本地引擎（云端服务商不看这个字段）。 */
export type LocalImageQuality = keyof typeof LOCAL_IMAGE_MODELS;

/**
 * 读档位。默认 `fast`：本地出图慢，默认值要选那个「点了就有反应」的。
 * 只认 `quality`，其它一切（含 undefined、旧数据）都当 `fast`。
 */
export function resolveLocalImageQuality(value: unknown): LocalImageQuality {
  return value === "quality" ? "quality" : "fast";
}

/** 档位 → 模型文件名。`model` 非空（用户手填/引擎里挑的）时以它为准。 */
export function resolveLocalImageModel(quality: LocalImageQuality, model?: string): string {
  const explicit = (model ?? "").trim();
  return explicit || LOCAL_IMAGE_MODELS[quality];
}

/** 给人看的档位说明，设置页和测试结果共用一套说法。 */
export const LOCAL_IMAGE_QUALITY_LABELS: Record<LocalImageQuality, string> = {
  fast: "快速（Turbo，12 步，约 10~15 秒）",
  quality: "精修（Aesthetic，30 步，约 40~60 秒）",
};
