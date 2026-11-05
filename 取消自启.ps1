# AI Token 统计台 - 取消开机自启
$ErrorActionPreference = 'Continue'

$lnk  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI-Token统计台.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'AITokenDashboard'

Write-Host '============================================'
Write-Host '  取消 AI Token 统计台 开机自启'
Write-Host '============================================'
Write-Host ''

Write-Host '[1/2] 删除启动文件夹快捷方式 ...'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host '      OK  已删除' }
else { Write-Host '      -   本就没有' }

Write-Host '[2/2] 删除注册表 Run 项 ...'
$v = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).$runName
if ($v) { Remove-ItemProperty -Path $runKey -Name $runName -Force; Write-Host '      OK  已删除' }
else { Write-Host '      -   本就没有' }

Write-Host ''
Write-Host '已取消开机自启。'
Write-Host '当前运行中的服务不会被停止；要停止请运行 停止服务.bat'
Write-Host ''
if ($Host.Name -eq 'ConsoleHost' -and -not $env:NO_PAUSE) { Read-Host '按回车关闭' }
