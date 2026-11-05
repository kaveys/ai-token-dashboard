/**
 * AI Token 统计台 · 本地 Web 服务
 * 静态文件 + /api/data（按需重新聚合，带 30s 缓存）
 *
 * 用法：node src/server.js [--port 8787] [--no-open]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf('--port', '8787'));
// 默认「不打开浏览器」：后台自启时绝不允许弹窗。
// 只有手动运行时显式传 --open 才会拉起浏览器。
const OPEN = args.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let cache = { at: 0, body: null, etag: null, running: null };
const TTL = 25 * 1000;

function aggregate() {
  // 并发合并：同时到达的多个请求共享同一个子进程，避免并行跑多份聚合
  if (cache.running) return cache.running;
  const now = Date.now();
  if (cache.body && now - cache.at < TTL) return Promise.resolve(cache.body);
  cache.running = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'aggregate.js')],
      { cwd: ROOT, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      (err) => {
        cache.running = null;
        if (err) return reject(err);
        try {
          const body = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
          const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
          cache = { at: Date.now(), body, etag, running: null };
          resolve(body);
        } catch (e) { reject(e); }
      }
    );
  });
  return cache.running;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (e) {
    res.writeHead(400).end('bad url');
    return;
  }
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/data') {
    try {
      const body = await aggregate();
      // 带上 ETag：内容没变时直接 304，省掉 120KB 传输
      if (req.headers['if-none-match'] === cache.etag) {
        res.writeHead(304, { ETag: cache.etag, 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ETag: cache.etag,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (p === '/api/refresh') {
    cache = { at: 0, body: null, etag: null, running: null };
    try {
      const body = await aggregate();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ETag: cache.etag,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // 静态文件
  const rel = p === '/' || p === '' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': full.endsWith('.html') ? 'no-store' : 'no-cache',
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  AI Token 统计台已启动');
  console.log('  ' + url);
  console.log('  按 Ctrl+C 停止\n');
  if (OPEN) {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  }
  // 预热一次，避免首屏等待
  aggregate().catch(() => {});
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 端口被占：先探一下是不是已经有本服务在跑（比如重复自启），是就安静退出，不算故障
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/data', timeout: 3000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        console.log(`端口 ${PORT} 上已有统计台在运行，本实例退出（不是错误）。`);
        process.exit(0);
      } else {
        console.log(`端口 ${PORT} 被其它程序占用，换一个：node src/server.js --port 8899`);
        process.exit(1);
      }
    }).on('error', () => {
      console.log(`端口 ${PORT} 被占用且不是统计台，换一个：node src/server.js --port 8899`);
      process.exit(1);
    });
    return;
  }
  console.log('服务启动失败：', e.message);
  process.exit(1);
});
