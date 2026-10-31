/* =========================================================================
   GA4 Analytics Dashboard — app.js
   Loads the compact integer-coded event data produced by build_data.py,
   filters it by the selected date range, and renders every sidebar panel.
   ========================================================================= */

const state = {
  data: null,
  predictions: null, // predictions.json from the Colab notebook (optional)
  colIdx: {},
  charts: {},     // canvas id -> Chart.js instance
  startDay: 0,
  endDay: 0,
};

const PALETTE = {}; // filled from CSS custom properties once DOM is ready

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name) => cs.getPropertyValue(name).trim();
  PALETTE.chart1 = get('--chart-1');
  PALETTE.chart2 = get('--chart-2');
  PALETTE.chart3 = get('--chart-3');
  PALETTE.chart4 = get('--chart-4');
  PALETTE.chart5 = get('--chart-5');
  PALETTE.primary = get('--primary');
  PALETTE.muted = get('--muted-foreground');
  PALETTE.border = get('--border');
  PALETTE.fg = get('--foreground');
  PALETTE.destructive = get('--destructive');
  PALETTE.card = get('--card');
  PALETTE.series = [PALETTE.chart1, PALETTE.chart3, PALETTE.chart4, PALETTE.chart2, PALETTE.chart5];
}

Chart.defaults.font.family = "ui-sans-serif, system-ui, -apple-system, sans-serif";
Chart.defaults.font.size = 11.5;
Chart.defaults.color = '#6b7280';
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.usePointStyle = true;

/* ---------------------------------------------------------------------
   Load data
   --------------------------------------------------------------------- */

async function loadData() {
  const res = await fetch('data.json');
  if (!res.ok) throw new Error('Could not load data.json — serve this folder with a local HTTP server.');
  state.data = await res.json();
  state.data.cols.forEach((c, i) => (state.colIdx[c] = i));
  state.startDay = 0;
  state.endDay = state.data.dates.length - 1;
}

/* ---------------------------------------------------------------------
   Filtering + generic aggregation helpers
   --------------------------------------------------------------------- */

function filteredRows() {
  const di = state.colIdx.day;
  return state.data.rows.filter((r) => r[di] >= state.startDay && r[di] <= state.endDay);
}

function lookup(col, code) {
  return state.data.lookups[col][code];
}

function countBy(rows, col) {
  const idx = state.colIdx[col];
  const m = new Map();
  for (const r of rows) {
    const v = r[idx];
    m.set(v, (m.get(v) || 0) + 1);
  }
  const out = [];
  for (const [code, count] of m.entries()) out.push({ label: lookup(col, code), count });
  out.sort((a, b) => b.count - a.count);
  return out;
}

function topN(arr, n) {
  return arr.slice(0, n);
}

function uniqueUserCount(rows) {
  const idx = state.colIdx.user;
  const s = new Set();
  for (const r of rows) s.add(r[idx]);
  return s.size;
}

function countWhere(rows, col, value) {
  const idx = state.colIdx[col];
  let n = 0;
  for (const r of rows) if (lookup(col, r[idx]) === value) n++;
  return n;
}

function dailySeries(rows) {
  const idx = state.colIdx.day;
  const m = new Map();
  for (const r of rows) m.set(r[idx], (m.get(r[idx]) || 0) + 1);
  const days = [];
  for (let d = state.startDay; d <= state.endDay; d++) days.push({ day: d, count: m.get(d) || 0 });
  return days;
}

function dailyUniqueUsers(rows) {
  const idx = state.colIdx.day, uidx = state.colIdx.user;
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[idx])) m.set(r[idx], new Set());
    m.get(r[idx]).add(r[uidx]);
  }
  const days = [];
  for (let d = state.startDay; d <= state.endDay; d++) days.push({ day: d, count: m.has(d) ? m.get(d).size : 0 });
  return days;
}

function dateLabel(dayIdx) {
  const s = state.data.dates[dayIdx];
  const [y, m, d] = s.split('-');
  return `${m}/${d}`;
}

function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
function fmtUsd(n) { return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }

// Basic descriptive statistics on a plain numeric array
function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  if (sortedArr[base + 1] !== undefined) return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  return sortedArr[base];
}

function describe(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (v.length === 0) {
    return { n: 0, mean: null, median: null, mode: null, min: null, max: null, range: null, std: null, variance: null, iqr: null, p10: null, p25: null, p75: null, p90: null, skew: null };
  }
  const sorted = [...v].sort((a, b) => a - b);
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const freq = new Map();
  v.forEach((x) => freq.set(x, (freq.get(x) || 0) + 1));
  let mode = v[0], modeCount = 0;
  for (const [val, c] of freq.entries()) if (c > modeCount) { mode = val; modeCount = c; }
  const p25 = quantile(sorted, 0.25), p75 = quantile(sorted, 0.75);
  // adjusted Fisher-Pearson sample skewness (same formula as pandas / Excel SKEW)
  const skew = n > 2 && std > 0
    ? (n / ((n - 1) * (n - 2))) * v.reduce((a, x) => a + ((x - mean) / std) ** 3, 0)
    : null;
  return {
    n, mean, median: quantile(sorted, 0.5), mode,
    min: sorted[0], max: sorted[n - 1], range: sorted[n - 1] - sorted[0],
    std, variance, iqr: p75 - p25, p10: quantile(sorted, 0.1), p25, p75, p90: quantile(sorted, 0.9), skew,
  };
}

/* ---------------------------------------------------------------------
   Chart helpers
   --------------------------------------------------------------------- */

function killChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

function makeLine(id, labels, datasets, opts = {}) {
  killChart(id);
  const { inlinePlugins = [], ...rest } = opts;
  const ctx = document.getElementById(id).getContext('2d');
  state.charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: datasets.length > 1 } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { grid: { color: PALETTE.border }, beginAtZero: true },
      },
      ...rest,
    },
    plugins: inlinePlugins,
  });
}

// Draws a text label on every bar of the first dataset so values are readable
// without hovering. `textFor(i)` returns a string, or an array of lines for vertical bars.
function barLabelPlugin(textFor, horizontal) {
  return {
    id: 'barLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = `600 11.5px ${Chart.defaults.font.family}`;
      ctx.fillStyle = PALETTE.fg;
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        const lines = [].concat(textFor(i));
        if (horizontal) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(lines.join(' · '), bar.x + 6, bar.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          // stack lines upward from just above the bar top
          lines.slice().reverse().forEach((line, j) => ctx.fillText(line, bar.x, bar.y - 4 - j * 14));
        }
      });
      ctx.restore();
    },
  };
}

// Bar chart with a direct label on every bar. With `opts.total`, each label shows the
// bar's share of that total plus its value ("41.3% · 41,325"); `opts.fmt` formats the value.
function makeBar(id, labels, data, opts = {}) {
  killChart(id);
  const horizontal = opts.horizontal;
  const fmt = opts.fmt || fmtInt;
  const total = opts.total;
  const textFor = opts.labelFor || ((i) => (total ? [fmtPct(data[i] / total), fmt(data[i])] : fmt(data[i])));
  const ctx = document.getElementById(id).getContext('2d');
  state.charts[id] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: opts.color || PALETTE.chart1, borderRadius: 4, maxBarThickness: horizontal ? 28 : 34 }],
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      // room for the labels past the end of the longest bar
      layout: { padding: horizontal ? { right: opts.padRight || (total ? 110 : 60) } : { top: total ? 32 : 18 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => (total ? `${fmt(c.raw)} (${fmtPct(c.raw / total)})` : fmt(c.raw)) } },
      },
      // the labels carry the values, so the value axis is hidden
      scales: horizontal
        ? { x: { display: false, beginAtZero: true, max: opts.max }, y: { grid: { display: false }, border: { display: false } } }
        : { x: { grid: { display: false } }, y: { display: false, beginAtZero: true, max: opts.max } },
    },
    plugins: [barLabelPlugin(textFor, horizontal), ...(opts.plugins || [])],
  });
}

// Labels drawn outside each slice with a leader line: category name, then "share · count".
// Labels on the same side are pushed apart vertically so thin neighbouring slices don't collide.
function donutLabelPlugin(labels, data, total) {
  const LINE_GAP = 30; // min vertical distance between two labels on the same side
  return {
    id: 'donutLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const placed = chart.getDatasetMeta(0).data.map((arc, i) => {
        const { x, y, startAngle, endAngle, outerRadius } = arc.getProps(['x', 'y', 'startAngle', 'endAngle', 'outerRadius'], true);
        const mid = (startAngle + endAngle) / 2;
        const cos = Math.cos(mid), sin = Math.sin(mid);
        const right = cos >= 0;
        return {
          i, right,
          anchor: [x + cos * outerRadius, y + sin * outerRadius],
          elbow: [x + cos * (outerRadius + 14), y + sin * (outerRadius + 14)],
          textY: y + sin * (outerRadius + 14),
          textX: x + (right ? 1 : -1) * (outerRadius + 28),
        };
      });
      [true, false].forEach((side) => {
        const group = placed.filter((pl) => pl.right === side).sort((a, b) => a.textY - b.textY);
        for (let k = 1; k < group.length; k++) {
          group[k].textY = Math.max(group[k].textY, group[k - 1].textY + LINE_GAP);
        }
        // keep the lowest label inside the chart, shifting the stack up if needed
        const overflow = group.length ? group[group.length - 1].textY - (chartArea.bottom - 8) : 0;
        if (overflow > 0) group.forEach((pl) => { pl.textY -= overflow; });
      });

      ctx.save();
      placed.forEach((pl) => {
        if (!data[pl.i]) return;
        const color = PALETTE.series[pl.i % PALETTE.series.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(...pl.anchor);
        ctx.lineTo(pl.elbow[0], pl.textY);
        ctx.lineTo(pl.textX + (pl.right ? -4 : 4), pl.textY);
        ctx.stroke();

        ctx.textAlign = pl.right ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = PALETTE.fg;
        ctx.font = `600 12px ${Chart.defaults.font.family}`;
        ctx.fillText(labels[pl.i], pl.textX, pl.textY - 7);
        ctx.fillStyle = PALETTE.muted;
        ctx.font = `11.5px ${Chart.defaults.font.family}`;
        ctx.fillText(`${fmtPct(data[pl.i] / total)} · ${fmtInt(data[pl.i])}`, pl.textX, pl.textY + 8);
      });
      ctx.restore();
    },
  };
}

