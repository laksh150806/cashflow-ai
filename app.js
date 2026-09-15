/**
 * app.js — CashFlow AI Dashboard Controller
 * ──────────────────────────────────────────
 * Orchestrates synthetic data, Holt-Winters forecasting,
 * 4-pillar credit scoring, early warning engine, scenario simulation,
 * and dual-view rendering (MSME Business Owner vs. Lender Portal).
 */

import { generateAllProfiles } from './synth-data.js';
import {
  holtWinters,
  forecastInflowOutflow,
  projectZeroBalanceDate,
  detectOutliers,
  cumulativeBalance,
  fmtINR,
  addDays,
} from './forecasting.js';
import { computeCreditScore, computeRiskBreakdown } from './credit-engine.js';
import { runWarningEngine } from './warning-engine.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  profiles: {},              // Generated synthetic profiles
  currentProfileKey: 'healthyKirana',
  role: 'msme',              // 'msme' | 'lender'
  horizon: 90,
  alpha: 0.30,
  beta: 0.10,
  gamma: 0.20,
  kSigma: 2.0,
  sim: {
    delayPct: 0,
    delayDays: 0,
    revenuePct: 0,
    emergencyAmount: 0,
  },
  charts: {},
};

// ─── DOM HELPER ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── BOOT ─────────────────────────────────────────────────────────────────────
function boot() {
  try {
    // 1. Generate synthetic MSME data
    state.profiles = generateAllProfiles();
  } catch (err) {
    console.error('Failed to generate synthetic MSME data:', err);
    $('loader-text').textContent = 'Error generating data: ' + err.message;
    return;
  }

  // 2. Setup UI & Listeners
  renderProfileSelector();
  bindRoleSwitcher();
  bindForecastControls();
  bindSimulatorControls();

  // 3. Initial Render
  render();

  // 4. Hide Loader
  setTimeout(() => {
    const loader = $('loader');
    if (loader) loader.classList.add('hidden');
  }, 400);
}

// ─── PROFILE SELECTOR ─────────────────────────────────────────────────────────
function renderProfileSelector() {
  const container = $('profile-grid');
  if (!container) return;

  container.innerHTML = '';

  Object.entries(state.profiles).forEach(([key, p]) => {
    const meta = p.profile;
    const card = document.createElement('div');
    card.className = `profile-card ${key === state.currentProfileKey ? 'active' : ''}`;
    card.dataset.key = key;

    card.innerHTML = `
      <div class="profile-card-header">
        <div class="profile-name">${meta.name}</div>
        <span class="profile-badge">${meta.sector}</span>
      </div>
      <p class="profile-desc">${meta.description}</p>
    `;

    card.addEventListener('click', () => {
      if (state.currentProfileKey === key) return;
      state.currentProfileKey = key;

      document.querySelectorAll('.profile-card').forEach(c => {
        c.classList.toggle('active', c.dataset.key === key);
      });

      render();
    });

    container.appendChild(card);
  });
}

// ─── ROLE SWITCHER ────────────────────────────────────────────────────────────
function bindRoleSwitcher() {
  const btnMsme = $('role-msme');
  const btnLender = $('role-lender');
  const slider = $('role-slider');
  const msmeView = $('msme-view');
  const lenderView = $('lender-view');

  if (!btnMsme || !btnLender) return;

  const setRole = role => {
    state.role = role;
    if (role === 'msme') {
      btnMsme.classList.add('active');
      btnLender.classList.remove('active');
      if (slider) slider.style.transform = 'translateX(0)';
      if (msmeView) msmeView.style.display = 'block';
      if (lenderView) lenderView.style.display = 'none';
    } else {
      btnLender.classList.add('active');
      btnMsme.classList.remove('active');
      if (slider) slider.style.transform = 'translateX(100%)';
      if (msmeView) msmeView.style.display = 'none';
      if (lenderView) lenderView.style.display = 'block';
    }
    render();
  };

  btnMsme.addEventListener('click', () => setRole('msme'));
  btnLender.addEventListener('click', () => setRole('lender'));
}

