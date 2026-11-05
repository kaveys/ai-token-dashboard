/**
 * AI Token 统计台 · 聚合器
 * 读取本机所有可发现的 AI Agent 用量记录，汇总成 data.json 供本地网页渲染。
 *
 * 数据源：
 *   1. ~/.dsh/dsh-bottom-info-bar/usage-ledger.sqlite  —— DSH 全 provider 用量账本（主源，逐请求明细）
 *   2. ~/.dsh/sessions/**\/session.v4.jsonl.zstd       —— DSH 会话日志（会话标题 / Agent 归属 / 工作区 / 主代理或子代理）
 *   3. ~/.dsh/dsh-bottom-info-bar/usage-records.json   —— 旧版账本（仅在 sqlite 缺失时兜底）
 *   4. <本目录>/extra-agents/*.json                    —— 手工追加的外部 Agent 用量（可选）
 *
 * 用法：node src/aggregate.js [--out data.json]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { isPeak, priceOf, IDLE, HOLIDAYS, priceKeyFor } = require('./pricing');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DSH = path.join(HOME, '.dsh');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data.json');
const EXTRA_DIR = path.join(ROOT, 'extra-agents');
const CACHE_FILE = path.join(ROOT, 'out', '.session-cache.json');
const TZ = 'Asia/Shanghai';

const warnings = [];
const sources = [];

/* ────────────────────────── 时间工具 ────────────────────────── */
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const partsRe = /(\d{4})-(\d{2})-(\d{2})(?:,? (\d{2}))?/;
// 按小时桶缓存：同一小时内的 date/month/hour/weekday 完全相同（UTC 整点对齐，无夏令时漂移）
const hourCache = new Map();
function localParts(ts) {
  const bucket = Math.floor(ts / 3600000);
  const hit = hourCache.get(bucket);
  if (hit) return hit;
  const m = partsRe.exec(partsFmt.format(new Date(ts)).replace(/\u200e/g, ''));
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const out = {
    date,
    month: `${m[1]}-${m[2]}`,
    hour: m[4] ? Number(m[4]) : 0,
    weekday: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(),
  };
  hourCache.set(bucket, out);
  return out;
}

/** 本地日期字符串 YYYY-MM-DD（供标题/提示复用） */
function fullDate(ts) {
  return localParts(ts).date;
}

/* ─────────────────────── zstd 多帧解码 ─────────────────────── */
function frameLen(buf, off) {
  let p = off + 4;
  const fhd = buf[p++];
  const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if (!single) p++;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  while (true) {
    const bh = buf.readUIntLE(p, 3);
    p += 3;
    const last = bh & 1, size = bh >>> 3;
    p += size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p - off;
}

function walkZstd(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkZstd(p, acc);
    else if (e.name.endsWith('.zstd')) acc.push(p);
  }
  return acc;
}

/** 解码单个会话日志，只保留聚合所需的元信息，避免大对象常驻
 *  会话文件是"追加写"的：命中前缀缓存时，只需从上次读到的帧偏移继续解码。 */
