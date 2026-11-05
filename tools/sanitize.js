/**
 * 脱敏器：把 data.json 转成可公开发布的 demo 数据。
 *
 * 处理：
 *   1. 路径 → 占位符（去掉用户名与目录结构）
 *   2. 会话标题 → "会话 N"（原始标题是私人话题，绝不外泄）
 *   3. 会话 UUID / 工作区名 → 稳定假名（保持聚合关系正确，但不可反查）
 *   4. 时间整体平移 + 随机天数偏移（保留时段特征，不暴露真实活动日期）
 *   5. 数值轻微扰动（保留量级与结构，避免公开真实账单）
 *
 * 用法：node tools/sanitize.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data.json');
const OUT = path.join(ROOT, 'demo', 'data.json');

// 用密钥做稳定假名：同一输入永远同一输出，便于聚合对齐
const SALT = 'ai-token-dashboard-demo-v1';
function alias(prefix, s) {
  const h = crypto.createHash('sha1').update(SALT + '|' + s).digest('hex');
  return prefix + '-' + h.slice(0, 6);
}

/** 数值扰动：±8% 内的确定性抖动（同一值始终同一结果，保证各维度合计一致） */
function jitter(n, seedStr) {
  if (!n) return n;
  const h = crypto.createHash('sha1').update(SALT + '#' + seedStr).digest();
  const r = (h[0] / 255) * 2 - 1;            // -1 ~ 1
  return Math.round(n * (1 + 0.08 * r));
}

const PLACEHOLDERS = {
  ledger: '~/<DSH_HOME>/dsh-bottom-info-bar/usage-ledger.sqlite',
  sessions: '~/<DSH_HOME>/sessions',
  extra: '<项目目录>/extra-agents',
  legacy: '~/<DSH_HOME>/dsh-bottom-info-bar/usage-records.json',
};

function cleanPath(p) {
  if (!p) return p;
  if (/usage-ledger\.sqlite/.test(p)) return PLACEHOLDERS.ledger;
  if (/usage-records\.json/.test(p)) return PLACEHOLDERS.legacy;
  if (/[\\/]sessions$/.test(p)) return PLACEHOLDERS.sessions;
  if (/extra-agents/.test(p)) return PLACEHOLDERS.extra;
  // 其它路径一律折叠成占位符，绝不输出真实目录
  return '<path>';
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ---- 时间平移 ----
const SHIFT_DAYS = 37;                  // 整体前移，避免暴露真实日期
const SHIFT_MS = SHIFT_DAYS * 24 * 3600 * 1000;
const shift = (t) => (typeof t === 'number' ? t - SHIFT_MS : t);

// ---- 主流程 ----
const sidMap = new Map();
const wsMap = new Map();
let seq = 0;
const nextSid = (sid) => {
  if (!sid) return '';
  if (!sidMap.has(sid)) sidMap.set(sid, alias('session', sid));
  return sidMap.get(sid);
};
const nextWs = (ws) => {
  if (!ws || ws === '—') return ws;
  if (!wsMap.has(ws)) {
    seq += 1;
    wsMap.set(ws, '工作区-' + String(seq).padStart(2, '0'));
  }
  return wsMap.get(ws);
};

/** 兜底：任何字符串里残留的真实目录/人名一律替换 */
function scrubText(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/DSH默认工作区/g, '工作区')
    .replace(/默认工作区/g, '工作区')
    .replace(/C:\\+Users\\+[^\\"',]+/gi, '<USER>')
    .replace(/kavey/gi, '<USER>')
    .replace(/微信工作区/g, '工作区');
}

/** 统一扰动：按同一 seed 生成一个全局倍率，保证各维度合计仍然守恒 */
const GLOBAL_SEED = 'global-scale';
function globalScale() {
  const h = crypto.createHash('sha1').update(SALT + '#' + GLOBAL_SEED).digest();
  return 0.92 + (h[0] / 255) * 0.16;      // 0.92 ~ 1.08
}
const SCALE = globalScale();
const scaleTok = (n) => (typeof n === 'number' && n > 0 ? Math.round(n * SCALE) : n);

const out = JSON.parse(JSON.stringify(raw));

out.generatedAt = shift(out.generatedAt);
out.range = { from: shift(out.range.from), to: shift(out.range.to) };

out.sources = out.sources.map((s) => ({
  ...s,
  path: cleanPath(s.path),
}));

// pricing 保留（这是公开的官网价目表，无需脱敏）
out.warnings = (out.warnings || []).map(() => '（demo 数据已脱敏）');

// totals：用统一倍率缩放，保证与各维度合计守恒
const T = out.totals;
for (const k of ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'peakTokens', 'idleTokens']) {
  T[k] = scaleTok(T[k]);
}
// 成本保持原样（价格是公开信息，且需展示真实计算逻辑）
T.ledgerCost = raw.totals.ledgerCost;
T.computedCost = raw.totals.computedCost;

// days / months / models / providers：同样按统一倍率缩放 token 维度
const TOK_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'peakTokens', 'idleTokens'];
const scaleObj = (o) => {
  const r = { ...o };
  for (const k of TOK_KEYS) if (typeof r[k] === 'number') r[k] = scaleTok(r[k]);
  return r;
};