// ─── CONTROLS BINDING ─────────────────────────────────────────────────────────
function bindForecastControls() {
  // Horizon buttons
  document.querySelectorAll('.btn-horizon').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-horizon').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.horizon = parseInt(btn.dataset.days, 10);
      render();
    });
  });

  // Holt-Winters Sliders
  const bindSlider = (id, valId, prop) => {
    const el = $(id);
    const valEl = $(valId);
    if (!el || !valEl) return;
    el.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      state[prop] = v;
      valEl.textContent = v.toFixed(2);
      render();
    });
  };

  bindSlider('alpha-slider', 'alpha-val', 'alpha');
  bindSlider('beta-slider', 'beta-val', 'beta');
  bindSlider('gamma-slider', 'gamma-val', 'gamma');
}

function bindSimulatorControls() {
  const bindSimSlider = (id, valId, prop, formatter) => {
    const el = $(id);
    const valEl = $(valId);
    if (!el || !valEl) return;
    el.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      state.sim[prop] = v;
      valEl.textContent = formatter ? formatter(v) : v;
      render();
    });
  };

  bindSimSlider('sim-delay-pct', 'sim-delay-pct-val', 'delayPct', v => `${v}%`);
  bindSimSlider('sim-delay-days', 'sim-delay-days-val', 'delayDays', v => `${v} days`);
  bindSimSlider('sim-revenue', 'sim-revenue-val', 'revenuePct', v => `${v > 0 ? '+' : ''}${v}%`);
  bindSimSlider('sim-emergency', 'sim-emergency-val', 'emergencyAmount', v => fmtINR(v));
}

// ─── MAIN RENDER PIPELINE ─────────────────────────────────────────────────────
function render() {
  const profileData = state.profiles[state.currentProfileKey];
  if (!profileData) return;

  const { profile: meta, days } = profileData;

  // Extract core time series
  const dates = days.map(d => d.date);
  const inflows = days.map(d => d.inflows.total);
  const outflows = days.map(d => d.outflows.total);
  const netFlows = days.map(d => d.netFlow);
  const balance = days.map(d => d.balance);

  const currentBalance = balance[balance.length - 1];
  const lastDate = dates[dates.length - 1];

  // 1. Run Holt-Winters Forecasting
  const hw = holtWinters(
    netFlows,
    state.alpha,
    state.beta,
    state.gamma,
    state.horizon,
    7,
    0.15
  );

  const fcastDates = [];
  for (let k = 1; k <= state.horizon; k++) {
    fcastDates.push(addDays(lastDate, k));
  }

  const fcastBalance = cumulativeBalance(hw.forecast, currentBalance);
  const fcastUpper = cumulativeBalance(hw.upper, currentBalance);
  const fcastLower = cumulativeBalance(hw.lower, currentBalance);

  // 2. Outlier Detection
  const od = detectOutliers(outflows, 14, state.kSigma);

  // 3. Credit Scoring Engine
  const scoreResult = computeCreditScore(days, meta);
  const riskBreakdown = computeRiskBreakdown(scoreResult, days);

  // 4. Early Warning Engine
  const warningResult = runWarningEngine(days, hw.forecast, currentBalance, lastDate, meta);

  // Render active view
  if (state.role === 'msme') {
    renderMSMEView(
      days,
      dates,
      outflows,
      balance,
      fcastDates,
      fcastBalance,
      fcastUpper,
      fcastLower,
      od,
      scoreResult,
      warningResult,
      meta,
      hw.forecast,
      currentBalance,
      lastDate
    );
  } else {
    renderLenderView(
      days,
      dates,
      balance,
      fcastDates,
      fcastBalance,
      fcastUpper,
      fcastLower,
      scoreResult,
      riskBreakdown,
      meta
    );
  }
}

