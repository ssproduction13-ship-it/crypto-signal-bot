/**
 * Statistical Significance Engine — проверяет изменения стратегий статистически.
 * Не допускает внедрения случайных улучшений.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface SignificanceTest {
  metricName: string;
  baselineValue: number;
  newValue: number;
  delta: number;
  deltaPercent: number;
  sampleSize: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
  interpretation: string;
}

export interface StrategyChangeTest {
  strategy: string;
  testedAt: string;
  baselinePF: number;
  newPF: number;
  baselineWR: number;
  newWR: number;
  pfTest: SignificanceTest;
  wrTest: SignificanceTest;
  shouldApply: boolean;
  reason: string;
}

// Welch's t-test (two-sample, unequal variance)
function welchTTest(a: number[], b: number[]): { tStat: number; pValue: number } {
  if (a.length < 5 || b.length < 5) return { tStat: 0, pValue: 1 };

  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  const varA = a.reduce((s, v) => s + (v - meanA) ** 2, 0) / (a.length - 1);
  const varB = b.reduce((s, v) => s + (v - meanB) ** 2, 0) / (b.length - 1);

  const se = Math.sqrt(varA / a.length + varB / b.length);
  if (se === 0) return { tStat: 0, pValue: 1 };

  const tStat = (meanB - meanA) / se;
  const df = (varA / a.length + varB / b.length) ** 2 /
    ((varA / a.length) ** 2 / (a.length - 1) + (varB / b.length) ** 2 / (b.length - 1));

  // Approximate p-value from t-distribution (two-tailed)
  const pValue = approximatePValue(Math.abs(tStat), df);
  return { tStat, pValue };
}

// Approximation of p-value using Abramowitz & Stegun formula
function approximatePValue(t: number, df: number): number {
  if (df < 1) return 1;
  const x = df / (df + t * t);
  // Regularized incomplete beta function approximation
  const a = df / 2;
  const b = 0.5;
  const betaInc = betaIncomplete(x, a, b);
  return Math.min(1, Math.max(0, betaInc));
}

function betaIncomplete(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Continued fraction approximation (Lentz's method)
  const maxIter = 200;
  const eps = 1e-10;
  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta) / a;

  let f = 1, C = 1, D = 1 - (a + b) * x / (a + 1);
  if (Math.abs(D) < eps) D = eps;
  D = 1 / D;
  f = D;

  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let num = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    D = 1 + num * D;
    C = 1 + num / C;
    if (Math.abs(D) < eps) D = eps;
    if (Math.abs(C) < eps) C = eps;
    D = 1 / D;
    f *= D * C;

    num = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    D = 1 + num * D;
    C = 1 + num / C;
    if (Math.abs(D) < eps) D = eps;
    if (Math.abs(C) < eps) C = eps;
    D = 1 / D;
    const delta = D * C;
    f *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  return front * f;
}

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) { y += 1; ser += ci / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function buildTest(
  baseline: number[],
  current: number[],
  metricName: string,
  baselineValue: number,
  newValue: number
): SignificanceTest {
  const { pValue } = welchTTest(baseline, current);
  const isSignificant = pValue < 0.05 && newValue > baselineValue;
  const delta = newValue - baselineValue;
  const deltaPercent = baselineValue !== 0 ? (delta / baselineValue) * 100 : 0;

  let interpretation: string;
  if (isSignificant) {
    interpretation = `✅ Улучшение подтверждено статистически (p=${pValue.toFixed(3)})`;
  } else if (pValue < 0.05 && newValue <= baselineValue) {
    interpretation = `❌ Ухудшение статистически значимо (p=${pValue.toFixed(3)})`;
  } else {
    interpretation = `⚠️ Изменение статистически не подтверждено (p=${pValue.toFixed(3)})`;
  }

  return {
    metricName,
    baselineValue,
    newValue,
    delta,
    deltaPercent,
    sampleSize: current.length,
    pValue,
    isSignificant,
    confidenceLevel: 1 - pValue,
    interpretation,
  };
}

export async function testStrategyChange(
  strategy: string,
  baselineWindowSize = 200,
  currentWindowSize = 50
): Promise<StrategyChangeTest> {
  const { rows } = await pool.query(
    `SELECT pnl_percent, outcome FROM paper_closed_trades
     WHERE strategy = $1 AND outcome IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT $2`,
    [strategy, baselineWindowSize + currentWindowSize]
  );

  const all = (rows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));
  if (all.length < 30) {
    return {
      strategy,
      testedAt: new Date().toISOString(),
      baselinePF: 0, newPF: 0, baselineWR: 0, newWR: 0,
      pfTest: buildTest([], [], "PF", 0, 0),
      wrTest: buildTest([], [], "WR", 0, 0),
      shouldApply: false,
      reason: "Недостаточно данных для тестирования",
    };
  }

  const current = all.slice(0, currentWindowSize);
  const baseline = all.slice(currentWindowSize);

  const calcPF = (arr: number[]) => {
    const gW = arr.filter(v => v > 0).reduce((s, v) => s + v, 0);
    const gL = Math.abs(arr.filter(v => v <= 0).reduce((s, v) => s + v, 0));
    return gL > 0 ? gW / gL : gW > 0 ? 99 : 0;
  };
  const calcWR = (arr: number[]) => arr.length > 0 ? arr.filter(v => v > 0).length / arr.length : 0;

  const baselinePF = calcPF(baseline);
  const newPF = calcPF(current);
  const baselineWR = calcWR(baseline);
  const newWR = calcWR(current);

  // FIX Critical#6: WR test needs binary 0/1 arrays; raw PnL arrays test average return, not win rate
  const baselineBinary = baseline.map(v => v > 0 ? 1 : 0);
  const currentBinary  = current.map(v => v > 0 ? 1 : 0);

  const pfTest = buildTest(baseline, current, "Profit Factor", baselinePF, newPF);
  const wrTest = buildTest(baselineBinary, currentBinary, "Win Rate", baselineWR, newWR);

  const shouldApply = pfTest.isSignificant || wrTest.isSignificant;
  const reason = shouldApply
    ? `PF: ${pfTest.interpretation} | WR: ${wrTest.interpretation}`
    : `Изменение не подтверждено статистически — оставить как есть`;

  const result: StrategyChangeTest = {
    strategy,
    testedAt: new Date().toISOString(),
    baselinePF, newPF, baselineWR, newWR,
    pfTest, wrTest, shouldApply, reason,
  };

  await pool.query(
    `INSERT INTO stat_significance_tests(strategy, baseline_pf, new_pf, baseline_wr, new_wr,
       pf_p_value, wr_p_value, should_apply, reason, tested_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [strategy, baselinePF, newPF, baselineWR, newWR,
      pfTest.pValue, wrTest.pValue, shouldApply, reason, result.testedAt]
  ).catch(err => logger.warn({ err }, "stat_significance_tests save failed"));

  return result;
}

export function formatSignificanceReport(tests: StrategyChangeTest[]): string {
  if (!tests.length) return "📐 *Статистика изменений*\n\nНедостаточно данных.";
  let text = "📐 *Статистическая проверка изменений*\n\n";
  for (const t of tests) {
    text += `*${t.strategy}*\n`;
    text += `PF: ${t.baselinePF.toFixed(2)} → ${t.newPF.toFixed(2)} (p=${t.pfTest.pValue.toFixed(3)})\n`;
    text += `WR: ${(t.baselineWR * 100).toFixed(1)}% → ${(t.newWR * 100).toFixed(1)}% (p=${t.wrTest.pValue.toFixed(3)})\n`;
    text += `${t.shouldApply ? "✅ Применять изменение" : "⛔ Не применять — случайное"}\n\n`;
  }
  return text.trim();
}
