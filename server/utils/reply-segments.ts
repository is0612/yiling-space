/**
 * 一条回复拆成几条消息发（QQ 上「一句一句弹出来」）。
 *
 * 为什么拆在**发送前**、而不是让模型返回数组：模型对自己一次说多少话没有概念，
 * 让它输出 `replies: []` 会把输出契约、解析、沉默轮记账、桌面对话全带下水；
 * 而「换行 = 另起一条」是她本来就会写的东西，代价是一个纯函数。
 *
 * 拆的时机也很关键：**必须在落库之前**由渠道声明自己能拆（`segmentCapable`），
 * 提示词那边才会告诉她「换行就是分条」。没声明的渠道（网页对话）拿到的是同一段
 * 文字，换行就只是换行 —— 桌面不会突然冒出三条气泡。
 *
 * 三条硬规则，都是踩出来的：
 * ① **最多 3 条**。真人补话也就补一两句，拆成五条像刷屏，也容易撞网关频率风控。
 * ② **超出的部分并回最后一条**，不许丢字 —— 宁可最后一条长，不能少半句。
 * ③ **看着像排版就不拆**。模型很爱用换行排版（列表、`- ` 开头、`1. `），
 *    那种换行拆开就是一地问号。这条判断必须是代码，不能靠提示词求它别这么写。
 */
export const MAX_REPLY_SEGMENTS = 3;

/**
 * 单条长度护栏。提示词里写的是 40 字，这里放宽到 60 才动手 ——
 * 它只用来兜「模型把三条都写成一大段」那种情况，不是切分依据（不硬切，不丢字）。
 */
export const MAX_SEGMENT_CHARS = 60;

/** 列表项、编号、标题：出现这类行首就当模型在排版，整段原样发一条。 */
const LOOKS_LIKE_LAYOUT = /^\s*(?:[-*•·]|\d+[.)、]|#{1,6}\s)/u;

/**
 * 把一段回复切成要发的几条。
 *
 * 返回 `[原文]` 表示「不拆」（一条消息照发），返回 `[]` 表示没内容可发。
 * 调用方只判长度：`length > 1` 才真的分条，其余一律走原来的单条路径 ——
 * 这样没换行的回复行为完全不变，出问题也只影响她主动分条的那几条。
 */
export function splitReplySegments(reply: string): string[] {
  const text = reply.replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  const parts = text.split("\n").map((part) => part.trim()).filter(Boolean);
  // 没换行（或只有空行）＝ 她只想说一句，别硬拆。
  if (parts.length <= 1) return [text];
  // 排版式换行：列表、编号、标题。拆开就成了几条没头没尾的短句。
  if (parts.some((part) => LOOKS_LIKE_LAYOUT.test(part))) return [text];
  // 有一条明显是长段落：她其实在写一整段、只是顺手换了行，拆开就是「长的长、短的短」。
  if (parts.some((part) => part.length > MAX_SEGMENT_CHARS)) return [text];

  if (parts.length > MAX_REPLY_SEGMENTS) {
    const head = parts.slice(0, MAX_REPLY_SEGMENTS - 1);
    // 并回最后一条而不是丢掉：缺半句比多一句难看得多。
    head.push(parts.slice(MAX_REPLY_SEGMENTS - 1).join("\n"));
    return head;
  }
  return parts;
}
