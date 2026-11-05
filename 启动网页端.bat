@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0bin\node.exe"
if not exist "%NODE_EXE%" (
  echo [X] 缺少内置运行时 bin\node.exe
  pause & exit /b 1
)

echo ============================================
echo   AI Token 统计台 - 临时打开
echo   浏览器会自动打开 http://127.0.0.1:8787/
echo   关闭本窗口即停止服务
echo ============================================
echo.

rem 手动运行时显式要求打开浏览器（后台自启永远不会带 --open）
"%NODE_EXE%" "%~dp0src\server.js" --open

if errorlevel 1 (
  echo.
  echo 启动失败。可改用「更新数据.bat」生成离线快照后直接打开 index.html。
  pause
)
