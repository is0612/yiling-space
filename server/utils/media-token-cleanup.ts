/** Remove complete channel media tokens before TTS or phrase mining, without changing ordinary brackets. */
export function stripMediaTokens(text: string): string {
  const start = /\[(?:图片|表情包)(?=[:：\]])/gu;
  const maxTokenChars = 4096;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text))) {
    let depth = 1;
    let end = match.index + 1;
    const limit = Math.min(text.length, match.index + maxTokenChars);
    for (; end < limit; end++) {
      if (text[end] === "[") depth++;
      else if (text[end] === "]" && --depth === 0) break;
    }
    // Incomplete or oversized input is not a trustworthy generated media token.
    if (depth !== 0) continue;
    output += text.slice(cursor, match.index) + " ";
    cursor = end + 1;
    start.lastIndex = cursor;
  }
  return output + text.slice(cursor);
}
