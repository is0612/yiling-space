/**
 * 「这句话是系统播报，不是人在说话」的判定。
 *
 * 两个入口用同一份判据，但**宽严不同**，因为误判的代价不对称：
 *
 *   - `looksLikeSystemMessage`（宽）：用在**读取侧**（注入提示词的窗口、捡梗统计）。
 *     误判的代价只是这一行不进提示词，下一秒就过去了。
 *   - `isSystemBroadcast`（窄）：用在**写入侧**（落库时打标记）。
 *     误判的代价是这条消息被永久标成噪声，后续提炼和审计都会跳过它。
 *
 * 背景：群里同时跑几个机器人时，它们对同一条命令各回一次
 * （「管理命令仅管理员可用。」实测 34 次），onebot 会原样当群友消息收进来。
 * QQ 侧拿不到「谁是机器人」，只能在文本特征上挡。
 */

/** 状态/提示类 emoji 开头：系统播报几乎都带。 */
const STATUS_EMOJI_PREFIX = /^[\u23F0-\u23F3\u26A0\u2705\u274C\u2757\u2753\u2755\u{1F514}\u{1F4E2}\u{1F6AB}]/u;

/**
 * 已知的系统句式（插件报错、权限回执、网关重启）。
 * 这里刻意用「固定片段」而不是通配，就是为了让写入侧的误判率接近 0。
 */
const SYSTEM_FRAMES = [
  "仅管理员可用",
  "系统服务重启中",
  "被安全策略拦截",
  "B站内容获取失败",
  "请在插件配置中填写",
];

/**
 * 宽判据：像不像一条系统播报。
 *
 * **完整句子 + 句末句号 + 有一定长度**。人说梗几乎不打句号（「xxx 不烧心吗」），
 * 系统提示几乎句句带句号（「管理命令仅管理员可用。」）。英文句号同理。
 *
 * ⚠️ 别拿它做删库判据：真实对话里有 60 条「≥8 字且以句号结尾」的正常发言
 * （「不然呢，我总不能有多根网线吧。我走的都是一个IP。」），那是人话。
 */
export function looksLikeSystemMessage(text: string): boolean {
  if (STATUS_EMOJI_PREFIX.test(text)) return true;
  if (text.length >= 8 && /[。.]$/.test(text)) return true;
  return false;
}

/**
 * 窄判据：这条消息**确定**是系统播报，可以打标记。
 *
 * 只在命中状态 emoji 或已知句式时才为真 —— 宁可漏标，不可错标。
 * 读取侧仍然用宽判据，所以旧的、没有标记的历史行也会被挡在窗口外。
 */
export function isSystemBroadcast(text: string): boolean {
  if (STATUS_EMOJI_PREFIX.test(text)) return true;
  return SYSTEM_FRAMES.some((frame) => text.includes(frame));
}
