# AI Token 统计台 - 停止服务
$ErrorPolicy = 'Continue'

Write-Host '============================================'
Write-Host '  停止 AI Token 统计台'
Write-Host '============================================'
Write-Host ''

$n = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'supervisor\.js|server\.js' } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch {}
  }
Write-Host ('      已结束 ' + $n + ' 个进程')

Start-Sleep -Milliseconds 900
$still = $false
try {
  if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { $still = $true }
} catch {}
if ($still) { Write-Host '      [!] 端口 8787 仍被占用' }
else { Write-Host '      OK  已停止，端口已释放' }

Write-Host ''
Write-Host '提示：如果设置了开机自启，下次开机仍会自动运行。'
Write-Host '要彻底关掉自启，请运行 取消自启.bat'
Write-Host ''
if ($Host.Name -eq 'ConsoleHost' -and -not $env:NO_PAUSE) { Read-Host '按回车关闭' }
