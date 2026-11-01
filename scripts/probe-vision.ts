/**
 * 探一探"这个角色的模型到底能不能看图"。
 *
 * 为什么需要它：`deepseek-flash` 这类模型名看不出多模态能力，服务商也不一定写在文档里。
 * 而且"HTTP 200"不等于"它看见了" —— 纯文本接口常常会默默忽略 `image_url`，
 * 照样回 200，只是答非所问。所以这里默认发一张**随机数字**的图，问它图里是几：
 * 答对才叫能看图，答错或答不出来就是只能走 `image-understanding.ts` 的旁路。
 *
 * 用法（每次几十个 token，不会打印 Key）：
 *   npx tsx scripts/probe-vision.ts                              # 所有 ACTIVE 且配了 Key 的角色
 *   npx tsx scripts/probe-vision.ts <characterId>                # 只看一个角色
 *   npx tsx scripts/probe-vision.ts <characterId> --image a.png  # 用指定图片代替随机数字图
 *
 * 随机数字图由本脚本现场生成（不需要 PIL，也不需要联网）：纯白底 + 黑字，
 * 模型只能靠"看见"才能答对，猜对的概率是 1/10。
 */

import "dotenv/config";

import { buildChatCompletionsEndpoint, resolveChatModelSettings } from "../server/utils/chat-model-config";
import { resolveCharacterApiKey } from "../server/utils/credential-encryption";
import { getPrisma } from "../server/utils/prisma";

/** 1×1 透明 PNG：探"接口收不收 image_url"用（不看内容）。 */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type ProbeResult = {
  ok: boolean;
  status: number;
  /** 模型正文。 */
  content: string;
  /** 截断原因；`length` 说明预算被思考过程吃掉了。 */
  finishReason: string;
  detail: string;
};

async function callModel(input: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  content: unknown;
  maxTokens: number;
}): Promise<ProbeResult> {
  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(input.apiBaseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, content: "", finishReason: "", detail: message };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + input.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        messages: [{ role: "user", content: input.content }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.text()).replace(/\s+/g, " ");
    if (!response.ok) {
      return { ok: false, status: response.status, content: "", finishReason: "", detail: body.slice(0, 300) };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, status: response.status, content: "", finishReason: "", detail: "响应不是 JSON：" + body.slice(0, 200) };
    }
    const record = payload as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }> | null };
    const first = record.choices?.[0];
    const content = typeof first?.message?.content === "string" ? first.message.content.trim() : "";
    const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : "";
    const reasoningChars = typeof first?.message?.reasoning_content === "string" ? first.message.reasoning_content.length : 0;
    return {
      ok: true,
      status: response.status,
      content,
      finishReason,
      detail: reasoningChars ? `思考 ${reasoningChars} 字` : "",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, content: "", finishReason: "", detail: `${name}: ${message}` };
  }
}

type Args = { characterId: string; imagePath: string };

function parseArgs(argv: string[]): Args {
  let characterId = "";
  let imagePath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!.trim();
    if (value === "--image") {
      imagePath = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (!value.startsWith("--") && !characterId) characterId = value;
  }
  return { characterId, imagePath };
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = getPrisma();
  const characters = await prisma.character.findMany({
    where: { ...(args.characterId ? { id: args.characterId } : { status: "ACTIVE" }) },
    select: { id: true, name: true, modelConfig: true },
    orderBy: { updatedAt: "desc" },
    take: args.characterId ? 1 : 20,
  });
  if (!characters.length) {
    console.log("没有找到角色。");
    return;
  }

  let imageDataUrl = "";
  if (args.imagePath) {
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(args.imagePath);
    imageDataUrl = `data:${mimeFor(args.imagePath)};base64,${buffer.toString("base64")}`;
    console.log(`使用图片 ${args.imagePath}（${buffer.byteLength} 字节）`);
  }

  for (const character of characters) {
    const settings = resolveChatModelSettings(character.modelConfig);
    const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl).catch(() => "");
    console.log(`\n=== ${character.name} (${character.id})`);
    console.log(`model=${settings.model} base=${settings.apiBaseUrl} key=${apiKey ? apiKey.length + " 字符" : "未配置"}`);
    if (!apiKey) {
      console.log("跳过：没有可用的 API Key。");
      continue;
    }

    const textProbe = await callModel({
      apiBaseUrl: settings.apiBaseUrl,
      apiKey,
      model: settings.model,
      maxTokens: 512,
      content: "只回答两个字：能听见。",
    });
    console.log(`文本调用: ${textProbe.ok ? "通" : "失败"} (HTTP ${textProbe.status}) ${textProbe.ok ? textProbe.content : textProbe.detail}`);

    const imageProbe = await callModel({
      apiBaseUrl: settings.apiBaseUrl,
      apiKey,
      model: settings.model,
      maxTokens: 1536,
      content: [
        { type: "text", text: imageDataUrl
          ? "图里是数字几？只回答那一个数字。"
          : "这张图是什么颜色？只说颜色。" },
        { type: "image_url", image_url: { url: imageDataUrl || "data:image/png;base64," + PIXEL_PNG } },
      ],
    });

    if (!imageProbe.ok) {
      console.log(`图片调用: 失败 (HTTP ${imageProbe.status}) —— 只能走 image-understanding 旁路。`);
      console.log(`  ${imageProbe.detail}`);
      continue;
    }
    if (!imageProbe.content) {
      console.log(`图片调用: 接口接受图片，但没有正文（finish_reason=${imageProbe.finishReason || "未知"}${imageProbe.detail ? "，" + imageProbe.detail : ""}）—— 说明它"收下但没看"，仍要旁路。`);
      continue;
    }
    console.log(`图片调用: 接口接受，回答="${imageProbe.content}"（finish_reason=${imageProbe.finishReason || "-"}）`);
    console.log("  把这个回答和图片的真实内容对一下：答对才是真的能看图，答错/答非所问就是收下但没看。");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void getPrisma().$disconnect().catch(() => undefined);
  });
