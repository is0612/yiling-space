import { createError, getRouterParam } from "h3";
import { buildModelsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterImageApiKey } from "../../../../utils/credential-encryption";
import type { ImageGenerationSettings } from "../../../../utils/image-generation";
import { buildImageGenerationEndpoint, describeImageGatewayRefusal, parseImageResponse, resolveImageGenerationSettings } from "../../../../utils/image-generation";
import { isImageGenerationModel } from "../../../../../shared/utils/vision-models";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 固定的测试画面描述。
 *
 * 不用随机词：内容审核是这条链路上唯一「同一段配置、今天过明天不过」的环节，
 * 换着花样试只会让人分不清是配置坏了还是运气不好。橘猫趴在窗台上是那种
 * 任何一家审核都不会拦的画面。
 */
const TEST_PROMPT = "一只橘猫趴在窗台上打盹，简笔插画，暖色调";

/** 和 generateImage 一样：画图比聊天慢一个量级，先要 b64 再要 url。 */
const TEST_TIMEOUT_MS = 90_000;

type ProbeResult = {
  ok: boolean;
  message: string;
  elapsedMs?: number;
  /** 服务商原文，429 / 403 这类状态码单看没有信息量 */
  detail?: string;
  model?: string;
};

function describeThrottled(detail: string): string {
  if (/余额|额度|欠费|quota|balance|insufficient|billing|credit/i.test(detail)) {
    return "画图额度的余额不足。它和对话额度通常分开计，去控制台看一下这个模型单独的额度。";
  }
  if (/实名|认证|real.?name|verif|开通|activate|permission/i.test(detail)) {
    return "画图账号还没实名或没开通这个模型。到服务商控制台办完，再回来测。";
  }
  return "画图服务返回 429：被限流，或账号还没开通这个模型。稍等再试，或换一个模型。";
}

type CatalogProbe = { ok: true; models: string[] } | { ok: false };

/**
 * 失败时顺手拉一次 `GET /models`，用来分清两种完全不同的病因：
 *
 *   - **模型名不对**：清单里根本没有它 —— 给出清单里的画图模型，照抄一个就行；
 *   - **模型对、路由没开**：清单里有它，但 `/images/generations` 被分组拦下。
 *     `GET /models` 返回的是这家的全局清单，能看到不等于这个令牌分组调得动 ——
 *     这正是「能获取模型、一测就 403」的成因，光看状态码分不出来。
 *
 * 只在失败路径调用：不花钱、几百毫秒。拉不到就 `ok:false`，保留原来那句话 ——
 * 诊断本身不该变成新的失败点。
 */
