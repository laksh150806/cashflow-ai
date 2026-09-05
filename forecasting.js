/**
 * forecasting.js
 * ---------------
 * Lightweight in-browser forecasting engine.
 * Implements:
 *   1. Holt-Winters Triple Exponential Smoothing (additive, m=7 weekly seasonality)
 *   2. Moving Standard Deviation Outlier Detection
 *   3. Separate Inflow/Outflow Forecasting
 *   4. Zero-Balance Date Projection
 */

'use strict';

// ─── HOLT-WINTERS ────────────────────────────────────────────────────────────

/**
 * Initialize seasonal indices using averages of the first 2 full seasons.
 * @param {number[]} y   - time-series values
 * @param {number}   m   - season length (7 for weekly)
 * @returns {number[]} initial seasonal indices of length m
 */
function initSeasonals(y, m) {
  const nSeasons = Math.floor(y.length / m);
  if (nSeasons < 1) return new Array(m).fill(0);

  // Season averages for the first nSeasons full seasons
  const seasonAvgs = [];
  for (let i = 0; i < nSeasons; i++) {
    let sum = 0;
    for (let j = 0; j < m; j++) sum += y[i * m + j];
    seasonAvgs.push(sum / m);
  }

  // Overall average across those seasons
  const overallAvg = seasonAvgs.reduce((a, b) => a + b, 0) / nSeasons;

  // Seasonal indices: average deviation from global mean for each position in season
  const seasonals = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    let sumDev = 0;
    for (let i = 0; i < nSeasons; i++) {
      sumDev += y[i * m + j] - seasonAvgs[i];
    }
    seasonals[j] = sumDev / nSeasons;
  }

  // Normalise so they sum to zero (additive model invariant)
  const mean = seasonals.reduce((a, b) => a + b, 0) / m;
  return seasonals.map(s => s - mean);
}

/**
 * Holt-Winters Triple Exponential Smoothing – Additive
 *
 * @param {number[]} y       - historical daily net cash flow series
 * @param {number}   alpha   - level smoothing  (0 < α < 1)
 * @param {number}   beta    - trend smoothing  (0 < β < 1)
 * @param {number}   gamma   - seasonal smoothing (0 < γ < 1)
 * @param {number}   horizon - forecast horizon in days (e.g. 90)
 * @param {number}   m       - season length (7 = weekly)
 * @param {number}   confPct - half-width of confidence band as fraction (0.15 = ±15%)
 *
 * @returns {{
 *   fitted:    number[],    // in-sample fitted values
 *   level:     number[],    // l_t at each step
 *   trend:     number[],    // b_t at each step
 *   seasonal:  number[],    // final seasonal indices (length m)
 *   forecast:  number[],    // point forecasts for next `horizon` steps
 *   upper:     number[],    // upper confidence bound
 *   lower:     number[],    // lower confidence bound
 * }}
 */
export function holtWinters(y, alpha = 0.3, beta = 0.1, gamma = 0.2, horizon = 90, m = 7, confPct = 0.15) {
  const n = y.length;
  if (n < 2 * m) {
    // Insufficient data – return naive forecast
    const last = y[n - 1] ?? 0;
    const forecast = new Array(horizon).fill(last);
    return {
      fitted: y.slice(),
      level: y.slice(),
      trend: new Array(n).fill(0),
      seasonal: new Array(m).fill(0),
      forecast,
      upper: forecast.map(v => v * (1 + confPct)),
      lower: forecast.map(v => v * (1 - confPct)),
    };
  }

  // Initialise level, trend, seasonals
  let seasonals = initSeasonals(y, m);

  // Initial level = average of first season
  let l = y.slice(0, m).reduce((a, b) => a + b, 0) / m;

  // Initial trend = average difference between first two seasons
  let b = 0;
  if (n >= 2 * m) {
    const avg1 = y.slice(0, m).reduce((a, b) => a + b, 0) / m;
    const avg2 = y.slice(m, 2 * m).reduce((a, b) => a + b, 0) / m;
    b = (avg2 - avg1) / m;
  }

  const levels = [];
  const trends = [];
  const fitted = [];

  for (let t = 0; t < n; t++) {
    const s_prev = seasonals[((t - m) % m + m) % m];
    const l_prev = l;
    const b_prev = b;

    const yt = y[t];

    // Update level
    l = alpha * (yt - s_prev) + (1 - alpha) * (l_prev + b_prev);

    // Update trend
    b = beta * (l - l_prev) + (1 - beta) * b_prev;

    // Update seasonal
    seasonals[t % m] = gamma * (yt - l_prev - b_prev) + (1 - gamma) * s_prev;

    levels.push(l);
    trends.push(b);
    fitted.push(l + seasonals[t % m]);  // fitted = level + seasonal (no trend shift for in-sample)
  }

  // Generate forecasts
  const forecast = [];
  const upper = [];
  const lower = [];

  for (let k = 1; k <= horizon; k++) {
    const s_idx = ((n - m + ((k - 1) % m)) % m + m) % m;
    const fk = l + k * b + seasonals[s_idx];
    forecast.push(fk);
    upper.push(fk * (1 + confPct));
    lower.push(fk * (1 - confPct));
  }

  return { fitted, level: levels, trend: trends, seasonal: seasonals, forecast, upper, lower };
}

