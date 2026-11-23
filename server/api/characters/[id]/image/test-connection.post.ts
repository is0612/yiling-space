import { createError, getRouterParam } from "h3";
import { resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterImageApiKey } from "../../../../utils/credential-encryption";
import { buildImageGenerationEndpoint, describeImageGatewayRefusal, parseImageResponse, resolveImageGenerationSettings } from "../../../../utils/image-generation";
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
     * 只有认不出网关话术时，才按状态码说鉴权 / 权限。
     */
    const gatewayRefusal = result.status === 401 || result.status === 403
      ? describeImageGatewayRefusal(result.detail)
      : null;
    const message = gatewayRefusal
      ? gatewayRefusal
      : result.status === 401 || result.status === 403
        ? "画图 Key 无效或没有该模型的权限（注意：它和对话、看图的 Key 是分开存的）。"
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
