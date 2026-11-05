在这里放 *.json 即可把其它 AI 工具（Cursor / Copilot / Claude Code / Codex 等）的用量并入看板。

格式：数组，或 {"records":[...]}。单条记录字段：

{
  "ts": 1793722000000,          // 必填：毫秒时间戳
  "provider": "cursor",         // 供应方/工具名
  "model": "gpt-5",             // 模型名
  "sessionId": "my-session-1",  // 可空；有值则按会话归并
  "input": 12000,
  "cacheRead": 0,
  "cacheWrite": 0,
  "output": 400,
  "cost": 0.03,                 // 可空
  "pricingStatus": "priced",    // priced 才计入成本
  "purpose": "",
  "status": "completed"
}

保存后点页面右上角「刷新」即可看到。
