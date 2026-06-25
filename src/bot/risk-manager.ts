import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";

  export interface RiskState {
    dailyPnlPct: number; weeklyPnlPct: number;
    consecutiveLosses: number; openPositions: number;
    tradingEnabled: boolean; stopReason: string | null;
    lastResetDate: string; lastWeekKey: string;
  }

  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function weekKey() {
    const d = new Date(), j = new Date(d.getFullYear(), 0, 1);
    const w = Math.ceil(((d.getTime() - j.getTime()) / 864e5 + j.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${w}`;
  }

  export async function loadRiskState(): Promise<RiskState> {
    const { rows } = await pool.query("SELECT * FROM risk_state WHERE id=1");
    if (!rows.length) return { dailyPnlPct: 0, weeklyPnlPct: 0, consecutiveLosses: 0, openPositions: 0,
      tradingEnabled: true, stopReason: null, lastResetDate: todayKey(), lastWeekKey: weekKey() };
    const r = rows[0] as Record<string, unknown>;
    let s: RiskState = {
      dailyPnlPct:       Number(r["daily_pnl_percent"]),
      weeklyPnlPct:      Number(r["weekly_pnl_percent"]),
      consecutiveLosses: Number(r["consecutive_losses"]),
      openPositions:     Number(r["open_positions_count"]),
      tradingEnabled:    Boolean(r["trading_enabled"]),
      stopReason:        (r["stop_reason"] as string | null) ?? null,
      lastResetDate:     r["last_reset_date"] as string,
      lastWeekKey:       r["last_week_reset_date"] as string,
    };
    let dirty = false;
    if (s.lastResetDate !== todayKey()) {
      s.dailyPnlPct = 0; s.lastResetDate = todayKey();
      if (s.stopReason === "DAILY_LIMIT") { s.tradingEnabled = true; s.stopReason = null; }
      if (s.stopReason === "3 убытка подряд") { s.tradingEnabled = true; s.stopReason = null; s.consecutiveLosses = 0; dirty = true; }
      dirty = true;
    }
    if (s.lastWeekKey !== weekKey()) {
      s.weeklyPnlPct = 0; s.lastWeekKey = weekKey();
      if (s.stopReason === "WEEKLY_LIMIT") { s.tradingEnabled = true; s.stopReason = null; }
      dirty = true;
    }
    if (dirty) await saveRiskState(s);
    return s;
  }

  export async function saveRiskState(s: RiskState): Promise<void> {
    await pool.query(
      `INSERT INTO risk_state(id,daily_pnl_percent,weekly_pnl_percent,consecutive_losses,
         open_positions_count,trading_enabled,stop_reason,last_reset_date,last_week_reset_date)
       VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET
         daily_pnl_percent=EXCLUDED.daily_pnl_percent,
         weekly_pnl_percent=EXCLUDED.weekly_pnl_percent,
         consecutive_losses=EXCLUDED.consecutive_losses,
         open_positions_count=EXCLUDED.open_positions_count,
         trading_enabled=EXCLUDED.trading_enabled,
         stop_reason=EXCLUDED.stop_reason,
         last_reset_date=EXCLUDED.last_reset_date,
         last_week_reset_date=EXCLUDED.last_week_reset_date`,
      [s.dailyPnlPct, s.weeklyPnlPct, s.consecutiveLosses, s.openPositions,
       s.tradingEnabled, s.stopReason, s.lastResetDate, s.lastWeekKey]
    );
  }

  export async function canOpenTrade(symbol: string, openSymbols: string[]): Promise<{ allowed: boolean; reason: string }> {
    const s = await loadRiskState();
    if (!s.tradingEnabled)             return { allowed: false, reason: s.stopReason ?? "Торговля остановлена" };
    if (s.openPositions >= 10)         return { allowed: false, reason: "Лимит: 10 открытых позиций" };
    if (openSymbols.includes(symbol))  return { allowed: false, reason: `Позиция ${symbol} уже открыта` };
    if (s.dailyPnlPct <= -3) {
      await saveRiskState({ ...s, tradingEnabled: false, stopReason: "DAILY_LIMIT" });
      return { allowed: false, reason: "Дневной убыток -3% — торговля до завтра" };
    }
    if (s.weeklyPnlPct <= -7) {
      await saveRiskState({ ...s, tradingEnabled: false, stopReason: "WEEKLY_LIMIT" });
      return { allowed: false, reason: "Недельный убыток -7% — торговля до след. недели" };
    }
    return { allowed: true, reason: "" };
  }

  export async function recordPositionOpened(): Promise<void> {
    const s = await loadRiskState();
    s.openPositions = Math.min(3, s.openPositions + 1);
    await saveRiskState(s);
  }

  export async function recordPositionClosed(pnlPct: number, isWin: boolean): Promise<string | null> {
    const s = await loadRiskState();
    s.openPositions      = Math.max(0, s.openPositions - 1);
    s.dailyPnlPct       += pnlPct;
    s.weeklyPnlPct      += pnlPct;
    s.consecutiveLosses  = isWin ? 0 : s.consecutiveLosses + 1;
    let alert: string | null = null;
    // Consecutive losses tracked for analytics only — no trading stop (paper trading mode)
    if (s.dailyPnlPct <= -3 && s.tradingEnabled) {
      s.tradingEnabled = false; s.stopReason = "DAILY_LIMIT";
      alert = "🛑 Дневной лимит -3% достигнут. Торговля возобновится завтра.";
    } else if (s.weeklyPnlPct <= -7 && s.tradingEnabled) {
      s.tradingEnabled = false; s.stopReason = "WEEKLY_LIMIT";
      alert = "🛑 Недельный лимит -7% достигнут. Торговля возобновится на след. неделе.";

    await saveRiskState(s);
    return alert;
  }

  export async function resumeTrading(): Promise<void> {
    const s = await loadRiskState();
    s.tradingEnabled = true; s.stopReason = null; s.consecutiveLosses = 0;
    await saveRiskState(s);
    logger.info("Trading resumed manually");
  }

  export async function getRiskStatus(): Promise<string> {
    const s = await loadRiskState();
    const icon = s.tradingEnabled ? "✅" : "🛑";
    return [
      `${icon} *Риск-менеджмент*`, "",
      `Торговля: ${s.tradingEnabled ? "активна" : "ОСТАНОВЛЕНА"}`,
      ...(!s.tradingEnabled && s.stopReason ? [`Причина: ${s.stopReason}`] : []), "",
      `📅 Дневной P&L: ${s.dailyPnlPct >= 0 ? "+" : ""}${s.dailyPnlPct.toFixed(2)}% (лимит -3%)`,
      `📆 Недельный P&L: ${s.weeklyPnlPct >= 0 ? "+" : ""}${s.weeklyPnlPct.toFixed(2)}% (лимит -7%)`,
      `📊 Убытков подряд: ${s.consecutiveLosses} (без лимита — режим обучения)`,
      `📂 Открытых позиций: ${s.openPositions}/10`,
      ...(!s.tradingEnabled ? ["", "Используй /resume для возобновления"] : []),
    ].join("\n");
  }
  