import { pool } from "../lib/db.js";
import { loadWeights, saveWeights, type FactorWeights } from "./storage.js";
import { logger } from "../lib/logger.js";

export interface ABVariant {
  id: number;
  name: string;
  weights: FactorWeights;
  trades: number;
  wins: number;
  totalPnl: number;
  profitFactor: number;
  winRate: number;
  createdAt: string;
  isActive: boolean;
  isChampion: boolean;
}

// Default variant configurations
const PRESET_VARIANTS: Array<{ name: string; weights: FactorWeights }> = [
  {
    name: "Trend V1 (balanced)",
    weights: { trend: 0.30, volume: 0.25, momentum: 0.20, levels: 0.15, pattern: 0.10 },
  },
  {
    name: "Trend V2 (trend-heavy)",
    weights: { trend: 0.40, volume: 0.20, momentum: 0.20, levels: 0.10, pattern: 0.10 },
  },
  {
    name: "Volume V3 (volume-focus)",
    weights: { trend: 0.25, volume: 0.35, momentum: 0.20, levels: 0.10, pattern: 0.10 },
  },
];

export async function initABVariants(): Promise<void> {
  const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM ab_variants");
  const cnt = Number((rows[0] as Record<string, unknown>)["cnt"]);
  if (cnt > 0) return;

  for (let i = 0; i < PRESET_VARIANTS.length; i++) {
    const v = PRESET_VARIANTS[i]!;
    await pool.query(
      `INSERT INTO ab_variants(name, weights, is_active, is_champion, created_at)
       VALUES($1, $2, $3, false, $4)`,
      [v.name, JSON.stringify(v.weights), i === 0, new Date().toISOString()]
    );
  }
  logger.info("AB variants initialized: 3 strategy variants");
}

export async function loadABVariants(): Promise<ABVariant[]> {
  const { rows } = await pool.query("SELECT * FROM ab_variants ORDER BY id");
  return rows.map(r => {
    const row = r as Record<string, unknown>;
    const trades = Number(row["trades"]);
    const wins = Number(row["wins"]);
    const winPnl = Number(row["win_pnl"]);
    const lossPnl = Number(row["loss_pnl"]);
    return {
      id: Number(row["id"]),
      name: row["name"] as string,
      weights: row["weights"] as FactorWeights,
      trades,
      wins,
      totalPnl: Number(row["total_pnl"]),
      profitFactor: lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 999 : 0,
      winRate: trades > 0 ? (wins / trades) * 100 : 0,
      createdAt: row["created_at"] as string,
      isActive: Boolean(row["is_active"]),
      isChampion: Boolean(row["is_champion"]),
    };
  });
}

export async function recordABTrade(variantId: number, pnlPercent: number, isWin: boolean): Promise<void> {
  await pool.query(
    `UPDATE ab_variants SET
       trades   = trades + 1,
       wins     = wins + $2,
       total_pnl = total_pnl + $3,
       win_pnl  = win_pnl + $4,
       loss_pnl = loss_pnl + $5
     WHERE id = $1`,
    [variantId, isWin ? 1 : 0, pnlPercent,
     isWin ? pnlPercent : 0, isWin ? 0 : Math.abs(pnlPercent)]
  );
}

export async function getActiveVariantId(): Promise<number> {
  const { rows } = await pool.query("SELECT id FROM ab_variants WHERE is_active=true LIMIT 1");
  if (!rows.length) return 1;
  return Number((rows[0] as Record<string, unknown>)["id"]);
}

// Compare all variants and promote the best one
// Returns a notification message if champion changed
export async function evaluateABVariants(): Promise<string | null> {
  const variants = await loadABVariants();
  // M4 fix: 20 trades is statistically weak — require 50 trades minimum
  // and a meaningful PF lead before displacing the current champion.
  const AB_MIN_TRADES = 50;
  const AB_CHAMPION_LEAD = 0.15; // challenger must exceed champion PF by ≥0.15
  const qualified = variants.filter(v => v.trades >= AB_MIN_TRADES);
  if (qualified.length < 2) return null;

  const best = qualified.reduce((b, v) => v.profitFactor > b.profitFactor ? v : b);
  const currentChampion = variants.find(v => v.isChampion);

  if (currentChampion && best.id === currentChampion.id) return null;

  // Only promote if challenger meaningfully outperforms champion (not just noise)
  if (currentChampion && (best.profitFactor - (currentChampion.profitFactor)) < AB_CHAMPION_LEAD) return null;

  // Promote new champion
  await pool.query("UPDATE ab_variants SET is_champion=false WHERE is_champion=true");
  await pool.query("UPDATE ab_variants SET is_champion=true, is_active=true WHERE id=$1", [best.id]);
  if (currentChampion) {
    await pool.query("UPDATE ab_variants SET is_active=false WHERE id=$1", [currentChampion.id]);
  }

  // Apply best weights to global settings
  await saveWeights(best.weights);
  logger.info({ variantId: best.id, name: best.name, pf: best.profitFactor }, "New champion strategy promoted");

  const prevName = currentChampion?.name ?? "нет";
  return (
    `🏆 *Новая лучшая стратегия!*\n\n` +
    `${best.name}\n` +
    `WR: ${best.winRate.toFixed(1)}% | PF: ${best.profitFactor === 999 ? "∞" : best.profitFactor.toFixed(2)}\n` +
    `Сделок: ${best.trades} | P&L: ${best.totalPnl >= 0 ? "+" : ""}${best.totalPnl.toFixed(2)}%\n\n` +
    `Заменила: ${prevName}\n` +
    `✅ Веса факторов обновлены автоматически`
  );
}

// Degradation protection: if active variant underperforms, rollback to champion
export async function checkDegradation(): Promise<string | null> {
  const variants = await loadABVariants();
  const active = variants.find(v => v.isActive);
  const champion = variants.find(v => v.isChampion);

  if (!active || !champion || active.id === champion.id) return null;
  if (active.trades < 15 || champion.trades < 15) return null;

  if (active.profitFactor < champion.profitFactor * 0.8) {
    await pool.query("UPDATE ab_variants SET is_active=false WHERE id=$1", [active.id]);
    await pool.query("UPDATE ab_variants SET is_active=true WHERE id=$1", [champion.id]);
    await saveWeights(champion.weights);
    logger.warn({ activeId: active.id, championId: champion.id }, "Degradation detected — rolled back to champion");
    return (
      `⚠️ *Откат стратегии!*\n\n` +
      `Стратегия "${active.name}" деградировала (PF ${active.profitFactor.toFixed(2)}).\n` +
      `Откат к чемпиону: "${champion.name}" (PF ${champion.profitFactor.toFixed(2)})`
    );
  }

  return null;
}

export function formatABReport(variants: ABVariant[]): string {
  const lines = variants.map(v => {
    const champ = v.isChampion ? " 👑" : "";
    const active = v.isActive ? " ▶️" : "";
    const pf = v.profitFactor === 999 ? "∞" : v.profitFactor.toFixed(2);
    if (v.trades === 0) return `📊 ${v.name}${champ}${active}\n   Нет данных`;
    const icon = v.profitFactor >= 1.5 ? "✅" : v.profitFactor >= 1 ? "⚠️" : "❌";
    return `${icon} ${v.name}${champ}${active}\n   ${v.trades} сд | WR ${v.winRate.toFixed(1)}% | PF ${pf} | P&L ${v.totalPnl >= 0 ? "+" : ""}${v.totalPnl.toFixed(2)}%`;
  });
  return [`🧪 *A/B Тестирование стратегий*\n👑 = чемпион | ▶️ = активная`, "", ...lines].join("\n");
}