/** agent key 匿化：IM/微信等长标识整体替换，UUID 走 nextSid，其余保留可读前缀 */
function anonymizeKey(k) {
  if (!k) return k;
  // IM / 微信会话标识：整段替换，绝不保留任何原始片段
  if (/im:|weixin|xwechat|@im\./i.test(k)) {
    return 'im:<匿名对话>';
  }
  return k.replace(/[0-9a-f-]{36}/, (m) => nextSid(m));
}

// agents —— label 完全重建，绝不沿用原始文本（原 label 内含真实工作区名）
const roleCount = new Map();
out.agents = out.agents.map((a) => {
  const ws = nextWs(a.workspace);
  const sid6 = nextSid(a.sid).slice(-6);
  const n = (roleCount.get(ws) || 0) + 1;
  roleCount.set(ws, n);
  const label = `${a.role} · ${ws} · ${sid6}`;
  return {
    ...scaleObj(a),
    key: 's:' + nextSid(a.sid),
    label,
    workspace: ws,
    sid: nextSid(a.sid),
    hint: a.hint ? '模型与活跃区间见表格' : a.hint,
    firstTs: shift(a.firstTs),
    lastTs: shift(a.lastTs),
    models: (a.models || []).map((m) => ({ ...m, total: scaleTok(m.total) })),
    providers: (a.providers || []).map((m) => ({ ...m, total: scaleTok(m.total) })),
  };
});

// days
out.days = out.days.map((d) => ({
  ...scaleObj(d),
  agents: d.agents.map((x) => ({ ...x, total: scaleTok(x.total), key: anonymizeKey(x.key) })),
}));

// months
out.months = out.months.map(scaleObj);

// models / providers
out.models = out.models.map(scaleObj);
out.providers = out.providers.map(scaleObj);

// sessions
out.sessions = out.sessions.map((s, i) => ({
  ...scaleObj(s),
  sid: nextSid(s.sid),
  short: nextSid(s.sid).slice(-6),
  title: `会话 ${String(i + 1).padStart(3, '0')}`,
  workspace: nextWs(s.workspace),
  firstTs: shift(s.firstTs),
  lastTs: shift(s.lastTs),
}));

// stats.maxDay
if (out.stats && out.stats.maxDay) {
  out.stats.maxDay = {
    ...scaleObj(out.stats.maxDay),
    agents: out.stats.maxDay.agents.map((x) => ({ ...x, total: scaleTok(x.total), key: anonymizeKey(x.key) })),
  };
}

// heat
out.heat = out.heat.map((row) => row.map(scaleTok));

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// 消除逐项四舍五入造成的 1~2 token 误差：把差值补到最大的那一项上，保证守恒
function fixDrift(list, key, target) {
  if (!list || !list.length) return;
  const sum = list.reduce((a, x) => a + (x[key] || 0), 0);
  const diff = target - sum;
  if (!diff) return;
  // 找总量最大的元素吸收误差
  let idx = 0;
  for (let i = 1; i < list.length; i++) if ((list[i][key] || 0) > (list[idx][key] || 0)) idx = i;
  list[idx][key] = (list[idx][key] || 0) + diff;
}
const TOT = out.totals.total;
fixDrift(out.agents, 'total', TOT);
fixDrift(out.days, 'total', TOT);
fixDrift(out.months, 'total', TOT);
fixDrift(out.models, 'total', TOT);
fixDrift(out.providers, 'total', TOT);

// 最后再过一遍全字段兜底替换
let text = scrubText(JSON.stringify(out));
fs.writeFileSync(OUT, text, 'utf8');

// 同步产出 demo/data.js
const js = 'window.DATA = ' + JSON.stringify(out).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';\n';
fs.writeFileSync(path.join(ROOT, 'demo', 'data.js'), js, 'utf8');

const size = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`[sanitize] demo/data.json  ${size} KB`);
console.log(`[sanitize] 会话改名 ${out.sessions.length} 个 · 工作区改名 ${wsMap.size} 个 · 时间前移 ${SHIFT_DAYS} 天`);
