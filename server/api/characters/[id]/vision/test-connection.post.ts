import { createError, getRouterParam } from "h3";
import sharp from "sharp";

import { buildChatCompletionsEndpoint, resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../utils/credential-encryption";
import { resolveVisionSettingsForCharacter } from "../../../../utils/image-understanding";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 「测试看图」：真发一张图过去，看它能不能说出图里的三种颜色。
 *
 * 为什么不能只测文本连通性：`HTTP 200` 不等于「它看见了」。
 * 纯文本模型会把 `image_url` 默默忽略，照样 200，答非所问。
 * 更典型的坑是思考模型（deepseek-flash 这类）：接口收图、思考吃掉全部
 * max_tokens、正文为空 —— 从外面看只是「她没说话」。
 *
 * 所以这里造一张**颜色顺序固定**的图（上红 / 中绿 / 下蓝），
 * 答对三种颜色才算真的能看见。图是现画的，不依赖外部网络。
 *
 * 另一个刻意的点：这一步**不看** `imageUnderstanding` 开关。
 * 用户当然要先把模型测通，再去 QQ 那边打开开关 —— 顺序反了会让人以为配置没生效。
 */
const VISION_TEST_PROMPT = "图从上到下有三条色带。只回答你看到的三种颜色，用「/」分隔，不要解释。";

async function buildTestImageDataUrl(): Promise<string> {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">',
    '<rect width="96" height="96" fill="#ffffff"/>',
    '<rect x="8" y="8" width="80" height="22" fill="#e5352b"/>',
    '<rect x="8" y="37" width="80" height="22" fill="#2bb35a"/>',
    '<rect x="8" y="66" width="80" height="22" fill="#2b6be5"/>',
    "</svg>",
  ].join("");
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * 429 至少有三种成因，用户该做的事完全不同：
 *
 *   - **模型自己在排队**（智谱 1305「该模型当前访问量过大」）—— 换一个模型比等更快，
 *     免费档的热门模型在晚上能挤一整天；
 *   - **账号没实名 / 没开通这个模型** —— 去控制台办手续，重试一辈子也没用；
 *   - **额度或余额用尽** —— 去充值，而且视觉额度常常和对话额度分开计。
 *
 * 只看状态码分不出来，必须读服务商正文。判错的代价是让人朝错误方向排查：
 * 把「模型堵了」说成「你可能没实名」，用户会去翻实名认证，然后发现一直是好的。
 */
function describeThrottled(detail: string): string {
  if (/实名|认证|real.?name|verif|开通|activate|permission/i.test(detail)) {
    return "看图的账号还没实名或没开通这个模型。到服务商控制台办完，再回来测。";
  }
  if (/余额|额度|欠费|quota|balance|insufficient|billing|credit/i.test(detail)) {
    return "看图额度的余额不足。它和对话额度常常是分开计的，去控制台看一下这个模型单独的额度。";
  }
  if (/访问量|过多|过大|繁忙|拥挤|overload|busy|too many|capacity|concurrent/i.test(detail)) {
    return "这个视觉模型自己堵了（服务端排队），不是你的 Key 或额度问题。换一个视觉模型通常比等更快 —— 免费档的热门模型在晚上经常这样。";
  }
  return "图片服务返回 429：被限流，或账号还没开通这个模型。稍等再试，或换一个视觉模型。";
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl).catch(() => "");
  const settings = await resolveVisionSettingsForCharacter({
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKey,
  }, { requireSwitch: false });

  if (!settings) {
    return {
      ok: false,
      message: "还没有可用的图片模型配置：请至少填一个看图模型，或让地址与 Key 回落到对话模型（对话模型也得能读图）。",
    };
  }

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "看图服务地址无效。" };
  }

  let imageDataUrl: string;
  try {
    imageDataUrl = await buildTestImageDataUrl();
  } catch {
    return { ok: false, message: "生成测试图片失败（服务端图像库不可用）。" };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer " + settings.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: VISION_TEST_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "这张图里是什么？" },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      // 把服务商的原文带一句回去：429 / 403 这类状态码自己说明不了问题
      // （智谱的免费视觉模型会先卡实名认证或并发，光看 429 只能瞎猜）。
      const raw = await response.text().catch(() => "");
      const detail = raw.replace(/\s+/g, " ").slice(0, 300);
      const message = response.status === 401 || response.status === 403
        ? "看图这把 Key 无效或没有该模型的权限（注意：它和对话模型的 Key 是分开存的）。"
        : response.status === 404
          ? "看图地址或模型名不存在，请检查 Base URL 与模型名称。"
          : response.status === 429
            ? describeThrottled(detail)
            : "图片服务返回 HTTP " + response.status + "。";
      return { ok: false, message, detail, model: settings.model, elapsedMs };
    }

    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    };
    const answer = (payload.choices?.[0]?.message?.content ?? "").trim().replace(/\s+/g, " ");
    const finishReason = payload.choices?.[0]?.finish_reason ?? "";

    if (!answer) {
      // 思考模型最典型的表现：接口 200、正文空、finish_reason=length。
      const reason = finishReason === "length"
        ? "输出预算被思考过程吃光了（finish_reason=length）"
        : "接口接受了图片但没有返回正文";
      return {
        ok: false,
        message: `模型没有回答出内容：${reason}。这个模型不适合当看图模型，换一个不思考的视觉模型。`,
        model: settings.model,
        elapsedMs,
      };
    }

    const sawRed = /红|red/i.test(answer);
    const sawGreen = /绿|green/i.test(answer);
    const sawBlue = /蓝|blue/i.test(answer);
    if (!sawRed || !sawGreen || !sawBlue) {
      return {
        ok: false,
        message: `模型收到了图，但没有读对颜色（它回答「${answer}」）。多半是它不支持读图，或没有视觉权限。`,
        model: settings.model,
        elapsedMs,
      };
    }

    return {
      ok: true,
      message: `看图可用：${settings.model} 认出了红 / 绿 / 蓝。`,
      model: settings.model,
      answer,
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const name = error instanceof Error ? error.name : "Error";
    return {
      ok: false,
      message: name === "TimeoutError" || name === "AbortError"
        ? "看图请求超时（30 秒）。思考型模型读一张图就可能超过这个时间，换一个不思考的视觉模型。"
        : "看图请求失败，请检查地址、Key 与网络。",
      model: settings.model,
      elapsedMs,
    };
  }
});
