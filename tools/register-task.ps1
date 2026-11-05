# AI Token 统计台 - 注册用户级计划任务（无需管理员）
#
# 为什么这次能成：
#   之前失败是因为用了 -AtLogOn / -AtStartup 触发器 + Interactive LogonType，
#   那两个组合会要求提升权限。
#   改用 S4U (Service For User) 登录类型后，用户级注册即可成功，
#   且 S4U 任务不在用户的交互式会话里 —— DSH 关掉、终端关掉都不受影响。
#
# 触发方式：
#   * 登录时（AtLogOn，S4U）
#   * 每 5 分钟补一次（防止被系统清理后长期无服务）

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs      = Join-Path $root '后台启动.vbs'
$taskName = 'AITokenDashboard'

Write-Host '============================================'
Write-Host '  注册 AI Token 统计台 计划任务'
Write-Host '============================================'
Write-Host ('  项目目录: ' + $root)
Write-Host ''

if (-not (Test-Path $vbs)) {
    Write-Host '[X] 缺少 后台启动.vbs'
    exit 1
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

# 动作：用 wscript 隐藏执行 VBS
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $vbs + '"') -WorkingDirectory $root

# 触发器：登录时 + 每 5 分钟兜底（避免任务被停后长期无服务）
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -RandomDelay (New-TimeSpan -Seconds 15)
$tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# 主体：S4U（不需要密码、不弹 UAC、脱离交互会话）
$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
    -LogonType S4U -RunLevel Limited

# 设置
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Write-Host '[1/3] 移除同名旧任务 ...'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Write-Host '      OK'

Write-Host '[2/3] 注册任务（S4U + 登录触发 + 5min 兜底）...'
try {
    Register-ScheduledTask -TaskName $taskName `
        -Action $action `
        -Trigger @($tLogon, $tRepeat) `
        -Principal $principal `
        -Settings $settings `
        -Description 'AI Token 统计台：登录后自动后台运行，且每 5 分钟自检补起' `
        -Force | Out-Null
    Write-Host '      OK'
} catch {
    Write-Host ('      [X] 注册失败: ' + $_.Exception.Message)
    exit 1
}

$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $t) { Write-Host '[X] 任务不存在'; exit 1 }
Write-Host ('      状态=' + $t.State)

Write-Host '[3/3] 立即运行一次验证 ...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 10

$busy = $false
try { $busy = [bool](Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) } catch {}
if ($busy) { Write-Host '      OK  端口 8787 已监听' }
else       { Write-Host '      [!] 端口未监听，查看 out\vbs-launch.log 与 out\watchdog.log' }

Write-Host ''
$info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
if ($info) {
    Write-Host ('  上次运行: ' + $info.LastRunTime)
    Write-Host ('  上次结果: ' + $info.LastTaskResult)
    Write-Host ('  下次运行: ' + $info.NextRunTime)
}
Write-Host ''
Write-Host '完成。此后：'
Write-Host '   * 登录 Windows 自动运行'
Write-Host '   * 每 5 分钟兜底自检，被清理也会自动补起'
Write-Host '   * 全程无窗口'
Write-Host ''
