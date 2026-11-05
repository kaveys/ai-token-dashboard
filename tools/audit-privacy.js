/**
 * 脱敏审计：对 demo/ 与将要提交的源码做穷举式隐私检查。
 * 任何一项命中都会让脚本以非 0 退出，阻止提交。
 *
 * 用法：node tools/audit-privacy.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 必须为零命中的敏感模式 */
const FORBIDDEN = [
  { re: /kavey/i, why: '本机用户名' },
  { re: /C:\\+Users/i, why: 'Windows 用户目录绝对路径' },
  { re: /C:\\+Windows|C:\\+Program Files/i, why: '系统绝对路径' },
  { re: /Desktop|Documents|Downloads/i, why: '个人目录名' },
  { re: /微信工作区|xwechat_files|im:weixin|@im\.wechat/i, why: '微信 / IM 身份' },
  { re: /\.credentials|access_token|refresh_token|api_key|apikey|Bearer /i, why: '凭据字样' },
  { re: /sk-[A-Za-z0-9]{8,}/, why: 'API Key 形态' },
  { re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, why: 'GitHub Token 形态' },
  { re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, why: 'JWT 形态' },
  { re: /(?:^|[^0-9])1[3-9]\d{9}(?![0-9])/, why: '手机号形态（11 位独立数字）' },
  { re: /[A-Za-z0-9._%+-]+@(qq|163|gmail|outlook|foxmail)\.com/i, why: '邮箱形态' },
   { re: /中式|思政作业|红米|Magisk|正大杯|无人航空器|高数|极限/i, why: '真实会话话题' },
  { re: /微信工作区|思政|极限|键鼠|自用脚本|学习文件|2026正大杯/i, why: '真实工作区名' },
   { re: /deepseek-harness-default-workspace/i, why: '真实本机目录名' },
];

/** 允许的会话标题形态：只允许 "会话 NNN" */
const TITLE_RE = /^会话 \d{3}$/;

const problems = [];
let scanned = 0;

function scanFile(file) {
  const base = path.basename(file);
  // 审计器与脱敏器自身必然包含这些模式串（它们是规则本身）；它们不含真实数据
  if (base === 'audit-privacy.js' || base === 'sanitize.js' || base === 'pre-commit-gate.sh' || base === '.gitignore') return;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  if (text.length > 60 * 1024 && !/\.json|\.js/.test(file)) return;
  scanned++;
  const rel = path.relative(ROOT, file);
  for (const { re, why } of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      const idx = Math.max(0, m.index - 40);
      problems.push({
        file: rel,
        why,
        sample: text.slice(idx, idx + 90).replace(/\s+/g, ' '),
      });
    }
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // bin=运行时; out=本地日志/缓存; .git; node_modules
      if (['bin', 'node_modules', '.git', 'out'].includes(e.name)) continue;
      walk(p, out);
    } else {
      // 本机采集产物不进仓库，也不审计
      if (['data.json', 'data.js'].includes(e.name)) continue;
      out.push(p);
    }
  }
  return out;
}

// 1) 全量扫描（排除 bin 大文件与 .git）
const files = walk(ROOT);
for (const f of files) scanFile(f);

// 2) 专门的 demo 数据检查
const demoPath = path.join(ROOT, 'demo', 'data.json');
if (fs.existsSync(demoPath)) {
  const d = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
  const bad = [];
  for (const s of d.sessions) if (!TITLE_RE.test(s.title)) bad.push(s.title);
  for (const a of d.agents) if (/会话\s*·\s*[0-9a-f]{8}/.test(a.label)) bad.push(a.label);
  for (const s of d.sources) if (/C:\\|Users|kavey/.test(s.path || '')) bad.push(s.path);

  // 全量原文扫描 —— 覆盖 agents / maxDay / heat 等此前漏检的位置
  const rawDemo = JSON.stringify(d);
  const RAW_RULES = [
    [/im:weixin|@im\.wechat|weixin_[0-9a-f]{8,}/i, 'IM/微信 会话标识'],
    [/xwechat|\bwxid\b/i, '微信账号标识'],
    [/kavey|C:\\+Users/i, '本机用户名或绝对路径'],
    [/\b1[3-9]\d{9}\b/, '手机号形态'],
  ];
  for (const [re, why] of RAW_RULES) {
    if (re.test(rawDemo)) bad.push(why);
  }
  for (const s of d.sessions) {
    if (!/^(session-[0-9a-f]{6}|)$/.test(s.sid) && !/^[0-9a-f]{8}$/.test(s.short)) {
      // 只允许 session-xxxxxx 形态
      if (!/^session-[0-9a-f]{6}$/.test(s.sid)) bad.push('sid:' + s.sid);
    }
  }
  if (bad.length) {
    problems.push({ file: 'demo/data.json', why: '标题/标签/sid 未脱敏', sample: JSON.stringify(bad.slice(0, 5)) });
  }
} else {
  problems.push({ file: 'demo/data.json', why: '文件缺失', sample: '' });
}

// 输出
console.log(`[audit] 扫描 ${scanned} 个文件，${FORBIDDEN.length} 类模式 + demo 结构校验`);
if (!problems.length) {
  console.log('[audit] PASS 未发现敏感信息');
  process.exit(0);
}
console.log(`[audit] FAIL 命中 ${problems.length} 处：`);
for (const p of problems.slice(0, 25)) {
  console.log(`  - ${p.file}  [${p.why}]`);
  if (p.sample) console.log(`      ${p.sample}`);
}
process.exit(1);
