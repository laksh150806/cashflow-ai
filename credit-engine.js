/**
 * credit-engine.js
 * ────────────────
 * MSME Credit Scoring Engine (0–100)
 *
 * 4 equally-weighted pillars (25 pts each):
 *   1. Debt Service Coverage Ratio (DSCR)
 *   2. Cash Volatility Index (CVI)
 *   3. Revenue Trend Velocity
 *   4. Liquidity Buffer Ratio
 *
 * Also provides:
 *   - Explainability matrix (human-readable deduction reasons)
 *   - Risk tier classification (Low / Moderate / High)
 *   - Loan pre-approval recommendation
 */

'use strict';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function fmtINR(val) {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

// ─── PILLAR 1: DEBT SERVICE COVERAGE RATIO ───────────────────────────────────

/**
 * DSCR = Net Operating Cash Inflow / Fixed Mandatory Outflows
 * Uses last 90 days of data.
 *
 * @param {object[]} days — daily records from synth-data
 * @returns {{ score: number, value: number, maxScore: number, explanation: string }}
 */
function scoreDSCR(days) {
  const last90 = days.slice(-90);

  const totalInflow = last90.reduce((s, d) => s + d.inflows.total, 0);
  const totalFixed = last90.reduce((s, d) =>
    s + d.outflows.rent + d.outflows.salaries + d.outflows.utilities, 0
  );

  const dscr = totalFixed > 0 ? totalInflow / totalFixed : 10;
  const dscrRound = Math.round(dscr * 100) / 100;

  let score, explanation;

  if (dscr >= 2.0) {
    score = 25;
    explanation = `DSCR of ${dscrRound}x is strong — net inflows comfortably cover ${fmtINR(totalFixed)} in fixed obligations.`;
  } else if (dscr >= 1.5) {
    score = 20;
    explanation = `DSCR of ${dscrRound}x is adequate but has limited headroom above the 1.5x safety threshold.`;
  } else if (dscr >= 1.0) {
    score = 12;
    const pctConsumed = Math.round((1 / dscr) * 100);
    explanation = `-13 pts: DSCR of ${dscrRound}x is below the 1.5x safe threshold — fixed costs consume ${pctConsumed}% of net inflows.`;
  } else {
    score = 5;
    explanation = `-20 pts: Critical DSCR of ${dscrRound}x — fixed obligations exceed net operating cash inflow. Debt servicing at risk.`;
  }

  return { score, value: dscrRound, maxScore: 25, explanation, label: 'Debt Service Coverage', category: 'repayment' };
}

// ─── PILLAR 2: CASH VOLATILITY INDEX ─────────────────────────────────────────

/**
 * CVI = σ(daily_balance) / μ(daily_balance) over last 90 days.
 * Lower is better (more stable cash position).
 *
 * @param {object[]} days
 * @returns {{ score: number, value: number, maxScore: number, explanation: string }}
 */
function scoreCVI(days) {
  const last90 = days.slice(-90);
  const balances = last90.map(d => d.balance);

  const avg = mean(balances);
  const sd = stdDev(balances);
  const cvi = avg !== 0 ? Math.abs(sd / avg) : 1;
  const cviRound = Math.round(cvi * 1000) / 1000;

  let score, explanation;

  if (cvi <= 0.15) {
    score = 25;
    explanation = `Cash Volatility Index of ${cviRound} indicates exceptionally stable working capital over the last 90 days.`;
  } else if (cvi <= 0.30) {
    score = 20;
    explanation = `Cash Volatility Index of ${cviRound} shows moderate balance fluctuation — within acceptable bounds.`;
  } else if (cvi <= 0.50) {
    score = 12;
    explanation = `-13 pts: High working capital volatility (CV ${cviRound}) in last 90 days — daily balance swings ${fmtINR(sd)} around ${fmtINR(avg)} average.`;
  } else {
    score = 5;
    explanation = `-20 pts: Extreme cash position volatility (CV ${cviRound}) — balance swings of ${fmtINR(sd)} create significant operational risk.`;
  }

  return { score, value: cviRound, maxScore: 25, explanation, label: 'Cash Volatility Index', category: 'stability' };
}

// ─── PILLAR 3: REVENUE TREND VELOCITY ────────────────────────────────────────

/**
 * Average month-over-month revenue growth over last 6 months.
 *
 * @param {object[]} days
 * @returns {{ score: number, value: number, maxScore: number, explanation: string }}
 */
function scoreRevenueTrend(days) {
  // Group by month
  const monthlyRev = {};
  days.forEach(d => {
    const m = d.date.slice(0, 7); // YYYY-MM
    monthlyRev[m] = (monthlyRev[m] || 0) + d.inflows.total;
  });

  const months = Object.keys(monthlyRev).sort();
  if (months.length < 2) {
    return { score: 15, value: 0, maxScore: 25, explanation: 'Insufficient data to calculate revenue trend.', label: 'Revenue Trend Velocity', category: 'liquidity' };
  }

  // Calculate MoM growth rates for last 6 months
  const recentMonths = months.slice(-7); // need 7 to get 6 growth rates
  const growthRates = [];
  for (let i = 1; i < recentMonths.length; i++) {
    const prev = monthlyRev[recentMonths[i - 1]];
    const curr = monthlyRev[recentMonths[i]];
    if (prev > 0) {
      growthRates.push((curr - prev) / prev);
    }
  }

  const avgGrowth = growthRates.length > 0 ? mean(growthRates) : 0;
  const avgGrowthPct = Math.round(avgGrowth * 1000) / 10; // e.g., 8.5%

  let score, explanation;

  if (avgGrowth >= 0.08) {
    score = 25;
    explanation = `Revenue growing at ${avgGrowthPct}% MoM average — strong upward trajectory over the last ${growthRates.length} months.`;
  } else if (avgGrowth >= 0.03) {
    score = 20;
    explanation = `Steady revenue growth at ${avgGrowthPct}% MoM — positive but below the 8% high-growth threshold.`;
  } else if (avgGrowth >= 0) {
    score = 15;
    explanation = `-10 pts: Flat revenue trend at ${avgGrowthPct}% MoM — growth has stagnated. Consider revenue diversification.`;
  } else {
    score = 5;
    explanation = `-20 pts: Revenue declining at ${avgGrowthPct}% MoM over ${growthRates.length} months — sustained negative trajectory signals business contraction.`;
  }

  return { score, value: avgGrowthPct, maxScore: 25, explanation, label: 'Revenue Trend Velocity', category: 'liquidity' };
}

// ─── PILLAR 4: LIQUIDITY BUFFER RATIO ────────────────────────────────────────

/**
 * LBR = Average Daily Balance / Daily Operating Expense Rate
 * Measured as "days of runway" the business can sustain.
 *
 * @param {object[]} days
 * @returns {{ score: number, value: number, maxScore: number, explanation: string }}
 */
function scoreLiquidityBuffer(days) {
  const last90 = days.slice(-90);
  const avgBalance = mean(last90.map(d => d.balance));
  const totalOpex = last90.reduce((s, d) => s + d.outflows.total, 0);
  const dailyOpex = totalOpex / 90;

  const bufferDays = dailyOpex > 0 ? avgBalance / dailyOpex : 999;
  const bufferRound = Math.round(bufferDays * 10) / 10;

  let score, explanation;

  if (bufferDays >= 60) {
    score = 25;
    explanation = `Liquidity buffer of ${bufferRound} days — business can sustain ${Math.round(bufferDays / 30)} months of operations without any inflow.`;
  } else if (bufferDays >= 30) {
    score = 20;
    explanation = `Liquidity buffer of ${bufferRound} days provides ~1 month runway — adequate but limited margin for disruptions.`;
  } else if (bufferDays >= 15) {
    score = 12;
    explanation = `-13 pts: Only ${bufferRound} days of liquidity buffer — a 2-week revenue disruption could trigger a cash crunch.`;
  } else {
    score = 5;
    const dailyFmt = fmtINR(dailyOpex);
    explanation = `-20 pts: Critical liquidity — only ${bufferRound} days of runway at ${dailyFmt}/day burn rate. Immediate working capital injection needed.`;
  }

  return { score, value: bufferRound, maxScore: 25, explanation, label: 'Liquidity Buffer Ratio', category: 'stability' };
}

// ─── AGGREGATE SCORING ───────────────────────────────────────────────────────

/**
 * Compute the full 0–100 credit score with all pillars and explainability.
 *
 * @param {object[]} days — daily records from synth-data
 * @param {object}   profile — profile metadata
 * @returns {{
 *   totalScore: number,
 *   tier: 'low' | 'moderate' | 'high',
 *   tierLabel: string,
 *   pillars: Array<{ label: string, score: number, maxScore: number, value: any, explanation: string, category: string }>,
 *   deductions: Array<{ points: number, reason: string }>,
 *   loanRecommendation: object | null
 * }}
 */
export function computeCreditScore(days, profile) {
  const pillars = [
    scoreDSCR(days),
    scoreCVI(days),
    scoreRevenueTrend(days),
    scoreLiquidityBuffer(days),
  ];

  const totalScore = pillars.reduce((s, p) => s + p.score, 0);

  // Risk tier
  let tier, tierLabel;
  if (totalScore >= 75) {
    tier = 'low';
    tierLabel = 'Low Risk';
  } else if (totalScore >= 50) {
    tier = 'moderate';
    tierLabel = 'Moderate Risk';
  } else {
    tier = 'high';
    tierLabel = 'High Risk';
  }

  // Deductions (pillars that lost points)
  const deductions = pillars
    .filter(p => p.score < p.maxScore)
    .map(p => ({
      points: p.maxScore - p.score,
      reason: p.explanation,
      category: p.category,
    }))
    .sort((a, b) => b.points - a.points);

  // Loan recommendation
  const loanRecommendation = computeLoanRecommendation(days, totalScore, tier, profile);

  return {
    totalScore,
    tier,
    tierLabel,
    pillars,
    deductions,
    loanRecommendation,
  };
}

// ─── LOAN PRE-APPROVAL ENGINE ────────────────────────────────────────────────

function computeLoanRecommendation(days, score, tier, profile) {
  const last90 = days.slice(-90);
  const monthlyInflow = last90.reduce((s, d) => s + d.inflows.total, 0) / 3;

  if (tier === 'high') {
    return {
      eligible: false,
      reason: 'Credit score below threshold for pre-approval. Recommended: Build 3 months of positive cash flow history.',
      suggestedAction: 'Improve cash flow stability and re-apply in 90 days.',
    };
  }

  // Loan sizing: based on monthly inflow and score
  let multiplier, interestRate, tenureMonths, product;

  if (tier === 'low') {
    multiplier = 3.0; // 3x monthly inflow
    interestRate = 12.5;
    tenureMonths = 24;
    product = 'Working Capital Line of Credit';
  } else {
    multiplier = 1.5;
    interestRate = 16.0;
    tenureMonths = 12;
    product = 'Short-Term Working Capital Loan';
  }

  const amount = Math.round(monthlyInflow * multiplier / 10000) * 10000; // round to nearest 10K
  const monthlyRate = interestRate / 100 / 12;
  const emi = Math.round(amount * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths) /
    (Math.pow(1 + monthlyRate, tenureMonths) - 1));

  return {
    eligible: true,
    product,
    amount,
    interestRate,
    tenureMonths,
    emi,
    reason: `Based on ${fmtINR(monthlyInflow)} avg monthly inflow and credit score of ${score}/100.`,
    conditions: [
      'Maintain minimum monthly balance of ' + fmtINR(amount * 0.1),
      'No negative balance days in next 90 days',
      'Continue UPI/digital transaction volume',
    ],
  };
}

