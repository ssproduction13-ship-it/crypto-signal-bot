import { pool } from "../lib/db.js";
    import { logger } from "../lib/logger.js";
import { getLossLimitStopReason } from "./risk-limits.js";

    export interface RiskState {
      dailyPnlPct: number; weeklyPnlPct: number;
      consecutiveLosses: number; openPositions: number;
      tradingEnabled: boolean; stopReason: string | null;
      lastResetDate: string; lastWeekKey: string;
  dailyStartBalance: number; weeklyStartBalance: number;
    }

const DEFAULT_REFERENCE_BALANCE = 10_000;

    function localDateStr(d = new Date()): string {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dy = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dy}`;
    }
    function todayKey() { return localDateStr(); }
    function weekKey() {
      const d = new Date();
      const dow = (d.getDay() + 6) % 7;
      const mon = new Date(d); mon.setDate(d.getDate() - dow); mon.setHours(0, 0, 0, 0);
      return `week-${localDateStr(mon)}`;
    }

async function getAggregateBalance(): Promise<number> {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE((SELECT SUM(balance) FROM paper_accounts), 0)
        + COALESCE((SELECT balance FROM emulator_account WHERE id = 1), 0)
        AS total_balance
    `);
    const balance = Number(rows[0]?.["total_balance"]);
    return Number.isFinite(balance) && balance > 0 ? balance : DEFAULT_REFERENCE_BALANCE;
  } catch (err) {
    logger.error({ err }, "Failed to read aggregate balance for loss limits");
    return DEFAULT_REFERENCE_BALANCE;
  }
}

