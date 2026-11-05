@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo [1/2] 采集本机 AI 用量 ...
"%NODE_EXE%" "%~dp0src\aggregate.js"
if errorlevel 1 (
  echo.
  echo 采集失败：请确认已安装 Node.js，或 DSH 运行时未被移动。
  pause
  exit /b 1
)

echo.
echo [2/2] 打开统计台 ...
start "" "%~dp0index.html"
exit /b 0
