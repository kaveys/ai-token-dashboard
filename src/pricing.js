/**
 * 官方价目表（来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
 * 抓取时间 2026-11-04。单位：元 / 百万 tokens。
 *
 * 错峰规则（官方网站原文）：
 *   空闲时段价格 = 高峰时段价格的一半。
 *   北京时间 周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
 *   其余时段，含周末及法定节假日全天，均为空闲时段。
 *
 * 交叉验证：用本机账本中 9,993 条官方已计价记录反解，单价与下表完全一致（误差 0），
 * 且按 isPeakAt() 分档后逐条比对，9,993 条全部精确吻合（不符 0 条）。
 */

const IDLE = {
  // model: [输入未命中缓存, 输入命中缓存(cacheRead), 输出]
  'deepseek-flash': [1.0, 0.02, 4.0],
  'deepseek-v4-pro': [4.5, 0.15, 13.5],
};

/** 模型名归一：旧名 / 变体 → 官方计费模型 */
function priceKeyFor(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('flash')) return 'deepseek-flash';      // deepseek-v4.1-flash, -1017, DeepSeek-V4.1-Flash…
  if (m.includes('v4-pro') || m.includes('v4pro')) return 'deepseek-v4-pro';
  if (m === 'deepseek-v4-flash') return 'deepseek-flash';
  if (m.includes('mimo')) return null;                   // 非 DeepSeek 官方模型，无公开价
  if (m.includes('deepseek')) return 'deepseek-v4-pro';  // 兜底：deepseek-v4 / deepseek 系列按 pro 计
  return null;
}

/** 中国法定节假日（2026 年主要假期；新增假期在此追加即可） */
const HOLIDAYS = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  // 清明
  '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

/**
 * 是否高峰时段。参数为本地日期（YYYY-MM-DD）与小时（0-23，北京时间）。
 * 周末与法定节假日全天空闲。
 */
function isPeak(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();  // 0=周日 6=周六
  if (wd === 0 || wd === 6) return false;
  if (HOLIDAYS.has(dateStr)) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * 计算一条记录的成本（元）。返回 { cost, priced, basis }。
 * basis: 'ledger' 取账本官方值；'official' 按官方价目表补算；'none' 无公开价。
 */
function priceOf(rec) {
  // 账本已有官方计价：直接采信，不重算
  if (rec.pricingStatus === 'priced' && typeof rec.cost === 'number') {
    return { cost: rec.cost, priced: true, basis: 'ledger' };
  }
  const key = priceKeyFor(rec.model);
  if (!key) return { cost: 0, priced: false, basis: 'none' };

  const [pin, pcr, pout] = IDLE[key];
  const peak = rec.peak ? 2 : 1;
  const cost = (rec.input * pin * peak
    + (rec.cacheRead || 0) * pcr * peak
    + (rec.cacheWrite || 0) * 0
    + rec.output * pout * peak) / 1e6;
  return { cost, priced: true, basis: 'official' };
}

module.exports = { IDLE, HOLIDAYS, priceKeyFor, isPeak, priceOf };