// ─── MSME VIEW RENDER ────────────────────────────────────────────────────────
function renderMSMEView(
  days,
  dates,
  outflows,
  balance,
  fcastDates,
  fcastBalance,
  fcastUpper,
  fcastLower,
  od,
  scoreResult,
  warningResult,
  meta,
  baselineForecast,
  currentBalance,
  lastDate
) {
  const { metrics, warnings, mitigations } = warningResult;

  // 1. Metric Cards
  if ($('m-balance')) $('m-balance').textContent = fmtINR(currentBalance);
  if ($('m-runrate')) $('m-runrate').textContent = fmtINR(metrics.runRate30d);
  if ($('m-burn')) $('m-burn').textContent = `${fmtINR(metrics.burnRate)}/day`;
  if ($('m-score')) $('m-score').textContent = `${scoreResult.totalScore}/100`;
  if ($('m-score-tier')) $('m-score-tier').textContent = scoreResult.tierLabel;
  if ($('m-runway')) {
    $('m-runway').textContent = metrics.runway >= 999 ? '∞' : `${Math.round(metrics.runway)} Days`;
  }
  if ($('m-outliers')) $('m-outliers').textContent = od.outlierIdx.length;

  // 2. Early Warnings & Mitigations
  const warnPanel = $('warnings-panel');
  const warnList = $('warnings-list');
  const mitGrid = $('mitigations-grid');

  if (warnPanel && warnList && mitGrid) {
    if (warnings.length > 0 || mitigations.length > 0) {
      warnPanel.style.display = 'block';

      // Render warnings
      warnList.innerHTML = warnings
        .map(
          w => `
        <div class="alert-banner alert-${w.severity}">
          <div class="alert-icon">${w.icon}</div>
          <div class="alert-content">
            <div class="alert-title">${w.title}</div>
            <div class="alert-msg">${w.message}</div>
          </div>
        </div>
      `
        )
        .join('');

      // Render mitigations
      mitGrid.innerHTML = mitigations
        .map(
          m => `
        <div class="mitigation-card">
          <div class="mitigation-header">
            <span class="mitigation-icon">${m.icon}</span>
            <span class="mitigation-title">${m.title}</span>
          </div>
          <p class="mitigation-desc">${m.description}</p>
          <div class="mitigation-impact">💡 ${m.impact}</div>
        </div>
      `
        )
        .join('');
    } else {
      warnPanel.style.display = 'none';
    }
  }

  // 3. Charts
  renderBalanceChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower);
  renderCategoryChart(days);
  renderOutflowChart(dates, outflows, od);

  // 4. Scenario Simulator
  renderSimulator(days, baselineForecast, currentBalance, lastDate, meta, scoreResult);

  // 5. Outliers Table
  renderOutlierTable(days, od, dates, outflows);
}