function readSession(file, fromFrame = 0, carry = null) {
  const buf = fs.readFileSync(file);
  let off = 0;
  const out = carry
    ? Object.assign({}, carry, { file, models: Object.assign({}, carry.models) })
    : { file, meta: null, title: null, turns: 0, steps: 0, minTs: Infinity, maxTs: 0, models: {}, frames: 0 };

  // 跳过已解码的帧：只做便宜的长度计算，不做解压
  for (let i = 0; i < fromFrame && off < buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0xFD2FB528) return out;
    off += frameLen(buf, off);
  }
  out.frames = fromFrame;

  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== 0xFD2FB528) break;
    const len = frameLen(buf, off);
    let text = '';
    try { text = zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'); } catch (e) { /* 损坏帧跳过 */ }
    off += len;
    out.frames++;
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!line) continue;
      // 便宜预筛：绝大多数行是 tool/result / step 之类的大对象，先按类型关键词过滤再解析
      const tq = line.indexOf('"type":"');
      if (tq < 0) continue;
      const t = line.slice(tq + 8, tq + 40).split('"')[0];
      if (t !== 'session' && t !== 'session/title' && t !== 'turn/start' &&
          t !== 'step/start' && t !== 'assistant/message') {
        // 非白名单记录也要贡献时间范围。JSONL 的字段序固定为 {"type":…,"seq":…,"time":…,"data":…}，
        // 把查找限制在 "data": 之前，避免命中正文/工具输出里的 "time" 字样。
        const dataAt = line.indexOf('"data":');
        const limit = dataAt > 0 ? dataAt : line.length;
        const ti = line.indexOf('"time":', 0);
        if (ti >= 0 && ti < limit) {
          const v = Number(line.slice(ti + 7, ti + 22).split(/[,}]/)[0]);
          if (Number.isFinite(v) && v > 0) {
            if (v < out.minTs) out.minTs = v;
            if (v > out.maxTs) out.maxTs = v;
          }
        }
        continue;
      }
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (t === 'session') { if (!out.meta) out.meta = o; }
      else if (t === 'session/title') {
        const d = o.data || {};
        if (!out.title) out.title = (d.title || d.text || '').toString().slice(0, 120) || null;
      } else if (t === 'turn/start') out.turns++;
      else if (t === 'step/start') out.steps++;
      else if (t === 'assistant/message') {
        const src = (o.data && o.data.message && o.data.message.source) || {};
        if (src.provider || src.model) {
          const k = `${src.provider || '?'}/${src.model || '?'}`;
          out.models[k] = out.models[k] || { n: 0, input: 0, output: 0, cacheRead: 0 };
          const b = out.models[k];
          const u = (o.data && o.data.usage) || {};
          b.n++;
          b.input += u.inputTokens || 0;
          b.output += u.outputTokens || 0;
          b.cacheRead += u.cacheReadTokens || 0;
        }
      }
      if (typeof o.time === 'number') {
        if (o.time < out.minTs) out.minTs = o.time;
        if (o.time > out.maxTs) out.maxTs = o.time;
      }
    }
  }
  return out;
}

/** 会话解析结果缓存：以 (size, mtime) 判断是否可复用，只增量解码新增帧 */
function loadSessionMetas(files) {
  let cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.v === 2 && raw.files) cache = raw.files;
  } catch (e) { /* 无缓存或已损坏 */ }

  const next = {};
  const metas = new Map();
  let reused = 0, incremental = 0, full = 0;

  for (const f of files) {
    const st = fs.statSync(f);
    const key = f;
    const prev = cache[key];
    let s;
    const same = prev && prev.size === st.size && prev.mtime === st.mtimeMs;
    const grown = prev && !same && st.size > prev.size && prev.frames > 0;
    try {
      if (same) {
        s = prev.data;
        reused++;
      } else if (grown) {
        s = readSession(f, prev.frames, prev.data);
        incremental++;
      } else {
        s = readSession(f, 0, null);
        full++;
      }
    } catch (e) {
      warnings.push(`会话日志解析失败 ${path.basename(path.dirname(f))}：${e.message}`);
      continue;
    }
    next[key] = { size: st.size, mtime: st.mtimeMs, frames: s.frames || 0, data: s };

    const id = s.meta && s.meta.id ? normSid(s.meta.id) : path.basename(path.dirname(f)).replace(/^session-/, '');
    metas.set(id, {
      id,
      raw: s.meta || {},
      title: s.title,
      preset: (s.meta && s.meta.agentPreset) || 'standard',
      origin: (s.meta && s.meta.origin) || 'main',
      depth: (s.meta && s.meta.delegationDepth) || 0,
      cwd: (s.meta && s.meta.cwd) || '',
      parent: (s.meta && s.meta.parentSession) || null,
      createdAt: (s.meta && s.meta.createdAt) || (s.minTs === Infinity ? null : s.minTs),
      turns: s.turns,
      steps: s.steps,
      minTs: s.minTs === Infinity ? null : s.minTs,
      maxTs: s.maxTs || null,
      models: s.models,
    });
  }

  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ v: 2, files: next }), 'utf8');
  } catch (e) {
    warnings.push(`会话缓存写入失败：${e.message}`);
  }

  return { metas, reused, incremental, full };
}

/* ─────────────────────── 账本读取 ─────────────────────── */
function normSid(sid) {
  if (!sid) return '';
  return sid.startsWith('session-') ? sid.slice(8) : sid;
}

