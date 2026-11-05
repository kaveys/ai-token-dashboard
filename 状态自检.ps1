# AI Token 统计台 - 一键状态自检
# 双击 状态自检.bat 即可看到：服务是否在线、watchdog 是否在、是否已脱离 DSH、自启入口是否齐全

$ErrorPolicy = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8787

Write-Host ''
Write-Host '============================================'
Write-Host '  AI Token 统计台 状态自检'
Write-Host '============================================'
Write-Host ''

Write-Host '[1] 服务健康'
try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/') -UseBasicParsing -TimeoutSec 6
    Write-Host ('  [OK]   页面 root = ' + $r.StatusCode) -ForegroundColor Green
} catch {
    Write-Host '  [X]    页面无响应' -ForegroundColor Red
}
try {
    $r2 = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/data') -UseBasicParsing -TimeoutSec 25
    $kb = [math]::Round(($r2.RawContentLength) / 1024)
    Write-Host ('  [OK]   接口 api  = ' + $r2.StatusCode + '  (' + $kb + ' KB)') -ForegroundColor Green
} catch {
    Write-Host '  [X]    接口无响应' -ForegroundColor Red
}

Write-Host ''
Write-Host '[2] 进程与进程树'
$sup = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'supervisor' } | Select-Object -First 1
if ($sup) {
    Write-Host ('  [OK]   supervisor PID=' + $sup.ProcessId) -ForegroundColor Green
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $sup.ParentProcessId) -ErrorAction SilentlyContinue
    if (-not $parent) {
        Write-Host '  [OK]     -> 父进程已退出：完全脱离，关掉 DSH 也杀不到' -ForegroundColor Green
    } elseif ($parent.Name -eq 'WmiPrvSE.exe') {
        Write-Host '  [OK]     -> 父进程 = WmiPrvSE.exe：由 WMI 创建，独立于任何终端' -ForegroundColor Green
    } elseif ($parent.Name -eq 'explorer.exe') {
        Write-Host '  [OK]     -> 父进程 = explorer.exe：不受 DSH 影响' -ForegroundColor Green
    } elseif ($parent.Name -eq 'node.exe') {
        Write-Host '  [OK]     -> 父进程 = watchdog：由看门狗拉起，脱离任何终端' -ForegroundColor Green
    } else {
        Write-Host ('  [!]      -> 父进程 = ' + $parent.Name + '：请确认不是从终端启动') -ForegroundColor Yellow
    }
} else {
    Write-Host '  [X]    supervisor 未运行' -ForegroundColor Red
}

$srv = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'server\.js' } | Select-Object -First 1
if ($srv) { Write-Host ('  [OK]   server PID=' + $srv.ProcessId) -ForegroundColor Green }
else      { Write-Host '  [X]    server 未运行' -ForegroundColor Red }

$wdNode = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -match 'watchdog\.js' })
$wdPs   = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -match 'watchdog\.ps1' })
if ($wdNode.Count -ge 1) {
    Write-Host ('  [OK]   watchdog(Node) 实例数 = ' + $wdNode.Count) -ForegroundColor Green
    if ($wdNode.Count -gt 1) {
        Write-Host '  [!]    多于 1 个：文件锁可能失效' -ForegroundColor Yellow
    }
} else {
    Write-Host '  [!]    watchdog(Node) 未运行（服务能用，但崩溃后不会自恢复）' -ForegroundColor Yellow
}
if ($wdPs.Count -ge 1) {
    Write-Host ('  [X]    仍有旧版 PowerShell watchdog 在跑 (' + $wdPs.Count + ' 个)，会闪窗') -ForegroundColor Red
}

Write-Host ''
Write-Host '[2b] 弹窗来源检查（应全为空/OK）'
$cmdNs = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -match 'netstat' })
if ($cmdNs.Count -eq 0) {
    Write-Host '  [OK]   无 cmd netstat 子进程' -ForegroundColor Green
} else {
    Write-Host ('  [X]    有 ' + $cmdNs.Count + ' 个 cmd netstat（旧版闪烁源）') -ForegroundColor Red
}
$srv = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'server\.js' } | Select-Object -First 1
if ($srv) {
    if ($srv.CommandLine -match '--open') {
        Write-Host '  [X]    server 带 --open，会弹浏览器' -ForegroundColor Red
    } else {
        Write-Host '  [OK]   server 无 --open，不会弹浏览器' -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '[3] 自启入口'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI-Token统计台.lnk'
if (Test-Path $lnk) {
    Write-Host '  [OK]   启动文件夹快捷方式存在' -ForegroundColor Green
} else {
    Write-Host '  [X]    启动文件夹快捷方式缺失' -ForegroundColor Red
}
$reg = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).AITokenDashboard
if ($reg) {
    Write-Host '  [OK]   注册表 Run 项存在' -ForegroundColor Green
} else {
    Write-Host '  [!]    注册表 Run 项缺失（启动文件夹仍可兜底）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '[4] 最近日志'
foreach ($f in @('vbs-launch.log','watchdog.log','supervisor.log')) {
    $p = Join-Path $root ('out\' + $f)
    $name = $f.PadRight(18)
    if (Test-Path $p) {
        $last = (Get-Content $p -Tail 1 -ErrorAction SilentlyContinue)
        Write-Host ('  ' + $name + $last)
    } else {
        Write-Host ('  ' + $name + '(无)')
    }
}

Write-Host ''
Write-Host '============================================'
Write-Host ''
Write-Host '停止服务：双击 停止服务.bat    取消自启：双击 取消自启.bat'
Write-Host ''