// ─── LENDER VIEW RENDER ──────────────────────────────────────────────────────
function renderLenderView(
  days,
  dates,
  balance,
  fcastDates,
  fcastBalance,
  fcastUpper,
  fcastLower,
  scoreResult,
  riskBreakdown,
  meta
) {
  // 1. Gauge & Business Info
  const score = scoreResult.totalScore;
  const scoreText = $('gauge-score');
  const gaugeArc = $('gauge-arc');
  const badge = $('risk-badge');
  const bizName = $('lender-biz-name');
  const bizSector = $('lender-biz-sector');

  if (scoreText) scoreText.textContent = score;
  if (bizName) bizName.textContent = meta.name;
  if (bizSector) bizSector.textContent = `${meta.sector} · ${meta.label}`;

  if (badge) {
    badge.textContent = scoreResult.tierLabel;
    badge.className = `risk-badge risk-${scoreResult.tier}`;
  }

  if (gaugeArc) {
    // Circumference = 2 * π * 85 ≈ 534.07, 270 deg arc = 401.92
    const totalLength = 401.92;
    const fillLength = (score / 100) * totalLength;
    const offset = totalLength - fillLength;
    gaugeArc.style.strokeDashoffset = offset;

    if (score >= 75) gaugeArc.style.stroke = 'url(#gauge-grad-good)';
    else if (score >= 50) gaugeArc.style.stroke = 'url(#gauge-grad-mid)';
    else gaugeArc.style.stroke = 'url(#gauge-grad-bad)';
  }

  // 2. Risk Engine Breakdown (Razorpay Shield Style)
  const breakdownGrid = $('risk-breakdown');
  if (breakdownGrid) {
    breakdownGrid.innerHTML = riskBreakdown
      .map(
        r => `
      <div class="risk-card status-${r.status}">
        <div class="risk-header">
          <span class="risk-icon">${r.icon}</span>
          <span class="risk-title">${r.category}</span>
          <span class="risk-status-pill pill-${r.status}">${r.statusLabel}</span>
        </div>
        <div class="risk-items">
          ${r.items
            .map(
              it => `
            <div class="risk-item">
              <span class="risk-item-label">${it.label}</span>
              <span class="risk-item-val val-${it.status}">${it.value}</span>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `
      )
      .join('');
  }

  // 3. Score Pillars Grid
  const pillarsGrid = $('pillars-grid');
  if (pillarsGrid) {
    pillarsGrid.innerHTML = scoreResult.pillars
      .map(
        p => `
      <div class="pillar-card">
        <div class="pillar-header">
          <span class="pillar-name">${p.label}</span>
          <span class="pillar-score">${p.score} / ${p.maxScore} pts</span>
        </div>
        <div class="pillar-bar-bg">
          <div class="pillar-bar-fill" style="width: ${(p.score / p.maxScore) * 100}%;"></div>
        </div>
        <p class="pillar-desc">${p.explanation}</p>
      </div>
    `
      )
      .join('');
  }

  // 4. Deduction Factors
  const explainList = $('explain-list');
  if (explainList) {
    if (scoreResult.deductions.length === 0) {
      explainList.innerHTML = `
        <div class="explain-item pass">
          <span>🎉 Perfect Score! No deductions incurred across all 4 credit pillars.</span>
        </div>`;
    } else {
      explainList.innerHTML = scoreResult.deductions
        .map(
          d => `
        <div class="explain-item">
          <span class="deduct-pill">-${d.points} pts</span>
          <span class="deduct-text">${d.reason}</span>
        </div>
      `
        )
        .join('');
    }
  }

  // 5. Loan Pre-Approval Card
  const loanCard = $('loan-card');
  if (loanCard) {
    const rec = scoreResult.loanRecommendation;
    if (!rec || !rec.eligible) {
      loanCard.innerHTML = `
        <div class="loan-ineligible">
          <div class="loan-header">
            <div class="loan-title">⚠️ Loan Pre-Approval Status</div>
            <span class="loan-badge error">Not Eligible</span>
          </div>
          <p class="loan-reason">${rec ? rec.reason : 'High credit risk profile.'}</p>
          <div class="loan-action">Action required: ${rec ? rec.suggestedAction : 'Improve cash balance.'}</div>
        </div>
      `;
    } else {
      loanCard.innerHTML = `
        <div class="loan-eligible">
          <div class="loan-header">
            <div>
              <div class="loan-title">🎉 Pre-Approved Credit Facility</div>
              <div class="loan-product">${rec.product}</div>
            </div>
            <span class="loan-badge success">Pre-Approved</span>
          </div>
          <div class="loan-amount">${fmtINR(rec.maxAmount)}</div>
          <div class="loan-grid">
            <div class="loan-spec">
              <span class="spec-label">Interest Rate</span>
              <span class="spec-val">${rec.interestRate}% p.a.</span>
            </div>
            <div class="loan-spec">
              <span class="spec-label">Max Tenure</span>
              <span class="spec-val">${rec.tenureMonths} Months</span>
            </div>
            <div class="loan-spec">
              <span class="spec-label">Estimated EMI</span>
              <span class="spec-val">${fmtINR(rec.estimatedEMI)}/mo</span>
            </div>
          </div>
          <div class="loan-conditions">
            <div class="conditions-title">📋 Approval Conditions:</div>
            <ul>
              ${rec.conditions.map(c => `<li>${c}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
    }
  }

  // 6. Lender Forecast Chart
  renderLenderChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower);
}

// ─── SCENARIO SIMULATOR ───────────────────────────────────────────────────────
function renderSimulator(days, baselineForecast, currentBalance, lastDate, meta, baselineScoreResult) {
  const resultContainer = $('sim-result');
  if (!resultContainer) return;

  const { delayPct, delayDays, revenuePct, emergencyAmount } = state.sim;

  if (delayPct === 0 && delayDays === 0 && revenuePct === 0 && emergencyAmount === 0) {
    resultContainer.style.display = 'none';
    return;
  }

  resultContainer.style.display = 'block';

  // Apply scenario modifications to baseline forecast
  const simForecast = baselineForecast.map((net, i) => {
    let mod = net;

    // Revenue change
    if (revenuePct !== 0) {
      mod += mod * (revenuePct / 100);
    }

    // Receivables delay
    if (delayPct > 0 && delayDays > 0 && i < delayDays) {
      mod -= Math.abs(mod) * (delayPct / 100);
    }

    // Emergency expense on day 1
    if (emergencyAmount > 0 && i === 0) {
      mod -= emergencyAmount;
    }

    return mod;
  });

  // Calculate simulated zero balance date
  const baseZero = projectZeroBalanceDate(baselineForecast, currentBalance, addDays(lastDate, 1));
  const simZero = projectZeroBalanceDate(simForecast, currentBalance, addDays(lastDate, 1));

  // Determine severity impact
  let impactBadge = 'info';
  let impactTitle = 'Minor Impact';

  if (simZero.daysUntilZero && (!baseZero.daysUntilZero || simZero.daysUntilZero < baseZero.daysUntilZero)) {
    impactBadge = 'critical';
    impactTitle = 'High Risk Scenario — Liquidity Depleted Early!';
  } else if (revenuePct < 0 || delayPct > 20) {
    impactBadge = 'warning';
    impactTitle = 'Moderate Cash Flow Stress';
  }

  resultContainer.innerHTML = `
    <div class="sim-banner sim-${impactBadge}">
      <div class="sim-banner-title">⚡ ${impactTitle}</div>
      <div class="sim-comparison-grid">
        <div class="sim-metric">
          <span class="sim-label">Baseline Cash Zero Date</span>
          <span class="sim-val">${baseZero.zeroDate ? baseZero.zeroDate : 'No Cash Crunch (Safe)'}</span>
        </div>
        <div class="sim-metric">
          <span class="sim-label">Simulated Zero Date</span>
          <span class="sim-val highlight-${impactBadge}">${simZero.zeroDate ? simZero.zeroDate + ` (${simZero.daysUntilZero} days)` : 'No Cash Crunch'}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── CHARTS RENDERING ─────────────────────────────────────────────────────────

function rebuildChart(key, ctx, config) {
  if (state.charts[key]) {
    state.charts[key].destroy();
  }
  state.charts[key] = new Chart(ctx, config);
}

function renderBalanceChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower) {
  const canvas = $('chart-balance');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const allDates = [...dates, ...fcastDates];
  const histData = balance.concat(new Array(fcastDates.length).fill(null));
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
    },
    {
      label: '+15% Upper',
      data: upperData,
      borderColor: 'hsl(264,80%,65%,0.3)',
      backgroundColor: 'hsl(264,80%,65%,0.08)',
      borderWidth: 1,
      borderDash: [3, 4],
      pointRadius: 0,
      fill: '+1',
      tension: 0.3,
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
    },
  ];

  rebuildChart('balance', ctx, {
    type: 'line',
    data: { labels: allDates, datasets },
    options: chartOptions('Cash Balance', allDates),
  });
}

function renderCategoryChart(days) {
  const canvas = $('chart-category');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const catTotals = {};
  days.forEach(d => {
    Object.entries(d.outflows).forEach(([cat, amt]) => {
      if (cat === 'total') return;
      catTotals[cat] = (catTotals[cat] || 0) + amt;
    });
  });

  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => k.toUpperCase());
  const data = sorted.map(([, v]) => v);

  const palette = [
    'hsl(195,100%,55%)',
    'hsl(264,80%,65%)',
    'hsl(152,68%,48%)',
    'hsl(356,80%,58%)',
    'hsl(38,95%,55%)',
    'hsl(200,60%,65%)',
    'hsl(30,80%,60%)',
    'hsl(270,60%,55%)',
  ];

  rebuildChart('category', ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: palette,
          borderColor: 'hsl(222,47%,5%)',
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: 'hsl(215,15%,60%)',
            font: { family: 'Inter', size: 11 },
            padding: 12,
            boxWidth: 12,
          },
        },
        tooltip: tooltipConfig(),
      },
    },
  });
}

