/**
 * 排查用：SnowLuma 的目录自动发现到底走到哪一层。
 *
 * 页面显示「没找到程序」时跑一下，能看到是扫描没中、还是走了默认路径：
 *   npx tsx scripts/probe-snowluma-home.ts
 *
 * 单独看扫描结果（不碰 netstat / powershell），耗时也一起打出来 ——
 * 扫描有预算和时限，正常应该几十毫秒；如果接近 1.5 秒说明盘上目录太多、被裁了。
 */
import { readSnowlumaStatus, scanForSnowluma } from "../server/utils/channel-adapter/onebot/runtime";

const scanStarted = Date.now();
const scanned = await scanForSnowluma();
const scanMs = Date.now() - scanStarted;

const statusStarted = Date.now();
const status = await readSnowlumaStatus();
const statusMs = Date.now() - statusStarted;

console.log("扫盘       ->", scanned ?? "(没扫到)", `${scanMs}ms`);
console.log("当前状态   ->", JSON.stringify(status, null, 2), `${statusMs}ms`);
