import {
  loadJournal,
  updateJournalEntry,
  loadWeights,
  saveWeights,
  type JournalEntry,
} from "./storage.js";
import { getPrice } from "./binance.js";
import { logger } from "../lib/logger.js";

export async function checkOpenSignals(): Promise<
  { entry: JournalEntry; message: string }[]
> {
  const journal = await loadJournal();
  const open = journal.filter((e) => !e.closedAt);
  const results: { entry: JournalEntry; message: string }[] = [];

  for (const entry of open) {
    try {
      const price = await getPrice(entry.symbol);
      let outcome: "TP1" | "TP2" | "SL" | null = null;
      let closePrice = price;

      if (entry.direction === "LONG") {
        if (price <= entry.stopLoss) { outcome = "SL"; closePrice = entry.stopLoss; }
        else if (price >= entry.tp2) { outcome = "TP2"; closePrice = entry.tp2; }
        else if (price >= entry.tp1) { outcome = "TP1"; closePrice = entry.tp1; }
      } else {
        if (price >= entry.stopLoss) { outcome = "SL"; closePrice = entry.stopLoss; }
        else if (price <= entry.tp2) { outcome = "TP2"; closePrice = entry.tp2; }
        else if (price <= entry.tp1) { outcome = "TP1"; closePrice = entry.tp1; }
      }

      if (outcome) {
        const pnlPercent =
          entry.direction === "LONG"
            ? ((closePrice - entry.entryPrice) / entry.entryPrice) * 100
            : ((entry.entryPrice - closePrice) / entry.entryPrice) * 100;

        let errorAnalysis: string | undefined;

        if (outcome === "SL") {
          errorAnalysis = analyzeError(entry);
          await updateWeights(entry, false);
        } else {
          await updateWeights(entry, true);
        }

        await updateJournalEntry(entry.id, {
          closedAt: new Date().toISOString(),
          closePrice,
          outcome,
          pnlPercent,
          errorAnalysis,
        });

        const emoji = outcome === "SL" ? "🔴" : "🟢";
        const msg =
          `${emoji} *Сигнал ${entry.symbol} закрыт: ${outcome}*\n` +
          `P&L: ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%\n` +
          (errorAnalysis ? `\n🔍 *Анализ ошибки:*\n${errorAnalysis}` : "");

        results.push({ entry, message: msg });
      }
    } catch (err) {
      logger.error({ err, entry }, "Failed to check signal");
    }
  }

  return results;
}

function analyzeError(entry: JournalEntry): string {
  const lines: string[] = [];

  if (entry.factors["trend"] != null && entry.factors["trend"] < 40) {
    lines.push("• Слабый тренд — сигнал шёл против рынка");
  }
  if (entry.factors["volume"] != null && entry.factors["volume"] < 40) {
    lines.push("• Низкий объём не подтвердил движение");
  }
  if (entry.factors["momentum"] != null && entry.factors["momentum"] < 40) {
    lines.push("• Слабый импульс — преждевременный вход");
  }
  if (entry.factors["levels"] != null && entry.factors["levels"] < 40) {
    lines.push("• Неудачные уровни — близко к сопротивлению/поддержке");
  }
  if (entry.factors["pattern"] != null && entry.factors["pattern"] < 40) {
    lines.push("• Паттерн не подтвердился");
  }

  if (lines.length === 0) {
    lines.push("• Рыночный шум — сигнал технически был верным, рынок не предсказуем");
  }

  lines.push("• Рекомендация: увеличь минимальный порог оценки в /settings");

  return lines.join("\n");
}