function loadLedger() {
  const dbPath = path.join(DSH, 'dsh-bottom-info-bar', 'usage-ledger.sqlite');
  if (fs.existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('select seq, ts, payload from records').all();
      db.close();
      const recs = [];
      for (const r of rows) {
        let o;
        try { o = JSON.parse(r.payload); } catch (e) { continue; }
        if (!o || typeof o.ts !== 'number') continue;
        recs.push(o);
      }
      sources.push({
        name: 'DSH 用量账本 (SQLite)', path: dbPath, ok: true,
        detail: `${recs.length.toLocaleString('en-US')} 条逐请求记录`,
      });
      return recs;
    } catch (e) {
      warnings.push(`读取 SQLite 账本失败：${e.message}`);
      sources.push({ name: 'DSH 用量账本 (SQLite)', path: dbPath, ok: false, detail: e.message });
    }
  } else {
    sources.push({ name: 'DSH 用量账本 (SQLite)', path: dbPath, ok: false, detail: '文件不存在' });
  }

  const legacy = path.join(DSH, 'dsh-bottom-info-bar', 'usage-records.json');
  if (fs.existsSync(legacy)) {
    try {
      const d = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      const recs = Array.isArray(d) ? d : (d.records || []);
      sources.push({
        name: '旧版用量账本 (JSON)', path: legacy, ok: true,
        detail: `${recs.length.toLocaleString('en-US')} 条记录（兜底）`,
      });
      return recs;
    } catch (e) {
      warnings.push(`读取 JSON 账本失败：${e.message}`);
    }
  }
  return [];
}

/* ─────────────────────── 外部 Agent 追加 ─────────────────────── */
function loadExtra() {
  const recs = [];
  if (!fs.existsSync(EXTRA_DIR)) {
    sources.push({ name: '外部 Agent 追加目录', path: EXTRA_DIR, ok: false, detail: '未创建（可选）' });
    return recs;
  }
  for (const f of fs.readdirSync(EXTRA_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(EXTRA_DIR, f), 'utf8'));
      const list = Array.isArray(d) ? d : (d.records || []);
      for (const r of list) if (r && typeof r.ts === 'number') recs.push(r);
      sources.push({ name: `外部 Agent 记录 · ${f}`, path: path.join(EXTRA_DIR, f), ok: true, detail: `${list.length} 条` });
    } catch (e) {
      warnings.push(`外部记录 ${f} 解析失败：${e.message}`);
    }
  }
  return recs;
}