function makeDonut(id, labels, data) {
  killChart(id);
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const ctx = document.getElementById(id).getContext('2d');
  state.charts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: PALETTE.series, borderWidth: 2, borderColor: '#fff' }] },
    // doughnuts default to a 1:1 box, which makes them much taller than the charts beside them
    options: {
      responsive: true, aspectRatio: 1.6, cutout: '62%',
      // room around the ring for the outside labels
      layout: { padding: { top: 28, bottom: 28, left: 120, right: 120 } },
      // every slice is labelled directly, so the legend would only repeat the names
      plugins: { legend: { display: false } },
    },
    plugins: [donutLabelPlugin(labels, data, total)],
  });
}

// Histogram with fixed-width bins; values >= cap fall into a final open-ended bin.
// `markers` ([{ label, value, color }]) are drawn as dashed vertical lines.
function makeHistogram(id, values, binWidth, cap, markers) {
  killChart(id);
  const nBins = Math.ceil(cap / binWidth) + 1;
  const counts = new Array(nBins).fill(0);
  for (const v of values) counts[Math.min(Math.floor(v / binWidth), nBins - 1)]++;
  const labels = counts.map((_, i) => (i === nBins - 1 ? `$${cap}+` : `$${i * binWidth}–${(i + 1) * binWidth}`));

  const markerPlugin = {
    id: 'histMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom } } = chart;
      const px = (v) => left + (Math.min(v, cap + binWidth) / (nBins * binWidth)) * (right - left);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      ctx.textAlign = 'left';
      markers.forEach((m, i) => {
        const x = px(m.value);
        const text = `${m.label} ${fmtUsd(m.value)}`;
        const y = top + 12 + i * 16;
        ctx.strokeStyle = m.color;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        // label on a light chip so it stays readable where it crosses a bar
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(x + 2, y - 10, ctx.measureText(text).width + 6, 14);
        ctx.fillStyle = m.color;
        ctx.fillText(text, x + 5, y);
      });
      ctx.restore();
    },
  };

  const ctx = document.getElementById(id).getContext('2d');
  state.charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Orders', data: counts, backgroundColor: PALETTE.chart2, categoryPercentage: 1, barPercentage: 0.94 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'Order value (USD)' } },
        y: { grid: { color: PALETTE.border }, beginAtZero: true, grace: '20%', ticks: { precision: 0 }, title: { display: true, text: 'Orders' } },
      },
    },
    plugins: [markerPlugin, barLabelPlugin((i) => (counts[i] ? fmtInt(counts[i]) : ''), false)],
  });
}

function statGrid(el, entries) {
  el.innerHTML = entries.map(([k, v]) => `<div class="stat-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function renderTable(el, headers, rows) {
  // build table DOM safely with textContent to avoid HTML injection and ensure
  // values like '(other)' render correctly even if they include special chars
  el.innerHTML = '';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h) => {
    const th = document.createElement('th');
    if (h.num) th.classList.add('num');
    th.textContent = h.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  el.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    r.forEach((c, i) => {
      const td = document.createElement('td');
      if (headers[i] && headers[i].num) td.classList.add('num');
      // support progress bar cell objects: { bar: { value, max, display } }
      if (c && typeof c === 'object' && c.bar) {
        const val = Number(c.bar.value) || 0;
        const max = Number(c.bar.max) || 1;
        const pct = Math.max(0, Math.min(100, Math.round((val / max) * 100)));
        const container = document.createElement('div');
        container.className = 'progress-cell';

        const track = document.createElement('div');
        track.className = 'progress-track';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        fill.style.width = pct + '%';
        track.appendChild(fill);

        const num = document.createElement('div');
        num.className = 'progress-num';
        num.textContent = c.bar.display || String(val);

        container.appendChild(track);
        container.appendChild(num);
        td.appendChild(container);
      } else {
        td.textContent = c == null ? '' : String(c);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);
}

/* ---------------------------------------------------------------------
   Panel renderers
   --------------------------------------------------------------------- */

function renderOverview(rows) {
  const sessions = countWhere(rows, 'event_name', 'session_start');
  const purchases = countWhere(rows, 'event_name', 'purchase');
  const revIdx = state.colIdx.revenue;
  const revenue = rows.reduce((a, r) => a + (r[revIdx] || 0), 0);
  const users = uniqueUserCount(rows);
  const convRate = sessions > 0 ? purchases / sessions : 0;

  document.getElementById('ov-kpis').innerHTML = [
    ['Total events', fmtInt(rows.length), 'All tracked interactions'],
    ['Unique users', fmtInt(users), 'Distinct GA4 client IDs'],
    ['Sessions', fmtInt(sessions), 'session_start events'],
    ['Purchases', fmtInt(purchases), 'Completed transactions'],
    ['Revenue', fmtUsd(revenue), 'Total purchase revenue'],
    ['Conversion rate', fmtPct(convRate), 'Purchases ÷ sessions'],
  ].map(([label, val, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      <div class="kpi-note">${note}</div>
    </div>`).join('');

  const daily = dailySeries(rows);
  makeLine('ov-trend', daily.map((d) => dateLabel(d.day)), [{
    data: daily.map((d) => d.count), borderColor: PALETTE.chart1, backgroundColor: PALETTE.chart1,
    tension: 0.3, pointRadius: 0, fill: false, borderWidth: 2,
  }]);

  const device = countBy(rows, 'device_category');
  makeDonut('ov-device', device.map((d) => d.label), device.map((d) => d.count));

  const countries = topN(countBy(rows, 'country'), 5);
  makeBar('ov-countries', countries.map((c) => c.label), countries.map((c) => c.count), { horizontal: true, total: rows.length, color: PALETTE.chart2 });

  const channels = countBy(rows, 'channel_group');
  makeBar('ov-channels', channels.map((c) => c.label), channels.map((c) => c.count), { horizontal: true, total: rows.length, color: PALETTE.chart1 });
}