// ─── RISK CATEGORY BREAKDOWN (Razorpay Shield Style) ─────────────────────────

/**
 * Maps the 4 pillars into Razorpay Shield-style risk categories.
 *
 * @param {{ pillars: object[], totalScore: number }} scoreResult
 * @param {object[]} days
 * @returns {Array<{ category: string, icon: string, status: string, statusColor: string, items: Array<{ label: string, value: string, status: string }> }>}
 */
export function computeRiskBreakdown(scoreResult, days) {
  const last90 = days.slice(-90);
  const last30 = days.slice(-30);

  // ── Liquidity ──
  const dscr = scoreResult.pillars[0];
  const buffer = scoreResult.pillars[3];
  const liquidityScore = dscr.score + buffer.score;
  const liquidityStatus = liquidityScore >= 40 ? 'pass' : liquidityScore >= 25 ? 'warn' : 'fail';

  // ── Operational Stability ──
  const cvi = scoreResult.pillars[1];
  const burnRate = mean(last30.map(d => d.outflows.total));
  const avgRevenue30 = mean(last30.map(d => d.inflows.total));
  const burnRatio = avgRevenue30 > 0 ? burnRate / avgRevenue30 : 1;
  const stabilityScore = cvi.score + (burnRatio < 0.8 ? 15 : burnRatio < 1.0 ? 10 : 5);
  const stabilityStatus = stabilityScore >= 30 ? 'pass' : stabilityScore >= 20 ? 'warn' : 'fail';

  // ── Customer Concentration ──
  // Assess by channel diversity (UPI vs NEFT vs Card spread)
  const totalByChannel = { upi: 0, neft: 0, card: 0 };
  last90.forEach(d => {
    totalByChannel.upi += d.inflows.upi;
    totalByChannel.neft += d.inflows.neft;
    totalByChannel.card += d.inflows.card;
  });
  const channelTotal = totalByChannel.upi + totalByChannel.neft + totalByChannel.card;
  const maxChannelShare = Math.max(
    totalByChannel.upi / channelTotal,
    totalByChannel.neft / channelTotal,
    totalByChannel.card / channelTotal
  );
  const concentrationStatus = maxChannelShare < 0.5 ? 'pass' : maxChannelShare < 0.7 ? 'warn' : 'fail';

  // ── Repayment Reliability ──
  const trend = scoreResult.pillars[2];
  const latePaymentDays = days.filter(d => d.flags.includes('late_receivable')).length;
  const latePaymentRate = latePaymentDays / days.length;
  const repaymentScore = trend.score + (latePaymentRate < 0.05 ? 15 : latePaymentRate < 0.10 ? 10 : 5);
  const repaymentStatus = repaymentScore >= 30 ? 'pass' : repaymentScore >= 20 ? 'warn' : 'fail';

  return [
    {
      category: 'Liquidity',
      icon: '💧',
      status: liquidityStatus,
      statusLabel: liquidityStatus === 'pass' ? 'Healthy' : liquidityStatus === 'warn' ? 'Moderate' : 'At Risk',
      items: [
        { label: 'Debt Service Coverage', value: `${dscr.value}x`, status: dscr.score >= 20 ? 'pass' : dscr.score >= 12 ? 'warn' : 'fail' },
        { label: 'Liquidity Buffer', value: `${buffer.value} days`, status: buffer.score >= 20 ? 'pass' : buffer.score >= 12 ? 'warn' : 'fail' },
      ],
    },
    {
      category: 'Operational Stability',
      icon: '⚙️',
      status: stabilityStatus,
      statusLabel: stabilityStatus === 'pass' ? 'Stable' : stabilityStatus === 'warn' ? 'Moderate' : 'Unstable',
      items: [
        { label: 'Cash Volatility', value: `CV ${cvi.value}`, status: cvi.score >= 20 ? 'pass' : cvi.score >= 12 ? 'warn' : 'fail' },
        { label: 'Burn Ratio', value: `${Math.round(burnRatio * 100)}%`, status: burnRatio < 0.8 ? 'pass' : burnRatio < 1.0 ? 'warn' : 'fail' },
      ],
    },
    {
      category: 'Revenue Diversification',
      icon: '🎯',
      status: concentrationStatus,
      statusLabel: concentrationStatus === 'pass' ? 'Diversified' : concentrationStatus === 'warn' ? 'Concentrated' : 'High Risk',
      items: [
        { label: 'UPI Share', value: `${Math.round(totalByChannel.upi / channelTotal * 100)}%`, status: totalByChannel.upi / channelTotal < 0.6 ? 'pass' : 'warn' },
        { label: 'NEFT Share', value: `${Math.round(totalByChannel.neft / channelTotal * 100)}%`, status: 'neutral' },
        { label: 'Card Share', value: `${Math.round(totalByChannel.card / channelTotal * 100)}%`, status: totalByChannel.card / channelTotal < 0.6 ? 'pass' : 'warn' },
      ],
    },
    {
      category: 'Repayment Reliability',
      icon: '🔁',
      status: repaymentStatus,
      statusLabel: repaymentStatus === 'pass' ? 'Reliable' : repaymentStatus === 'warn' ? 'Moderate' : 'Unreliable',
      items: [
        { label: 'Revenue Trend', value: `${trend.value}% MoM`, status: trend.score >= 20 ? 'pass' : trend.score >= 15 ? 'warn' : 'fail' },
        { label: 'Late Receivables', value: `${Math.round(latePaymentRate * 100)}% of days`, status: latePaymentRate < 0.05 ? 'pass' : latePaymentRate < 0.10 ? 'warn' : 'fail' },
      ],
    },
  ];
}
