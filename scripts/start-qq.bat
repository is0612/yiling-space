@echo off
rem 双击这个就能把 QQ 链路整个拉起来：SnowLuma → 等端口 → 适配器。
rem 协议端目录：优先读 SNOWLUMA_HOME，其次是网页「QQ 渠道 → 换目录」保存的那份。
cd /d "%~dp0.."
npx tsx scripts/start-qq-stack.ts
echo.
echo 已退出。按任意键关闭窗口。
pause >nul