function renderTrends(rows) {
  const daily = dailySeries(rows);
  // --- setup tabs for tr-multi chart ---
  const tabsEl = document.getElementById('tr-multi-tabs');
  if (tabsEl) {
    if (!state.trMultiMode) state.trMultiMode = 'main';
    const btns = tabsEl.querySelectorAll('.chart-tab');
    btns.forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.trMultiMode);
      // attach click handler once
      if (!b._hasListener) {
        b.addEventListener('click', () => {
          state.trMultiMode = b.dataset.mode;
          btns.forEach((bb) => bb.classList.toggle('active', bb === b));
          renderTrends(filteredRows());
        });
        b._hasListener = true;
      }
    });
  }
  // --- summary KPI cards for Trends panel ---
  const usersCount = uniqueUserCount(rows);
  const sessionsCount = countWhere(rows, 'event_name', 'session_start');
  const eventsCount = rows.length;
  const pageviewsCount = countWhere(rows, 'event_name', 'page_view');
  const purchasesCount = countWhere(rows, 'event_name', 'purchase');
  const revIdx = state.colIdx.revenue;
  const revenueTotal = rows.reduce((a, r) => a + (r[revIdx] || 0), 0);

  const sessionsPerUser = usersCount ? (sessionsCount / usersCount) : 0;
  const eventsPerSession = sessionsCount ? (eventsCount / sessionsCount) : 0;
  const pageviewsPerSession = sessionsCount ? (pageviewsCount / sessionsCount) : 0;
  const purchaseRate = sessionsCount ? (purchasesCount / sessionsCount) : 0;
  const revenuePerPurchase = purchasesCount ? (revenueTotal / purchasesCount) : 0;

  document.getElementById('tr-kpis').innerHTML = [
    ['Users', fmtInt(usersCount), `Unique users`],
    ['Sessions', fmtInt(sessionsCount), `Sessions / user: ${sessionsPerUser.toFixed(2)}`],
    ['Events', fmtInt(eventsCount), `Events / session: ${eventsPerSession.toFixed(2)}`],
    ['Pageviews', fmtInt(pageviewsCount), `Pageviews / session: ${pageviewsPerSession.toFixed(2)}`],
    ['Purchases', fmtInt(purchasesCount), `Purchases ÷ sessions: ${fmtPct(purchaseRate)}`],
    ['Revenue', fmtUsd(revenueTotal), `Revenue / purchase: ${fmtUsd(Math.round(revenuePerPurchase))}`],
  ].map(([label, val, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      <div class="kpi-note">${note}</div>
    </div>`).join('');

  const sessionsIdx = state.colIdx.event_name;
  const sessionCode = state.data.lookups.event_name.indexOf('session_start');
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');
  const dayIdx = state.colIdx.day;

  const sessionsByDay = new Map(), purchasesByDay = new Map();
  for (const r of rows) {
    if (r[sessionsIdx] === sessionCode) sessionsByDay.set(r[dayIdx], (sessionsByDay.get(r[dayIdx]) || 0) + 1);
    if (r[sessionsIdx] === purchaseCode) purchasesByDay.set(r[dayIdx], (purchasesByDay.get(r[dayIdx]) || 0) + 1);
  }

  const labels = daily.map((d) => dateLabel(d.day));
  const mode = state.trMultiMode || 'main';
  if (mode === 'main') {
    makeLine('tr-multi', labels, [
      { label: 'Total events', data: daily.map((d) => d.count), borderColor: PALETTE.chart1, backgroundColor: PALETTE.chart1, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Sessions', data: daily.map((d) => sessionsByDay.get(d.day) || 0), borderColor: PALETTE.chart3, backgroundColor: PALETTE.chart3, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Purchases', data: daily.map((d) => purchasesByDay.get(d.day) || 0), borderColor: PALETTE.chart4, backgroundColor: PALETTE.chart4, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
    ], {
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { position: 'left', grid: { color: PALETTE.border }, beginAtZero: true, title: { display: true, text: 'Events / sessions' } },
        y1: { position: 'right', grid: { display: false }, beginAtZero: true, title: { display: true, text: 'Purchases' } },
      },
    });
  } else {
    // pageviews + revenue
    const pageviewCode = state.data.lookups.event_name.indexOf('page_view');
    const pageviewsByDay = new Map();
    const revenueByDay = new Map();
    for (const r of rows) {
      const d = r[dayIdx];
      if (r[sessionsIdx] === pageviewCode) pageviewsByDay.set(d, (pageviewsByDay.get(d) || 0) + 1);
      if (r[sessionsIdx] === purchaseCode) revenueByDay.set(d, (revenueByDay.get(d) || 0) + (r[revIdx] || 0));
    }
    makeLine('tr-multi', labels, [
      { label: 'Pageviews', data: labels.map((_, i) => pageviewsByDay.get(daily[i].day) || 0), borderColor: PALETTE.chart2, backgroundColor: PALETTE.chart2, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Revenue', data: labels.map((_, i) => revenueByDay.get(daily[i].day) || 0), borderColor: PALETTE.chart4, backgroundColor: PALETTE.chart4, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
    ], {
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { position: 'left', grid: { color: PALETTE.border }, beginAtZero: true, title: { display: true, text: 'Pageviews' } },
        y1: { position: 'right', grid: { display: false }, beginAtZero: true, title: { display: true, text: 'Revenue (USD)' } },
      },
    });
  }

  const stats = describe(daily.map((d) => d.count));
  statGrid(document.getElementById('tr-stats'), [
    ['Mean / day', stats.mean ? stats.mean.toFixed(0) : '—'],
    ['Median / day', stats.median ? stats.median.toFixed(0) : '—'],
    ['Std dev', stats.std ? stats.std.toFixed(0) : '—'],
    ['Range', stats.range ? stats.range.toFixed(0) : '—'],
    ['IQR', stats.iqr ? stats.iqr.toFixed(0) : '—'],
    ['Min', stats.min ?? '—'],
    ['P75', stats.p75 ? stats.p75.toFixed(0) : '—'],
    ['Max', stats.max ?? '—'],
  ]);

  const users = dailyUniqueUsers(rows);
  makeLine('tr-users', users.map((d) => dateLabel(d.day)), [{
    data: users.map((d) => d.count), borderColor: PALETTE.chart2, backgroundColor: PALETTE.chart2, tension: 0.3, pointRadius: 0, fill: false, borderWidth: 2,
  }]);
}

function renderDevice(rows) {
  const device = countBy(rows, 'device_category');
  const total = rows.length;
  document.getElementById('dev-kpis').innerHTML = device.map((d) => `
    <div class="kpi-card">
      <div class="kpi-label">${d.label}</div>
      <div class="kpi-value">${fmtInt(d.count)}</div>
      <div class="kpi-note">${fmtPct(d.count / total)} of events</div>
    </div>`).join('');

  makeDonut('dev-donut', device.map((d) => d.label), device.map((d) => d.count));

  const brands = topN(countBy(rows, 'mobile_brand_name'), 8);
  makeBar('dev-brand', brands.map((b) => b.label), brands.map((b) => b.count), { horizontal: true, total, color: PALETTE.chart3 });

  // compute revenue, unique users, and purchases per device
  const devIdx = state.colIdx.device_category;
  const revIdx = state.colIdx.revenue;
  const userIdx = state.colIdx.user;
  const enIdx = state.colIdx.event_name;
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');

  const revByDevice = new Map();
  const usersByDevice = new Map();
  const purchasesByDevice = new Map();

  for (const r of rows) {
    const label = lookup('device_category', r[devIdx]);
    revByDevice.set(label, (revByDevice.get(label) || 0) + (r[revIdx] || 0));
    if (!usersByDevice.has(label)) usersByDevice.set(label, new Set());
    usersByDevice.get(label).add(r[userIdx]);
    if (r[enIdx] === purchaseCode) purchasesByDevice.set(label, (purchasesByDevice.get(label) || 0) + 1);
  }

  renderTable(document.getElementById('dev-table'),
    [
      { label: 'Device' },
      { label: 'Events', num: true },
      { label: 'Share', num: true },
      { label: 'Revenue', num: true },
      { label: 'Users', num: true },
      { label: 'Purchases', num: true },
    ],
    device.map((d) => {
      const key = d.label;
      const display = key && String(key).trim() ? key : '(other)';
      return [
        display,
        fmtInt(d.count),
        fmtPct(d.count / total),
        fmtUsd(revByDevice.get(key) || 0),
        fmtInt((usersByDevice.get(key) || new Set()).size),
        fmtInt(purchasesByDevice.get(key) || 0),
      ];
    }));
}

function renderCountries(rows) {
  const countries = countBy(rows, 'country');
  const total = rows.length;
  const top10 = topN(countries, 10);
  makeBar('ctr-bar', top10.map((c) => c.label), top10.map((c) => c.count), { horizontal: true, total, color: PALETTE.chart1 });

  const continents = countBy(rows, 'continent');
  makeBar('ctr-continent', continents.map((c) => c.label), continents.map((c) => c.count), { horizontal: true, total, color: PALETTE.chart3 });

  const top15 = topN(countries, 15);

  // compute revenue, unique users, and purchases per country
  const countryIdx = state.colIdx.country;
  const revIdx = state.colIdx.revenue;
  const userIdx = state.colIdx.user;
  const enIdx = state.colIdx.event_name;
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');

  const revByCountry = new Map();
  const usersByCountry = new Map();
  const purchasesByCountry = new Map();

  for (const r of rows) {
    const label = lookup('country', r[countryIdx]);
    revByCountry.set(label, (revByCountry.get(label) || 0) + (r[revIdx] || 0));
    if (!usersByCountry.has(label)) usersByCountry.set(label, new Set());
    usersByCountry.get(label).add(r[userIdx]);
    if (r[enIdx] === purchaseCode) purchasesByCountry.set(label, (purchasesByCountry.get(label) || 0) + 1);
  }

  // three summary stat cards for Countries panel
  const countriesRepresented = countries.length;
  const topCountry = countries.length ? countries[0] : { label: '—', count: 0 };
  const topCountryRevenue = revByCountry.get(topCountry.label) || 0;
  const topCountryDisplay = topCountry.label && String(topCountry.label).trim() ? topCountry.label : '(other)';
  const ctrKpisEl = document.getElementById('ctr-kpis');
  if (ctrKpisEl) {
    ctrKpisEl.innerHTML = [
      ['Countries represented', fmtInt(countriesRepresented), 'Distinct countries in the selected range'],
      ['Top country', `${topCountryDisplay} · ${fmtInt(topCountry.count)}`, 'Leading country by event volume'],
      ['Top country revenue', fmtUsd(topCountryRevenue), 'Revenue from the top country'],
    ].map(([label, val, note]) => `
      <div class="kpi-card">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${val}</div>
        <div class="kpi-note">${note}</div>
      </div>
    `).join('');
  }

  renderTable(document.getElementById('ctr-table'),
    [
      { label: '#', num: true },
      { label: 'Country' },
      { label: 'Events', num: true },
      { label: 'Share', num: true },
      { label: 'Revenue', num: true },
      { label: 'Users', num: true },
      { label: 'Purchases', num: true },
    ],
    top15.map((c, i) => {
      const key = c.label;
      const display = key && String(key).trim() ? key : '(other)';
      return [
        i + 1,
        display,
        fmtInt(c.count),
        fmtPct(c.count / total),
        fmtUsd(revByCountry.get(key) || 0),
        fmtInt((usersByCountry.get(key) || new Set()).size),
        fmtInt(purchasesByCountry.get(key) || 0),
      ];
    }));
}

function renderOsBrowser(rows) {
  const os = topN(countBy(rows, 'operating_system'), 10);
  const browser = topN(countBy(rows, 'browser'), 10);

  // helper to get display label (use '(other)' for empty/null/whitespace)
  const displayLabel = (s) => (s && String(s).trim() ? s : '(other)');

  makeBar('os-bar', os.map((o) => displayLabel(o.label)), os.map((o) => o.count), { total: rows.length, color: PALETTE.chart1 });
  makeBar('br-bar', browser.map((b) => displayLabel(b.label)), browser.map((b) => b.count), { total: rows.length, color: PALETTE.chart2 });

  // compute unique users per OS and per Browser using original keys (may be empty string)
  const osIdx = state.colIdx.operating_system;
  const brIdx = state.colIdx.browser;
  const userIdx = state.colIdx.user;
  const usersByOs = new Map();
  const usersByBrowser = new Map();
  for (const r of rows) {
    const osKey = lookup('operating_system', r[osIdx]);
    const brKey = lookup('browser', r[brIdx]);
    if (!usersByOs.has(osKey)) usersByOs.set(osKey, new Set());
    usersByOs.get(osKey).add(r[userIdx]);
    if (!usersByBrowser.has(brKey)) usersByBrowser.set(brKey, new Set());
    usersByBrowser.get(brKey).add(r[userIdx]);
  }

  // render OS table
  const osTableEl = document.getElementById('os-table');
  if (osTableEl) {
    renderTable(osTableEl,
      [{ label: 'OS' }, { label: 'Events', num: true }, { label: 'Users', num: true }],
      os.map((o) => {
        const key = o.label;
        const disp = displayLabel(key);
        return [disp, fmtInt(o.count), fmtInt((usersByOs.get(key) || new Set()).size)];
      })
    );
  }

  // render Browser table
  const brTableEl = document.getElementById('br-table');
  if (brTableEl) {
    renderTable(brTableEl,
      [{ label: 'Browser' }, { label: 'Events', num: true }, { label: 'Users', num: true }],
      browser.map((b) => {
        const key = b.label;
        const disp = displayLabel(key);
        return [disp, fmtInt(b.count), fmtInt((usersByBrowser.get(key) || new Set()).size)];
      })
    );
  }
}

function renderSources(rows) {
  const channels = countBy(rows, 'channel_group');
  makeBar('src-channel', channels.map((c) => c.label), channels.map((c) => c.count), { horizontal: true, total: rows.length, color: PALETTE.chart2 });

  const sources = topN(countBy(rows, 'source'), 8);
  makeBar('src-source', sources.map((s) => s.label), sources.map((s) => s.count), { horizontal: true, total: rows.length, color: PALETTE.chart3 });

  // build detailed source/medium table with Source, Medium, Source Name, Channel, Events, Users
  const sIdx = state.colIdx.source, mIdx = state.colIdx.medium, snIdx = state.colIdx.source_name, chIdx = state.colIdx.channel_group;
  const uIdx = state.colIdx.user;
  const comboMap = new Map();
  for (const r of rows) {
    const srcKey = lookup('source', r[sIdx]);
    const medKey = lookup('medium', r[mIdx]);
    const srcNameKey = lookup('source_name', r[snIdx]);
    const chKey = lookup('channel_group', r[chIdx]);
    const key = `${srcKey}||${medKey}||${srcNameKey}||${chKey}`;
    if (!comboMap.has(key)) comboMap.set(key, { source: srcKey, medium: medKey, source_name: srcNameKey, channel: chKey, count: 0, users: new Set() });
    const entry = comboMap.get(key);
    entry.count += 1;
    entry.users.add(r[uIdx]);
  }
  const comboArr = [...comboMap.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  const total = rows.length;
  renderTable(document.getElementById('src-table'),
    [
      { label: 'Source' },
      { label: 'Medium' },
      { label: 'Source Name' },
      { label: 'Channel' },
      { label: 'Events', num: true },
      { label: 'Users', num: true },
    ],
    comboArr.map((c) => [
      (c.source && String(c.source).trim()) ? c.source : '(other)',
      (c.medium && String(c.medium).trim()) ? c.medium : '(other)',
      (c.source_name && String(c.source_name).trim()) ? c.source_name : '(other)',
      (c.channel && String(c.channel).trim()) ? c.channel : '(other)',
      fmtInt(c.count),
      fmtInt(c.users.size),
    ])
  );
}

function renderEvents(rows) {
  const events = countBy(rows, 'event_name');
  const total = rows.length;
  makeBar('ev-bar', events.map((e) => e.label), events.map((e) => e.count), { horizontal: true, total, color: PALETTE.chart1 });

  // progress column: each event's count relative to the most frequent event
  const maxCount = events.length ? events[0].count : 1;
  renderTable(document.getElementById('ev-table'),
    [
      { label: '#', num: true },
      { label: 'Event' },
      { label: 'Count', num: true },
      { label: 'Share', num: true },
      { label: 'vs top event', num: true },
    ],
    events.map((e, i) => [
      i + 1,
      e.label,
      fmtInt(e.count),
      fmtPct(e.count / total),
      { bar: { value: e.count, max: maxCount, display: fmtPct(e.count / maxCount) } },
    ]));
}

function renderConversion(rows) {
  const steps = ['session_start', 'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'];
  const stepLabels = ['Session start', 'View item', 'Add to cart', 'Begin checkout', 'Payment info', 'Purchase'];
  const counts = steps.map((s) => countWhere(rows, 'event_name', s));
  const base = counts[0] || 1;

  const sessions = counts[0], purchases = counts[5], carts = counts[2], checkouts = counts[3];
  // compute revenue and checkout starts
  const revIdx = state.colIdx.revenue;
  const revenue = rows.reduce((a, r) => a + (r[revIdx] || 0), 0);
  const checkoutStarts = countWhere(rows, 'event_name', 'begin_checkout');

  document.getElementById('cv-kpis').innerHTML = [
    ['Conversion rate', fmtPct(sessions ? purchases / sessions : 0), 'Purchases ÷ sessions'],
    ['Purchases', fmtInt(purchases), 'Completed transactions'],
    ['Revenue', fmtUsd(revenue), 'Total purchase revenue'],
    ['Checkout starts', fmtInt(checkoutStarts), 'begin_checkout events'],
  ].map(([label, val, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      <div class="kpi-note">${note}</div>
    </div>`).join('');

  const el = document.getElementById('cv-funnel');
  el.innerHTML = steps.map((s, i) => {
    const pct = base > 0 ? counts[i] / base : 0;
    return `
      <div class="funnel-step">
        <div>${stepLabels[i]}</div>
        <div class="funnel-bar-track"><div class="funnel-bar" style="width:${Math.max(pct * 100, 2)}%"></div></div>
        <div class="funnel-pct">${fmtInt(counts[i])} · ${fmtPct(pct)}</div>
      </div>`;
  }).join('');

  // --- Conversion rate over time (purchases ÷ sessions per day) ---
  const dayIdx = state.colIdx.day;
  const enIdx = state.colIdx.event_name;
  const sessionCode = state.data.lookups.event_name.indexOf('session_start');
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');
  const sessionsByDay = new Map();
  const purchasesByDay = new Map();
  for (const r of rows) {
    const d = r[dayIdx];
    if (r[enIdx] === sessionCode) sessionsByDay.set(d, (sessionsByDay.get(d) || 0) + 1);
    if (r[enIdx] === purchaseCode) purchasesByDay.set(d, (purchasesByDay.get(d) || 0) + 1);
  }
  const labels = [];
  const rateSeries = [];
  for (let d = state.startDay; d <= state.endDay; d++) {
    labels.push(dateLabel(d));
    const s = sessionsByDay.get(d) || 0;
    const p = purchasesByDay.get(d) || 0;
    rateSeries.push(s ? (p / s) * 100 : 0);
  }
  makeLine('cv-rate', labels, [{ label: 'Conversion rate (%)', data: rateSeries, borderColor: PALETTE.chart4, backgroundColor: PALETTE.chart4, tension: 0.2, pointRadius: 0, borderWidth: 2 }], {
    scales: { y: { ticks: { callback: (v) => v.toFixed ? v.toFixed(1) + '%' : v + '%' }, beginAtZero: true } }
  });

  // --- Conversion rate by channel table ---
  const chIdx = state.colIdx.channel_group;
  const channelMap = new Map();
  for (const r of rows) {
    const chKey = lookup('channel_group', r[chIdx]) || '(other)';
    if (!channelMap.has(chKey)) channelMap.set(chKey, { sessions: 0, converted: 0 });
    const entry = channelMap.get(chKey);
    if (r[enIdx] === sessionCode) entry.sessions += 1;
    if (r[enIdx] === purchaseCode) entry.converted += 1;
  }
  const channelArr = [...channelMap.entries()].map(([channel, v]) => ({ channel, sessions: v.sessions, converted: v.converted }));
  channelArr.sort((a, b) => b.sessions - a.sessions);
  // place Sessions column on the right side for easier comparison of converted/rate
  renderTable(document.getElementById('cv-channel-table'),
    [ { label: 'Channel' }, { label: 'Purchases', num: true }, { label: 'Rate', num: true }, { label: 'Sessions', num: true } ],
    channelArr.map((c) => [ c.channel, fmtInt(c.converted), fmtPct(c.sessions ? c.converted / c.sessions : 0), fmtInt(c.sessions) ])
  );
}

function renderEcommerce(rows) {
  const enIdx = state.colIdx.event_name;
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');
  const purchaseRows = rows.filter((r) => r[enIdx] === purchaseCode);
  const revIdx = state.colIdx.revenue, qtyIdx = state.colIdx.qty, itemsIdx = state.colIdx.items;

  // Purchases whose revenue is missing are null in data.json: they count as
  // orders but are left out of every revenue statistic.
  const revenues = purchaseRows.map((r) => r[revIdx]).filter((v) => v !== null && v !== undefined);
  const totalRevenue = revenues.reduce((a, b) => a + b, 0);
  const stats = describe(revenues);
  const qtyStats = describe(purchaseRows.map((r) => r[qtyIdx]));

  document.getElementById('ec-kpis').innerHTML = [
    ['Total revenue', fmtUsd(totalRevenue), `${fmtInt(purchaseRows.length)} orders · ${fmtInt(revenues.length)} with revenue`],
    ['Avg order value', stats.mean ? fmtUsd(stats.mean) : '—', 'Mean purchase revenue'],
    ['Median order value', stats.median ? fmtUsd(stats.median) : '—', 'Middle value'],
    ['Avg items / order', qtyStats.mean ? qtyStats.mean.toFixed(1) : '—', 'Mean item quantity'],
  ].map(([label, val, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      <div class="kpi-note">${note}</div>
    </div>`).join('');

  const dayIdx = state.colIdx.day;
  const revByDay = new Map();
  for (const r of purchaseRows) revByDay.set(r[dayIdx], (revByDay.get(r[dayIdx]) || 0) + (r[revIdx] || 0));
  const days = [];
  for (let d = state.startDay; d <= state.endDay; d++) days.push({ day: d, rev: revByDay.get(d) || 0 });
  const dayVals = days.map((d) => d.rev);
  const dayStats = describe(dayVals);
  makeLine('ec-trend', days.map((d) => dateLabel(d.day)), [{
    label: 'Revenue', data: dayVals, borderColor: PALETTE.chart4, backgroundColor: PALETTE.chart4, tension: 0.3, pointRadius: 0, borderWidth: 2,
  }], {
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          afterBody: function() {
            return [
              `Mean: ${dayStats.mean ? fmtUsd(Math.round(dayStats.mean)) : '—'}` ,
              `Median: ${dayStats.median ? fmtUsd(Math.round(dayStats.median)) : '—'}` ,
              `Std dev: ${dayStats.std ? fmtUsd(Math.round(dayStats.std)) : '—'}` ,
              `n (days): ${dayStats.n}`
            ];
          }
        }
      }
    }
  });

  const devIdx = state.colIdx.device_category;
  const revByDevice = new Map();
  for (const r of purchaseRows) {
    const label = lookup('device_category', r[devIdx]);
    revByDevice.set(label, (revByDevice.get(label) || 0) + (r[revIdx] || 0));
  }
  const deviceEntries = [...revByDevice.entries()].sort((a, b) => b[1] - a[1]);
  makeBar('ec-device', deviceEntries.map((e) => e[0]), deviceEntries.map((e) => e[1]), { total: totalRevenue, fmt: fmtUsd, color: PALETTE.chart4 });

  makeHistogram('ec-hist', revenues, 25, 250, stats.n ? [
    { label: 'Median', value: stats.median, color: PALETTE.chart1 },
    { label: 'Mean', value: stats.mean, color: PALETTE.chart4 },
  ] : []);
  document.getElementById('ec-skew').textContent = skewNote(stats);

  statGrid(document.getElementById('ec-stats-rev'), [
    ['Mean', stats.mean ? fmtUsd(stats.mean) : '—'],
    ['Median', stats.median ? fmtUsd(stats.median) : '—'],
    ['Mode', stats.mode !== null ? fmtUsd(stats.mode) : '—'],
    ['Std dev', stats.std ? fmtUsd(stats.std) : '—'],
    ['Variance', stats.variance ? Math.round(stats.variance).toLocaleString() : '—'],
    ['Range', stats.range ? fmtUsd(stats.range) : '—'],
    ['IQR', stats.iqr ? fmtUsd(stats.iqr) : '—'],
    ['n (orders)', stats.n],
  ]);

  statGrid(document.getElementById('ec-stats-pos'), [
    ['Min', stats.min !== null ? fmtUsd(stats.min) : '—'],
    ['P10', stats.p10 != null ? fmtUsd(stats.p10) : '—'],
    ['P25', stats.p25 ? fmtUsd(stats.p25) : '—'],
    ['P50 (median)', stats.median ? fmtUsd(stats.median) : '—'],
    ['P75', stats.p75 ? fmtUsd(stats.p75) : '—'],
    ['P90', stats.p90 ? fmtUsd(stats.p90) : '—'],
    ['Max', stats.max !== null ? fmtUsd(stats.max) : '—'],
  ]);
}

// Plain-language reading of a distribution's shape, for the order-value histogram
function skewNote(stats) {
  if (stats.n < 3 || stats.skew == null) return 'Not enough orders in this range to describe the distribution.';
  const gap = stats.median ? (stats.mean - stats.median) / stats.median : 0;
  const skewTxt = `Skewness ${stats.skew.toFixed(2)} (n = ${fmtInt(stats.n)} orders).`;
  if (stats.skew > 0.5) {
    return `${skewTxt} Right-skewed: most orders are small, with a long tail of large ones. `
      + `The mean (${fmtUsd(stats.mean)}) is ${fmtPct(gap)} above the median (${fmtUsd(stats.median)}) because a few big orders pull it up, `
      + `so the median is the better measure of a typical order.`;
  }
  if (stats.skew < -0.5) {
    return `${skewTxt} Left-skewed: a few unusually small orders pull the mean (${fmtUsd(stats.mean)}) below the median (${fmtUsd(stats.median)}).`;
  }
  return `${skewTxt} Roughly symmetric: the mean (${fmtUsd(stats.mean)}) and median (${fmtUsd(stats.median)}) are close, so either describes a typical order.`;
}

/* ---------------------------------------------------------------------
   Predictions panel
   Reads predictions.json, the file exported by GMS_Predictive_Models.ipynb
   (Google Colab). The panel shows the model evaluation for Problems #1–#4.
   It does not depend on the date range: the models were trained and tested
   on fixed periods (see the notebook).
   --------------------------------------------------------------------- */

async function loadPredictions() {
  try {
    const res = await fetch('predictions.json', { cache: 'no-store' });
    state.predictions = res.ok ? await res.json() : null;
  } catch (err) {
    state.predictions = null;
  }
}

const fmt2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
const fmt3 = (v) => (v == null ? '—' : Number(v).toFixed(3));
const fmtPctOrDash = (v) => (v == null ? '—' : fmtPct(v));
const fmtUsdOrDash = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));
const fmtIntOrDash = (v) => (v == null ? '—' : fmtInt(Math.round(v)));
const num = (label) => ({ label, num: true });

// ----- Chart helpers used only by the Predictions panel

const BAND = 'rgba(42, 161, 179, 0.22)';         // 80% range fill (forecast)
const BAND_STRONG = 'rgba(42, 161, 179, 0.38)';  // 80% range bars (orders)
const fmtPct0 = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const weekdayOf = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

// Same colour for the same kind of model in every chart.
function modelColor(model) {
  if (model.startsWith('Baseline')) return PALETTE.muted;
  if (model.startsWith('Gradient') || model.startsWith('Decision')) return PALETTE.chart3;
  return PALETTE.chart1;
}

// "country_Spain" -> "Country: Spain", "n_scroll" -> "Scroll events"
function prettyFeature(f) {
  const named = { n_scroll: 'Scroll events', n_page_view: 'Page views', n_view_item: 'Item views', n_session_start: 'Sessions' };
  if (named[f]) return named[f];
  const m = f.match(/^(country|channel_group|device_category|month|day_of_week)_(.+)$/);
  if (!m) return f;
  const prefix = { country: 'Country', channel_group: 'Channel', device_category: 'Device', month: 'Month', day_of_week: 'Day' }[m[1]];
  return `${prefix}: ${m[2]}`;
}

// Dashed reference line (target / cut-off) across the plot on the given value axis.
function refLinePlugin(value, text, axisId, opts = {}) {
  return {
    id: 'refLine',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a } = chart;
      const scale = chart.scales[axisId];
      const p = scale.getPixelForValue(value);
      ctx.save();
      ctx.strokeStyle = PALETTE.fg;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (scale.isHorizontal()) { ctx.moveTo(p, a.top); ctx.lineTo(p, a.bottom); } else { ctx.moveTo(a.left, p); ctx.lineTo(a.right, p); }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = PALETTE.fg;
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      if (scale.isHorizontal()) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(text, p + 4, a.top + 2);
      } else if (opts.left) {
        // left end, just under the line, on a background chip so bar labels stay readable
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const w = ctx.measureText(text).width;
        ctx.fillStyle = PALETTE.card || '#fff';
        ctx.fillRect(a.left + 2, p + 2, w + 6, 15);
        ctx.fillStyle = PALETTE.fg;
        ctx.fillText(text, a.left + 5, p + 4);
      } else {
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(text, a.right, p - 3);
      }
      ctx.restore();
    },
  };
}

// Value label on every (non-empty) bar of every visible dataset.
function groupedBarLabelPlugin(fmt, horizontal) {
  return {
    id: 'groupedBarLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = `600 10.5px ${Chart.defaults.font.family}`;
      ctx.fillStyle = PALETTE.fg;
      chart.data.datasets.forEach((ds, di) => {
        if (!chart.isDatasetVisible(di)) return;
        chart.getDatasetMeta(di).data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v == null) return;
          if (horizontal) {
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(fmt(v), bar.x + 4, bar.y);
          } else {
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText(fmt(v), bar.x, bar.y - 3);
          }
        });
      });
      ctx.restore();
    },
  };
}

// Value labels on chosen points of line datasets. Each spec: { label, only?(i), pos?(i) -> 'above'|'below' }.
// By default a label sits on the outer side of the curve: above peaks, below dips.
function pointLabelPlugin(specs) {
  return {
    id: 'pointLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a } = chart;
      const xs = chart.scales.x;
      ctx.save();
      ctx.font = `600 10px ${Chart.defaults.font.family}`;
      ctx.textBaseline = 'middle';
      specs.forEach((spec) => {
        const di = chart.data.datasets.findIndex((d) => d.label === spec.label);
        if (di < 0 || !chart.isDatasetVisible(di)) return;
        const data = chart.data.datasets[di].data;
        chart.getDatasetMeta(di).data.forEach((pt, i) => {
          const v = data[i];
          if (v == null || i < xs.min || i > xs.max) return;
          if (spec.only && !spec.only(i)) return;
          const prev = data[i - 1] ?? v, next = data[i + 1] ?? v;
          const above = spec.pos ? spec.pos(i) === 'above' : v >= (prev + next) / 2;
          const text = fmtInt(Math.round(v));
          const w = ctx.measureText(text).width;
          const x = Math.min(Math.max(pt.x, a.left + w / 2 + 2), a.right - w / 2 - 2);
          const y = pt.y + (above ? -11 : 11);
          ctx.fillStyle = PALETTE.card || '#fff';
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x - w / 2 - 2, y - 7, w + 4, 14);
          ctx.globalAlpha = 1;
          ctx.fillStyle = PALETTE.fg;
          ctx.textAlign = 'center';
          ctx.fillText(text, x, y);
        });
      });
      ctx.restore();
    },
  };
}

// Grouped bars on one shared value axis, with a legend naming each group.
function makeGroupedBar(id, labels, sets, opts = {}) {
  killChart(id);
  const horizontal = !!opts.horizontal;
  const fmt = opts.fmt || fmt2;
  const valueAxis = {
    beginAtZero: true, min: opts.min, max: opts.max,
    grid: { color: PALETTE.border }, border: { display: false },
    ticks: { callback: (v) => fmt(v), maxTicksLimit: 6 },
  };
  const catAxis = { grid: { display: false }, border: { display: false } };
  state.charts[id] = new Chart(document.getElementById(id).getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: sets.map((s) => ({ borderRadius: 4, maxBarThickness: 22, categoryPercentage: 0.72, barPercentage: 0.9, ...s })),
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      // room for the value labels past the end of the bars
      layout: { padding: horizontal ? { right: 36 } : { top: 16 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: sets.length > 1, position: 'top', align: 'start' },
        tooltip: {
          filter: (item) => item.raw != null,
          callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` },
        },
      },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    },
    plugins: [groupedBarLabelPlugin(fmt, horizontal), ...(opts.plugins || [])],
  });
}

