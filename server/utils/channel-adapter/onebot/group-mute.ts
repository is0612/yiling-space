/**
 * 群聊「静默档」：有人明确让她闭嘴时，这个群在 10 分钟内不接话。
 *
 * 为什么单独一档而不是调参数：闸门原来只有「送不送进模型」，没有「配不配说话」。
 * 群里有人说「先别说话」，模型回不回全看它自己的判断 —— 2026-11-02 实测三次里三次
 * 都还在接（其中一次 @ 的还是别人）。把「闭嘴」当成语义问题交给模型，等于没有决定。
 *
 * 三条边界：
 *   - 只有群主 / 管理员 / 主人能触发，普通群友喊「闭嘴」不算 —— 否则一句玩笑能让她消失十分钟；
 *   - 必须是**冲她说的**（@ 她或叫到名字），群里两人互喊「闭嘴」不能算；
 *   - 静默只压「说不说」，不压「听不听」：消息照常进短期上下文、照常落库，只是不回。
 */

/** 静默时长：10 分钟。够长到让人看出「她真的停了」，也短到不会被忘在后台。 */
export const GROUP_MUTE_MS = 10 * 60 * 1000;

/**
 * 判据故意收紧：整句就是一句命令，而不是「句子里出现了这个词」。
 *
 * 为什么必须整句匹配：群里聊到「闭嘴」这两个字太常见了 —— 「他刚才让我闭嘴」
 * 「闭嘴这个话题挺有意思的」。按包含匹配，这些都会让她消失十分钟，而且事后
 * 完全看不出是踩了哪个词。真下命令的人也不会把命令夹在句子中间。
 *
 * 允许的前后缀只有语气词和称呼（你 / 先 / 都 / 给我 / 吧 / 了 / ！），
 * 长度上限 24 字与 `isClarificationMessage` 同一个尺度。
 */
const QUIET_PATTERN = /^(?:你|你们|先|都|给我|请|请你|麻烦|快|赶紧)*(?:闭嘴|别说话|别插嘴|别接话|先别接|安静点|消停点|不用出声|不必出声|不出声)[了吧啊呀哦呢。！!～~，,、\s]*$/u;

/** 「可以说了」这类放行指令。只在已静默时才看，避免「说吧」这种日常用法误触。 */
const RESUME_PATTERN = /^(?:现在|你|已经)?(?:(?:可以|能)(?:说|开口|出声)了|不用憋着|别憋着|出来吧)[了吧啊呀。！!～~]*$/u;

function normalize(content: string): string {
  return content
    .replace(/\[CQ:[^\]]*\]/g, "")
    .replace(/@\d+/g, "")
    .replace(/@self/giu, "")
    .replace(/\s+/gu, "");
}

/**
 * 这句是不是在让她闭嘴。
 *
 * 只认「短句 + 命令词」，且**调用方还要再确认是冲她说的**（direct / named）——
 * 判据本身不知道群里谁在跟谁说话，那件事只有调用方看得见。
 */
export function isQuietRequest(content: string): boolean {
  if (!content) return false;
  const text = normalize(content);
  if (!text || text.length > 24) return false;
  return QUIET_PATTERN.test(text);
}

/** 这句是不是在解除静默。 */
export function isResumeRequest(content: string): boolean {
  if (!content) return false;
  const text = normalize(content);
  if (!text || text.length > 24) return false;
  return RESUME_PATTERN.test(text);
}

export type GroupMuteStore = {
  /** 开始静默，返回到期时间戳（毫秒）。重复触发会把时间往后推。 */
  mute(key: string, at?: number): number;
  /** 立即解除。 */
  unmute(key: string): void;
  /** 现在是否处于静默。过期的条目读的时候顺手清掉。 */
  isMuted(key: string, at?: number): boolean;
  /** 还剩多久（毫秒）；没静默返回 0。 */
  remainingMs(key: string, at?: number): number;
  /** 停机 / 换绑时全清。 */
  clear(): void;
};

/**
 * 静默状态按「绑定 + 群」存内存。
 *
 * 为什么不做持久化：10 分钟的临时状态，重启丢了大不了多回两句；写库要为每群维护一行
 * 状态表、还要处理过期清理，成本远大于收益。真需要跨重启时，再按 `groupChatModes`
 * 那样的绑定级配置加一档。
 */
export function createGroupMuteStore(options: { muteMs?: number; now?: () => number } = {}): GroupMuteStore {
  const muteMs = options.muteMs ?? GROUP_MUTE_MS;
  const now = options.now ?? Date.now;
  const until = new Map<string, number>();

  const prune = (at: number): void => {
    for (const [key, expiry] of until) {
      if (expiry <= at) until.delete(key);
    }
  };

  return {
    mute(key, at = now()) {
      prune(at);
      const expiry = at + muteMs;
      until.set(key, expiry);
      return expiry;
    },
    unmute(key) {
      until.delete(key);
    },
    isMuted(key, at = now()) {
      const expiry = until.get(key);
      if (!expiry) return false;
      if (expiry <= at) {
        until.delete(key);
        return false;
      }
      return true;
    },
    remainingMs(key, at = now()) {
      const expiry = until.get(key);
      return expiry && expiry > at ? expiry - at : 0;
    },
    clear() {
      until.clear();
    },
  };
}
