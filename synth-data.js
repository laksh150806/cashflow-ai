/**
 * synth-data.js
 * ─────────────
 * Synthetic MSME Transaction Engine
 *
 * Generates 12 months of daily transactions for 3 MSME profiles:
 *   1. Healthy Kirana Store — stable, low volatility
 *   2. High-Growth D2C Brand — strong upward trend, higher tickets
 *   3. Volatile Seasonal Trader — extreme swings, festival spikes, monsoon dips
 *
 * Each day record contains:
 *   - Inflows broken by channel (UPI, NEFT, Card)
 *   - Outflows broken by category (rent, salaries, suppliers, utilities, GST, refunds, logistics, misc)
 *   - Net flow, running balance
 *   - Transaction metadata (count, dominant channel)
 */

'use strict';

// ─── SEEDED PRNG (Mulberry32) ─────────────────────────────────────────────────
// Deterministic random so profiles are consistent across page reloads
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function gaussianRandom(rng) {
  // Box-Muller transform
  let u1 = rng(), u2 = rng();
  while (u1 === 0) u1 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function dateRange(startStr, endStr) {
  const dates = [];
  const d = new Date(startStr);
  const end = new Date(endStr);
  while (d <= end) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function fmtDate(d) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayOfWeek(d) { return d.getDay(); } // 0=Sun, 6=Sat
function monthIdx(d) { return d.getMonth(); } // 0=Jan
function dayOfMonth(d) { return d.getDate(); }
function daysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function isLastDayOfMonth(d) {
  return d.getDate() === daysInMonth(d);
}
function isQuarterEnd(d) {
  // GST filing months: end of Mar, Jun, Sep, Dec
  return isLastDayOfMonth(d) && [2, 5, 8, 11].includes(d.getMonth());
}

// ─── SEASONAL MULTIPLIER ─────────────────────────────────────────────────────

/**
 * Monthly seasonal multipliers for revenue.
 * Index 0 = January, 11 = December.
 */
const SEASONALITY = {
  kirana: [0.92, 0.88, 0.95, 0.90, 0.85, 0.82, 0.78, 0.80, 0.95, 1.30, 1.35, 1.15],
  d2c:    [0.85, 0.80, 0.90, 0.88, 0.92, 0.95, 0.88, 0.90, 1.00, 1.25, 1.40, 1.30],
  trader: [0.70, 0.65, 0.80, 0.85, 0.75, 0.60, 0.45, 0.50, 0.90, 1.55, 1.70, 1.20],
};

// ─── PROFILE CONFIGS ─────────────────────────────────────────────────────────

const PROFILES = {
  healthyKirana: {
    name: 'Rajesh General Store',
    sector: 'Kirana / Grocery Retail',
    label: 'Healthy Kirana',
    description: 'Stable neighborhood grocery store in Pune with 15+ years of operations. Consistent daily footfall, low volatility, strong supplier relationships.',
    seed: 42,
    startBalance: 850000,
    // Daily base revenue (before seasonality)
    baseRevenue: 28000,
    revenueStdDev: 4000,
    // Revenue growth: ~2% MoM
    monthlyGrowthRate: 0.02,
    // Weekend boost (Sat/Sun)
    weekendBoost: 0.35,
    // Channel split for inflows
    inflowSplit: { upi: 0.55, neft: 0.10, card: 0.35 },
    // Fixed monthly expenses
    rent: 35000,
    salaries: 95000, // 4 employees
    utilities: 12000,
    // Supplier cost as % of revenue
    supplierCostRatio: 0.62,
    // Refund rate
    refundRate: 0.015,
    // GST quarterly payment
    gstQuarterly: 45000,
    // Logistics/delivery
    logisticsDailyBase: 800,
    // Misc daily
    miscDailyBase: 500,
    // Late payment probability (supplier pays late)
    latePaymentProb: 0.03,
    // Seasonality key
    seasonKey: 'kirana',
  },

  highGrowthD2C: {
    name: 'UrbanCraft Wellness',
    sector: 'D2C / Health & Beauty',
    label: 'High-Growth D2C',
    description: 'Fast-growing Direct-to-Consumer health supplement brand based in Bangalore. Strong online presence, 8%+ MoM growth, higher average order value.',
    seed: 137,
    startBalance: 1200000,
    baseRevenue: 65000,
    revenueStdDev: 12000,
    monthlyGrowthRate: 0.085,
    weekendBoost: 0.18,
    inflowSplit: { upi: 0.30, neft: 0.15, card: 0.55 },
    rent: 85000,
    salaries: 320000, // 12 employees
    utilities: 25000,
    supplierCostRatio: 0.45,
    refundRate: 0.035,
    gstQuarterly: 180000,
    logisticsDailyBase: 5500,
    miscDailyBase: 2000,
    latePaymentProb: 0.06,
    seasonKey: 'd2c',
  },

  volatileTrader: {
    name: 'Gupta Spice Trading Co.',
    sector: 'Commodity Trading / Spices',
    label: 'Volatile Seasonal Trader',
    description: 'Seasonal spice trader in Kochi dealing in bulk cardamom and pepper. Revenue swings wildly with harvest cycles, festival demand, and monsoon disruptions.',
    seed: 271,
    startBalance: 500000,
    baseRevenue: 42000,
    revenueStdDev: 18000,
    monthlyGrowthRate: -0.01,
    weekendBoost: 0.08,
    inflowSplit: { upi: 0.25, neft: 0.50, card: 0.25 },
    rent: 28000,
    salaries: 140000, // 6 employees + seasonal labor
    utilities: 15000,
    supplierCostRatio: 0.70,
    refundRate: 0.025,
    gstQuarterly: 65000,
    logisticsDailyBase: 3200,
    miscDailyBase: 1500,
    latePaymentProb: 0.12,
    seasonKey: 'trader',
  },
};

// ─── GENERATOR ────────────────────────────────────────────────────────────────

/**
 * Generate 12 months of synthetic MSME transactions.
 *
 * @param {string} profileKey — one of 'healthyKirana', 'highGrowthD2C', 'volatileTrader'
 * @returns {{
 *   profile: object,
 *   days: Array<{
 *     date: string,
 *     inflows: { upi: number, neft: number, card: number, total: number },
 *     outflows: { rent: number, salaries: number, suppliers: number, utilities: number,
 *                 gst: number, refunds: number, logistics: number, misc: number, total: number },
 *     netFlow: number,
 *     balance: number,
 *     txCount: number,
 *     flags: string[]
 *   }>
 * }}
 */
export function generateProfile(profileKey) {
  const cfg = PROFILES[profileKey];
  if (!cfg) throw new Error(`Unknown profile: ${profileKey}`);

  const rng = mulberry32(cfg.seed);
  const seasonal = SEASONALITY[cfg.seasonKey];
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 365);
  const dates = dateRange(fmtDate(startDate), fmtDate(endDate));

  let balance = cfg.startBalance;
  const days = [];

  // Track monthly revenue for growth calculation
  let cumulativeGrowth = 1.0;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const month = monthIdx(d);
    const dom = dayOfMonth(d);
    const dow = dayOfWeek(d);
    const flags = [];

    // ── Growth factor (compounds monthly) ────────────────
    if (i > 0 && dom === 1) {
      cumulativeGrowth *= (1 + cfg.monthlyGrowthRate);
    }

    // ── INFLOWS ──────────────────────────────────────────
    // Base revenue with noise
    let dayRevenue = cfg.baseRevenue + gaussianRandom(rng) * cfg.revenueStdDev;
    dayRevenue = Math.max(dayRevenue * 0.1, dayRevenue); // floor at 10% of base

    // Apply growth
    dayRevenue *= cumulativeGrowth;

    // Apply seasonality
    dayRevenue *= seasonal[month];

    // Weekend boost
    if (dow === 0 || dow === 6) {
      dayRevenue *= (1 + cfg.weekendBoost);
      if (cfg.weekendBoost > 0.2) flags.push('weekend_spike');
    }

    // Festival boost (Diwali week: ~Oct 25 – Nov 5)
    if ((month === 9 && dom >= 25) || (month === 10 && dom <= 5)) {
      dayRevenue *= 1.6 + rng() * 0.4; // 60–100% boost
      flags.push('festival_diwali');
    }

    // Holi boost (mid-March)
    if (month === 2 && dom >= 12 && dom <= 18) {
      dayRevenue *= 1.2 + rng() * 0.2;
      flags.push('festival_holi');
    }

    // Late payment simulation (some days have delayed receivables = zero inflow)
    if (rng() < cfg.latePaymentProb) {
      dayRevenue *= 0.1; // 90% reduction
      flags.push('late_receivable');
    }

    dayRevenue = Math.round(dayRevenue);

    // Split into channels
    const inflowUPI = Math.round(dayRevenue * cfg.inflowSplit.upi * (0.9 + rng() * 0.2));
    const inflowNEFT = Math.round(dayRevenue * cfg.inflowSplit.neft * (0.85 + rng() * 0.3));
    const inflowCard = Math.max(0, dayRevenue - inflowUPI - inflowNEFT);
    const totalInflow = inflowUPI + inflowNEFT + inflowCard;

    // ── OUTFLOWS ─────────────────────────────────────────

    // Rent: 1st of each month
    const rent = (dom === 1) ? cfg.rent : 0;

    // Salaries: last day of month
    const salaries = isLastDayOfMonth(d) ? cfg.salaries : 0;

    // Utilities: 15th of each month
    const utilities = (dom === 15) ? cfg.utilities : 0;

    // GST: quarterly end
    const gst = isQuarterEnd(d) ? cfg.gstQuarterly : 0;

    // Supplier payments: daily, proportional to revenue with 3-day lag
    const laggedRevenue = (i >= 3) ? (days[i - 3]?.inflows?.total ?? dayRevenue) : dayRevenue;
    let suppliers = Math.round(laggedRevenue * cfg.supplierCostRatio * (0.8 + rng() * 0.4));

    // Occasional bulk supplier payment (1st and 15th)
    if (dom === 1 || dom === 15) {
      suppliers += Math.round(cfg.baseRevenue * cfg.supplierCostRatio * 3 * (0.5 + rng() * 0.5));
    }

    // Refunds
    let refunds = Math.round(totalInflow * cfg.refundRate * (0.5 + rng() * 1.0));
    // Occasional refund spike (bad batch, returns)
    if (rng() < 0.02) {
      refunds = Math.round(totalInflow * 0.12); // 12% refund day
      flags.push('refund_spike');
    }

    // Logistics
    const logistics = Math.round(cfg.logisticsDailyBase * (0.7 + rng() * 0.6) * cumulativeGrowth);

    // Misc
    const misc = Math.round(cfg.miscDailyBase * (0.5 + rng() * 1.0));

    const totalOutflow = rent + salaries + utilities + gst + suppliers + refunds + logistics + misc;

    // ── NET & BALANCE ────────────────────────────────────
    const netFlow = totalInflow - totalOutflow;
    balance += netFlow;

    // Flag if balance drops dangerously
    if (balance < cfg.startBalance * 0.1) {
      flags.push('low_balance');
    }

    // Estimate transaction count
    const txCount = Math.round(
      (inflowUPI / 500) * (0.6 + rng() * 0.8) +
      (inflowNEFT > 0 ? 1 + Math.floor(rng() * 3) : 0) +
      (inflowCard / 1200) * (0.5 + rng() * 1.0) +
      (rent > 0 ? 1 : 0) +
      (salaries > 0 ? Math.ceil(cfg.salaries / 25000) : 0) +
      (gst > 0 ? 1 : 0) +
      (suppliers > 0 ? Math.ceil(suppliers / 10000) : 0) +
      (refunds > 0 ? Math.ceil(refunds / 2000) : 0)
    );

    days.push({
      date: fmtDate(d),
      inflows: {
        upi: inflowUPI,
        neft: inflowNEFT,
        card: inflowCard,
        total: totalInflow,
      },
      outflows: {
        rent,
        salaries,
        suppliers,
        utilities,
        gst,
        refunds,
        logistics,
        misc,
        total: totalOutflow,
      },
      netFlow,
      balance: Math.round(balance),
      txCount: Math.max(1, txCount),
      flags,
    });
  }

  return {
    profile: {
      key: profileKey,
      name: cfg.name,
      sector: cfg.sector,
      label: cfg.label,
      description: cfg.description,
      startBalance: cfg.startBalance,
      rent: cfg.rent,
      salaries: cfg.salaries,
      utilities: cfg.utilities,
      gstQuarterly: cfg.gstQuarterly,
    },
    days,
  };
}

/**
 * Get all available profile keys.
 */
export function getProfileKeys() {
  return Object.keys(PROFILES);
}

/**
 * Get profile metadata without generating data.
 */
export function getProfileMeta(key) {
  const cfg = PROFILES[key];
  if (!cfg) return null;
  return {
    key,
    name: cfg.name,
    sector: cfg.sector,
    label: cfg.label,
    description: cfg.description,
  };
}

/**
 * Generate all profiles at once.
 */
export function generateAllProfiles() {
  const result = {};
  for (const key of Object.keys(PROFILES)) {
    result[key] = generateProfile(key);
  }
  return result;
}
