/**
 * app.js — CashFlow AI Dashboard
 * --------------------------------
 * Orchestrates data loading, UI state, chart rendering,
 * and wires the forecasting + outlier engines.
 *
 * Dependencies (CDN in index.html):
 *   - Chart.js 4.x
 *   - forecasting.js (ES module, same origin)
 */

import { holtWinters, detectOutliers, cumulativeBalance, fmtINR, addDays } from './forecasting.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  raw: null,          // full JSON from daily_cashflow_data.json
  groupKey: 'overall',
  horizon: 90,
  alpha: 0.3,
  beta: 0.1,
  gamma: 0.2,
  kSigma: 2.0,
  startBalance: 5_000_000,
  charts: {},
};

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const res = await fetch('daily_cashflow_data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.raw = await res.json();
  } catch (e) {
    console.error('Failed to load data:', e);
    $('loader-text').textContent = 'Error loading data. Is the dev server running?';
    return;
  }

  populateCohortSelects();
  bindControls();
  render();

  $('loader').classList.add('hidden');
}

// ─── COHORT SELECTS ───────────────────────────────────────────────────────────
function populateCohortSelects() {
  const { states, banks } = state.raw.metadata;

  const stateEl = $('select-state');
  states.forEach(s => {
    const opt = document.createElement('option');
    opt.value = `state_${s}`;
    opt.textContent = s;
    stateEl.appendChild(opt);
  });

  const bankEl = $('select-bank');
  banks.forEach(b => {
    const opt = document.createElement('option');
    opt.value = `bank_${b}`;
    opt.textContent = b;
    bankEl.appendChild(opt);
  });
}

// ─── CONTROLS ────────────────────────────────────────────────────────────────
function bindControls() {
  // Cohort type radio
  document.querySelectorAll('input[name="cohort-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const type = radio.value;
      $('state-group').style.display = type === 'state' ? '' : 'none';
      $('bank-group').style.display  = type === 'bank'  ? '' : 'none';

      if (type === 'overall') state.groupKey = 'overall';
      else if (type === 'state') state.groupKey = $('select-state').value;
      else state.groupKey = $('select-bank').value;
      render();
    });
  });

  $('select-state').addEventListener('change', e => {
    state.groupKey = e.target.value;
    render();
  });

  $('select-bank').addEventListener('change', e => {
    state.groupKey = e.target.value;
    render();
  });

  // Alpha
  $('alpha-slider').addEventListener('input', e => {
    state.alpha = parseFloat(e.target.value);
    $('alpha-val').textContent = state.alpha.toFixed(2);
    render();
  });

  // Beta
  $('beta-slider').addEventListener('input', e => {
    state.beta = parseFloat(e.target.value);
    $('beta-val').textContent = state.beta.toFixed(2);
    render();
  });

  // Gamma
  $('gamma-slider').addEventListener('input', e => {
    state.gamma = parseFloat(e.target.value);
    $('gamma-val').textContent = state.gamma.toFixed(2);
    render();
  });

  // kSigma
  $('sigma-slider').addEventListener('input', e => {
    state.kSigma = parseFloat(e.target.value);
    $('sigma-val').textContent = state.kSigma.toFixed(1);
    render();
  });

  // Starting balance
  $('start-balance').addEventListener('change', e => {
    state.startBalance = parseFloat(e.target.value) || 5_000_000;
    render();
  });

  // Horizon buttons
  document.querySelectorAll('.btn-horizon').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-horizon').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.horizon = parseInt(btn.dataset.days, 10);
      render();
    });
  });
}