// ─── SEPARATE INFLOW / OUTFLOW FORECASTING ───────────────────────────────────

/**
 * Run Holt-Winters separately on inflows and outflows, then derive net forecast.
 *
 * @param {number[]} inflows  - historical daily inflow series
 * @param {number[]} outflows - historical daily outflow series
 * @param {object}   params   - { alpha, beta, gamma, horizon, m, confPct }
 * @returns {{
 *   inflowForecast: object,    // HW result for inflows
 *   outflowForecast: object,   // HW result for outflows
 *   netForecast: number[],     // inflow forecast − outflow forecast
 *   netUpper: number[],        // optimistic net (high inflow − low outflow)
 *   netLower: number[],        // pessimistic net (low inflow − high outflow)
 * }}
 */
export function forecastInflowOutflow(inflows, outflows, params = {}) {
  const {
    alpha = 0.3,
    beta = 0.1,
    gamma = 0.2,
    horizon = 90,
    m = 7,
    confPct = 0.15,
  } = params;

  const hwIn = holtWinters(inflows, alpha, beta, gamma, horizon, m, confPct);
  const hwOut = holtWinters(outflows, alpha, beta, gamma, horizon, m, confPct);

  const netForecast = [];
  const netUpper = [];
  const netLower = [];

  for (let i = 0; i < horizon; i++) {
    netForecast.push(hwIn.forecast[i] - hwOut.forecast[i]);
    netUpper.push(hwIn.upper[i] - hwOut.lower[i]);   // optimistic
    netLower.push(hwIn.lower[i] - hwOut.upper[i]);    // pessimistic
  }

  return { inflowForecast: hwIn, outflowForecast: hwOut, netForecast, netUpper, netLower };
}

// ─── ZERO-BALANCE DATE PROJECTION ────────────────────────────────────────────

/**
 * Scan a forecast balance series to find when balance first crosses zero.
 *
 * @param {number[]} forecastNetFlows - daily net flow forecasts
 * @param {number}   currentBalance   - starting balance
 * @param {string}   startDate        - ISO date string (day after last historical date)
 * @returns {{ daysUntilZero: number | null, zeroDate: string | null, projectedBalances: number[] }}
 */
export function projectZeroBalanceDate(forecastNetFlows, currentBalance, startDate) {
  let balance = currentBalance;
  const projectedBalances = [];
  let daysUntilZero = null;

  for (let i = 0; i < forecastNetFlows.length; i++) {
    balance += forecastNetFlows[i];
    projectedBalances.push(balance);

    if (balance <= 0 && daysUntilZero === null) {
      daysUntilZero = i + 1;
    }
  }

  let zeroDate = null;
  if (daysUntilZero !== null) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + daysUntilZero - 1);
    zeroDate = d.toISOString().slice(0, 10);
  }

  return { daysUntilZero, zeroDate, projectedBalances };
}

// ─── OUTLIER DETECTION ────────────────────────────────────────────────────────

/**
 * Moving Standard Deviation Outlier Detection.
 * Flags days where outflow > movingAvg + k * movingStd.
 *
 * @param {number[]} outflows  - daily outflow series
 * @param {number}   window    - lookback window in days (default 14)
 * @param {number}   kSigma    - threshold multiplier (default 2.0)
 *
 * @returns {{
 *   movingAvg:  number[],    // rolling mean at each index
 *   movingStd:  number[],    // rolling std at each index
 *   threshold:  number[],    // movingAvg + k*movingStd
 *   outlierIdx: number[],    // indices of detected outliers
 * }}
 */
export function detectOutliers(outflows, window = 14, kSigma = 2.0) {
  const n = outflows.length;
  const movingAvg = [];
  const movingStd = [];
  const threshold = [];
  const outlierIdx = [];

  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = outflows.slice(start, i + 1);

    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);

    const thr = mean + kSigma * std;

    movingAvg.push(mean);
    movingStd.push(std);
    threshold.push(thr);

    if (i >= window - 1 && outflows[i] > thr) {
      outlierIdx.push(i);
    }
  }

  return { movingAvg, movingStd, threshold, outlierIdx };
}

// ─── CUMULATIVE BALANCE ──────────────────────────────────────────────────────

/**
 * Compute running cash balance from daily net flows.
 * @param {number[]} netFlows     - daily (inflow - outflow)
 * @param {number}   startBalance - initial balance
 * @returns {number[]} balance at end of each day
 */
export function cumulativeBalance(netFlows, startBalance = 0) {
  let balance = startBalance;
  return netFlows.map(flow => {
    balance += flow;
    return balance;
  });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

/** Simple sum of an array */
export function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/** Format large Indian Rupee numbers readably */
export function fmtINR(val) {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Add `days` to a YYYY-MM-DD string */
export function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
