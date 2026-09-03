import { pool } from "../lib/db.js";

export interface MfeTp2Row {
  strategy: string;
  outcome: string;
  mfeR: number;
  tp2R: number;
}

export interface MfeTp2Analysis {
  sampleSize: number;
  medianRatio: number;
  p25Ratio: number;
  p75Ratio: number;
  averageMfeR: number;
  averageTp2R: number;
  tp2Reached: number;
  tp2ReachRate: number;
  byStrategy: Array<{
    strategy: string;
    sampleSize: number;
    medianRatio: number;
    tp2ReachRate: number;
  }>;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function analyzeMfeTp2(rows: MfeTp2Row[]): MfeTp2Analysis {
  const valid = rows.filter((row) =>
    Number.isFinite(row.mfeR) && Number.isFinite(row.tp2R) && row.tp2R > 0,
  );
  const ratios = valid.map((row) => row.mfeR / row.tp2R);
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const byStrategy = [...new Set(valid.map((row) => row.strategy))].sort().map((strategy) => {
    const strategyRows = valid.filter((row) => row.strategy === strategy);
    return {
      strategy,
      sampleSize: strategyRows.length,
      medianRatio: percentile(strategyRows.map((row) => row.mfeR / row.tp2R), 0.5),
      tp2ReachRate: strategyRows.length
        ? strategyRows.filter((row) => row.outcome === "TP2").length / strategyRows.length
        : 0,
    };
  });

  return {
    sampleSize: valid.length,
    medianRatio: percentile(ratios, 0.5),
    p25Ratio: percentile(ratios, 0.25),
    p75Ratio: percentile(ratios, 0.75),
    averageMfeR: mean(valid.map((row) => row.mfeR)),
    averageTp2R: mean(valid.map((row) => row.tp2R)),
    tp2Reached: valid.filter((row) => row.outcome === "TP2").length,
    tp2ReachRate: valid.length
      ? valid.filter((row) => row.outcome === "TP2").length / valid.length
      : 0,
    byStrategy,
  };
}

export async function getMfeTp2Report(chatId: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, outcome, mfe_r, ABS(tp2 - entry_price)
       / NULLIF(ABS(stop_loss - entry_price), 0) AS tp2_r
       FROM paper_closed_trades
      WHERE chat_id=$1
        AND outcome IN ('TP1', 'TP2', 'SL', 'BE')
        AND mfe_r IS NOT NULL
        AND stop_loss IS NOT NULL
        AND tp2 IS NOT NULL
      ORDER BY closed_at DESC`,
    [chatId],
  );
  const analysis = analyzeMfeTp2((rows as Record<string, unknown>[]).map((row) => ({
    strategy: String(row["strategy"] ?? "UNKNOWN"),
    outcome: String(row["outcome"] ?? ""),
    mfeR: Number(row["mfe_r"]),
    tp2R: Number(row["tp2_r"]),
  })));

  if (analysis.sampleSize < 5) {
    return [
      "📐 *Исследование MFE / TP2*",
      "",
      `Недостаточно данных: ${analysis.sampleSize}/5 сделок с MFE и сохранёнными SL/TP2.`,
      "Порог TP2 не изменён — сначала накапливаю распределение.",
    ].join("\n");
  }

  const interpretation = analysis.medianRatio >= 1
    ? "MFE обычно достигает TP2 или выше; снижение TP2 не обосновано."
    : analysis.p75Ratio >= 1
      ? "TP2 достигается в верхнем квартиле; проверьте частичную фиксацию, но не меняйте порог автоматически."
      : "Большинство движений не достигает TP2; гипотеза о более ранней цели требует отдельного backtest.";
  const strategyLines = analysis.byStrategy.map((item) =>
    `  ${item.strategy}: n=${item.sampleSize}, median ${(item.medianRatio * 100).toFixed(0)}% TP2, ` +
    `TP2 reach ${(item.tp2ReachRate * 100).toFixed(1)}%`,
  );

  return [
    `📐 *Исследование MFE / TP2* (${analysis.sampleSize} сделок)`,
    "",
    `MFE avg: ${analysis.averageMfeR.toFixed(2)}R | TP2 avg: ${analysis.averageTp2R.toFixed(2)}R`,
    `MFE/TP2: P25 ${(analysis.p25Ratio * 100).toFixed(0)}% | median ${(analysis.medianRatio * 100).toFixed(0)}% | P75 ${(analysis.p75Ratio * 100).toFixed(0)}%`,
    `Фактический TP2: ${analysis.tp2Reached}/${analysis.sampleSize} (${(analysis.tp2ReachRate * 100).toFixed(1)}%)`,
    "",
    "По стратегиям:",
    ...strategyLines,
    "",
    interpretation,
    "Решение по TP2 остаётся исследовательским до отдельного backtest/статпроверки.",
  ].join("\n");
}