/**
 * AI Token 统计台 · 看门狗（Node 版，零窗口）
 *
 * 为什么换成 Node 而不是 PowerShell：
 *   PowerShell 进程即使加了 -WindowStyle Hidden，创建那一瞬间仍可能闪一个窗口；
 *   而 node.exe 用 windowsHide:true 启动是完全不可见的。
 *
 * 职责：
 *   1. 单实例（用 Node 的独占文件锁，跨进程可靠）
 *   2. 每 60 秒检查端口；服务没在就拉起 supervisor
 *   3. 自身由 wscript 以隐藏窗口启动，不在任何终端的 Job Object 里
 *
 * 用法：node src/watchdog.js [--port 8787] [--interval 60] [--once]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const args = process.argv.slice(2);
const argOf = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf('--port', '8787'));
const INTERVAL = Number(argOf('--interval', '60'));
const ONCE = args.includes('--once');

const LOG = path.join(OUT, 'watchdog.log');
const LOCK = path.join(OUT, '.watchdog.lock');

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) {
      fs.renameSync(LOG, LOG + '.1');
    }
    const ts = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    fs.appendFileSync(LOG, `${ts}  ${msg}\n`, 'utf8');
  } catch (e) { /* 日志失败不影响主逻辑 */ }
}

/**
 * 取锁。关键：锁文件里写 PID，若持有者已死则视为脏锁，自动回收。
 * 只靠 wx 原子创建是不够的 —— 进程被强杀时锁文件不会被删除，
 * 会导致后续所有 watchdog 误判"已有实例"而永久 SKIP。
 */
function acquireLock() {
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) {}

  const staleGuard = () => {
    // 读旧锁里的 PID，判断是否还活着
    try {
      const txt = fs.readFileSync(LOCK, 'utf8').trim();
      const oldPid = parseInt(txt, 10);
      if (!oldPid) return true;           // 内容无效 → 视为脏锁
      try {
        process.kill(oldPid, 0);          // 只探测，不发信号
        return false;                     // 进程还活着 → 不是脏锁
      } catch (e) {
        return true;                      // ESRCH 等 → 进程已死 → 脏锁
      }
    } catch (e) {
      return true;                        // 读不到 → 脏锁
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx'); // 原子：已存在则失败
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      if (staleGuard()) {
        log(`发现脏锁（持有进程已退出），回收后重试 (第 ${attempt + 1} 次)`);
        try { fs.unlinkSync(LOCK); } catch (e2) {}
        continue;
      }
      return null;                        // 真有人在跑
    }
  }
  return null;
}

function releaseLock(fd) {
  try { fs.closeSync(fd); } catch (e) {}
  try { fs.unlinkSync(LOCK); } catch (e) {}
}

/** 探端口：能连上就说明有服务 */
function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(2500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function startSupervisor() {
  // windowsHide:true → 完全不弹窗；detached → 脱离当前进程组
  const p = spawn(process.execPath, [path.join(__dirname, 'supervisor.js'), '--port', PORT], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  p.unref();
  return p.pid;
}

async function main() {
  const fd = acquireLock();
  if (fd === null) {
    log(`SKIP: 已有 watchdog 持锁 (pid=${process.pid} 退出)`);
    return;
  }

  log(`WATCHDOG 启动 (port=${PORT} 间隔=${INTERVAL}s pid=${process.pid})`);

  const stop = () => {
    log('WATCHDOG 退出');
    releaseLock(fd);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (e) => log('异常: ' + e.message));

  while (true) {
    if (!(await portAlive(PORT))) {
      log(`端口 ${PORT} 无监听 -> 拉起 supervisor`);
      try {
        const pid = startSupervisor();
        log(`  已拉起 PID=${pid}`);
      } catch (e) {
        log('  拉起失败: ' + e.message);
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }

  stop();
}

main();