// ─── MAIN RENDER ─────────────────────────────────────────────────────────────
function render() {
  const records = state.raw.groups[state.groupKey];
  if (!records || records.length === 0) return;

  // Extract series
  const dates    = records.map(r => r.date);
  const inflows  = records.map(r => r.inflow);
  const outflows = records.map(r => r.outflow);
  const netFlows = records.map((r, i) => inflows[i] - outflows[i]);

  // Running balance
  const balance = cumulativeBalance(netFlows, state.startBalance);

  // ── Holt-Winters on net flows ───────────────────────────────
  const hw = holtWinters(
    netFlows,
    state.alpha,
    state.beta,
    state.gamma,
    state.horizon,
    7,       // weekly seasonality
    0.15     // ±15% confidence
  );

  // Build forecast dates
  const lastDate = dates[dates.length - 1];
  const fcastDates = [];
  for (let k = 1; k <= state.horizon; k++) {
    fcastDates.push(addDays(lastDate, k));
  }

  // Forecast running balance (starting from last historical balance)
  const fcastBalance  = cumulativeBalance(hw.forecast, balance[balance.length - 1]);
  const fcastUpper    = cumulativeBalance(hw.upper,    balance[balance.length - 1]);
  const fcastLower    = cumulativeBalance(hw.lower,    balance[balance.length - 1]);

  // ── Outlier Detection on outflows ──────────────────────────
  const od = detectOutliers(outflows, 14, state.kSigma);

  // ── Update metric cards ────────────────────────────────────
  const totalNet    = netFlows.reduce((a, b) => a + b, 0);
  const endBal      = balance[balance.length - 1];
  const outlierCnt  = od.outlierIdx.length;
  const lastTrend   = hw.trend[hw.trend.length - 1];

  $('metric-net').textContent     = fmtINR(totalNet);
  $('metric-balance').textContent = fmtINR(endBal);
  $('metric-outliers').textContent = outlierCnt;
  $('metric-trend').textContent   = lastTrend >= 0
    ? `▲ ${fmtINR(lastTrend)}/day`
    : `▼ ${fmtINR(Math.abs(lastTrend))}/day`;
  $('metric-trend').style.color = lastTrend >= 0
    ? 'var(--emerald)' : 'var(--ruby)';

  // ── Render charts ──────────────────────────────────────────
  renderBalanceChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower);
  renderOutflowChart(dates, outflows, od);
  renderCategoryChart(records);

  // ── Render outlier table ───────────────────────────────────
  renderOutlierTable(records, od, dates, outflows);
}

// ─── CHART 1: Balance + Forecast ─────────────────────────────────────────────
function renderBalanceChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower) {
  const ctx = $('chart-balance').getContext('2d');

  const allDates = [...dates, ...fcastDates];

  // Historical balance — null pad the forecast zone
  const histData  = balance.map(v => v).concat(new Array(fcastDates.length).fill(null));
  const fcastData = new Array(dates.length).fill(null).concat(fcastBalance);
  const upperData = new Array(dates.length).fill(null).concat(fcastUpper);
  const lowerData = new Array(dates.length).fill(null).concat(fcastLower);

  const datasets = [
    {
      label: 'Historical Balance',
      data: histData,
      borderColor: 'hsl(195,100%,55%)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      order: 1,
    },
    {
      label: 'Forecast (HW)',
      data: fcastData,
      borderColor: 'hsl(264,80%,65%)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      tension: 0.3,
      order: 2,
    },
    {
      label: '+15% Upper',
      data: upperData,
      borderColor: 'hsl(264,80%,65%,0.3)',
      backgroundColor: 'hsl(264,80%,65%,0.07)',
      borderWidth: 1,
      borderDash: [3, 4],
      pointRadius: 0,
      fill: '+1',
      tension: 0.3,
      order: 3,
    },
    {
      label: '-15% Lower',
      data: lowerData,
      borderColor: 'hsl(264,80%,65%,0.3)',
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderDash: [3, 4],
      pointRadius: 0,
      tension: 0.3,
      order: 4,
    },
  ];

  rebuildChart('balance', ctx, {
    type: 'line',
    data: { labels: allDates, datasets },
    options: chartOptions('Cash Balance (INR)', allDates, true),
  });
}

// ─── CHART 2: Outflows + Moving Avg + Outliers ───────────────────────────────
function renderOutflowChart(dates, outflows, od) {
  const ctx = $('chart-outflow').getContext('2d');

  // Build outlier point overlay
  const outlierPoints = outflows.map((v, i) =>
    od.outlierIdx.includes(i) ? v : null
  );

  const datasets = [
    {
      label: 'Daily Outflow',
      data: outflows,
      borderColor: 'hsl(356,80%,58%)',
      backgroundColor: 'hsl(356,80%,58%,0.08)',
      borderWidth: 1.5,
      pointRadius: 0,
      fill: true,
      tension: 0.2,
      order: 3,
    },
    {
      label: 'Moving Average (14d)',
      data: od.movingAvg,
      borderColor: 'hsl(200,60%,65%)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 2,
    },
    {
      label: `Threshold (±${state.kSigma}σ)`,
      data: od.threshold,
      borderColor: 'hsl(38,95%,55%,0.6)',
      backgroundColor: 'hsl(38,95%,55%,0.05)',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      fill: '-1',
      tension: 0.3,
      order: 1,
    },
    {
      label: 'Spike Outlier',
      data: outlierPoints,
      borderColor: 'transparent',
      backgroundColor: 'hsl(38,95%,55%)',
      pointRadius: 5,
      pointHoverRadius: 8,
      pointStyle: 'triangle',
      showLine: false,
      order: 0,
    },
  ];

  rebuildChart('outflow', ctx, {
    type: 'line',
    data: { labels: dates, datasets },
    options: chartOptions('Outflows & Outlier Detection', dates),
  });
}

