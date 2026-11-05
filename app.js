/* AI Token 统计台 · 前端渲染
 * 数据来源：http(s) 下走 /api/data（可点刷新实时重算）；file:// 下读 data.js。
 * 无外部依赖。 */
(function () {
  'use strict';

  const ROLE_META = {
    '主代理':     { cls: 'main',  icon: 'i-role-main' },
    '子代理':     { cls: 'sub',   icon: 'i-role-sub' },
    '未归档会话': { cls: 'lost',  icon: 'i-role-lost' },
    '散记请求':   { cls: 'loose', icon: 'i-role-loose' },
  };
  const KIND_COLORS = { '缓存复用': '#6ec7ff', '输入': '#c9f24d', '输出': '#ff7a45' };
  const PALETTE = ['#c9f24d', '#6ec7ff', '#ff7a45', '#b28cff', '#ff6d9d', '#52d6a0',
                   '#ffd166', '#4dd4d0', '#a8e05f', '#f0785a', '#8aa9ff', '#d68cff'];
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const SVGNS = 'http://www.w3.org/2000/svg';

  const nf = new Intl.NumberFormat('en-US');
  const nInt = (n) => nf.format(Math.round(n || 0));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /** 正文数字：两位有效小数，但避免 "408.25M" 过长 → ≥100M 时降到一位 */
  function human(n) {
    n = n || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
    if (a >= 1e8) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }
  /** 轴刻度用更紧凑的写法，避免 1.00B / 750.0M 这种尾零 */
  function humanAxis(n) {
    n = n || 0;
    const a = Math.abs(n);
    const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
    if (a >= 1e9) return trim((n / 1e9).toFixed(1)) + 'B';
    if (a >= 1e6) return trim((n / 1e6).toFixed(a >= 1e8 ? 0 : 1)) + 'M';
    if (a >= 1e3) return trim((n / 1e3).toFixed(0)) + 'K';
    return String(Math.round(n));
  }
  const pct = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
  function money(n) { return n ? '¥' + (n >= 100 ? n.toFixed(0) : n.toFixed(2)) : '—'; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const md = (date) => date.slice(5).replace('-', '/');
  const shortLabel = (l) => {
    const p = String(l).split(' · ');
    return p.length >= 2 ? p[0] + ' · ' + p[1] : l;
  };
  function weekdayOf(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * p;
  }

  /* ══════════════ 引导：取数据 ══════════════ */
  function applyData(D) {
    if (!D || !D.totals) {
      document.getElementById('boot-error').hidden = false;
      return;
    }
    document.getElementById('boot-error').hidden = true;
    boot(D);
  }

  async function loadViaApi(force = false) {
    const url = force ? 'api/refresh' : 'api/data?t=' + Date.now();
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* 数字格式化依赖时区，统一挂在闭包里 */
  let D = null;
  let TZ = 'Asia/Shanghai';

  function fullDate(ts) {
    const f = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(new Date(ts)).replace(/\//g, '-');
  }
  function fullDateTime(ts) {
    const f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return f.format(new Date(ts));
  }
  function relTime(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts, m = 60e3, h = 60 * m, d = 24 * h;
    if (diff < m) return '刚刚';
    if (diff < h) return Math.floor(diff / m) + ' 分钟前';
    if (diff < d) return Math.floor(diff / h) + ' 小时前';
    if (diff < 7 * d) return Math.floor(diff / d) + ' 天前';
    return fullDate(ts);
  }

  /* ══════════════ 主渲染 ══════════════ */
  let renderDaily, renderAgents;

  function boot(data) {
    D = data;
    TZ = D.timezone || 'Asia/Shanghai';
    const T = D.totals;

    /* ── 顶栏 ── */
    const rangeFrom = D.range.from ? fullDate(D.range.from) : '—';
    const rangeTo = D.range.to ? fullDate(D.range.to) : '—';
    $('#topbar-sub').textContent = `本机 AI Agent 用量归集 · ${rangeFrom} → ${rangeTo}`;
    $('#generated').textContent = fullDateTime(D.generatedAt);
    $('#generated').title = '数据生成时间 ' + fullDateTime(D.generatedAt);
    $('#source-count').textContent = `${D.sources.filter((s) => s.ok).length} 个数据源`;

    /* ── 总计 ── */
    $('#total-tokens').textContent = human(T.total);
    $('#total-unit').textContent = 'tokens';

    $('#hero-split').innerHTML = [
      { lab: '输入', val: T.input, icon: 'i-in' },
      { lab: '缓存复用', val: T.cacheRead, icon: 'i-cache' },
      { lab: '输出', val: T.output, icon: 'i-out' },
    ].map((s) => `
      <div class="split-item">
        <span class="lab"><svg class="ico s"><use href="#${s.icon}"/></svg>${s.lab}</span>
        <span class="val" title="${nInt(s.val)} tokens">${human(s.val)}</span>
      </div>`).join('');

    $('#chips').innerHTML = [
      { lab: '累计成本', val: T.cost != null ? '¥' + (T.cost >= 1000 ? nInt(T.cost) : T.cost.toFixed(2)) : '—', icon: 'i-coins', sub: ' 按官网分时段价' },
      { lab: '请求总数', val: nInt(T.requests), icon: 'i-bolt', sub: ' 次调用' },
      { lab: 'Agent 数量', val: nInt(D.stats.agentCount), icon: 'i-agent', sub: ' 个实体' },
      { lab: '缓存命中率', val: pct(T.cacheHitRate), icon: 'i-gauge', sub: ' 复用占比' },
      { lab: '日均消耗', val: human(T.total / Math.max(1, D.stats.activeDays)), icon: 'i-cal', sub: ` ${D.stats.activeDays} 天` },
      { lab: '峰值单日', val: human(D.stats.maxDay.total || 0), icon: 'i-fire', sub: ` ${D.stats.maxDay.date || '—'}` },
      { lab: '错峰节省', val: T.costIfAllPeak ? '¥' + (T.costIfAllPeak - T.cost >= 1000 ? nInt(T.costIfAllPeak - T.cost) : (T.costIfAllPeak - T.cost).toFixed(2)) : '—', icon: 'i-clock', sub: ` 省 ${T.costIfAllPeak ? ((T.costIfAllPeak - T.cost) / T.costIfAllPeak * 100).toFixed(0) : 0}%` },
      { lab: '单次平均', val: human(T.avgPerRequest), icon: 'i-pulse', sub: ' tokens' },
    ].map((c) => `
      <li class="chip">
        <span class="icobox"><svg class="ico"><use href="#${c.icon}"/></svg></span>
        <span class="body">
          <span class="lab">${c.lab}</span>
          <span class="val">${c.val}<small>${c.sub}</small></span>
        </span>
      </li>`).join('');

    /* ── 每日图 ── */
    const dailyChart = $('#daily-chart');
    const dailyTip = $('#daily-tip');
    const legendBox = $('#daily-legend');
    const agentByKey = new Map(D.agents.map((a) => [a.key, a]));
    let dailyMode = 'agent';
    let dailyRange = 30;
    let showMA = true;
    let hiddenSeries = new Set();

    function seriesForAgentMode(days) {
      const sum = new Map();
      for (const d of days) for (const a of d.agents) sum.set(a.key, (sum.get(a.key) || 0) + a.total);
      const ranked = [...sum.entries()].sort((a, b) => b[1] - a[1]);
      const LEAD = 7;
      const top = ranked.slice(0, LEAD), rest = ranked.slice(LEAD);
      const out = top.map(([k], i) => {
        const a = agentByKey.get(k);
        return {
          key: k, label: a ? a.label : k, color: PALETTE[i % PALETTE.length],
          value: (d) => { const hit = d.agents.find((x) => x.key === k); return hit ? hit.total : 0; },
          total: sum.get(k),
        };
      });
      if (rest.length) {
        const restKeys = new Set(rest.map(([k]) => k));
        out.push({
          key: '__rest__', label: `其他 ${rest.length} 个 Agent`, color: '#586570',
          value: (d) => d.agents.reduce((a, x) => a + (restKeys.has(x.key) ? x.total : 0), 0),
          total: rest.reduce((a, [, v]) => a + v, 0),
        });
      }
      return out;
    }

    function seriesForKindMode() {
      const sum = (get) => D.days.reduce((a, d) => a + get(d), 0);
      return [
        { key: '缓存复用', label: '缓存复用', color: KIND_COLORS['缓存复用'], value: (d) => d.cacheRead, total: sum((d) => d.cacheRead) },
        { key: '输入', label: '输入', color: KIND_COLORS['输入'], value: (d) => d.input, total: sum((d) => d.input) },
        { key: '输出', label: '输出', color: KIND_COLORS['输出'], value: (d) => d.output, total: sum((d) => d.output) },
      ].filter((s) => s.total > 0);
    }

    const visibleDays = () => (dailyRange === 'all' ? D.days : D.days.slice(Math.max(0, D.days.length - dailyRange)));
    // allSeries: 图例用（永远列全部，隐藏项置灰仍可点回来）；activeSeries: 绘图/提示用
    const allSeries = (days) => (dailyMode === 'agent' ? seriesForAgentMode(days) : seriesForKindMode());
    const activeSeries = (days) => allSeries(days).filter((s) => !hiddenSeries.has(dailyMode + ':' + s.key));

    function renderDailyChart() {
      const days = visibleDays();
      const series = activeSeries(days);

      legendBox.innerHTML = allSeries(days).map((s) => {
        const off = hiddenSeries.has(dailyMode + ':' + s.key);
        return `
        <button class="li" type="button" data-key="${esc(s.key)}" aria-pressed="${off ? 'false' : 'true'}"
                title="点击隐藏 / 显示「${esc(s.label)}」">
          <i class="sw" style="background:${s.color}"></i>
          <span>${esc(s.label)}</span>
          <b>${human(s.total ?? 0)}</b>
        </button>`;
      }).join('') || '<span class="li off">无可显示序列</span>';

      const W = dailyChart.clientWidth || dailyChart.parentElement.clientWidth || 1000;
      const H = dailyChart.clientHeight || 210;
      const padL = 56, padR = 10, padT = 14, padB = 28;
      const iw = Math.max(60, W - padL - padR);
      const ih = Math.max(40, H - padT - padB);

      const stacking = days.map((d) => series.map((s) => ({ s, v: s.value(d) })).filter((x) => x.v > 0));
      const totals = stacking.map((segs) => segs.reduce((a, x) => a + x.v, 0));
      const maxTotal = Math.max(1, ...totals);
      const yMax = niceMax(maxTotal);

      const bw = iw / Math.max(1, days.length);
      const gap = days.length > 40 ? 1.5 : Math.min(6, bw * 0.22);
      const barW = Math.max(2, bw - gap);

      dailyChart.setAttribute('viewBox', `0 0 ${W} ${H}`);
      dailyChart.setAttribute('width', W);
      dailyChart.setAttribute('height', H);

      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = padT + (ih * i) / 4;
        out += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
        out += `<text class="axis-text" x="${padL - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${humanAxis(yMax * (1 - i / 4))}</text>`;
      }

      days.forEach((d, i) => {
        const x = padL + i * bw + (bw - barW) / 2;
        let yBase = padT + ih;
        out += `<g class="bar" data-i="${i}">`;
        out += `<rect x="${(padL + i * bw).toFixed(2)}" y="${padT}" width="${bw.toFixed(2)}" height="${ih}" fill="transparent"/>`;
        if (d.total === 0) {
          // 无记录日：整列极淡底色 + 底部短虚线，明确"这天没跑"
          out += `<rect class="gap-col" x="${(padL + i * bw).toFixed(2)}" y="${padT}" width="${bw.toFixed(2)}" height="${ih}" pointer-events="none"/>`;
          out += `<line class="gap-mark" x1="${x.toFixed(2)}" x2="${(x + barW).toFixed(2)}" y1="${(padT + ih).toFixed(2)}" y2="${(padT + ih).toFixed(2)}"/>`;
        }
        for (const { s, v } of stacking[i].slice().reverse()) {
          const h = Math.max(0.6, (v / yMax) * ih);
          yBase -= h;
          out += `<rect class="seg-r" x="${x.toFixed(2)}" y="${yBase.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${s.color}" rx="${Math.min(2, barW / 3)}"/>`;
        }
        if (totals[i] === maxTotal && maxTotal > 0) {
          out += `<rect x="${(x - 1).toFixed(2)}" y="${(yBase - 1).toFixed(2)}" width="${(barW + 2).toFixed(2)}" height="${(padT + ih - yBase + 1).toFixed(2)}" fill="none" stroke="rgba(201,242,77,.45)" stroke-width="1" rx="2"/>`;
        }
        out += `</g>`;
      });

      const step = days.length <= 10 ? 2 : days.length <= 20 ? 3 : days.length <= 32 ? 4 : Math.ceil(days.length / 12);
      days.forEach((d, i) => {
        const cx = padL + i * bw + bw / 2;
        const isLast = i === days.length - 1;
        if (i % step === 0 || isLast) {
          out += `<text class="axis-text${isLast ? ' hot' : ''}" x="${cx.toFixed(1)}" y="${H - padB + 16}" text-anchor="middle">${md(d.date)}</text>`;
        }
      });

      // 7 日移动平均：柱图看"哪天爆"，折线看"趋势"——两者叠加才看得出消耗走向
      if (showMA && days.length >= 7) {
        const win = 7;
        const pts = [];
        for (let i = 0; i < days.length; i++) {
          const from = Math.max(0, i - win + 1);
          let sum = 0, n = 0;
          for (let j = from; j <= i; j++) { sum += totals[j]; n++; }
          const ma = sum / n;
          const x = padL + i * bw + bw / 2;
          const y = padT + ih - (ma / yMax) * ih;
          pts.push({ x, y });
        }
        out += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
        // 末端点强调
        const last = pts[pts.length - 1];
        out += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" fill="rgba(255,255,255,.75)" pointer-events="none"/>`;
      }

      dailyChart.innerHTML = out;

      $$('.bar', dailyChart).forEach((g) => {
        g.addEventListener('mouseenter', (e) => showTip(+g.dataset.i, e));
        g.addEventListener('mousemove', moveTip);
        g.addEventListener('mouseleave', () => { dailyTip.hidden = true; });
      });

      $('#daily-note').textContent =
        `${days.length} 天 · 峰值 ${human(maxTotal)} · 累计 ${human(totals.reduce((a, b) => a + b, 0))}`;
    }

    function showTip(i, e) {
      const days = visibleDays();
      const d = days[i];
      if (!d) return;
      const rows = activeSeries(days)
        .map((s) => ({ s, v: s.value(d) }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 8);

      // 空白天：给出前后最近有记录的日，说明"缺口在哪、邻日多少"
      let extra = '';
      if (d.total === 0) {
        let prev = null, next = null;
        for (let k = i - 1; k >= 0; k--) if (days[k].total > 0) { prev = days[k]; break; }
        for (let k = i + 1; k < days.length; k++) if (days[k].total > 0) { next = days[k]; break; }
        const bits = [];
        if (prev) bits.push(`${md(prev.date)} ${human(prev.total)}`);
        if (next) bits.push(`${md(next.date)} ${human(next.total)}`);
        extra = `<div class="t-row" style="color:var(--ink-3)"><span>邻近有记录日</span><b style="font-weight:400">${bits.join(' / ') || '—'}</b></div>`;
      }

      dailyTip.hidden = false;
      dailyTip.innerHTML = `
        <div class="t-date">${d.date} ${WEEKDAYS[weekdayOf(d.date)]}</div>
        <div class="t-total">${nInt(d.total)} <span style="font-size:10px;color:var(--ink-3)">tokens</span></div>
        ${rows.map((r) => `
          <div class="t-row">
            <span><i class="sw" style="background:${r.s.color}"></i>${esc(shortLabel(r.s.label))}</span>
            <b>${human(r.v)}</b>
          </div>`).join('') || '<div class="t-row" style="color:var(--ink-3)">该日无记录（未产生任何请求）</div>'}
        ${extra}
        <div class="t-row" style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);color:var(--ink-3)">
          <span>请求 ${nInt(d.requests)}</span>
          <b style="color:var(--flame)">¥${d.cost >= 100 ? nInt(d.cost) : (d.cost || 0).toFixed(2)}</b>
        </div>
        ${d.total > 0 ? `<div class="t-row" style="color:var(--ink-3);font-size:10.5px">
          <span>高峰 ${human(d.peakTokens || 0)} / 空闲 ${human(d.idleTokens || 0)}</span>
          <b style="font-weight:400">¥${(d.peakCost || 0).toFixed(2)} / ¥${(d.idleCost || 0).toFixed(2)}</b>
        </div>` : ''}`;
      moveTip(e);
    }
    function moveTip(e) {
      const host = dailyChart.closest('.chartwrap');
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      // 先放到不越界的位置再量，避免 offsetWidth 读到旧内容
      dailyTip.style.left = '0px';
      dailyTip.style.top = '0px';
      const tw = dailyTip.offsetWidth, th = dailyTip.offsetHeight;
      const halfW = tw / 2;
      const left = Math.min(Math.max(x, halfW + 10), Math.max(halfW + 10, r.width - halfW - 10));
      const top = Math.max(2, y - th - 14);
      dailyTip.style.left = left + 'px';
      dailyTip.style.top = top + 'px';
    }

    legendBox.addEventListener('click', (e) => {
      const li = e.target.closest('.li');
      if (!li || !li.dataset.key) return;
      toggleSeries(li);
    });
    // button 元素本身支持 Enter/Space 点击，但这里统一走 keydown，保证内联 span 也响应
    legendBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const li = e.target.closest('.li');
      if (!li || !li.dataset.key) return;
      e.preventDefault();
      toggleSeries(li);
    });

    function toggleSeries(li) {
      const id = dailyMode + ':' + li.dataset.key;
      if (hiddenSeries.has(id)) hiddenSeries.delete(id);
      else hiddenSeries.add(id);
      // innerHTML 重建会丢焦点：记下当前按钮，重绘后还回去，键盘用户不会"失联"
      const keep = li.dataset.key;
      renderDailyChart();
      const again = legendBox.querySelector(`.li[data-key="${CSS.escape(keep)}"]`);
      if (again) again.focus();
    }

    /** 分段控件：点击 + 左右方向键切换，符合 tablist 语义 */
    function bindSeg(sel, attr, apply) {
      const box = $(sel);
      const btns = $$(sel + ' button');
      const pick = (b) => {
        if (!b) return;
        apply(b.dataset[attr]);
        btns.forEach((x) => {
          const on = x === b;
          x.classList.toggle('on', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
          x.tabIndex = on ? 0 : -1;
        });
        hiddenSeries.clear();
        renderDailyChart();
      };
      btns.forEach((b, i) => {
        b.tabIndex = b.classList.contains('on') ? 0 : -1;
        b.addEventListener('click', () => pick(b));
        b.addEventListener('keydown', (e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          let n = i;
          if (e.key === 'ArrowLeft') n = (i + btns.length - 1) % btns.length;
          else if (e.key === 'ArrowRight') n = (i + 1) % btns.length;
          else if (e.key === 'Home') n = 0;
          else n = btns.length - 1;
          btns[n].focus();
          pick(btns[n]);
        });
      });
    }

    bindSeg('#daily-mode', 'mode', (v) => { dailyMode = v; });
    bindSeg('#daily-range', 'range', (v) => { dailyRange = v === 'all' ? 'all' : Number(v); });

    const maBtn = $('#daily-ma button');
    if (maBtn) {
      maBtn.addEventListener('click', () => {
        showMA = !showMA;
        maBtn.classList.toggle('on', showMA);
        maBtn.setAttribute('aria-pressed', showMA ? 'true' : 'false');
        renderDailyChart();
      });
    }

    renderDaily = renderDailyChart;

    /* ── 每月 ── */
    const monthsRev = D.months.slice().reverse();
    const maxMonth = Math.max(1, ...monthsRev.map((m) => m.total));
    const curMonth = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' })
      .format(new Date()).replace(/\u200e/g, '').slice(0, 7);

    $('#months').innerHTML = monthsRev.map((m) => {
      const [y, mo] = m.month.split('-');
      const isCur = m.month === curMonth;
      const days = D.days.filter((d) => d.date.startsWith(m.month)).length;
      return `
        <div class="month${isCur ? ' current' : ''}">
          <div class="m-label"><b>${Number(mo)}</b> 月<br><span style="font-size:10px;color:var(--ink-3)">${y}</span></div>
          <div class="m-mid">
            <div class="m-bar"><div class="m-fill" style="width:${(m.total / maxMonth * 100).toFixed(1)}%"></div></div>
            <div class="m-meta">
              <span>${nInt(m.requests)} 请求</span>
              <span>输入 ${human(m.input)}</span>
              <span>缓存 ${human(m.cacheRead)}</span>
              <span>输出 ${human(m.output)}</span>
              <span>${days} 天有记录</span>
            </div>
          </div>
          <div class="m-val">${human(m.total)}<small style="display:block;font-size:10px;color:var(--ink-3);font-weight:400">tokens${m.cost ? ' · ¥' + (m.cost >= 100 ? nInt(m.cost) : m.cost.toFixed(2)) : ''}</small></div>
        </div>`;
    }).join('');
    $('#monthly-note').textContent =
      `${D.months.length} 个月 · 月均 ${human(D.months.reduce((a, m) => a + m.total, 0) / D.months.length)}`;

    /* ── 热力图 ── */
    const heatMax = Math.max(1, ...D.heat.flat());
    const heatHtml = ['<div></div>'];
    for (let h = 0; h < 24; h++) heatHtml.push(`<div class="hl-hour">${h % 4 === 0 ? h : ''}</div>`);
    for (let w = 0; w < 7; w++) {
      heatHtml.push(`<div class="hl">${WEEKDAYS[w].replace('周', '')}</div>`);
      for (let h = 0; h < 24; h++) {
        const v = D.heat[w][h];
        const t = v / heatMax;
        const bg = t <= 0 ? '#1d232a' : `color-mix(in srgb, #93b32f ${(18 + t * 82).toFixed(1)}%, #1d232a)`;
        heatHtml.push(`<div class="cell" style="background:${bg}" title="${WEEKDAYS[w]} ${String(h).padStart(2, '0')}:00 — ${nInt(v)} tokens"></div>`);
      }
    }
    $('#heat').innerHTML = heatHtml.join('');

    /* ── 成本推算 ── */
    renderCost(T);

    /* ── Agent 表 ── */
    const tbody = $('#agent-body');
    const emptyBox = $('#agent-empty');
    const moreBtn = $('#agent-more');
    const AGENT_PAGE = 24;
    let sortKey = 'total', sortDir = -1, roleFilter = 'all', query = '', expanded = false;

    const roleMeta = (role) => ROLE_META[role] || { cls: 'lost', icon: 'i-lost' };

    function renderAgentTable() {
      let rows = D.agents.filter((a) => {
        if (roleFilter !== 'all' && a.role !== roleFilter) return false;
        if (query) {
          const hay = (a.label + ' ' + a.workspace + ' ' + a.models.map((m) => m.name).join(' ')).toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });

      rows.sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        if (typeof x === 'string') return sortDir * String(x).localeCompare(String(y));
        return sortDir * ((x || 0) - (y || 0));
      });

      const matched = rows.length;
      const shown = expanded ? rows : rows.slice(0, AGENT_PAGE);
      const maxTotal = Math.max(1, ...shown.map((r) => r.total));

      tbody.innerHTML = shown.map((a) => {
        const m = roleMeta(a.role);
        const share = a.total / Math.max(1, T.total);
        const modelsStr = a.models.slice(0, 2).map((x) => x.name.split('/')[1] || x.name).join(' · ');
        const sub = a.hint ? `<span class="m hint" title="模型 / 活跃区间">${esc(a.hint)}</span>` : `
                  <span class="m">
                    <svg class="ico s"><use href="#i-model"/></svg>${esc(modelsStr || '—')}
                    ${a.sessions > 1 ? ' · ' + a.sessions + ' 会话' : ''}
                  </span>`;
        return `
          <tr class="${a.total === 0 ? 'zero' : ''}">
            <td class="c-role">
              <span class="role-tag ${m.cls}"><svg class="ico"><use href="#i-role-${m.cls}"/></svg>${esc(a.role)}</span>
            </td>
            <td class="c-name">
              <div class="a-name">
                <span class="k" title="${esc(a.label)}">${esc(a.label)}</span>
                ${sub}
              </div>
            </td>
            <td class="num">${nInt(a.requests)}</td>
            <td class="num" title="${nInt(a.input)}">${human(a.input)}</td>
            <td class="num" title="${nInt(a.cacheRead)}">${human(a.cacheRead)}</td>
            <td class="num" title="${nInt(a.output)}">${human(a.output)}</td>
            <td class="num strong" title="${nInt(a.total)} tokens">${human(a.total)}</td>
            <td class="num cost" title="${a.priced} 条已计价">${a.cost >= 0.01 ? '¥' + (a.cost >= 100 ? nInt(a.cost) : a.cost.toFixed(2)) : '—'}</td>
            <td class="c-share">
              <span class="share">
                <span class="sbar"><span class="sfill" style="width:${(a.total / maxTotal * 100).toFixed(1)}%"></span></span>
                <span class="spct">${(share * 100).toFixed(1)}%</span>
              </span>
            </td>
            <td class="num" title="${a.lastTs ? fullDateTime(a.lastTs) : ''}">${relTime(a.lastTs)}</td>
          </tr>`;
      }).join('');

      emptyBox.hidden = shown.length > 0;
      $('#agents-note').textContent =
        `${matched} / ${D.agents.length} 个 Agent · 合计 ${human(rows.reduce((a, b) => a + b.total, 0))}`;
      moreBtn.hidden = matched <= AGENT_PAGE;
      moreBtn.textContent = expanded ? '收起' : `展开全部 ${matched} 个 Agent`;
    }

    $$('#agent-table th.sortable').forEach((th) => {
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      const doSort = () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir *= -1;
        else { sortKey = k; sortDir = -1; }
        $$('#agent-table th').forEach((x) => {
          x.classList.remove('on');
          x.removeAttribute('aria-sort');
        });
        th.classList.add('on');
        th.setAttribute('aria-sort', sortDir < 0 ? 'descending' : 'ascending');
        renderAgentTable();
      };
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); }
      });
    });
    const totalTh = $('#agent-table th[data-sort="total"]');
    totalTh.classList.add('on');
    totalTh.setAttribute('aria-sort', 'descending');

    $$('#agent-filter button').forEach((b) => b.addEventListener('click', () => {
      roleFilter = b.dataset.role;
      expanded = false;
      $$('#agent-filter button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-selected', x === b ? 'true' : 'false');
      });
      renderAgentTable();
    }));
    $('#agent-search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      expanded = false;
      renderAgentTable();
    });
    moreBtn.addEventListener('click', () => { expanded = !expanded; renderAgentTable(); });

    renderAgents = renderAgentTable;

    /* ── Provider / 模型 ── */
    const maxProv = Math.max(1, ...D.providers.map((p) => p.total));
    $('#providers').innerHTML = D.providers.map((p) => `
      <div class="prow">
        <span class="pname" title="${esc(p.provider)}">${esc(p.provider)}</span>
        <span class="pbar"><span class="pfill" style="width:${(p.total / maxProv * 100).toFixed(1)}%"></span></span>
        <span class="pval">${human(p.total)}<small>${nInt(p.requests)} 请求</small></span>
      </div>`).join('');
    $('#provider-note').textContent = `${D.providers.length} 个供应方`;

    const maxModel = Math.max(1, ...D.models.map((m) => m.total));
    $('#models').innerHTML = D.models.slice(0, 12).map((m) => `
      <div class="prow">
        <span class="pname" title="${esc(m.name)}">${esc(m.model)}<span style="color:var(--ink-3);font-size:10px"> · ${esc(m.provider)}</span></span>
        <span class="pbar"><span class="pfill acid" style="width:${(m.total / maxModel * 100).toFixed(1)}%"></span></span>
        <span class="pval">${human(m.total)}<small>${nInt(m.requests)} 请求</small></span>
      </div>`).join('');
    $('#model-note').textContent = `${D.models.length} 个模型`;

    /* ── 会话 ── */
    const topSessions = D.sessions.slice(0, 14);
    const maxSess = Math.max(1, ...topSessions.map((s) => s.total));
    $('#sessions').innerHTML = topSessions.map((s, i) => {
      const archived = s.role === '未归档';
      return `
        <div class="srow">
          <span class="rank">${i + 1}</span>
          <span class="smain">
            <span class="stitle" title="${esc(s.title)}">${esc(s.title)}</span>
            <span class="smeta">
              <span>${esc(s.workspace)}</span><span class="sep">·</span>
              <span>${esc(s.role)}</span><span class="sep">·</span>
              ${archived ? '<span class="muted">日志已清理</span>' : `<span>${s.turns} 轮 / ${nInt(s.steps)} 步</span><span class="sep">·</span>`}
              <span>${nInt(s.requests)} 请求</span><span class="sep">·</span>
              <span>${relTime(s.lastTs)}</span>
            </span>
            <span class="sbar"><span class="sfill" style="width:${(s.total / maxSess * 100).toFixed(1)}%"></span></span>
          </span>
          <span class="sval">${human(s.total)}<small>${nInt(s.input + s.cacheRead)} 输入+缓存</small></span>
        </div>`;
    }).join('');
    $('#sessions-note').textContent = `共 ${D.sessions.length} 个会话 · 展示前 ${topSessions.length}`;

    /* ── 数据源 ── */
    $('#source-list').innerHTML = D.sources.map((s) => `
      <li class="${s.ok ? 'ok' : 'bad'}">
        <svg class="ico"><use href="#${s.ok ? 'i-db' : 'i-warn'}"/></svg>
        <div>
          <div class="sn">${esc(s.name)}</div>
          <div class="sd">${esc(s.detail || '')}</div>
          <div class="sd dim">${esc(s.path || '')}</div>
        </div>
      </li>`).join('');

    $('#footer-note').innerHTML = [
      '统计口径：<b>合计 = 输入 + 缓存读取 + 缓存写入 + 输出</b>（缓存命中会显著放大总量）。',
      `时间按 <b>${esc(TZ)}</b> 切分日 / 月；数据于 <b>${fullDateTime(D.generatedAt)}</b> 生成。`,
      'Agent 归属：带工作区与主 / 子代理身份的按<b>会话</b>计；日志已归档但账本仍留痕的按<b>未归档会话</b>独立计；其余为<b>散记请求</b>。',
      `成本仅在价目表可匹配时给出，未定价 <b>${nInt(T.unpriced)}</b> 条只累计 token 不计钱。`,
      T.errors ? `另有 <b>${nInt(T.errors)}</b> 条请求状态非 completed，已计入总量。` : '',
      D.warnings && D.warnings.length ? '采集告警：' + D.warnings.map(esc).join('；') : '',
    ].filter(Boolean).join(' ');

    renderDailyChart();
    renderAgentTable();

    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { renderDailyChart(); $('#daily-tip').hidden = true; }, 140);
    });
  }

  /* ══════════════ 刷新按钮 ══════════════ */
  const refreshBtn = $('#refresh');
  if (refreshBtn) {
    const isHttp = /^https?:$/.test(location.protocol);
    if (!isHttp) {
      refreshBtn.title = '直接双击打开时读的是本地快照；运行「启动网页端.bat」后可实时刷新';
      refreshBtn.addEventListener('click', () => location.reload());
    } else {
      let lastTotal = null;
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('busy');
        refreshBtn.disabled = true;
        const before = D ? D.totals.total : null;
        const beforeAt = D ? D.generatedAt : null;
        try {
          const d = await loadViaApi(true);
          if (!d) return;
          applyData(d);
          const delta = d.totals.total - before;
          flash(delta > 0
            ? `新增 ${human(delta)} tokens`
            : (d.generatedAt !== beforeAt ? '已是最新' : '已是最新'));
        } catch (e) {
          flash('刷新失败');
        } finally {
          refreshBtn.classList.remove('busy');
          refreshBtn.disabled = false;
          lastTotal = D ? D.totals.total : null;
        }
      });
    }
  }

  /** 刷新后的小反馈 */
  let flashTimer;
  function flash(msg) {
    const el = $('#flash');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ══════════════ 成本推算 ══════════════ */
  function renderCost(T) {
    const P = D.pricing;
    if (!P) { $('#sec-cost').hidden = true; return; }
    const cur = P.currency === 'CNY' ? '¥' : (P.currency || '');
    // 成本统一保留两位小数；大额加千分位，但始终带 .00，避免 ¥0.3 / ¥1,020 这种精度不一致
    const money2 = (v) => (v == null ? '—'
      : cur + (Math.abs(v) >= 1000
        ? nInt(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (Number.isInteger(v) ? '.00' : '')
        : v.toFixed(2)));
    const priceLabel = (v) => {
      const s = v.toFixed(2).replace(/\.00$/, '');
      return cur + s;
    };
    const saved = T.costIfAllPeak - T.cost;
    const savedPct = T.costIfAllPeak > 0 ? saved / T.costIfAllPeak : 0;

    $('#cost-note').textContent =
      `${nInt(P.ledgerRows + P.computedRows)} 条已计价（账本 ${nInt(P.ledgerRows)} / 补算 ${nInt(P.computedRows)}）`;

    const cards = [
      { lab: '累计成本', val: money2(T.cost), sub: `按官网价目表 · ${nInt(P.ledgerRows + P.computedRows)} 条已计价`, icon: 'i-coins', accent: true },
      { lab: '错峰节省', val: money2(saved), sub: `全按高峰 ${money2(T.costIfAllPeak)} · 省 ${(savedPct * 100).toFixed(0)}%`, icon: 'i-fire' },
      { lab: '每请求均价', val: money2(T.avgCostPerRequest), sub: `${nInt(T.requests)} 次调用`, icon: 'i-pulse' },
      { lab: '每百万 token', val: cur + (T.total ? (T.cost / (T.total / 1e6)).toFixed(2) : '—'), sub: '综合均价（含缓存折扣）', icon: 'i-gauge' },
    ];
    $('#cost-grid').innerHTML = cards.map((c) => `
      <div class="cost-card${c.accent ? ' accent' : ''}">
        <div class="cc-head"><svg class="ico"><use href="#${c.icon}"/></svg><span>${c.lab}</span></div>
        <div class="cc-val">${c.val}</div>
        <div class="cc-sub">${c.sub}</div>
      </div>`).join('');

    // 高峰 / 空闲 拆分条
    const pk = T.peakCost, idc = T.idleCost, sum = pk + idc || 1;
    $('#cost-split').innerHTML = `
      <div class="split-head">
        <span class="lab">高峰 / 空闲 成本构成</span>
        <span class="lab" style="color:var(--acid)">错峰省 ${(savedPct * 100).toFixed(0)}%</span>
      </div>
      <div class="split-bar">
        <span class="seg peak" style="width:${(pk / sum * 100).toFixed(2)}%" title="高峰 ${money2(pk)}"></span>
        <span class="seg idle" style="width:${(idc / sum * 100).toFixed(2)}%" title="空闲 ${money2(idc)}"></span>
      </div>
      <div class="split-legend">
        <span><i class="sw peak"></i>高峰时段 ${money2(pk)} · ${nInt(T.peakRequests)} 次 · ${human(T.peakTokens)} tokens</span>
        <span><i class="sw idle"></i>空闲时段 ${money2(idc)} · ${nInt(T.idleRequests)} 次 · ${human(T.idleTokens)} tokens</span>
      </div>`;

    // 价目表（官网）
    const models = Object.entries(P.idle);
    $('#price-table').innerHTML = `
      <thead>
        <tr>
          <th>模型</th>
          <th class="num">输入·命中缓存</th>
          <th class="num">输入·未命中</th>
          <th class="num">输出</th>
          <th class="num">高峰倍率</th>
        </tr>
      </thead>
      <tbody>
        ${models.map(([k, v]) => `
          <tr>
            <td class="pm">${esc(k)}</td>
            <td class="num">${priceLabel(v.cacheRead)} <span class="dim">峰 ${priceLabel(v.cacheRead * P.peakMultiplier)}</span></td>
            <td class="num">${priceLabel(v.input)} <span class="dim">峰 ${priceLabel(v.input * P.peakMultiplier)}</span></td>
            <td class="num">${priceLabel(v.output)} <span class="dim">峰 ${priceLabel(v.output * P.peakMultiplier)}</span></td>
            <td class="num dim">×${P.peakMultiplier}</td>
          </tr>`).join('')}
      </tbody>`;

    $('#cost-foot').innerHTML = [
      `价格单位：<b>${esc(P.unit)}</b> · 币种 <b>${esc(P.currency)}</b> · 官网抓取于 <b>${esc(P.fetchedAt)}</b>。`,
      `错峰规则：${esc(P.peakRule)}。`,
      `已含节假日表 ${P.holidays.length} 天。`,
      `其中 <b>${nInt(P.ledgerRows)}</b> 条取自 DSH 账本的官方计价值（原样采信），<b>${nInt(P.computedRows)}</b> 条按官网价目表补算。`,
      `<a href="${esc(P.source)}" target="_blank" rel="noreferrer">官网价目表 ↗</a> · 实际扣费以官方账单为准。`,
    ].join(' ');
  }


  const isHttp = /^https?:$/.test(location.protocol);
  if (isHttp) {
    loadViaApi()
      .then(applyData)
      .catch(() => { if (window.DATA) applyData(window.DATA); else document.getElementById('boot-error').hidden = false; });
  } else if (window.DATA) {
    applyData(window.DATA);
  } else {
    document.getElementById('boot-error').hidden = false;
  }
})();
