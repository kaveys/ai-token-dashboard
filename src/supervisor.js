/**
 * AI Token 统计台 · 守护进程
 * 不依赖 DSH：用项目自带 bin/node.exe 跑它，DSH 关掉也照常运行。
 *
 * 职责：起 server.js → 监控 → 异常退出自动重启（退避重试）→ 写日志。
 * 用法：node src/supervisor.js [--port 8787]
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'out');

const args = process.argv.slice(2);
const argOf = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = argOf('--port', '8787');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'supervisor.log'), line + '\n', 'utf8');
  } catch (e) {}
  console.log(line);
}

/** 日志滚动：超过 2MB 就切成 .1 */
function rotate() {
  const f = path.join(LOG_DIR, 'supervisor.log');
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) {
      fs.renameSync(f, f + '.1');
    }
  } catch (e) {}
}

let child = null;
let stopped = false;
let backoff = 2000;
let lastStart = 0;

function start() {
  if (stopped) return;
  lastStart = Date.now();
  log(`启动统计服务 (port=${PORT})`);

  child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', PORT, '--no-open'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d) => {
    const t = d.toString().trim();
    if (t) log('server:', t.split('\n').join(' | '));
  });
  child.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t) log('server!:', t.split('\n').join(' | '));
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopped) { log('服务已停止'); return; }
    // code=0 是我们主动让位的“正常退出”（端口已有实例），不再重启，避免两个自启项互踢
    if (code === 0) {
      log('服务正常退出（端口已有实例），守护进程结束');
      stopped = true;
      return;
    }
    const ranMs = Date.now() - lastStart;
    // 稳定跑过 10 分钟就重置退避；否则逐步拉长（2s → 4s → … → 30s）
    if (ranMs > 10 * 60 * 1000) backoff = 2000;
    else backoff = Math.min(backoff * 2, 30000);
    log(`服务退出 (code=${code}, signal=${signal}, 运行 ${Math.round(ranMs / 1000)}s)，${Math.round(backoff / 1000)}s 后重启`);
    rotate();
    setTimeout(start, backoff);
  });

  child.on('error', (e) => log('启动失败:', e.message));
}

process.on('SIGTERM', () => { stopped = true; if (child) child.kill(); process.exit(0); });
process.on('SIGINT', () => { stopped = true; if (child) child.kill(); process.exit(0); });
// 守护进程自身崩溃时别把服务一起带走
process.on('uncaughtException', (e) => log('supervisor 异常:', e.message));

log('=== supervisor 启动 ===');
start();
