/**
 * 模型服务商目录：API 根地址 + 常见模型名。
 *
 * 两个用途：
 * 1. 模型设置页里选「服务商」一键带出 API 地址和模型下拉选项；
 * 2. 「获取可用模型」拉取失败（不少服务商不给 `GET /models`）时的兜底清单。
 *
 * ⚠️ 模型名一定会过期。这里只当**起点**：模型下拉允许手填任意名字，
 *    服务商支持列表接口时以拉回来的结果为准。
 * ⚠️ 匹配按**域名**而非 baseUrl 全等：用户常把路径改成 /v1 或兼容模式地址，
 *    全等比对会认不出来，服务商下拉就退回「自定义」了。
 */

export type ModelProvider = {
  key: string;
  name: string;
  /** 一键填充的 API 根地址；空串 = 自定义，不填 */
  baseUrl: string;
  models: string[];
  /** 是否有 `GET /models`。没有的那家（智谱）界面要提示走内置清单 */
  supportsModelList: boolean;
  /**
   * 开放平台 / 控制台地址：用户去这里注册、充值、领取自己的 Key。
   * 表单里挂在「API 地址」右侧，省得用户从别处找入口。
   * 空 = 没有固定入口（自定义），界面不显示链接。
   * ⚠️ 只放**平台根入口或官方 Key 页面**，别拼带参数的深链，改版就会 404。
   */
  consoleUrl?: string;
};

const PROVIDERS: ModelProvider[] = [
  {
    key: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    // 这两项是 2026-10 对本机 Key 实际拉 `GET /models` 拿到的结果，不是抄文档
    models: ["deepseek-flash", "deepseek-v4-pro"],
    supportsModelList: true,
    consoleUrl: "https://platform.deepseek.com/",
  },
  {
    key: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    supportsModelList: true,
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    key: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long"],
    supportsModelList: true,
    consoleUrl: "https://bailian.console.aliyun.com/",
  },
  {
    key: "kimi",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.6", "kimi-k2-thinking", "moonshot-v1-32k"],
    supportsModelList: true,
    consoleUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    key: "zhipu",
    name: "智谱 GLM",
    // 网关不提供模型列表接口（返回 406），只能靠下面的清单
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6", "glm-4.7-flash", "glm-4-flash"],
    supportsModelList: false,
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    key: "hunyuan",
    name: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-lite", "hunyuan-t1-latest"],
    supportsModelList: true,
    consoleUrl: "https://console.cloud.tencent.com/hunyuan",
  },
  {
    key: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"],
    supportsModelList: true,
    consoleUrl: "https://platform.minimaxi.com/",
  },
  {
    key: "siliconflow",
    name: "硅基流动",
    // 聚合平台，模型名随上架变动，一律以拉取结果为准
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [],
    supportsModelList: true,
    consoleUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    key: "custom",
    name: "自定义",
    baseUrl: "",
    models: [],
    supportsModelList: true,
  },
];

export const MODEL_PROVIDERS: readonly ModelProvider[] = PROVIDERS;

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 按域名认服务商：改过路径也认得出；认不出返回 null */
export function providerByBaseUrl(baseUrl: string): ModelProvider | null {
  const host = hostnameOf(baseUrl);
  if (!host) return null;
  const matched = PROVIDERS.find((provider) => {
    if (!provider.baseUrl) return false;
    const providerHost = hostnameOf(provider.baseUrl);
    if (!providerHost) return false;
    return host === providerHost || host.endsWith("." + providerHost);
  });
  return matched ?? null;
}

export function providerByKey(key: string): ModelProvider | null {
  return PROVIDERS.find((provider) => provider.key === key) ?? null;
}

/** 该地址的常见模型清单；不认识则空数组 */
export function catalogModelsForBaseUrl(baseUrl: string): string[] {
  return providerByBaseUrl(baseUrl)?.models ?? [];
}

/**
 * 模型下拉的选项：内置清单 + 当前已填的值（用户手填的名字不能因为不在清单里就消失）
 * + 本次拉取回来的列表（去重，保持顺序）。
 */
export function buildModelOptions(input: {
  baseUrl: string;
  current: string;
  fetched?: string[];
}): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const push = (value: string) => {
    const model = value.trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    options.push(model);
  };
  push(input.current);
  for (const model of input.fetched ?? []) push(model);
  for (const model of catalogModelsForBaseUrl(input.baseUrl)) push(model);
  return options;
}
