/**
 * warning-engine.js
 * ─────────────────
 * Early-Warning Engine for MSME Cash Flow Health
 *
 * Features:
 *   1. Zero-balance date projection with severity classification
 *   2. Upcoming obligation overlap detection (rent + GST + salary clusters)
 *   3. Actionable mitigation suggestions
 *   4. Burn rate and runway calculations
 */

'use strict';

import { projectZeroBalanceDate } from './forecasting.js';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtINR(val) {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ─── MAIN WARNING ENGINE ─────────────────────────────────────────────────────

/**
 * Run the full early-warning analysis.
 *
 * @param {object[]} days               - historical daily records from synth-data
 * @param {number[]} forecastNetFlows   - forecasted daily net flows
 * @param {number}   currentBalance     - current cash balance
 * @param {string}   lastDate           - last historical date (ISO)
 * @param {object}   profile            - profile metadata (rent, salaries, gstQuarterly, etc.)
 * @returns {{
 *   warnings: Array<{ severity: 'critical' | 'warning' | 'info', icon: string, title: string, message: string, daysUntil: number | null }>,
 *   mitigations: Array<{ icon: string, title: string, description: string, impact: string }>,
 *   metrics: { burnRate: number, runway: number, avgCollectionPeriod: number, runRate30d: number }
 * }}
 */
export function runWarningEngine(days, forecastNetFlows, currentBalance, lastDate, profile) {
  const warnings = [];
  const mitigations = [];

  // ── Calculate key metrics ──────────────────────────────
  const last30 = days.slice(-30);
  const last90 = days.slice(-90);

  const dailyOutflow30 = mean(last30.map(d => d.outflows.total));
  const dailyInflow30 = mean(last30.map(d => d.inflows.total));
  const burnRate = dailyOutflow30;
  const runway = burnRate > 0 ? currentBalance / burnRate : 999;

  // 30-day run rate (projected end balance)
  const netFlow30 = mean(last30.map(d => d.netFlow));
  const runRate30d = currentBalance + netFlow30 * 30;

  // Average collection period (simplistic: days receivables outstanding)
  // Estimated as (avg daily balance / avg daily inflow) — proxy metric
  const avgBalance = mean(last30.map(d => d.balance));
  const avgCollectionPeriod = dailyInflow30 > 0 ? (avgBalance * 0.3) / dailyInflow30 : 0;

  const metrics = {
    burnRate: Math.round(burnRate),
    runway: Math.round(runway * 10) / 10,
    avgCollectionPeriod: Math.round(avgCollectionPeriod * 10) / 10,
    runRate30d: Math.round(runRate30d),
  };

  // ── 1. Zero-Balance Projection ─────────────────────────
  const startDate = new Date(lastDate);
  startDate.setDate(startDate.getDate() + 1);
  const startDateStr = startDate.toISOString().slice(0, 10);

  const zeroProj = projectZeroBalanceDate(forecastNetFlows, currentBalance, startDateStr);

  if (zeroProj.daysUntilZero !== null) {
    if (zeroProj.daysUntilZero <= 14) {
      warnings.push({
        severity: 'critical',
        icon: '🚨',
        title: `Cash crunch in ${zeroProj.daysUntilZero} days`,
        message: `Balance projected to hit zero by ${zeroProj.zeroDate}. Current balance: ${fmtINR(currentBalance)}, daily burn: ${fmtINR(burnRate)}.`,
        daysUntil: zeroProj.daysUntilZero,
      });
    } else if (zeroProj.daysUntilZero <= 30) {
      warnings.push({
        severity: 'warning',
        icon: '⚠️',
        title: `Cash crunch predicted in ${zeroProj.daysUntilZero} days`,
        message: `At current trajectory, balance depletes by ${zeroProj.zeroDate}. Proactive measures recommended.`,
        daysUntil: zeroProj.daysUntilZero,
      });
    } else if (zeroProj.daysUntilZero <= 60) {
      warnings.push({
        severity: 'info',
        icon: 'ℹ️',
        title: `Runway of ${zeroProj.daysUntilZero} days remaining`,
        message: `Balance projected to deplete by ${zeroProj.zeroDate}. Monitor closely and plan ahead.`,
        daysUntil: zeroProj.daysUntilZero,
      });
    }
  }

  // ── 2. Upcoming Obligation Overlap ─────────────────────
  // Check if rent + salaries + GST cluster within a 5-day window in next 30 days
  const upcomingFixedCosts = [];
  const today = new Date(lastDate);

  for (let i = 1; i <= 30; i++) {
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + i);
    const dom = futureDate.getDate();
    const month = futureDate.getMonth();
    const daysInMo = new Date(futureDate.getFullYear(), month + 1, 0).getDate();
    const isLastDay = dom === daysInMo;
    const isQuarterEnd = isLastDay && [2, 5, 8, 11].includes(month);

    let cost = 0;
    const components = [];

    if (dom === 1) {
      cost += profile.rent || 0;
      components.push('Rent');
    }
    if (isLastDay) {
      cost += profile.salaries || 0;
      components.push('Salaries');
    }
    if (isQuarterEnd) {
      cost += profile.gstQuarterly || 0;
      components.push('GST');
    }
    if (dom === 15) {
      cost += profile.utilities || 0;
      components.push('Utilities');
    }

    if (cost > 0) {
      upcomingFixedCosts.push({
        date: futureDate.toISOString().slice(0, 10),
        daysAway: i,
        cost,
        components,
      });
    }
  }

  // Find clusters (multiple obligations within 5 days)
  for (let i = 0; i < upcomingFixedCosts.length; i++) {
    const cluster = [upcomingFixedCosts[i]];
    for (let j = i + 1; j < upcomingFixedCosts.length; j++) {
      if (upcomingFixedCosts[j].daysAway - upcomingFixedCosts[i].daysAway <= 5) {
        cluster.push(upcomingFixedCosts[j]);
      }
    }
    if (cluster.length >= 2) {
      const totalCluster = cluster.reduce((s, c) => s + c.cost, 0);
      const allComponents = [...new Set(cluster.flatMap(c => c.components))];

      if (totalCluster > currentBalance * 0.3) {
        warnings.push({
          severity: 'warning',
          icon: '📅',
          title: `${allComponents.join(' + ')} overlap in ${cluster[0].daysAway} days`,
          message: `${fmtINR(totalCluster)} in fixed obligations clustered between ${cluster[0].date} and ${cluster[cluster.length - 1].date}. This represents ${Math.round(totalCluster / currentBalance * 100)}% of current balance.`,
          daysUntil: cluster[0].daysAway,
        });
      }
      break; // Only report the nearest cluster
    }
  }

  // ── 3. High Burn Rate Warning ──────────────────────────
  if (burnRate > dailyInflow30 * 1.1) {
    warnings.push({
      severity: 'warning',
      icon: '🔥',
      title: 'Burn rate exceeds revenue',
      message: `Daily expenses (${fmtINR(burnRate)}) exceed daily revenue (${fmtINR(dailyInflow30)}) by ${Math.round((burnRate / dailyInflow30 - 1) * 100)}%. Cash reserves depleting.`,
      daysUntil: null,
    });
  }

  // ── 4. Declining Revenue Trend ─────────────────────────
  const monthlyRevs = {};
  last90.forEach(d => {
    const m = d.date.slice(0, 7);
    monthlyRevs[m] = (monthlyRevs[m] || 0) + d.inflows.total;
  });
  const mRevArr = Object.values(monthlyRevs);
  if (mRevArr.length >= 3) {
    const declining = mRevArr[mRevArr.length - 1] < mRevArr[mRevArr.length - 2] &&
                      mRevArr[mRevArr.length - 2] < mRevArr[mRevArr.length - 3];
    if (declining) {
      warnings.push({
        severity: 'warning',
        icon: '📉',
        title: 'Revenue declining 3+ consecutive months',
        message: `Monthly revenue has decreased for 3 consecutive months. Consider diversifying revenue channels or adjusting pricing.`,
        daysUntil: null,
      });
    }
  }

  // ── 5. Generate Mitigations ────────────────────────────
  if (zeroProj.daysUntilZero !== null && zeroProj.daysUntilZero <= 30) {
    const invoiceAmount = Math.round(dailyInflow30 * 15 / 10000) * 10000;
    mitigations.push({
      icon: '📄',
      title: 'Invoice Discounting',
      description: `Apply for ${fmtINR(invoiceAmount)} invoice discounting to unlock receivables immediately.`,
      impact: `+${fmtINR(invoiceAmount)} liquidity within 48 hours`,
    });

    mitigations.push({
      icon: '🤝',
      title: 'Extend Vendor Credit Terms',
      description: `Request 15-day credit extension from top 3 suppliers to defer ${fmtINR(Math.round(dailyOutflow30 * 0.6 * 15))} in payables.`,
      impact: `+15 days runway`,
    });
  }

  if (burnRate > dailyInflow30) {
    mitigations.push({
      icon: '✂️',
      title: 'Reduce Discretionary Spending',
      description: `Cut non-essential expenses by 20% to save ${fmtINR(Math.round(burnRate * 0.2 * 30))}/month.`,
      impact: `Extends runway by ${Math.round(currentBalance * 0.2 / burnRate)} days`,
    });
  }

  if (avgCollectionPeriod > 15) {
    mitigations.push({
      icon: '⚡',
      title: 'Accelerate Collections',
      description: `Reduce average collection period from ${Math.round(avgCollectionPeriod)} days to 7 days through early payment incentives.`,
      impact: `+${fmtINR(Math.round(dailyInflow30 * (avgCollectionPeriod - 7)))} freed working capital`,
    });
  }

  // Always suggest WCL for moderate/high risk
  const monthlyInflow = dailyInflow30 * 30;
  if (runway < 60) {
    mitigations.push({
      icon: '🏦',
      title: 'Working Capital Line',
      description: `Apply for ${fmtINR(Math.round(monthlyInflow * 2 / 100000) * 100000)} working capital facility at competitive rates.`,
      impact: `Safety net for cash flow gaps`,
    });
  }

  // Sort warnings by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  warnings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return { warnings, mitigations, metrics };
}