function renderOutflowChart(dates, outflows, od) {
  const canvas = $('chart-outflow');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const outlierPoints = outflows.map((v, i) => (od.outlierIdx.includes(i) ? v : null));

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
    },
    {
      label: 'Moving Average (14d)',
      data: od.movingAvg,
      borderColor: 'hsl(200,60%,65%)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
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
    },
    {
      label: 'Spending Spike',
      data: outlierPoints,
      borderColor: 'transparent',
      backgroundColor: 'hsl(38,95%,55%)',
      pointRadius: 6,
      pointHoverRadius: 9,
      pointStyle: 'triangle',
      showLine: false,
    },
  ];

  rebuildChart('outflow', ctx, {
    type: 'line',
    data: { labels: dates, datasets },
    options: chartOptions('Outflows & Spikes', dates),
  });
}

function renderLenderChart(dates, balance, fcastDates, fcastBalance, fcastUpper, fcastLower) {
  const canvas = $('chart-lender-balance');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const allDates = [...dates, ...fcastDates];
  const histData = balance.concat(new Array(fcastDates.length).fill(null));
  const fcastData = new Array(dates.length).fill(null).concat(fcastBalance);

  const datasets = [
    {
      label: 'Historical Trajectory',
      data: histData,
      borderColor: 'hsl(152,68%,48%)',
      backgroundColor: 'hsl(152,68%,48%,0.05)',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.3,
    },
    {
      label: 'Lender Project Trajectory',
      data: fcastData,
      borderColor: 'hsl(195,100%,55%)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      tension: 0.3,
    },
  ];

  rebuildChart('lender-balance', ctx, {
    type: 'line',
    data: { labels: allDates, datasets },
    options: chartOptions('Cash Trajectory', allDates),
  });
}

