/**
 * Decision Trace — полный путь принятия решения для каждого сигнала.
 * Записывает каждый шаг Trade Quality Gate (PASS/FAIL) в БД.
 * Используется для аудита и аналитики через Полный отчёт.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface DecisionStep {
  check: string;
  result: "PASS" | "FAIL" | "SKIP";
  value?: string | number;
  threshold?: string | number;
  note?: string;
}

export interface DecisionTrace {
  symbol: string;
  strategy: string;
  direction: string;
  regime: string;
  timestamp: string;
  steps: DecisionStep[];
  verdict: "OPEN" | "REJECT";
  rejectReason?: string;
  tradeId?: string;
  score?: number;
  confidence?: number;
}

export function makeTrace(
  symbol: string,
  direction: string,
  regime: string,
  strategy = "UNKNOWN",
): { steps: DecisionStep[]; pass: (check: string, value?: string | number, note?: string) => void; fail: (check: string, reason: string, value?: string | number, threshold?: string | number) => void; skip: (check: string, note?: string) => void; rejected: boolean; rejectReason: string } {
  const steps: DecisionStep[] = [];
  let rejected = false;
  let rejectReason = "";

  return {
    steps,
    get rejected() { return rejected; },
    get rejectReason() { return rejectReason; },
    pass(check, value?, note?) {
      steps.push({ check, result: "PASS", value, note });
    },
    fail(check, reason, value?, threshold?) {
      if (!rejected) { rejected = true; rejectReason = reason; }
      steps.push({ check, result: "FAIL", value, threshold, note: reason });
    },
    skip(check, note?) {
      steps.push({ check, result: "SKIP", note });
    },
  };
}

export async function saveDecisionTrace(trace: DecisionTrace): Promise<void> {
  await pool.query(
    `INSERT INTO decision_log(symbol, strategy, direction, regime, timestamp, steps, verdict, reject_reason, trade_id, score, confidence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      trace.symbol, trace.strategy, trace.direction, trace.regime,
      trace.timestamp, JSON.stringify(trace.steps),
      trace.verdict, trace.rejectReason ?? null, trace.tradeId ?? null,
      trace.score ?? null, trace.confidence ?? null,
    ]
  ).catch(err => logger.warn({ err }, "decision_log save failed"));
}

export async function getRecentDecisionLog(limit = 50): Promise<DecisionTrace[]> {
  const { rows } = await pool.query(
    `SELECT * FROM decision_log ORDER BY timestamp DESC LIMIT $1`, [limit]
  );
  return (rows as Record<string, unknown>[]).map(r => ({
    symbol:       String(r["symbol"]),
    strategy:     String(r["strategy"]),
    direction:    String(r["direction"]),
    regime:       String(r["regime"]),
    timestamp:    String(r["timestamp"]),
    steps:        Array.isArray(r["steps"]) ? r["steps"] as DecisionStep[] : JSON.parse(String(r["steps"] ?? "[]")),
    verdict:      r["verdict"] as "OPEN" | "REJECT",
    rejectReason: r["reject_reason"] ? String(r["reject_reason"]) : undefined,
    tradeId:      r["trade_id"] ? String(r["trade_id"]) : undefined,
    score:        r["score"] ? Number(r["score"]) : undefined,
    confidence:   r["confidence"] ? Number(r["confidence"]) : undefined,
  }));
}

export async function getDecisionStats(): Promise<{
  total: number; opened: number; rejected: number;
  topRejectReasons: { reason: string; count: number }[];
}> {
  const { rows } = await pool.query(`
    SELECT verdict, reject_reason, COUNT(*) as cnt
    FROM decision_log
    WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days'
    GROUP BY verdict, reject_reason
    ORDER BY cnt DESC
    LIMIT 20
  `).catch(() => ({ rows: [] }));

  let total = 0, opened = 0, rejected = 0;
  const reasonMap = new Map<string, number>();

  for (const r of rows as Record<string, unknown>[]) {
    const cnt = Number(r["cnt"]);
    total += cnt;
    if (r["verdict"] === "OPEN") { opened += cnt; }
    else {
      rejected += cnt;
      const reason = String(r["reject_reason"] ?? "Unknown");
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + cnt);
    }
  }

  const topRejectReasons = [...reasonMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  return { total, opened, rejected, topRejectReasons };
}

export function formatDecisionTrace(trace: DecisionTrace): string {
  const icon = trace.verdict === "OPEN" ? "✅" : "❌";
  const lines = [
    `${icon} *Decision Trace: ${trace.symbol}*`,
    `Стратегия: ${trace.strategy} | ${trace.direction} | ${trace.regime}`,
    ``,
  ];
  for (const s of trace.steps) {
    const si = s.result === "PASS" ? "✅" : s.result === "FAIL" ? "❌" : "⏭";
    const val = s.value !== undefined ? ` (${s.value}${s.threshold !== undefined ? ` / мин ${s.threshold}` : ""})` : "";
    lines.push(`${si} ${s.check}${val}${s.note && s.result === "FAIL" ? `: ${s.note}` : ""}`);
  }
  if (trace.verdict === "REJECT" && trace.rejectReason) {
    lines.push(``, `🚫 Причина: *${trace.rejectReason}*`);
  } else if (trace.verdict === "OPEN" && trace.tradeId) {
    lines.push(``, `✅ *Сделка открыта*`);
  }
  return lines.join("\n");
}
