@echo off
setlocal
cd /d "%~dp0"
if not defined LAN_CHAT_NODE set "LAN_CHAT_NODE=node"
set "LAN_CHAT_OPEN=1"
echo 局域网聊天 LAN Chat - 正在启动...
echo 服务启动后会自动打开浏览器；关闭本窗口即可停止服务。
echo 若系统没有 node，可设置 LAN_CHAT_NODE 指向 dsh 自带 runtime 的 node.exe。
echo.
"%LAN_CHAT_NODE%" "%~dp0server.mjs"
echo.
echo 服务已停止。
pause