async function getClosedPnlSince(start: Date): Promise<number> {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE((SELECT SUM(pnl) FROM paper_closed_trades WHERE closed_at >= $1), 0)
        + COALESCE((SELECT SUM(pnl) FROM emulator_closed_trades WHERE closed_at >= $1), 0)
        AS total_pnl
    `, [start.toISOString()]);
    const pnl = Number(rows[0]?.["total_pnl"]);
    return Number.isFinite(pnl) ? pnl : 0;
  } catch (err) {
    logger.error({ err, start: start.toISOString() }, "Failed to calculate closed P&L for loss limits");
    return 0;
  }
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function startOfCurrentWeek(): Date {
  const now = startOfToday();
  const dow = (now.getDay() + 6) % 7;
  now.setDate(now.getDate() - dow);
  return now;
}

function pnlPctFrom(pnl: number, startingBalance: number): number {
  return startingBalance > 0 ? (pnl / startingBalance) * 100 : 0;
}

    export async function loadRiskState(): Promise<RiskState> {
      const { rows } = await pool.query("SELECT * FROM risk_state WHERE id=1");
      if (!rows.length) return {
        dailyPnlPct: 0, weeklyPnlPct: 0, consecutiveLosses: 0, openPositions: 0,
        tradingEnabled: true, stopReason: null, lastResetDate: todayKey(), lastWeekKey: weekKey(),
    dailyStartBalance: await getAggregateBalance(),
    weeklyStartBalance: await getAggregateBalance(),
      };
      const r = rows[0] as Record<string, unknown>;
  const currentBalance = await getAggregateBalance();
      let s: RiskState = {
        dailyPnlPct:       Number(r["daily_pnl_percent"]),
        weeklyPnlPct:      Number(r["weekly_pnl_percent"]),
        consecutiveLosses: Number(r["consecutive_losses"]),
        openPositions:     Number(r["open_positions_count"]),
        tradingEnabled:    Boolean(r["trading_enabled"]),  // FIX High: read actual DB value, not hardcoded true
        stopReason:        r["stop_reason"] as string | null,
        lastResetDate:     r["last_reset_date"] as string,
        lastWeekKey:       r["last_week_reset_date"] as string,
    dailyStartBalance: Number(r["daily_start_balance"]) || currentBalance,
    weeklyStartBalance: Number(r["weekly_start_balance"]) || currentBalance,
      };
      let dirty = false;
      if (s.lastResetDate !== todayKey()) {
    s.dailyPnlPct = 0;
    s.lastResetDate = todayKey();
    s.dailyStartBalance = currentBalance;
    if (s.stopReason?.startsWith("Дневной лимит")) {
      s.tradingEnabled = true;
      s.stopReason = null;
      s.consecutiveLosses = 0;
    }
    dirty = true;
      }
      if (s.lastWeekKey !== weekKey()) {
    s.weeklyPnlPct = 0;
    s.lastWeekKey = weekKey();
    s.weeklyStartBalance = currentBalance;
    if (s.stopReason?.startsWith("Недельный лимит")) {
      s.tradingEnabled = true;
      s.stopReason = null;
      s.consecutiveLosses = 0;
    }
    dirty = true;
      }
  if (!Number(r["daily_start_balance"]) || !Number(r["weekly_start_balance"])) dirty = true;
      if (dirty) await saveRiskState(s);
      return s;
    }

    export async function saveRiskState(s: RiskState): Promise<void> {
      await pool.query(
        `INSERT INTO risk_state(id,daily_pnl_percent,weekly_pnl_percent,consecutive_losses,
           open_positions_count,trading_enabled,stop_reason,last_reset_date,last_week_reset_date)
         VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(id) DO UPDATE SET
           daily_pnl_percent=EXCLUDED.daily_pnl_percent,
           weekly_pnl_percent=EXCLUDED.weekly_pnl_percent,
           consecutive_losses=EXCLUDED.consecutive_losses,
           open_positions_count=EXCLUDED.open_positions_count,
           trading_enabled=EXCLUDED.trading_enabled,
           stop_reason=EXCLUDED.stop_reason,
           last_reset_date=EXCLUDED.last_reset_date,
           last_week_reset_date=EXCLUDED.last_week_reset_date,
           daily_start_balance=EXCLUDED.daily_start_balance,
           weekly_start_balance=EXCLUDED.weekly_start_balance`,
        [s.dailyPnlPct, s.weeklyPnlPct, s.consecutiveLosses, s.openPositions,
         s.tradingEnabled, s.stopReason, s.lastResetDate, s.lastWeekKey,
         s.dailyStartBalance, s.weeklyStartBalance]
      );
    }

    // Learning mode — все лимиты по количеству позиций сняты.
    // Бот открывает столько сделок, сколько считает нужным, чтобы собрать максимум данных.
    // Единственная защита: нельзя открыть две позиции по одному символу одновременно.
  export async function canOpenTrade(
    symbol: string,
    openSymbols: string[],
    openPositionsCount?: number,
    direction?: "LONG" | "SHORT",
    openPositions?: Array<{ symbol: string; direction: string }>,
  ): Promise<{ allowed: boolean; reason: string }> {
    const s = await loadRiskState();
    if (!s.tradingEnabled) {
      return { allowed: false, reason: s.stopReason ?? "Торговля приостановлена (kill switch)" };
    }
  // Block duplicate symbol:interval key (allows BTCUSDT:1h + BTCUSDT:4h simultaneously)
    if (openSymbols.includes(symbol)) {
        const displaySymbol = symbol.includes(':') ? symbol.split(':')[0]! : symbol;
        return { allowed: false, reason: `Позиция ${displaySymbol} уже открыта на этом таймфрейме` };
      }
    return { allowed: true, reason: "" };
  }

    // Sync the risk_state counter with the actual positions in DB (call on startup or repair)
    export async function syncPositionsCount(): Promise<void> {
      const { rows } = await pool.query("SELECT COUNT(*) AS cnt FROM paper_positions");
      const actual = Number(rows[0]?.cnt ?? 0);
      const s = await loadRiskState();
      if (s.openPositions !== actual) {
        logger.warn({ was: s.openPositions, actual }, "Syncing risk_state positions counter");
        s.openPositions = actual;
        await saveRiskState(s);
      }
    }

    export async function recordPositionOpened(): Promise<void> {
      const s = await loadRiskState();
      s.openPositions = s.openPositions + 1;
      await saveRiskState(s);
    }

    export async function getDailyLossPct(state?: RiskState): Promise<number> {
      const s = state ?? await loadRiskState();
      return pnlPctFrom(await getClosedPnlSince(startOfToday()), s.dailyStartBalance);
    }

    export async function getWeeklyLossPct(state?: RiskState): Promise<number> {
      const s = state ?? await loadRiskState();
      return pnlPctFrom(await getClosedPnlSince(startOfCurrentWeek()), s.weeklyStartBalance);
    }

    export async function recordPositionClosed(pnlPct: number, isWin: boolean, openedAt?: string): Promise<string | null> {
      const s = await loadRiskState();
      s.openPositions      = Math.max(0, s.openPositions - 1);
      const hoursOpen = openedAt ? (Date.now() - new Date(openedAt).getTime()) / 3_600_000 : 0;
      s.consecutiveLosses  = isWin ? 0 : (hoursOpen < 48 ? s.consecutiveLosses + 1 : s.consecutiveLosses);
      const [dailyLossPct, weeklyLossPct] = await Promise.all([
        getDailyLossPct(s),
        getWeeklyLossPct(s),
      ]);
      s.dailyPnlPct = dailyLossPct;
      s.weeklyPnlPct = weeklyLossPct;

      const maxDaily = Number(process.env["MAX_DAILY_LOSS_PCT"] ?? "5");
      const maxWeekly = Number(process.env["MAX_WEEKLY_LOSS_PCT"] ?? "12");
      const stopReason = getLossLimitStopReason(dailyLossPct, weeklyLossPct, maxDaily, maxWeekly);
      if (stopReason && s.tradingEnabled) {
        s.tradingEnabled = false;
        s.stopReason = stopReason;
      }
      await saveRiskState(s);
      return stopReason;
    }

    export async function resumeTrading(): Promise<void> {
      const s = await loadRiskState();
      s.tradingEnabled = true; s.stopReason = null; s.consecutiveLosses = 0;
      await saveRiskState(s);
      logger.info("Trading resumed manually");
    }

    export async function getRiskStatus(): Promise<string> {
      const s = await loadRiskState();
      return [
        `📚 *Режим обучения — все лимиты позиций сняты*`, "",
        `📅 Дневной P&L: ${s.dailyPnlPct >= 0 ? "+" : ""}${s.dailyPnlPct.toFixed(2)}% (только стат.)`,
        `📆 Недельный P&L: ${s.weeklyPnlPct >= 0 ? "+" : ""}${s.weeklyPnlPct.toFixed(2)}% (только стат.)`,
        `📊 Убытков подряд: ${s.consecutiveLosses}`,
        `📂 Открытых позиций: ${s.openPositions} (без лимита)`,
      ].join("\n");
    }


  // ── Concentration Risk Limits ──────────────────────────────────────────────────────
  // Prevents risk from accumulating in a single strategy/direction/symbol/regime.
  // Called in scheduler.ts after Correlation Guard, before opening a position.

  const MAX_RISK_PER_STRATEGY = 15;  // % of deposit total in one strategy
  const MAX_RISK_PER_DIRECTION = 15; // % of deposit total in LONG or SHORT
  const MAX_RISK_PER_SYMBOL    = 4;  // % of deposit in one coin (across all timeframes)
  const MAX_RISK_PER_REGIME    = 20; // % of deposit in positions opened in one market regime
  const MAX_TOTAL_POSITIONS    = 15; // hard cap on simultaneous open positions

  export interface ConcentrationPosition {
    symbol: string;
    strategy?: string;
    direction?: string;
    riskPercent?: number;
    marketRegime?: string;
  }

  export function checkConcentrationLimits(
    newSymbol: string,
    newStrategy: string,
    newDirection: "LONG" | "SHORT",
    newRegime: string,
    newRiskPct: number,
    openPositions: ConcentrationPosition[]
  ): { blocked: boolean; reason?: string } {

    if (openPositions.length >= MAX_TOTAL_POSITIONS) {
      return { blocked: true, reason: `Достигнут лимит одновременных позиций (${MAX_TOTAL_POSITIONS})` };
    }

    const riskByStrategy = openPositions
      .filter(p => p.strategy === newStrategy)
      .reduce((s, p) => s + (p.riskPercent ?? 0), 0) + newRiskPct;
    if (riskByStrategy > MAX_RISK_PER_STRATEGY) {
      return { blocked: true, reason: `Риск по стратегии ${newStrategy} превысит лимит: ${riskByStrategy.toFixed(1)}% > ${MAX_RISK_PER_STRATEGY}%` };
    }

    const riskByDirection = openPositions
      .filter(p => p.direction === newDirection)
      .reduce((s, p) => s + (p.riskPercent ?? 0), 0) + newRiskPct;
    if (riskByDirection > MAX_RISK_PER_DIRECTION) {
      return { blocked: true, reason: `Риск по направлению ${newDirection} превысит лимит: ${riskByDirection.toFixed(1)}% > ${MAX_RISK_PER_DIRECTION}%` };
    }

    const riskBySymbol = openPositions
      .filter(p => p.symbol === newSymbol)
      .reduce((s, p) => s + (p.riskPercent ?? 0), 0) + newRiskPct;
    if (riskBySymbol > MAX_RISK_PER_SYMBOL) {
      return { blocked: true, reason: `Риск по ${newSymbol} превысит лимит: ${riskBySymbol.toFixed(1)}% > ${MAX_RISK_PER_SYMBOL}%` };
    }

    const riskByRegime = openPositions
      .filter(p => p.marketRegime === newRegime)
      .reduce((s, p) => s + (p.riskPercent ?? 0), 0) + newRiskPct;
    if (riskByRegime > MAX_RISK_PER_REGIME) {
      return { blocked: true, reason: `Риск в режиме "${newRegime}" превысит лимит: ${riskByRegime.toFixed(1)}% > ${MAX_RISK_PER_REGIME}%` };
    }

    return { blocked: false };
  }

  export function getPortfolioTiltMultiplier(consecutiveLosses: number): number {
    if (consecutiveLosses >= 7) return 0.30; // жёсткое снижение
    if (consecutiveLosses >= 5) return 0.50;
    if (consecutiveLosses >= 3) return 0.70;
    return 1.0; // норма
  }