async function updateWeights(entry: JournalEntry, isWin: boolean): Promise<void> {
  // fix: old pattern was loadWeights() → mutate in JS → saveWeights(), which caused
  // a race condition when multiple trades close simultaneously — the second write
  // would overwrite the first, losing learning signal. Now uses a single atomic
  // SQL UPDATE with relative arithmetic so concurrent calls compose correctly.
  const lr = 0.01;
  const factors = ["trend", "volume", "momentum", "levels", "pattern"] as const;

  // Build a single UPDATE that adjusts each column atomically in the DB
  const setClauses: string[] = [];
  for (const factor of factors) {
    const score = entry.factors[factor] ?? 50;
    if (score <= 60) continue; // only adjust factors that were meaningfully active
    const delta = isWin ? lr : -lr;
    if (isWin) {
      // LEAST/GREATEST keep values in [0.05, 0.5] range
      setClauses.push(`${factor} = LEAST(0.5, GREATEST(0.05, ${factor} + ${delta}))`);
    } else {
      setClauses.push(`${factor} = LEAST(0.5, GREATEST(0.05, ${factor} + ${delta}))`);
    }
  }

  if (setClauses.length === 0) return; // no active factors → nothing to update

  // Apply delta, then re-normalise so weights always sum to 1.0
  await pool.query(`UPDATE factor_weights SET ${setClauses.join(", ")} WHERE id = 1`);
  // Normalise in a second atomic update
  await pool.query(`
    UPDATE factor_weights SET
      trend    = trend    / (trend + volume + momentum + levels + pattern),
      volume   = volume   / (trend + volume + momentum + levels + pattern),
      momentum = momentum / (trend + volume + momentum + levels + pattern),
      levels   = levels   / (trend + volume + momentum + levels + pattern),
      pattern  = pattern  / (trend + volume + momentum + levels + pattern)
    WHERE id = 1
  `);
}

export async function getJournalStats(): Promise<string> {
  const journal = await loadJournal();
  const closed = journal.filter((e) => e.closedAt);

  if (closed.length === 0) {
    return "📓 Журнал пустой. Получи сигналы через /signal — они будут автоматически отслеживаться.";
  }

  const wins = closed.filter((e) => (e.pnlPercent ?? 0) > 0);
  const losses = closed.filter((e) => (e.pnlPercent ?? 0) <= 0);
  const winRate = (wins.length / closed.length) * 100;

  const avgWin = wins.length
    ? wins.reduce((a, e) => a + (e.pnlPercent ?? 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((a, e) => a + (e.pnlPercent ?? 0), 0) / losses.length)
    : 0;
  const profitFactor =
    avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 999;

  const bySymbol: Record<string, { wins: number; total: number }> = {};
  for (const e of closed) {
    if (!bySymbol[e.symbol]) bySymbol[e.symbol] = { wins: 0, total: 0 };
    bySymbol[e.symbol]!.total++;
    if ((e.pnlPercent ?? 0) > 0) bySymbol[e.symbol]!.wins++;
  }

  const sorted = Object.entries(bySymbol).sort(
    ([, a], [, b]) => b.wins / b.total - a.wins / a.total
  );
  const top5 = sorted.slice(0, 5).map(([sym, d]) =>
    `  ${sym}: ${((d.wins / d.total) * 100).toFixed(0)}% WR`
  );

  const weights = await loadWeights();

  const recentErrors = closed
    .filter((e) => e.outcome === "SL" && e.errorAnalysis)
    .slice(-3)
    .map((e) => `📍 ${e.symbol}: ${e.errorAnalysis?.split("\n")[0] ?? ""}`)
    .join("\n");

  return [
    `📓 *Журнал сигналов*`,
    ``,
    `Всего сигналов: ${closed.length} | Открытых: ${journal.length - closed.length}`,
    `WinRate: ${winRate.toFixed(1)}%`,
    `Profit Factor: ${profitFactor.toFixed(2)}`,
    `Средний выигрыш: +${avgWin.toFixed(2)}% | Убыток: -${avgLoss.toFixed(2)}%`,
    ``,
    `🏆 *Лучшие пары:*`,
    top5.join("\n") || "  нет данных",
    ``,
    `🧠 *Текущие веса (самообучение):*`,
    `  Тренд: ${(weights.trend * 100).toFixed(0)}%`,
    `  Объём: ${(weights.volume * 100).toFixed(0)}%`,
    `  Импульс: ${(weights.momentum * 100).toFixed(0)}%`,
    `  Уровни: ${(weights.levels * 100).toFixed(0)}%`,
    `  Паттерн: ${(weights.pattern * 100).toFixed(0)}%`,
    ...(recentErrors ? [``, `🔍 *Последние ошибки:*`, recentErrors] : []),
  ].join("\n");
}