// ─── OUTLIER TABLE ────────────────────────────────────────────────────────────
function renderOutlierTable(days, od, dates, outflows) {
  const tbody = $('outlier-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (od.outlierIdx.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">
          No spending spikes detected at current sensitivity threshold (${state.kSigma}σ).
        </td>
      </tr>`;
    return;
  }

  const sorted = [...od.outlierIdx].sort((a, b) => outflows[b] - outflows[a]);

  sorted.slice(0, 30).forEach(idx => {
    const day = days[idx];
    const date = dates[idx];
    const actual = outflows[idx];
    const thr = od.threshold[idx];
    const pctOver = (((actual - thr) / thr) * 100).toFixed(1);

    // Find top outflow category for this day
    const cats = Object.entries(day.outflows).filter(([k]) => k !== 'total');
    cats.sort((a, b) => b[1] - a[1]);
    const topCat = cats[0] ? `${cats[0][0].toUpperCase()} (${fmtINR(cats[0][1])})` : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${date}</td>
      <td><span class="amount-negative">${fmtINR(actual)}</span></td>
      <td>${fmtINR(thr)}</td>
      <td>
        <span class="spike-badge">
          <span class="spike-dot"></span>
          +${pctOver}% over threshold
        </span>
      </td>
      <td>${topCat}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── CHART CONFIG HELPERS ─────────────────────────────────────────────────────
function chartOptions(yLabel, labels) {
  const tickStep = Math.max(1, Math.floor(labels.length / 10));

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 300 },
    plugins: {
      legend: {
        labels: {
          color: 'hsl(215,15%,60%)',
          font: { family: 'Inter', size: 11 },
          boxWidth: 14,
          padding: 12,
          usePointStyle: true,
        },
      },
      tooltip: tooltipConfig(),
    },
    scales: {
      x: {
        ticks: {
          color: 'hsl(215,12%,40%)',
          font: { family: 'Inter', size: 10 },
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
          font: { family: 'Inter', size: 10 },
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
    bodyColor: 'hsl(215,15%,60%)',
    padding: 12,
    titleFont: { family: 'Inter', size: 12, weight: '600' },
    bodyFont: { family: 'Inter', size: 11 },
    callbacks: {
      label: ctx => {
        const v = ctx.parsed.y ?? ctx.raw;
        if (v === null || v === undefined) return null;
        return ` ${ctx.dataset.label}: ${fmtINR(v)}`;
      },
    },
  };
}

// ─── START ────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