// ----- Forecast card with sub-tabs (one line at a time)

function renderForecast(P) {
  const F = P.forecast;
  const labels = [...F.history_dates, ...F.future_dates];
  const nHist = F.history_dates.length, nFut = F.future_dates.length, last = labels.length - 1;
  const testStart = F.history_dates.indexOf(F.test_dates[0]);
  const zoomFrom = Math.max(0, testStart - 14);
  const place = (arr, start) => labels.map((_, i) => (i >= start && i < start + arr.length ? arr[i - start] : null));
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color,
    pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, tension: 0.25, spanGaps: false, fill: false, ...extra });
  const actualData = [...F.history_events, ...new Array(nFut).fill(null)];

  // Fresh dataset objects on every draw (Chart.js mutates them).
  const S = {
    actual: () => line('Actual', actualData, PALETTE.fg, { borderWidth: 1.75 }),
    actualGrey: () => line('Actual', actualData, PALETTE.muted, { borderWidth: 1.5 }),
    testBand: (name) => [
      line('_test_lower', place(F.test_lower, testStart), 'transparent', { borderWidth: 0 }),
      line(name, place(F.test_upper, testStart), 'transparent', { borderWidth: 0, fill: '-1', backgroundColor: BAND }),
    ],
    futureBand: (name) => [
      line('_future_lower', place(F.future_lower, nHist), 'transparent', { borderWidth: 0 }),
      line(name, place(F.future_upper, nHist), 'transparent', { borderWidth: 0, fill: '-1', backgroundColor: BAND }),
    ],
    hw: () => line('Holt-Winters (test)', place(F.test_forecast, testStart), PALETTE.chart1, { borderWidth: 2.5 }),
    naive: () => line('Seasonal naive (baseline)', place(F.naive_forecast, testStart), PALETTE.chart4, { borderDash: [5, 4], borderWidth: 2 }),
    future: () => line('Forecast Feb 1–14', place(F.future_forecast, nHist), PALETTE.chart3, { borderDash: [6, 3], borderWidth: 2.5 }),
  };

  // Numbers for the captions
  const tm = P.p2.traffic.metrics;
  const hwMae = fmtIntOrDash((tm.find((r) => r.model === 'Holt-Winters') || {}).MAE);
  const naiveMae = fmtIntOrDash((tm.find((r) => r.model.startsWith('Baseline')) || {}).MAE);
  const testActual = F.history_events.slice(testStart, testStart + F.test_dates.length);
  const inside = testActual.filter((v, i) => v >= F.test_lower[i] && v <= F.test_upper[i]).length;
  const ev = F.history_events;
  const iMax = ev.indexOf(Math.max(...ev)), iMin = ev.indexOf(Math.min(...ev));
  const ff = F.future_forecast;
  const fMax = ff.indexOf(Math.max(...ff)), fMin = ff.indexOf(Math.min(...ff));

  const MODES = {
    all: {
      sets: () => [S.actual(), ...S.testBand('80% range'), S.hw(), S.naive(), ...S.futureBand('_future_upper'), S.future()],
      from: 0, to: last,
      labels: [{ label: 'Actual', only: (i) => i === iMax || i === iMin, pos: (i) => (i === iMax ? 'above' : 'below') }],
      caption: 'Every line together. Pick a tab above to see one line at a time.',
    },
    actual: {
      sets: () => [S.actual()], from: 0, to: nHist - 1,
      labels: [{ label: 'Actual', only: (i) => i === iMax || i === iMin, pos: (i) => (i === iMax ? 'above' : 'below') }],
      caption: `Real events per day, ${shortDate(F.history_dates[0])} – ${shortDate(F.history_dates[nHist - 1])}. Weekdays are busier than weekends. ` +
        `Busiest day: ${shortDate(F.history_dates[iMax])} (${fmtInt(ev[iMax])}); quietest: ${shortDate(F.history_dates[iMin])} (${fmtInt(ev[iMin])}).`,
    },
    range: {
      sets: () => [S.actualGrey(), ...S.testBand('80% range'), ...S.futureBand('_future_upper')], from: zoomFrom, to: last,
      labels: [{ label: 'Actual', only: (i) => i >= testStart && i < testStart + F.test_dates.length }],
      caption: `The shaded band is where the model expects about 80% of days to land. ${inside} of ${testActual.length} test days ` +
        `(${fmtPct0(inside / testActual.length)}) fell inside it. Grey is the actual traffic.`,
    },
    hw: {
      sets: () => [S.actualGrey(), S.hw()], from: zoomFrom, to: nHist - 1,
      labels: [{ label: 'Holt-Winters (test)' }],
      caption: `The model's guess for each test day (${shortDate(F.test_dates[0])} – ${shortDate(F.test_dates[F.test_dates.length - 1])}) next to what really happened (grey). ` +
        `On average it was off by ${hwMae} events a day.`,
    },
    naive: {
      sets: () => [S.actualGrey(), S.naive()], from: zoomFrom, to: nHist - 1,
      labels: [{ label: 'Seasonal naive (baseline)' }],
      caption: `The baseline just repeats the same weekday from the week before. It was off by ${naiveMae} events a day, ` +
        `so Holt-Winters (${hwMae}) is only slightly better.`,
    },
    future: {
      sets: () => [S.actualGrey(), ...S.futureBand('80% range'), S.future()], from: zoomFrom, to: last,
      labels: [{ label: 'Forecast Feb 1–14' }],
      caption: `The next two weeks, which have no real data yet. Busiest: ${weekdayOf(F.future_dates[fMax])}s (~${fmtInt(Math.round(ff[fMax]))}); ` +
        `quietest: ${weekdayOf(F.future_dates[fMin])}s (~${fmtInt(Math.round(ff[fMin]))}). The band widens day by day because the further ahead the model looks, the less sure it is.`,
    },
  };

  const draw = () => {
    const mode = MODES[state.prForecastMode] || MODES.all;
    const sets = mode.sets();
    document.getElementById('pr-forecast-caption').textContent = mode.caption;
    makeLine('pr-forecast', labels.map((d) => shortDate(d)), sets, {
      inlinePlugins: [pointLabelPlugin(mode.labels || [])],
      layout: { padding: { top: 16 } },
      plugins: {
        legend: { display: sets.filter((s) => !s.label.startsWith('_')).length > 1, labels: { filter: (item) => !item.text.startsWith('_') } },
        tooltip: {
          filter: (item) => !item.dataset.label.startsWith('_') && item.raw != null,
          callbacks: { label: (c) => `${c.dataset.label}: ${fmtInt(Math.round(c.raw))}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 }, min: mode.from, max: mode.to },
        y: { grid: { color: PALETTE.border }, beginAtZero: true, ticks: { callback: (v) => fmtInt(v) } },
      },
    });
  };

  if (!state.prForecastMode) state.prForecastMode = 'all';
  const btns = document.querySelectorAll('#pr-forecast-tabs .chart-tab');
  btns.forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.prForecastMode);
    if (!b._hasListener) {
      b.addEventListener('click', () => {
        state.prForecastMode = b.dataset.mode;
        btns.forEach((bb) => bb.classList.toggle('active', bb === b));
        draw();
      });
      b._hasListener = true;
    }
  });
  draw();
}

// ----- Odds ratios: bars grow left/right from 1 on a log axis

function renderOdds(P) {
  killChart('pr-p1-odds-chart');
  const rows = [...P.p1.odds_ratios].sort((a, b) => b.odds_ratio - a.odds_ratio);
  const labels = rows.map((r) => prettyFeature(r.feature));
  const up = rows.map((r) => (r.odds_ratio >= 1 ? [1, r.odds_ratio] : null));
  const down = rows.map((r) => (r.odds_ratio < 1 ? [r.odds_ratio, 1] : null));
  const ors = rows.map((r) => r.odds_ratio);
  const lo = Math.min(0.5, ...ors) * 0.75, hi = Math.max(2, ...ors) * 1.35;
  const labelPlugin = {
    id: 'oddsLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      ctx.fillStyle = PALETTE.fg;
      ctx.textBaseline = 'middle';
      chart.data.datasets.forEach((ds, di) => {
        chart.getDatasetMeta(di).data.forEach((bar, i) => {
          if (ds.data[i] == null) return;
          const raising = ors[i] >= 1;
          const end = raising ? Math.max(bar.x, bar.base) : Math.min(bar.x, bar.base);
          ctx.textAlign = raising ? 'left' : 'right';
          ctx.fillText('×' + fmt2(ors[i]), end + (raising ? 5 : -5), bar.y);
        });
      });
      ctx.restore();
    },
  };
  state.charts['pr-p1-odds-chart'] = new Chart(document.getElementById('pr-p1-odds-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Raises the odds', data: up, backgroundColor: PALETTE.chart3, borderRadius: 4, grouped: false, maxBarThickness: 18 },
        { label: 'Lowers the odds', data: down, backgroundColor: PALETTE.chart4, borderRadius: 4, grouped: false, maxBarThickness: 18 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: true, position: 'top', align: 'start' },
        tooltip: { filter: (item) => item.raw != null, callbacks: { label: (c) => `Odds ratio ×${fmt2(ors[c.dataIndex])}` } },
      },
      scales: {
        x: {
          type: 'logarithmic', min: lo, max: hi,
          grid: { color: (c) => (c.tick && c.tick.value === 1 ? PALETTE.fg : PALETTE.border) },
          border: { display: false },
          afterBuildTicks: (axis) => { axis.ticks = [0.5, 1, 2, 3].filter((v) => v >= lo && v <= hi).map((v) => ({ value: v })); },
          ticks: { callback: (v) => '×' + v },
        },
        y: { grid: { display: false }, border: { display: false } },
      },
    },
    plugins: [labelPlugin],
  });
}

// ----- Order-value ranges: one floating bar per test order + the actual value

function renderOrderRanges(P) {
  killChart('pr-p3-ranges');
  const tr = [...P.p3.orders.test_ranges].sort((a, b) => a.actual - b.actual);
  const isIn = (r) => r.actual >= r.P10 && r.actual <= r.P90;
  const nIn = tr.filter(isIn).length;
  const outs = tr.filter((r) => !isIn(r));
  const dot = (label, data, color, style) => ({
    type: 'line', label, data, showLine: false, pointStyle: style, pointRadius: style === 'rectRot' ? 6 : 4.5, pointHoverRadius: 7,
    pointBackgroundColor: color, pointBorderColor: '#fff', pointBorderWidth: 1.5, borderColor: color, backgroundColor: color,
  });
  // Actual value of each order, written vertically above its range bar.
  const actualLabels = {
    id: 'actualLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const ys = chart.scales.y;
      ctx.save();
      ctx.font = `600 10px ${Chart.defaults.font.family}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      chart.getDatasetMeta(2).data.forEach((bar, i) => {
        const r = tr[i];
        const top = Math.min(ys.getPixelForValue(r.actual), ys.getPixelForValue(r.P90)) - 8;
        ctx.save();
        ctx.translate(bar.x, top);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = isIn(r) ? PALETTE.fg : PALETTE.destructive;
        ctx.fillText('$' + Math.round(r.actual), 0, 0);
        ctx.restore();
      });
      ctx.restore();
    },
  };
  state.charts['pr-p3-ranges'] = new Chart(document.getElementById('pr-p3-ranges').getContext('2d'), {
    type: 'bar',
    data: {
      labels: tr.map((_, i) => String(i + 1)),
      datasets: [
        dot('Actual (inside range)', tr.map((r) => (isIn(r) ? r.actual : null)), PALETTE.chart1, 'circle'),
        dot('Actual (outside range)', tr.map((r) => (isIn(r) ? null : r.actual)), PALETTE.destructive, 'rectRot'),
        { type: 'bar', label: '80% range (P10–P90)', data: tr.map((r) => [r.P10, r.P90]), backgroundColor: BAND_STRONG,
          borderRadius: 4, barPercentage: 0.75, categoryPercentage: 0.9 },
      ],
    },
    options: {
      responsive: true,
      layout: { padding: { top: 34 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', align: 'start' },
        tooltip: {
          filter: (item) => item.raw != null,
          callbacks: {
            title: (items) => `Test order ${items[0].label}`,
            label: (c) => (Array.isArray(c.raw) ? `Range: $${Math.round(c.raw[0])} – $${Math.round(c.raw[1])}` : `Actual: $${Math.round(c.raw)}`),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'Test orders, smallest to largest' } },
        y: { beginAtZero: true, grid: { color: PALETTE.border }, border: { display: false }, ticks: { callback: (v) => '$' + v } },
      },
    },
    plugins: [actualLabels],
  });
  const small = outs.filter((r) => r.actual < r.P10).length;
  document.getElementById('pr-p3-note').textContent =
    `${nIn} of ${tr.length} test orders (${fmtPct0(nIn / tr.length)}) landed inside their predicted range, a little under the 80% target. ` +
    `Of the ${outs.length} misses, ${small} were smaller than predicted and ${outs.length - small} larger (up to $${Math.round(Math.max(...tr.map((r) => r.actual)))}).`;
}

// ----- Quiet days: events per test day + a grid of what each model flagged

function renderQuietDays(P) {
  const D = P.p4.days;
  const labels = D.flags.map((r) => [r.weekday.slice(0, 2), r.date.slice(8)]);
  makeGroupedBar('pr-p4-days-bars', labels, [
    { label: 'Quiet day', data: D.flags.map((r) => (r.actual_quiet ? r.events : null)), backgroundColor: PALETTE.chart3, grouped: false },
    { label: 'Normal day', data: D.flags.map((r) => (r.actual_quiet ? null : r.events)), backgroundColor: PALETTE.border, grouped: false },
  ], { fmt: fmtIntOrDash, plugins: [refLinePlugin(D.cutoff, `Cut-off ${fmtInt(D.cutoff)}`, 'y', { left: true })] });

  const cell = (flag, actual) => {
    const kind = flag && actual ? 'hit' : flag ? 'false' : actual ? 'miss' : 'none';
    const sym = { hit: '✓', false: '!', miss: '✗', none: '' }[kind];
    return `<div class="flag-cell ${kind}">${sym}</div>`;
  };
  const head = D.flags.map((r) => `<div class="flag-head">${r.weekday.slice(0, 2)}<br>${r.date.slice(8)}</div>`).join('');
  const row = (name, cells) => `<div class="flag-name">${name}</div>${cells}`;
  document.getElementById('pr-p4-flag-grid').innerHTML =
    `<div></div>${head}` +
    row('Actually quiet', D.flags.map((r) => `<div class="flag-cell ${r.actual_quiet ? 'actual' : 'none'}"></div>`).join('')) +
    row('Decision tree', D.flags.map((r) => cell(r.tree_flag, r.actual_quiet)).join('')) +
    row('Logistic', D.flags.map((r) => cell(r.logit_flag, r.actual_quiet)).join(''));
}

function renderPredictions() {
  const P = state.predictions;
  document.getElementById('pr-missing').style.display = P ? 'none' : '';
  document.getElementById('pr-content').style.display = P ? '' : 'none';
  if (!P) return;

  const m = P.meta || {};
  document.getElementById('pr-meta').textContent =
    `Results from ${m.source_csv || 'the notebook'} (generated ${m.generated_at || '—'}). ` +
    `Time-based split: training ${m.train_days ? m.train_days.join(' → ') : '—'}, ` +
    `test ${m.test_days ? m.test_days.join(' → ') : '—'}. The date filter above does not apply to this panel.`;

  // ----- KPIs
  const summary = P.summary || [];
  const kept = summary.filter((r) => r.beats_baseline).length;
  const lr1 = (P.p1.metrics || []).find((r) => r.model === 'Logistic regression') || {};
  const hw = (P.p2.traffic.metrics || []).find((r) => r.model === 'Holt-Winters') || {};
  const hwBase = (P.p2.traffic.metrics || []).find((r) => r.model.startsWith('Baseline')) || {};
  const cov = (P.p3.traffic.metrics || []).find((r) => r.model.startsWith('Holt-Winters')) || {};
  document.getElementById('pr-kpis').innerHTML = [
    ['Models beating baseline', `${kept} / ${summary.length}`, 'On each task’s main metric'],
    ['Buyer model AUC', fmt3(lr1.auc), `Logistic regression · recall ${fmtPctOrDash(lr1.recall)}`],
    ['Traffic forecast MAE', fmtIntOrDash(hw.MAE), `events/day · baseline ${fmtIntOrDash(hwBase.MAE)}`],
    ['Forecast range coverage', fmtPctOrDash(cov.coverage), 'Target ≈ 80% of test days'],
  ].map(([label, val, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${val}</div>
      <div class="kpi-note">${note}</div>
    </div>`).join('');

  // ----- Summary table
  const fmtMetric = (metric, v) => {
    if (v == null) return '—';
    if (metric.startsWith('MAE ($')) return fmtUsdOrDash(v);
    if (metric.startsWith('MAE')) return fmtIntOrDash(v);
    if (metric === 'Recall' || metric.startsWith('|coverage')) return fmtPct(v);
    return fmt3(v);
  };
  renderTable(document.getElementById('pr-summary'),
    [{ label: 'Problem' }, { label: 'Task' }, { label: 'Model' }, { label: 'Main metric' }, num('Model'), num('Baseline'), { label: 'Beats baseline?' }],
    summary.map((r) => [r.problem, r.task, r.model, r.metric, fmtMetric(r.metric, r.model_value),
      fmtMetric(r.metric, r.baseline_value), r.beats_baseline ? '✓ Yes' : '✗ No']));

  // ----- Forecast (sub-tabs)
  renderForecast(P);

  // ----- Problem #1
  makeGroupedBar('pr-p1-chart', ['Precision', 'Recall', 'F1', 'AUC'],
    P.p1.metrics.map((r) => ({ label: r.model, data: [r.precision, r.recall, r.f1, r.auc], backgroundColor: modelColor(r.model) })),
    { min: 0, max: 1, fmt: fmt2 });
  document.getElementById('pr-p1-note').textContent =
    `Logistic regression catches ${fmtPct0(lr1.recall)} of real buyers (recall), but only ${fmtPctOrDash(lr1.precision)} of the visitors it flags actually buy (precision), ` +
    `because just ${fmtInt(P.p1.n_buyers)} of ${fmtInt(P.p1.n_visitors)} visitors are buyers. ` +
    `Its ranking is still useful: the top 1% of visitors it ranks highest contain ${fmtPct0(P.p1.share_buyers_top1pct)} of all test buyers.`;
  renderTable(document.getElementById('pr-p1-metrics'),
    [{ label: 'Model' }, num('Accuracy'), num('Precision'), num('Recall'), num('F1'), num('AUC')],
    P.p1.metrics.map((r) => [r.model, fmtPctOrDash(r.accuracy), fmt3(r.precision), fmt3(r.recall), fmt3(r.f1), fmt3(r.auc)]));
  renderOdds(P);
  renderTable(document.getElementById('pr-p1-odds'),
    [{ label: 'Feature' }, num('Odds ratio')],
    P.p1.odds_ratios.map((r) => [prettyFeature(r.feature), fmt2(r.odds_ratio)]));

  // ----- Problem #2
  const om = P.p2.orders.metrics, tmx = P.p2.traffic.metrics;
  makeBar('pr-p2-orders-chart', om.map((r) => r.model), om.map((r) => r.MAE),
    { horizontal: true, color: om.map((r) => modelColor(r.model)), fmt: fmtUsdOrDash });
  makeBar('pr-p2-traffic-chart', tmx.map((r) => r.model), tmx.map((r) => r.MAE),
    { horizontal: true, color: tmx.map((r) => modelColor(r.model)), fmt: fmtIntOrDash });
  const omB = om.find((r) => r.model.startsWith('Baseline')) || {}, omM = om.find((r) => !r.model.startsWith('Baseline')) || {};
  document.getElementById('pr-p2-note').textContent =
    `Both models beat their baseline, but only just: order value by ${fmtUsdOrDash(omB.MAE - omM.MAE)} per order, ` +
    `daily traffic by ${fmtIntOrDash(hwBase.MAE - hw.MAE)} events per day.`;
  renderTable(document.getElementById('pr-p2-orders'),
    [{ label: 'Order value' }, num('MAE'), num('RMSE'), num('R²')],
    om.map((r) => [r.model, fmtUsdOrDash(r.MAE), fmtUsdOrDash(r.RMSE), fmt3(r.R2)]));
  renderTable(document.getElementById('pr-p2-traffic'),
    [{ label: 'Daily traffic' }, num('MAE'), num('RMSE')],
    tmx.map((r) => [r.model, fmtIntOrDash(r.MAE), fmtIntOrDash(r.RMSE)]));
  const wk = P.p2.traffic.weekday_effects || [];
  makeBar('pr-weekday', wk.map((r) => r.weekday.slice(0, 3)), wk.map((r) => Math.round(r.effect_vs_average_day)),
    { color: wk.map((r) => (r.effect_vs_average_day >= 0 ? PALETTE.chart1 : PALETTE.chart4)), fmt: (v) => (v > 0 ? '+' : '') + fmtInt(v) });

  // ----- Problem #3
  const p3all = [
    ...P.p3.orders.metrics.map((r) => ({ task: 'Order value', r, width: fmtUsdOrDash(r.avg_width), mae: fmtUsdOrDash(r.MAE_P50) })),
    ...P.p3.traffic.metrics.map((r) => ({ task: 'Daily traffic', r, width: fmtIntOrDash(r.avg_width), mae: fmtIntOrDash(r.MAE) })),
  ];
  makeBar('pr-p3-chart', p3all.map((x) => [x.task, x.r.model.replace(/\s*\(.*\)$/, '')]), p3all.map((x) => x.r.coverage), {
    horizontal: true, max: 1, padRight: 120,
    color: p3all.map((x) => modelColor(x.r.model)),
    labelFor: (i) => `${fmtPct0(p3all[i].r.coverage)} · width ${p3all[i].width}`,
    fmt: fmtPct0,
    plugins: [refLinePlugin(0.8, '80% target', 'x')],
  });
  renderTable(document.getElementById('pr-p3'),
    [{ label: 'Task' }, { label: 'Model' }, num('MAE (middle)'), num('Coverage'), num('Avg width')],
    p3all.map((x) => [x.task, x.r.model, x.mae, fmtPctOrDash(x.r.coverage), x.width]));
  renderOrderRanges(P);

  // ----- Problem #4
  const p4Sets = (rows) => rows.filter((r) => !r.model.startsWith('Baseline'))
    .map((r) => ({ label: r.model, data: [r.precision, r.recall, r.f1], backgroundColor: modelColor(r.model) }));
  makeGroupedBar('pr-p4-orders-chart', ['Precision', 'Recall', 'F1'], p4Sets(P.p4.orders.metrics), { min: 0, max: 1, fmt: fmt2 });
  makeGroupedBar('pr-p4-days-chart', ['Precision', 'Recall', 'F1'], p4Sets(P.p4.days.metrics), { min: 0, max: 1, fmt: fmt2 });
  const p4rows = [
    ...P.p4.orders.metrics.map((r) => ['High-value order', r.model, fmt3(r.precision), fmt3(r.recall), fmt3(r.f1), fmt3(r.auc), fmtPctOrDash(r.accuracy)]),
    ...P.p4.days.metrics.map((r) => ['Quiet day', r.model, fmt3(r.precision), fmt3(r.recall), fmt3(r.f1), '—', fmtPctOrDash(r.accuracy)]),
  ];
  renderTable(document.getElementById('pr-p4'),
    [{ label: 'Task' }, { label: 'Model' }, num('Precision'), num('Recall'), num('F1'), num('AUC'), num('Accuracy')], p4rows);
  document.getElementById('pr-p4-note').textContent =
    `High-value = order ≥ ${fmtUsdOrDash(P.p4.orders.cutoff)} (${P.p4.orders.n_pos_test} in the test set). ` +
    `Quiet day = fewer than ${fmtIntOrDash(P.p4.days.cutoff)} events (${P.p4.days.n_pos_test} of the 14 test days). ` +
    'Quiet days are easy to spot; high-value orders are not. With so few cases, one right or wrong call moves recall a lot.';
  renderQuietDays(P);
  const yn = (v) => (v ? 'Quiet' : '');
  renderTable(document.getElementById('pr-p4-flags'),
    [{ label: 'Date' }, { label: 'Day' }, num('Events'), { label: 'Actual' }, { label: 'Tree' }, { label: 'Logistic' }],
    P.p4.days.flags.map((r) => [r.date, r.weekday.slice(0, 3), fmtInt(r.events), yn(r.actual_quiet), yn(r.tree_flag), yn(r.logit_flag)]));

  // ----- Overfitting: scores (0–1) as train vs test bars; errors stay in the table
  const ov = P.overfit_summary || [];
  const scores = ov.filter((r) => ['AUC', 'F1', 'Coverage'].includes(r.metric));
  makeGroupedBar('pr-overfit-chart', scores.map((r) => [`${r.task} (${r.metric})`, r.model]), [
    { label: 'Training', data: scores.map((r) => r.train), backgroundColor: PALETTE.chart4 },
    { label: 'Test', data: scores.map((r) => r.test), backgroundColor: PALETTE.chart1 },
  ], { horizontal: true, min: 0, max: 1, fmt: fmt2 });
  const worst = scores.reduce((a, b) => (b['train − test'] > (a ? a['train − test'] : -Infinity) ? b : a), null);
  if (worst) {
    document.getElementById('pr-overfit-note').textContent =
      `Biggest drop: ${worst.model} for ${worst.task.replace(/^#\d+ /, '').toLowerCase()} (${worst.metric} ${fmt2(worst.train)} → ${fmt2(worst.test)}), ` +
      'so treat that model with caution. Most other models score about the same on both, which means they generalise.';
  }
  const fmtOv = (metric, v) => (metric.startsWith('RMSE') ? fmtUsdOrDash(v) : metric.startsWith('MAE') ? fmtIntOrDash(v) : fmt3(v));
  renderTable(document.getElementById('pr-overfit'),
    [{ label: 'Task' }, { label: 'Model' }, { label: 'Metric' }, num('Train'), num('Test'), num('Train − test')],
    ov.map((r) => [r.task, r.model, r.metric, fmtOv(r.metric, r.train), fmtOv(r.metric, r.test),
      fmtOv(r.metric, r['train − test'])]));
}

const RENDERERS = {
  overview: renderOverview,
  trends: renderTrends,
  device: renderDevice,
  countries: renderCountries,
  'os-browser': renderOsBrowser,
  sources: renderSources,
  events: renderEvents,
  conversion: renderConversion,
  ecommerce: renderEcommerce,
  predictions: renderPredictions,
};

const TITLES = {
  overview: ['Overview', 'Key metrics across the selected date range.'],
  trends: ['Summary & Trends', 'How activity moves over time — volume, users, and central-tendency stats.'],
  device: ['Device Category', 'Desktop, mobile, and tablet usage.'],
  countries: ['Countries', 'Where events originate, by country and continent.'],
  'os-browser': ['Operating System & Browser', 'Technology breakdown of visiting devices.'],
  sources: ['Top Traffic Sources', 'Acquisition channels, sources, and mediums.'],
  events: ['Events', 'Frequency of every tracked GA4 event.'],
  conversion: ['Conversion', 'Funnel from session start through purchase.'],
  ecommerce: ['eCommerce', 'Revenue and order statistics.'],
  predictions: ['Predictions', 'Model evaluation for Problems #1–#4, exported from the Colab notebook.'],
};

let currentPanel = 'overview';

function renderCurrentPanel() {
  const rows = filteredRows();
  RENDERERS[currentPanel](rows);
}

function switchPanel(panel) {
  currentPanel = panel;
  document.querySelectorAll('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === panel));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${panel}`));
  const [title, sub] = TITLES[panel];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = sub;
  renderCurrentPanel();
}

/* ---------------------------------------------------------------------
   Date range controls
   --------------------------------------------------------------------- */

function dayIndexForDate(dateStr) {
  const idx = state.data.dates.indexOf(dateStr);
  return idx;
}

function applyDateRange(startStr, endStr) {
  let s = dayIndexForDate(startStr);
  let e = dayIndexForDate(endStr);
  if (s === -1) s = 0;
  if (e === -1) e = state.data.dates.length - 1;
  if (s > e) [s, e] = [e, s];
  state.startDay = s;
  state.endDay = e;
  renderCurrentPanel();
}

function setupDateControls() {
  const min = state.data.meta.date_min, max = state.data.meta.date_max;
  const startInput = document.getElementById('start-date');
  const endInput = document.getElementById('end-date');
  [startInput, endInput].forEach((el) => { el.min = min; el.max = max; });
  startInput.value = min;
  endInput.value = max;

  startInput.addEventListener('change', () => applyDateRange(startInput.value, endInput.value));
  endInput.addEventListener('change', () => applyDateRange(startInput.value, endInput.value));

  const presetsEl = document.getElementById('presets');
  const allDates = state.data.dates;
  const maxDate = new Date(max + 'T00:00:00');

  function daysBack(n) {
    const d = new Date(maxDate);
    d.setDate(d.getDate() - (n - 1));
    const iso = d.toISOString().slice(0, 10);
    return iso < min ? min : iso;
  }

  const presets = [
    { label: 'All time', start: min, end: max },
    { label: 'Last 30d', start: daysBack(30), end: max },
    { label: 'Last 7d', start: daysBack(7), end: max },
  ];

  presetsEl.innerHTML = presets.map((p, i) => `<button class="preset-btn${i === 0 ? ' active' : ''}" data-i="${i}">${p.label}</button>`).join('');
  presetsEl.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = presets[Number(btn.dataset.i)];
      startInput.value = p.start;
      endInput.value = p.end;
      presetsEl.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyDateRange(p.start, p.end);
    });
  });
}

/* ---------------------------------------------------------------------
   Init
   --------------------------------------------------------------------- */

async function init() {
  readPalette();
  try {
    await loadData();
    await loadPredictions();   // optional: the panel explains what to do if it is missing
  } catch (err) {
    document.getElementById('loading-msg').textContent = err.message;
    return;
  }
  document.getElementById('loading-msg').style.display = 'none';
  document.querySelectorAll('.panel').forEach((p) => (p.style.display = ''));
  document.getElementById('panel-overview').classList.add('active');

  document.getElementById('sidebar-meta').innerHTML =
    `${fmtInt(state.data.meta.n_rows)} events · ${fmtInt(state.data.meta.n_users)} users<br>${state.data.meta.date_min} → ${state.data.meta.date_max}`;

  setupDateControls();

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchPanel(btn.dataset.panel);
      history.replaceState(null, '', '#' + btn.dataset.panel);
    });
  });

  // a link like index.html#predictions opens that panel directly
  const fromHash = location.hash.slice(1);
  if (RENDERERS[fromHash]) switchPanel(fromHash); else renderCurrentPanel();
}

init();