// ─── SCENARIO SIMULATION ─────────────────────────────────────────────────────

/**
 * Apply scenario adjustments to forecast net flows.
 *
 * @param {number[]} baseInflowForecast  - base inflow forecasts
 * @param {number[]} baseOutflowForecast - base outflow forecasts
 * @param {object}   scenario - {
 *   receivablesDelayPct: number (0-100),   // % of receivables delayed
 *   receivablesDelayDays: number,           // delay in days
 *   revenueChangePct: number (-100 to 100), // % change in revenue
 *   emergencyExpense: number                // one-time expense amount
 * }
 * @returns {{ adjustedNet: number[], adjustedInflows: number[], adjustedOutflows: number[] }}
 */
export function applyScenario(baseInflowForecast, baseOutflowForecast, scenario = {}) {
  const {
    receivablesDelayPct = 0,
    receivablesDelayDays = 0,
    revenueChangePct = 0,
    emergencyExpense = 0,
  } = scenario;

  const n = baseInflowForecast.length;
  const adjustedInflows = [...baseInflowForecast];
  const adjustedOutflows = [...baseOutflowForecast];

  // 1. Revenue change
  if (revenueChangePct !== 0) {
    const factor = 1 + revenueChangePct / 100;
    for (let i = 0; i < n; i++) {
      adjustedInflows[i] *= factor;
    }
  }

  // 2. Receivables delay: X% of inflows are shifted forward by Y days
  if (receivablesDelayPct > 0 && receivablesDelayDays > 0) {
    const delayFraction = receivablesDelayPct / 100;
    const delayed = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const delayedAmount = adjustedInflows[i] * delayFraction;
      adjustedInflows[i] -= delayedAmount;

      const targetDay = i + receivablesDelayDays;
      if (targetDay < n) {
        delayed[targetDay] += delayedAmount;
      }
      // else: falls off the forecast window (worst case)
    }

    for (let i = 0; i < n; i++) {
      adjustedInflows[i] += delayed[i];
    }
  }

  // 3. Emergency expense: one-time hit on day 15 (mid-month)
  if (emergencyExpense > 0 && n > 15) {
    adjustedOutflows[14] += emergencyExpense;
  }

  // Net
  const adjustedNet = [];
  for (let i = 0; i < n; i++) {
    adjustedNet.push(adjustedInflows[i] - adjustedOutflows[i]);
  }

  return { adjustedNet, adjustedInflows, adjustedOutflows };
}
