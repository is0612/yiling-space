/**
 * probe-* 脚本的「目标角色」从哪来。
 *
 * probe 脚本的定位是「拿我库里的某个角色，真跑一次模型，看输出对不对」，
 * 所以必须知道跑哪个角色。但真实角色 id 不能写进代码：
 *   - 开源后等于把本地数据的标识公开；
 *   - 换台机器 / 换个人 clone 下来，写死的 id 必然查不到，脚本直接抛错。
 *
 * 解析顺序：
 *   1. `CHAR_ID` 环境变量（一次性覆盖，适合临时换角色）
 *   2. `.data/probe-target.json` 里的 `characterId`（本地固定值，该目录已被 git 忽略）
 *   3. 都没有就抛错，并说明怎么配
 *
 * 为什么用文件而不是每次 set：probe 脚本是手动反复跑的，写进 `.data/` 一次就再也不用管。
 * 与 `start-qq-stack.ts` 读 `.data/snowluma-home.json` 是同一套做法。
 *
 * 配置示例（文件不存在就自己建）：
 *   .data/probe-target.json
 *   { "characterId": "把角色详情页 URL 里那串 UUID 粘进来" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SAVED_TARGET = join(REPO_ROOT, ".data", "probe-target.json");

export function resolveProbeCharacterId(): string {
  const fromEnv = process.env.CHAR_ID?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(SAVED_TARGET)) {
    try {
      const parsed = JSON.parse(readFileSync(SAVED_TARGET, "utf8")) as { characterId?: unknown };
      if (typeof parsed.characterId === "string" && parsed.characterId.trim()) {
        return parsed.characterId.trim();
      }
    } catch {
      // 文件坏了按「没配」处理，走下面的统一报错，避免抛一个看不懂的 JSON 解析错误
    }
  }

  throw new Error(
    "没有目标角色。二选一：\n" +
      "  1. 临时指定：CHAR_ID=<角色 UUID> npx tsx scripts/probe-xxx.ts\n" +
      `  2. 固定下来：在 ${SAVED_TARGET} 写 {"characterId": "<角色 UUID>"}（.data/ 已被 git 忽略）`,
  );
}
