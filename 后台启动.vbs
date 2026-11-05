' AI Token Dashboard - silent launcher (v4)
'
' 全程零窗口、零闪烁。启动链：
'
'   explorer.exe (登录加载启动文件夹 / 注册表 Run)
'     └─ wscript.exe (本文件, 隐藏)
'         └─ node.exe watchdog   (windowsHide, 单实例, 长驻)
'             └─ node.exe supervisor (detached, 崩溃自动重启)
'                 └─ node.exe server (--no-open, 绝不开浏览器)
'
' 历史坑（都已消除）：
'   * sh.Exec("cmd /c netstat ...") → 每次闪 cmd 黑窗
'   * 拉起 powershell.exe watchdog → 创建瞬间可能闪窗
'   * server.js 不带 --no-open → 自动弹浏览器
'
' 本版：
'   * 端口检测用 XMLHTTP，纯进程内，不启任何外部程序
'   * watchdog 换成 Node 版（src/watchdog.js），windowsHide 完全不可见
'
Option Explicit

Dim fso, sh, root, exePath, wdPath, supPath, logDir, logFile, ts

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root    = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = root & "\bin\node.exe"
wdPath  = root & "\src\watchdog.js"
supPath = root & "\src\supervisor.js"
logDir  = root & "\out"

If Not fso.FileExists(exePath) Then WScript.Quit 2

If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\vbs-launch.log"

ts = Year(Now) & "-" & Right("0" & Month(Now),2) & "-" & Right("0" & Day(Now),2) & " " & _
     Right("0" & Hour(Now),2) & ":" & Right("0" & Minute(Now),2) & ":" & Right("0" & Second(Now),2)

sh.CurrentDirectory = root

' 1. 端口已占用 → 静默退出（判断过程不启任何外部进程）
If HttpAlive(8787) Then
  AppendLog logFile, ts & "  SKIP: port 8787 already listening"
  WScript.Quit 0
End If

' 2. 优先 Run Node 版 watchdog（它负责保活与崩溃恢复）
If fso.FileExists(wdPath) Then
  sh.Run """" & exePath & """ """ & wdPath & """", 0, False
  AppendLog logFile, ts & "  START: node watchdog launched"
ElseIf fso.FileExists(supPath) Then
  sh.Run """" & exePath & """ """ & supPath & """", 0, False
  AppendLog logFile, ts & "  START: supervisor launched directly"
Else
  AppendLog logFile, ts & "  ERR: missing watchdog.js / supervisor.js"
End If

WScript.Quit 0


' ---- 纯进程内探测，无窗口 ----
Function HttpAlive(p)
  Dim x
  HttpAlive = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.XMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  x.open "GET", "http://127.0.0.1:" & p & "/api/data", False
  x.send
  If Err.Number = 0 Then
    If x.status = 200 Then HttpAlive = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

Sub AppendLog(p, line)
  Dim f
  On Error Resume Next
  Set f = fso.OpenTextFile(p, 8, True)
  f.WriteLine line
  f.Close
  On Error GoTo 0
End Sub
