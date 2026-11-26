/**
 * 显式能力命令：用户在消息开头写 `&出图：…` 这类前缀来点名一项能力。
 *
 * 这里只做前缀识别：分清「是不是命令、是哪一项、正文是什么、格式错在哪」。
 * 不去猜一句话像不像在要画图，也不判断开关、额度、收件人和目标图片 ——
 * 命令本身不授予任何能力，那些都在各自执行前校验。
 */

const COMMAND_LABELS = { image: "出图", voice: "语音", vision: "看图", history: "查记录" } as const;

export type CapabilityCommandName = keyof typeof COMMAND_LABELS;
export const CAPABILITY_COMMAND_LABELS: Readonly<Record<CapabilityCommandName, string>> = COMMAND_LABELS;
/** 超出按格式错误报，不截断：截过的画面描述或查询条件已经不是用户要的那个。 */
export const CAPABILITY_COMMAND_BODY_MAX_CHARS = 2000;

export type CapabilityCommandInvalidReason = "missing_colon" | "empty_body" | "too_long";

export type ParsedCapabilityCommand =
  | { kind: "none" }
  | { kind: "invalid"; name: CapabilityCommandName; reason: CapabilityCommandInvalidReason; hint: string }
  | { kind: "command"; name: CapabilityCommandName; body: string };

export type CapabilityCommandSource = {
  externalMessageId?: string;
  kind?: "AI" | "HUMAN" | "UNKNOWN";
  readOnly?: boolean;
  /** 落库与展示用的全文：会混入 @ 占位、附件占位、协议端给的摘要。 */
  content: string;
  /** 用户手打的文字。有它就只认它。 */
  commandText?: string;
  hasAttachments?: boolean;
  addressedToSelf?: boolean;
};

export type CapabilityCommandRequest = {
  externalMessageId?: string;
  /** 是不是对她说的。解析不因它改变；执行前必须看它。 */
  addressedToSelf: boolean;
  command: Exclude<ParsedCapabilityCommand, { kind: "none" }>;
};

const NONE: ParsedCapabilityCommand = Object.freeze({ kind: "none" }) as ParsedCapabilityCommand;
const PREFIX = "&";
// 长名在前，免得以后加了互为前缀的名字时短的先命中。
const LABELS: ReadonlyArray<readonly [CapabilityCommandName, string]> = (Object.entries(COMMAND_LABELS) as Array<[CapabilityCommandName, string]>)
  .sort((a, b) => b[1].length - a[1].length);

function formatHint(name: CapabilityCommandName, reason: CapabilityCommandInvalidReason): string {
  const written = `&${CAPABILITY_COMMAND_LABELS[name]}：`;
  if (reason === "missing_colon") return `格式不对，要写成「${written}内容」。`;
  if (reason === "empty_body") return `「${written}」后面要写上内容。`;
  return `「${written}」后面的内容太长了，请精简后再发。`;
}

const invalid = (name: CapabilityCommandName, reason: CapabilityCommandInvalidReason): ParsedCapabilityCommand =>
  ({ kind: "invalid", name, reason, hint: formatHint(name, reason) });

export function parseCapabilityCommand(text: string): ParsedCapabilityCommand {
  if (typeof text !== "string") return NONE;
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return NONE;
  const rest = trimmed.slice(PREFIX.length);
  for (const [name, label] of LABELS) {
    if (!rest.startsWith(label)) continue;
    const tail = rest.slice(label.length);
    // 命令名与冒号之间不许夹任何字符，空白也不行。
    if (!/^[:：]/u.test(tail)) return invalid(name, "missing_colon");
    const body = tail.slice(1).trim();
    if (!body) return invalid(name, "empty_body");
    if (body.length > CAPABILITY_COMMAND_BODY_MAX_CHARS) return invalid(name, "too_long");
    return { kind: "command", name, body };
  }
  return NONE;
}

export function readCapabilityCommand(source: CapabilityCommandSource): CapabilityCommandRequest | null {
  // AI 的话、只读观察消息里出现的命令样式是在转述，不是用户在下指令。
  if (source.kind === "AI" || source.readOnly) return null;
  // 与出图的旧判定同口径：有手打文本就只认它；只发了附件时不回落到 content。
  const text = source.commandText ?? (source.hasAttachments ? "" : source.content);
  const command = parseCapabilityCommand(text);
  if (command.kind === "none") return null;
  return {
    addressedToSelf: source.addressedToSelf === true,
    ...(source.externalMessageId ? { externalMessageId: source.externalMessageId } : {}),
    command,
  };
}

export function readCapabilityCommands(sources: readonly CapabilityCommandSource[]): CapabilityCommandRequest[] {
  return sources.flatMap(source => { const hit = readCapabilityCommand(source); return hit ? [hit] : []; });
}
