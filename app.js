/* =========================================================================
   GA4 Analytics Dashboard — app.js
   Loads the compact integer-coded event data produced by build_data.py,
   filters it by the selected date range, and renders every sidebar panel.
   ========================================================================= */

const state = {
  data: null,
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
    return { n: 0, mean: null, median: null, mode: null, min: null, max: null, range: null, std: null, variance: null, iqr: null, p25: null, p75: null, p90: null };
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
  return {
    n, mean, median: quantile(sorted, 0.5), mode,
    min: sorted[0], max: sorted[n - 1], range: sorted[n - 1] - sorted[0],
    std, variance, iqr: p75 - p25, p25, p75, p90: quantile(sorted, 0.9),
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
      ...opts,
    },
  });
}

function makeBar(id, labels, data, opts = {}) {
  killChart(id);
  const ctx = document.getElementById(id).getContext('2d');
  const horizontal = opts.horizontal;
  state.charts[id] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: opts.color || PALETTE.chart1, borderRadius: 4, maxBarThickness: 34 }],
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: !horizontal, color: PALETTE.border }, beginAtZero: true },
        y: { grid: { display: horizontal, color: PALETTE.border }, beginAtZero: true },
      },
    },
  });
}

function makeDonut(id, labels, data) {
  killChart(id);
  const ctx = document.getElementById(id).getContext('2d');
  state.charts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: PALETTE.series, borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: true, cutout: '62%', plugins: { legend: { position: 'bottom' } } },
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
  const revenue = rows.reduce((a, r) => a + r[revIdx], 0);
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
  makeBar('ov-countries', countries.map((c) => c.label), countries.map((c) => c.count), { horizontal: true, color: PALETTE.chart2 });

  const channels = countBy(rows, 'channel_group');
  makeDonut('ov-channels', channels.map((c) => c.label), channels.map((c) => c.count));

  // Overview: User & sessions over time
  const usersSeries = dailyUniqueUsers(rows);
  const enIdx = state.colIdx.event_name;
  const sessionCode = state.data.lookups.event_name.indexOf('session_start');
  const sessionsByDay = new Map();
  for (const r of rows) if (r[enIdx] === sessionCode) sessionsByDay.set(r[state.colIdx.day], (sessionsByDay.get(r[state.colIdx.day]) || 0) + 1);
  makeLine('ov-usersessions', usersSeries.map((d) => dateLabel(d.day)), [
    { label: 'Users', data: usersSeries.map((d) => d.count), borderColor: PALETTE.chart2, backgroundColor: PALETTE.chart2, tension: 0.3, pointRadius: 0, borderWidth: 2 },
    { label: 'Sessions', data: usersSeries.map((d) => sessionsByDay.get(d.day) || 0), borderColor: PALETTE.chart3, backgroundColor: PALETTE.chart3, tension: 0.3, pointRadius: 0, borderWidth: 2 },
  ]);

  // Overview: Traffic by channel (top channels horizontal bar)
  const topChannels = topN(channels, 8);
  makeBar('ov-traffic-channel', topChannels.map((c) => c.label), topChannels.map((c) => c.count), { horizontal: true, color: PALETTE.chart1 });
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
  makeBar('dev-brand', brands.map((b) => b.label), brands.map((b) => b.count), { color: PALETTE.chart3 });

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
  makeBar('ctr-bar', top10.map((c) => c.label), top10.map((c) => c.count), { horizontal: true, color: PALETTE.chart1 });

  const continents = countBy(rows, 'continent');
  makeDonut('ctr-continent', continents.map((c) => c.label), continents.map((c) => c.count));

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

  makeBar('os-bar', os.map((o) => displayLabel(o.label)), os.map((o) => o.count), { color: PALETTE.chart1 });
  makeBar('br-bar', browser.map((b) => displayLabel(b.label)), browser.map((b) => b.count), { color: PALETTE.chart2 });

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
  makeDonut('src-channel', channels.map((c) => c.label), channels.map((c) => c.count));

  const sources = topN(countBy(rows, 'source'), 8);
  makeBar('src-source', sources.map((s) => s.label), sources.map((s) => s.count), { horizontal: true, color: PALETTE.chart3 });

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
  makeBar('ev-bar', events.map((e) => e.label), events.map((e) => e.count), { horizontal: true, color: PALETTE.chart1 });

  // Sessions progress column: visual progress of event count relative to max
  const maxCount = events.length ? events[0].count : 1;
  // debug log first few progress values
  if (window && window.console) console.log('renderEvents: sample', events.slice(0,6).map(e => ({label: e.label, count: e.count, pct: Math.round((e.count/(events[0]?.count||1))*100)})));
  renderTable(document.getElementById('ev-table'),
    [
      { label: '#', num: true },
      { label: 'Event' },
      { label: 'Count', num: true },
      { label: 'Share', num: true },
      { label: 'Sessions', num: true },
    ],
    events.map((e, i) => [
      i + 1,
      e.label,
      fmtInt(e.count),
      fmtPct(e.count / total),
      { bar: { value: e.count, max: maxCount, display: fmtInt(e.count) } },
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
    [ { label: 'Channel' }, { label: 'Converted', num: true }, { label: 'Rate', num: true }, { label: 'Sessions', num: true } ],
    channelArr.map((c) => [ c.channel, fmtInt(c.converted), fmtPct(c.sessions ? c.converted / c.sessions : 0), fmtInt(c.sessions) ])
  );
}

function renderEcommerce(rows) {
  const enIdx = state.colIdx.event_name;
  const purchaseCode = state.data.lookups.event_name.indexOf('purchase');
  const purchaseRows = rows.filter((r) => r[enIdx] === purchaseCode);
  const revIdx = state.colIdx.revenue, qtyIdx = state.colIdx.qty, itemsIdx = state.colIdx.items;

  const revenues = purchaseRows.map((r) => r[revIdx]);
  const totalRevenue = revenues.reduce((a, b) => a + b, 0);
  const stats = describe(revenues);
  const qtyStats = describe(purchaseRows.map((r) => r[qtyIdx]));

  document.getElementById('ec-kpis').innerHTML = [
    ['Total revenue', fmtUsd(totalRevenue), `${fmtInt(purchaseRows.length)} orders`],
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
  for (const r of purchaseRows) revByDay.set(r[dayIdx], (revByDay.get(r[dayIdx]) || 0) + r[revIdx]);
  const days = [];
  for (let d = state.startDay; d <= state.endDay; d++) days.push({ day: d, rev: revByDay.get(d) || 0 });
  const dayVals = days.map((d) => d.rev);
  const dayStats = describe(dayVals);
  makeLine('ec-trend', days.map((d) => dateLabel(d.day)), [{
    data: dayVals, borderColor: PALETTE.chart4, backgroundColor: PALETTE.chart4, tension: 0.3, pointRadius: 0, borderWidth: 2,
  }], {
    plugins: {
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
    revByDevice.set(label, (revByDevice.get(label) || 0) + r[revIdx]);
  }
  const deviceEntries = [...revByDevice.entries()];
  makeDonut('ec-device', deviceEntries.map((e) => e[0]), deviceEntries.map((e) => e[1]));

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
    ['P25', stats.p25 ? fmtUsd(stats.p25) : '—'],
    ['P50 (median)', stats.median ? fmtUsd(stats.median) : '—'],
    ['P75', stats.p75 ? fmtUsd(stats.p75) : '—'],
    ['P90', stats.p90 ? fmtUsd(stats.p90) : '—'],
    ['Max', stats.max !== null ? fmtUsd(stats.max) : '—'],
  ]);
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
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
  });

  renderCurrentPanel();
}

init();
