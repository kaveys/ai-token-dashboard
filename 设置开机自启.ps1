# AI Token 统计台 - 开机自启设置（无参数，双击即可）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $root '后台启动.vbs'
$node = Join-Path $root 'bin\node.exe'
$lnk  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI-Token统计台.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'AITokenDashboard'

Write-Host '============================================'
Write-Host '  AI Token 统计台 - 开机自启设置'
Write-Host '============================================'
Write-Host ("  项目目录: " + $root)
Write-Host ''

if (-not (Test-Path $vbs))  { Write-Host '[X] 缺少 后台启动.vbs'; if ($Host.Name -eq 'ConsoleHost' -and -not $env:NO_PAUSE) { Read-Host '按回车退出' }; exit 1 }
if (-not (Test-Path $node)) { Write-Host '[X] 缺少 bin\node.exe'; if ($Host.Name -eq 'ConsoleHost' -and -not $env:NO_PAUSE) { Read-Host '按回车退出' }; exit 1 }

# 1) 启动文件夹快捷方式
Write-Host '[1/3] 写入启动文件夹快捷方式 ...'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
if (-not (Test-Path $startup)) { New-Item -ItemType Directory -Path $startup -Force | Out-Null }
$sh = New-Object -ComObject WScript.Shell
$ln = $sh.CreateShortcut($lnk)
$ln.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$ln.Arguments = '"' + $vbs + '"'
$ln.WorkingDirectory = $root
$ln.WindowStyle = 7
$ln.Description = 'AI Token Dashboard (autostart)'
$ln.Save()
if (Test-Path $lnk) { Write-Host '      OK' } else { Write-Host '      [!] 失败' }

# 2) 注册表 Run 项（双保险）
Write-Host '[2/3] 写入注册表 Run 项 ...'
$val = '"' + (Join-Path $env:SystemRoot 'System32\wscript.exe') + '" "' + $vbs + '"'
Set-ItemProperty -Path $runKey -Name $runName -Value $val -Type String
$back = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).$runName
if ($back) { Write-Host '      OK' } else { Write-Host '      [!] 失败' }

# 3) 立即启动（已在跑就跳过）
Write-Host '[3/3] 立即启动 ...'
$listening = $false
try {
  $c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($c) { $listening = $true }
} catch {}
if ($listening) {
  Write-Host '      已在运行，跳过'
} else {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
                -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/data' -UseBasicParsing -TimeoutSec 10
    Write-Host ('      已启动，接口返回 ' + $r.StatusCode)
  } catch {
    Write-Host '      已启动，但接口暂未响应，请看 out\supervisor.log'
  }
}

Write-Host ''
Write-Host '完成。开机自动后台运行，不弹窗口，不依赖 DSH。'
Write-Host '   打开网页  http://127.0.0.1:8787/'
Write-Host '   查看日志  out\supervisor.log'
Write-Host '   停止服务  双击 停止服务.bat'
Write-Host '   取消自启  双击 取消自启.bat'
Write-Host ''
if ($Host.Name -eq 'ConsoleHost' -and -not $env:NO_PAUSE) { Read-Host '按回车关闭' }
