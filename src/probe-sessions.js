// 探查：解码 DSH 会话日志，提取 usage 与 session 元数据
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function frameLen(buf, off) {
  let p = off + 4;
  const fhd = buf[p++];
  const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if (!single) p++;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  while (true) {
    const bh = buf.readUIntLE(p, 3); p += 3;
    const last = bh & 1, size = bh >>> 3;
    p += size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p - off;
}

function decodeAll(file) {
  const buf = fs.readFileSync(file);
  let off = 0; const parts = [];
  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== 0xFD2FB528) break;
    const len = frameLen(buf, off);
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8')); } catch (e) {}
    off += len;
  }
  return parts.join('');
}

function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.zstd')) out.push(p);
  }
  return out;
}

const root = process.argv[2];
const files = walk(root, []);
const sessions = [];
for (const f of files) {
  let text;
  try { text = decodeAll(f); } catch (e) { continue; }
  const lines = text.split('\n').filter(Boolean);
  let meta = null;
  const byModel = {};
  const usages = [];
  const presets = {};
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch (e) { continue; }
    if (o.type === 'session' && !meta) meta = o;
    if (o.type === 'model/selection') presets['sel:' + (o.data && (o.data.model || o.data.selection))] = 1;
    if (o.type === 'assistant/message' && o.data && o.data.usage) {
      const u = o.data.usage;
      const src = ((o.data.message || {}).source) || {};
      const k = (src.provider || '?') + '/' + (src.model || '?');
      byModel[k] = byModel[k] || { n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const b = byModel[k];
      b.n++;
      b.input += u.inputTokens || 0;
      b.output += u.outputTokens || 0;
      b.cacheRead += u.cacheReadTokens || 0;
      b.cacheWrite += u.cacheWriteTokens || 0;
      b.reasoning += u.reasoningTokens || 0;
      usages.push({ t: o.time, ...b });
    }
  }
  sessions.push({
    file: f,
    sid: meta && meta.id,
    preset: meta && meta.agentPreset,
    origin: meta && meta.origin,
    depth: meta && meta.delegationDepth,
    cwd: meta && meta.cwd,
    parent: meta && meta.parentSession,
    createdAt: meta && meta.createdAt,
    bytes: fs.statSync(f).size,
    byModel,
    usageCount: usages.length,
    firstUsage: usages.length ? usages[0].t : null,
    lastUsage: usages.length ? usages[usages.length - 1].t : null,
  });
}
console.log(JSON.stringify(sessions, null, 1));
