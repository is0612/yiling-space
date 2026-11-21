/**
 * 清理脚本的统一护栏。
 *
 * 这几个脚本会**真删数据**（孤儿角色数据、孤儿身份、失败的评估记录）。此前各写各的：
 * 都支持 `--apply` 干跑保护，但没有一条统一的规则保证「目标库是不是我以为的那个」——
 * 在 `.env` 指到线上库的时候，一条 `--apply` 就够了。
 *
 * 这里只做三件确定性的事，不碰业务判断：
 *   1. 必须能从 `DATABASE_URL` 解析出库名；
 *   2. 非本机库（不是 localhost / 回环）默认拒绝执行，要显式加 `--allow-remote`；
 *   3. 打印目标库，让人在输出第一行就能核对。
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type CleanupTarget = {
  /** 是否真的是删（脚本里 `--apply`）。 */
  apply: boolean;
  /** 库名，用于打印核对。 */
  database: string;
  /** 主机（含端口），用于打印核对。 */
  host: string;
  /** 目标是否为本机库。 */
  local: boolean;
  /** 一行给人看的目标描述。 */
  label: string;
};

export function readCleanupTarget(connectionString: string | undefined, argv: readonly string[] = process.argv): CleanupTarget {
  if (!connectionString) throw new Error("缺少 DATABASE_URL，清理脚本无法运行。");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL 不是合法的连接串，拒绝执行清理。");
  }
  const database = url.pathname.replace(/^\//u, "").trim();
  if (!database) throw new Error("DATABASE_URL 里没有库名，拒绝执行清理。");
  const local = LOOPBACK.has(url.hostname);
  const apply = argv.includes("--apply");
  if (!local && !argv.includes("--allow-remote")) {
    throw new Error(
      `目标库不在本机（${url.hostname}），拒绝执行。确认这确实是你要清理的库后，再加 --allow-remote。`,
    );
  }
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return { apply, database, host, local, label: `${database} @ ${host}${local ? "（本机）" : "（远程）"}` };
}

/** 把目标库一行打在输出最上面；干跑时追加一句「什么都没删」。 */
export function announceCleanupTarget(target: CleanupTarget): void {
  console.log(`目标库：${target.label}`);
  if (!target.apply) console.log("干跑模式：只统计，不删除。确认后加 --apply。");
}