async function probeImageCatalog(settings: ImageGenerationSettings): Promise<CatalogProbe> {
  try {
    const endpoint = buildModelsEndpoint(settings.apiBaseUrl);
    const response = await fetch(endpoint, {
      headers: { authorization: "Bearer " + settings.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false };
    const payload = await response.json() as unknown;
    const root = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const rawList = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];
    const models: string[] = [];
    for (const item of rawList) {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      const id = record && typeof record.id === "string"
        ? record.id
        : record && typeof record.name === "string"
          ? record.name
          : typeof item === "string" ? item : "";
      const model = id.trim();
      if (model) models.push(model);
    }
    return { ok: true, models };
  } catch {
    return { ok: false };
  }
}

/** 网关拒绝时把话说到能动手的程度：要么换模型名，要么换路（分组 / 官方地址）。 */
async function explainGatewayRefusal(settings: ImageGenerationSettings, fallback: string): Promise<string> {
  const catalog = await probeImageCatalog(settings);
  if (!catalog.ok) return fallback;

  const target = settings.model.trim().toLowerCase();
  const knownHere = catalog.models.some((model) => model.trim().toLowerCase() === target);
  if (knownHere) {
    return `「${settings.model}」确实在这家的模型清单里，但 /images/generations 这条路由你的令牌分组没开通 —— 清单是全局的，看得到不等于调得动（这类中转的画图接口要单独的 image 类型渠道，光有 chat 渠道不够）。两条路：在中转后台把这个模型加进当前分组，或者把地址换成服务商官方地址（MiniMax 是 https://api.minimaxi.com/v1，OpenAI 是 https://api.openai.com/v1）。`;
  }

  const imageModels = catalog.models.filter(isImageGenerationModel).slice(0, 6);
  const sample = imageModels.length
    ? `清单里的画图模型有：${imageModels.join("、")}。`
    : "清单里一个画图模型都没有，这家大概不提供画图。";
  return `「${settings.model}」不在这家的模型清单里，模型名八成不对。${sample}照抄一个再测；如果确实没有对得上的，就换一家支持生图的服务。`;
}

/**
 * 真·鉴权失败要说清三件事，否则用户只能反复贴同一把 Key：
 *
 *   ① 打到了哪 —— 地址换了但 Key 没换，是这类错误最常见的原因；
 *   ② 用的哪把 —— 画图 Key 和对话、看图的 Key 分开存，账号里同时躺着三把；
 *   ③ 长得对不对 —— MiniMax 官方 Key 是 `eyJ` 开头的长 JWT，`sk-` 开头的是
 *      OpenAI / 中转的令牌。官方地址配 `sk-` Key 必然 401，而这从界面上
 *      完全看不出来（两边都是「一串字符」）。
 *
 * Key 只显示前 4 位和总长度：足够认出「是不是我刚填的那把」，又不至于泄露。
 */
function describeImageAuthFailure(input: {
  status: number;
  endpointLabel: string;
  settings: ImageGenerationSettings;
  keyOrigin: string;
  maskedKey: string;
}): Promise<string> | string {
  let host = input.settings.apiBaseUrl;
  try { host = new URL(input.settings.apiBaseUrl).host; } catch { /* 地址解析不了时原样展示 */ }

  const head = input.status === 401
    ? `画图服务不认这把 Key（HTTP 401，发往 ${input.endpointLabel}）。`
    : `画图服务认得 Key，但没放开这个模型（HTTP 403，发往 ${input.endpointLabel}）。`;
  const who = `Key 取自「${input.keyOrigin}」：${input.maskedKey}。`;
  const key = input.settings.apiKey;

  // 官方域名 + 另一家的 Key 前缀 = 「换了地址没换 Key」，不用再探一次
  if (/(^|\.)minimaxi?\.(com|cn)$/i.test(host) && /^sk-/.test(key) && !key.startsWith("eyJ")) {
    return `${head}${who}地址是 MiniMax 官方，但这把 Key 是 sk- 开头 —— MiniMax 官方的 Key 是 eyJ 开头的一长串 JWT，sk- 这种通常是 OpenAI 或中转的令牌，两家不通用。`;
  }
  if (/(^|\.)openai\.com$/i.test(host) && !/^sk-/.test(key)) {
    return `${head}${who}地址是 OpenAI 官方，但这把 Key 不是 sk- 开头，八成填了别家的 Key。`;
  }

  /**
   * 最后一种、也是最容易把人绕晕的一种：**同一把 Key，拉清单通、画图不通**。
   * 那说明 Key 本身没填错，是网关把图片接口路由到了另一个上游 ——
   * 这类中转的图片通道经常单独配 Key，或者干脆没配。探一次清单就能分清。
   */
  return (async () => {
    const catalog = await probeImageCatalog(input.settings);
    if (catalog.ok) {
      return `${head}${who}但同一把 Key 拉 GET /models 是通的 —— 说明 Key 没填错，是这个网关对图片接口有单独的上游/鉴权配置（很常见：图片走另一条通道，那条通道没配 Key 或没开通）。要么在中转后台给图片通道单独配 Key，要么换成服务商官方地址。`;
    }
    return `${head}${who}地址和 Key 可能不是同一家，或者这把 Key 已失效、被停用。画图 Key 跟对话、看图的 Key 是分开存的，换服务商时两样要一起换。`;
  })();
}

/**
 * 「测试画图」：真的让服务商画一张，看它能不能交回一张图。
 *
 * 为什么不能只测连通性：`GET /models` 里躺着模型名、`/images/generations`
 * 也可能回 200，但回的是 `data: []` 或 `data[].error`（MiniMax 一张失败也回 200）。
 * 只看到「请求发出去了」不等于「画画这条路是通的」。
 *
 * 和看图的测试不一样：**这一下是要花钱的**（按张计费），所以：
 *   - 只画一张、尺寸就用配置里那档，不多花；
 *   - **不落盘**：测完就扔，不要在角色的图片目录里留一张谁都不引用的图；
 *   - 错误原文截断带回，按状态码分诊（401 / 402 / 422 / 404 各自修法不同）。
 *
 * 刻意不看 `imageEnabled` 开关：用户得先把模型测通，再去 QQ 那边打开画图开关。
 */
export default defineEventHandler(async (event): Promise<ProbeResult> => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const imageApiKey = await resolveCharacterImageApiKey(character.modelConfig).catch(() => "");
  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const settings = resolveImageGenerationSettings({
    modelConfig: character.modelConfig,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    imageApiKey,
  });
  if (!settings) {
    return {
      ok: false,
      message: imageApiKey || process.env.IMAGE_API_KEY?.trim()
        ? "画图 API 地址无效，请填写完整地址，例如 https://api.minimaxi.com/v1。"
        : "还没有可用的画图配置：请先填写画图 API Key 并保存。",
    };
  }

  let endpoint: URL;
  try {
    endpoint = buildImageGenerationEndpoint(settings.apiBaseUrl);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "画图地址无效。" };
  }

  const endpointLabel = "POST " + endpoint.host + endpoint.pathname;
  const startedAt = Date.now();
  /** 鉴权失败时要报「用的是哪把 Key」：画图 / 对话 / 看图三把分开存，只报状态码永远查不出来 */
  const keyOrigin = imageApiKey.trim() ? "角色设置里保存的画图 Key" : "环境变量 IMAGE_API_KEY";
  const maskedKey = settings.apiKey.slice(0, 4) + "…（共 " + settings.apiKey.length + " 位）";

  const request = async (responseFormat: "b64_json" | "url"):
    Promise<{ ok: true; payload: unknown } | { ok: false; status: number; detail: string }> => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer " + settings.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: settings.model,
          prompt: TEST_PROMPT,
          size: settings.size,
          n: 1,
          response_format: responseFormat,
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const looksLikeHtml = /^\s*<(!doctype|html)/i.test(raw);
        return {
          ok: false,
          status: response.status,
          detail: looksLikeHtml
            ? "服务商返回的是 HTML 错误页（不是 JSON），多半是网关或中转挡下了这个请求。"
            : raw.replace(/\s+/g, " ").slice(0, 300),
        };
      }
      return { ok: true, payload: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return {
        ok: false,
        status: 0,
        detail: name === "TimeoutError" || name === "AbortError"
          ? `画图请求超时（${TEST_TIMEOUT_MS / 1000} 秒）。`
          : "画图接口连不上，请检查地址与网络。",
      };
    }
  };

  // 少数服务商不认 `response_format: b64_json`（400）：退回 url 再要一次。
  // 只对 400 重试 —— 402/422/401 重发一遍还是同样的结果，白花一次钱。
  let result = await request("b64_json");
  if (!result.ok && result.status === 400) result = await request("url");

  const elapsedMs = Date.now() - startedAt;

  if (!result.ok) {
    if (result.status === 0) {
      return { ok: false, message: result.detail, model: settings.model, elapsedMs };
    }
    /**
     * 401/403 先看服务商原话：中转常把「分组没有这个模型的渠道」包装成 403
     * （`this group is not served by this gateway`），那不是 Key 的事。
     * 认出来之后再去清单里对一次模型名 —— 「能获取模型、一测就 403」这种组合，
     * 只有比过清单才知道该改模型名还是该换路。
     */
    const gatewayRefusal = result.status === 401 || result.status === 403
      ? describeImageGatewayRefusal(result.detail)
      : null;
    const message = gatewayRefusal
      ? await explainGatewayRefusal(settings, gatewayRefusal)
      : result.status === 401 || result.status === 403
        ? await describeImageAuthFailure({ status: result.status, endpointLabel, settings, keyOrigin, maskedKey })
        : result.status === 402
          ? "画图服务余额不足，去控制台充值后再测。"
          : result.status === 404
            ? `画图地址或模型名不存在（${endpointLabel}，模型 ${settings.model}）。先确认 Base URL 有没有少 /v1，再确认模型名在这家的清单里。`
            : result.status === 422
              ? "内容审核没通过。测试词是固定的（橘猫打盹），这通常意味着账号被风控，而不是提示词的问题。"
              : result.status === 429
                ? describeThrottled(result.detail)
                : `画图服务返回 HTTP ${result.status}。`;
    return { ok: false, message, detail: result.detail, model: settings.model, elapsedMs };
  }

  const parsed = parseImageResponse(result.payload);
  if (parsed.error || (!parsed.url && !parsed.b64)) {
    return {
      ok: false,
      message: `服务商回了成功，但没有交出图片：${parsed.error || "响应里既没有 url 也没有 b64_json"}。这个模型可能不是生图模型，或不在 /images/generations 这个接口上。`,
      model: settings.model,
      elapsedMs,
    };
  }

  return {
    ok: true,
    message: `画图可用：${settings.model} 画出了 ${settings.size} 的图（这次测试按一张计费，图不落盘）。`,
    model: settings.model,
    elapsedMs,
  };
});