// ─── CHART 3: Category Doughnut ──────────────────────────────────────────────
function renderCategoryChart(records) {
  const ctx = $('chart-category').getContext('2d');

  // Sum up all category outflows
  const catTotals = {};
  records.forEach(r => {
    Object.entries(r.categories || {}).forEach(([cat, amt]) => {
      catTotals[cat] = (catTotals[cat] || 0) + amt;
    });
  });

  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => k);
  const data   = sorted.map(([, v]) => v);

  const palette = [
    'hsl(195,100%,55%)', 'hsl(264,80%,65%)', 'hsl(152,68%,48%)',
    'hsl(356,80%,58%)',  'hsl(38,95%,55%)',  'hsl(200,60%,65%)',
    'hsl(30,80%,60%)',   'hsl(270,60%,55%)', 'hsl(100,55%,50%)',
    'hsl(0,60%,65%)',
  ];

  rebuildChart('category', ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: palette,
        borderColor: 'hsl(222,47%,5%)',
        borderWidth: 3,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: 'hsl(215,15%,60%)',
            font: { family: 'Outfit', size: 11 },
            padding: 12,
            boxWidth: 12,
          },
        },
        tooltip: tooltipConfig(),
      },
    },
  });
}

// ─── OUTLIER TABLE ────────────────────────────────────────────────────────────
function renderOutlierTable(records, od, dates, outflows) {
  const tbody = $('outlier-tbody');
  tbody.innerHTML = '';

  if (od.outlierIdx.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">
          No outliers detected at current threshold (${state.kSigma}σ). Lower the sensitivity slider to detect more.
        </td>
      </tr>`;
    return;
  }

  // Sort descending by severity
  const sorted = [...od.outlierIdx].sort((a, b) => {
    const devA = outflows[a] - od.threshold[a];
    const devB = outflows[b] - od.threshold[b];
    return devB - devA;
  });

  sorted.slice(0, 50).forEach(idx => {
    const rec      = records[idx];
    const date     = dates[idx];
    const actual   = outflows[idx];
    const thr      = od.threshold[idx];
    const excess   = actual - thr;
    const pctOver  = ((excess / thr) * 100).toFixed(1);

    // Top category for this day
    const cats = Object.entries(rec.categories || {});
    cats.sort((a, b) => b[1] - a[1]);
    const topCat = cats[0] ? `${cats[0][0]} (${fmtINR(cats[0][1])})` : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${date}</td>
      <td><span class="amount-negative">${fmtINR(actual)}</span></td>
      <td>${fmtINR(thr)}</td>
      <td>
        <span class="spike-badge">
          <span class="spike-dot"></span>
          +${pctOver}% over
        </span>
      </td>
      <td>${topCat}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── CHART UTILITIES ──────────────────────────────────────────────────────────
function rebuildChart(key, ctx, config) {
  if (state.charts[key]) {
    state.charts[key].destroy();
  }
  state.charts[key] = new Chart(ctx, config);
}

function chartOptions(yLabel, labels, isBalance = false) {
  // Show every ~30th label for readability
  const tickStep = Math.max(1, Math.floor(labels.length / 12));

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 400 },
    plugins: {
      legend: {
        labels: {
          color: 'hsl(215,15%,60%)',
          font: { family: 'Outfit', size: 11 },
          boxWidth: 14,
          padding: 14,
          usePointStyle: true,
        },
      },
      tooltip: tooltipConfig(),
    },
    scales: {
      x: {
        ticks: {
          color: 'hsl(215,12%,40%)',
          font: { family: 'Outfit', size: 10 },
          maxRotation: 0,
          callback: function (val, idx) {
            return idx % tickStep === 0 ? labels[idx] : '';
          },
        },
        grid: { color: 'hsl(222,20%,14%)' },
      },
      y: {
        ticks: {
          color: 'hsl(215,12%,40%)',
          font: { family: 'Outfit', size: 10 },
          callback: v => fmtINR(v),
        },
        grid: { color: 'hsl(222,20%,14%)' },
      },
    },
  };
}

function tooltipConfig() {
  return {
    backgroundColor: 'hsl(222,30%,10%)',
    borderColor: 'hsl(222,20%,22%)',
    borderWidth: 1,
    titleColor: 'hsl(215,20%,90%)',
    bodyColor:  'hsl(215,15%,60%)',
    padding: 12,
    titleFont:  { family: 'Outfit', size: 12, weight: '600' },
    bodyFont:   { family: 'Outfit', size: 11 },
    callbacks: {
      label: ctx => {
        const v = ctx.parsed.y ?? ctx.raw;
        if (v === null || v === undefined) return null;
        return ` ${ctx.dataset.label}: ${fmtINR(v)}`;
      },
    },
  };
}

// ─── KICK OFF ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', boot);