/* ─────────────────────── 主流程 ─────────────────────── */
function main() {
  const recs = loadLedger().concat(loadExtra());

  // 会话元信息（带增量缓存）
  const sessionsDir = path.join(DSH, 'sessions');
  const files = walkZstd(sessionsDir);
  const conv = loadSessionMetas(files);
  const metas = conv.metas;
  sources.push({
    name: 'DSH 会话日志 (zstd)', path: sessionsDir, ok: files.length > 0,
    detail: `${files.length} 个会话文件，识别 ${metas.size} 个 Agent 会话` +
      `（复用 ${conv.reused} · 增量 ${conv.incremental} · 全解 ${conv.full}）`,
  });

  /* 逐请求归一化（含官方分时段定价） */
  const flat = [];
  const priceStats = { ledger: 0, official: 0, none: 0, peakCount: 0, idleCount: 0 };
  let costLedger = 0, costTotal = 0, costPeak = 0, costIdle = 0;
  let tokPeak = 0, tokIdle = 0;
  for (const r of recs) {
    const input = r.input || 0, cacheRead = r.cacheRead || 0, cacheWrite = r.cacheWrite || 0, output = r.output || 0;
    const sid = normSid(r.sessionId);
    const t = localParts(r.ts);
    const peak = isPeak(t.date, t.hour);
    const base = {
      ts: r.ts, date: t.date, month: t.month, hour: t.hour, weekday: t.weekday, peak,
      sid, provider: r.provider || '(未知)', model: r.model || '(未知)',
      input, cacheRead, cacheWrite, output,
      total: input + cacheRead + cacheWrite + output,
    };
    const p = priceOf(Object.assign({}, r, { peak: peak ? 1 : 0 }));
    base.cost = p.cost;
    base.priced = p.priced;
    base.basis = p.basis;
    if (p.basis === 'ledger') costLedger += p.cost;
    priceStats[p.basis] = (priceStats[p.basis] || 0) + 1;
    if (p.priced) costTotal += p.cost;
    if (peak) { priceStats.peakCount++; tokPeak += base.total; costPeak += p.cost; }
    else { priceStats.idleCount++; tokIdle += base.total; costIdle += p.cost; }
    flat.push(base);
  }

  /* Agent = 会话（主代理 / 子代理）× 工作区 × preset；无归档会话按 provider 归并 */
  function agentOf(rec) {
    const m = rec.sid ? metas.get(rec.sid) : null;
    if (m) {
      const wsPath = m.cwd || '';
      const ws = wsPath ? (wsPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || wsPath) : '未指定工作区';
      const role = m.depth > 0 || m.origin === 'subagent' ? '子代理' : '主代理';
      return { key: `s:${m.id}`, label: `${role} · ${ws}`, workspace: ws, role, preset: m.preset, sid: m.id, known: true };
    }
    if (rec.sid) {
      // 有会话 ID 但日志已归档/清理：仍按会话粒度独立计数，保留 Agent 身份
      return {
        key: `u:${rec.sid}`, label: `未归档会话 · ${rec.sid.slice(0, 8)}`,
        workspace: `来源 ${rec.provider}`, role: '未归档会话', preset: '—', sid: rec.sid, known: false,
      };
    }
    return {
      key: `p:${rec.provider}`, label: `散记请求 · ${rec.provider}`,
      workspace: '—', role: '散记请求', preset: '—', sid: '', known: false,
    };
  }

  const agentAgg = new Map();
  const dayAgg = new Map();
  const monthAgg = new Map();
  const modelAgg = new Map();
  const providerAgg = new Map();
  const sessionAgg = new Map();
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const totals = {
    requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0,
    cost: 0, priced: 0, unpriced: 0, errors: 0,
    // 分时段成本（官方错峰：高峰 = 空闲 × 2）
    peakTokens: 0, idleTokens: 0, peakCost: 0, idleCost: 0, peakRequests: 0, idleRequests: 0,
    ledgerCost: 0, computedCost: 0,
  };
  let minTs = Infinity, maxTs = 0;

  const blank = () => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: 0, priced: 0, unpriced: 0, peakTokens: 0, idleTokens: 0, peakCost: 0, idleCost: 0 });
  const add = (box, r) => {
    box.requests++;
    box.input += r.input; box.cacheRead += r.cacheRead; box.cacheWrite += r.cacheWrite;
    box.output += r.output; box.total += r.total;
    box.cost += r.priced ? r.cost : 0;
    if (r.peak) { box.peakTokens += r.total; box.peakCost += r.priced ? r.cost : 0; }
    else { box.idleTokens += r.total; box.idleCost += r.priced ? r.cost : 0; }
    if (r.priced) box.priced++; else box.unpriced++;
  };

  for (const r of flat) {
    add(totals, r);
    if (r.status && r.status !== 'completed') totals.errors++;
    if (r.peak) totals.peakRequests++; else totals.idleRequests++;
    if (r.basis === 'ledger') totals.ledgerCost += r.cost;
    else if (r.basis === 'official') totals.computedCost += r.cost;
    minTs = Math.min(minTs, r.ts); maxTs = Math.max(maxTs, r.ts);
    heat[r.weekday][r.hour] += r.total;

    const a = agentOf(r);
    let A = agentAgg.get(a.key);
    if (!A) {
      A = Object.assign(blank(), {
        key: a.key, label: a.label, workspace: a.workspace, role: a.role,
        preset: a.preset, sid: a.sid, known: a.known,
        sessions: new Set(), models: new Map(), providers: new Map(), firstTs: Infinity, lastTs: 0,
      });
      agentAgg.set(a.key, A);
    }
    add(A, r);
    if (r.sid) A.sessions.add(r.sid);
    A.firstTs = Math.min(A.firstTs, r.ts); A.lastTs = Math.max(A.lastTs, r.ts);
    A.models.set(r.model, (A.models.get(r.model) || 0) + r.total);
    A.providers.set(r.provider, (A.providers.get(r.provider) || 0) + r.total);

    let D = dayAgg.get(r.date);
    if (!D) { D = blank(); D.date = r.date; D.agents = new Map(); dayAgg.set(r.date, D); }
    add(D, r);
    D.agents.set(a.key, (D.agents.get(a.key) || 0) + r.total);

    let M = monthAgg.get(r.month);
    if (!M) { M = blank(); M.month = r.month; monthAgg.set(r.month, M); }
    add(M, r);

    const mk = `${r.provider}/${r.model}`;
    let Mo = modelAgg.get(mk);
    if (!Mo) { Mo = blank(); Mo.name = mk; Mo.provider = r.provider; Mo.model = r.model; modelAgg.set(mk, Mo); }
    add(Mo, r);

    let P = providerAgg.get(r.provider);
    if (!P) { P = blank(); P.provider = r.provider; providerAgg.set(r.provider, P); }
    add(P, r);

    if (r.sid) {
      let S = sessionAgg.get(r.sid);
      if (!S) { S = Object.assign(blank(), { sid: r.sid, firstTs: Infinity, lastTs: 0, models: new Map() }); sessionAgg.set(r.sid, S); }
      add(S, r);
      S.firstTs = Math.min(S.firstTs, r.ts); S.lastTs = Math.max(S.lastTs, r.ts);
      S.models.set(r.model, (S.models.get(r.model) || 0) + r.total);
    }
  }

  const agentList = [...agentAgg.values()].map((a) => ({
    key: a.key, label: a.label, workspace: a.workspace, role: a.role, preset: a.preset,
    sid: a.sid, known: a.known, hint: null,
    sessions: a.sessions.size, requests: a.requests,
    input: a.input, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, output: a.output,
    total: a.total, cost: a.cost, priced: a.priced, unpriced: a.unpriced,
    firstTs: a.firstTs === Infinity ? null : a.firstTs,
    lastTs: a.lastTs || null,
    models: [...a.models.entries()].sort((x, y) => y[1] - x[1]).map(([name, total]) => ({ name, total })),
    providers: [...a.providers.entries()].sort((x, y) => y[1] - x[1]).map(([name, total]) => ({ name, total })),
  })).sort((x, y) => y.total - x.total);

  // 同名 Agent（同一工作区内的多个会话）加短 ID 后缀，避免表格与图例里出现无法区分的重复行
  const labelCount = new Map();
  for (const a of agentList) labelCount.set(a.label, (labelCount.get(a.label) || 0) + 1);
  for (const a of agentList) {
    if ((labelCount.get(a.label) || 0) > 1 && a.sid) a.label = `${a.label} · ${a.sid.slice(0, 6)}`;
  }

  // 未归档会话难以一眼分辨：用「活跃时段 + 主要模型 + 时间段」补一个人性化副标题
  for (const a of agentList) {
    if (a.role !== '未归档会话') continue;
    const mo = a.models[0] ? a.models[0].name.split('/')[1] || a.models[0].name : '';
    const span = a.lastTs && a.firstTs ? `${fullDate(a.firstTs)}–${fullDate(a.lastTs).slice(5)}` : '';
    a.hint = [mo, span].filter(Boolean).join(' · ');
  }

  const sessionList = [...sessionAgg.values()].map((s) => {
    const m = metas.get(s.sid);
    return {
      sid: s.sid,
      short: s.sid.slice(0, 8),
      title: m ? ((m.title || '') || '会话 ' + s.sid.slice(0, 8)) : '未归档会话 · ' + s.sid.slice(0, 8),
      workspace: m ? (m.cwd || '').split(/[\\/]/).pop() || '—' : '—',
      role: m ? (m.depth > 0 || m.origin === 'subagent' ? '子代理' : '主代理') : '未归档',
      preset: m ? m.preset : '—',
      turns: m ? m.turns : 0,
      steps: m ? m.steps : 0,
      requests: s.requests, input: s.input, cacheRead: s.cacheRead, output: s.output,
      total: s.total, cost: s.cost, priced: s.priced,
      firstTs: s.firstTs === Infinity ? null : s.firstTs, lastTs: s.lastTs || null,
    };
  }).sort((x, y) => y.total - x.total);

  const domain = (() => {
    const out = [];
    const start = new Date(minTs === Infinity ? Date.now() : minTs);
    const end = new Date(maxTs || Date.now());
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    // 用本地日期遍历，保证与时区一致
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const lastStr = fmt.format(end).replace(/\u200e/g, '');
    let guard = 0;
    const d0 = new Date(fmt.format(start).replace(/\u200e/g, '') + 'T00:00:00Z');
    for (let d = d0; guard++ < 800; d.setUTCDate(d.getUTCDate() + 1)) {
      const s = d.toISOString().slice(0, 10);
      if (s > lastStr) break;
      out.push(s);
    }
    return out;
  })();

  const days = domain.map((date) => {
    const D = dayAgg.get(date);
    const agents = D ? [...D.agents.entries()].sort((a, b) => b[1] - a[1]).map(([key, total]) => ({ key, total })) : [];
    return {
      date,
      requests: D ? D.requests : 0,
      input: D ? D.input : 0, cacheRead: D ? D.cacheRead : 0, cacheWrite: D ? D.cacheWrite : 0,
      output: D ? D.output : 0, total: D ? D.total : 0,
      cost: D ? D.cost : 0,
      peakTokens: D ? D.peakTokens : 0, idleTokens: D ? D.idleTokens : 0,
      peakCost: D ? D.peakCost : 0, idleCost: D ? D.idleCost : 0,
      peakRequests: D ? D.peakRequests : 0, idleRequests: D ? D.idleRequests : 0,
      agents,
    };
  });

  const months = [...monthAgg.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    month: m.month, requests: m.requests, input: m.input, cacheRead: m.cacheRead,
    cacheWrite: m.cacheWrite, output: m.output, total: m.total, cost: m.cost, priced: m.priced,
    peakTokens: m.peakTokens, idleTokens: m.idleTokens, peakCost: m.peakCost, idleCost: m.idleCost,
  }));

  const payload = {
    generatedAt: Date.now(),
    timezone: TZ,
    range: { from: minTs === Infinity ? null : minTs, to: maxTs || null },
    sources,
    warnings,
    pricing: {
      // 官网价目表（元 / 百万 tokens，空闲时段价；高峰 = ×2）
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
      fetchedAt: '2026-11-04',
      currency: 'CNY',
      unit: '元 / 百万 tokens',
      idle: Object.fromEntries(Object.entries(IDLE).map(([k, v]) => [k, { input: v[0], cacheRead: v[1], output: v[2] }])),
      peakMultiplier: 2,
      peakRule: '北京时间 周一至周五（非法定节假日）9:00–12:00、14:00–18:00 为高峰，其余时段及周末/法定节假日全天空闲',
      holidays: [...HOLIDAYS].sort(),
      // 本次计价的构成
      ledgerRows: priceStats.ledger,
      computedRows: priceStats.official,
      unpricedRows: priceStats.none,
      peakRequests: priceStats.peakCount,
      idleRequests: priceStats.idleCount,
      ledgerCost: totals.ledgerCost,
      computedCost: totals.computedCost,
      totalCost: totals.cost,
    },
    totals: {
      ...totals,
      cacheHitRate: (totals.input + totals.cacheRead) > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : 0,
      avgPerRequest: totals.requests ? totals.total / totals.requests : 0,
      avgCostPerRequest: totals.requests ? totals.cost / totals.requests : 0,
      // 若全量都按高峰价计，成本会是多少（用于展示"错峰省了多少钱"）
      costIfAllPeak: totals.peakCost + totals.idleCost * 2,
    },
    agents: agentList,
    days,
    months,
    models: [...modelAgg.values()].map((m) => ({
      name: m.name, provider: m.provider, model: m.model, requests: m.requests,
      input: m.input, cacheRead: m.cacheRead, output: m.output, total: m.total, cost: m.cost, priced: m.priced,
    })).sort((a, b) => b.total - a.total),
    providers: [...providerAgg.values()].map((p) => ({
      provider: p.provider, requests: p.requests, input: p.input, cacheRead: p.cacheRead,
      output: p.output, total: p.total, cost: p.cost, priced: p.priced,
    })).sort((a, b) => b.total - a.total),
    sessions: sessionList,
    heat,
    stats: {
      agentCount: agentList.length,
      sessionCount: sessionList.length,
      modelCount: modelAgg.size,
      providerCount: providerAgg.size,
      activeDays: dayAgg.size,
      maxDay: days.reduce((a, b) => (b.total > a.total ? b : a), { total: 0, date: '—' }),
    },
  };

  const outPath = OUT;
  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
  // 同时写出 data.js，确保 file:// 直接双击打开也能读数据（不受 CORS 限制）
  const jsPath = path.resolve(__dirname, '..', 'data.js');
  const js = 'window.DATA = ' + JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';\n';
  fs.writeFileSync(jsPath, js, 'utf8');
  const size = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`[aggregate] ${outPath}  ${size} KB  (+ data.js)`);
  console.log(`[aggregate] 请求 ${totals.requests} · 总 token ${(totals.total / 1e6).toFixed(1)}M · Agent ${agentList.length} · 会话 ${sessionList.length} · 覆盖 ${dayAgg.size} 天`);
  if (warnings.length) warnings.forEach((w) => console.log('  ! ' + w));
}

main();
