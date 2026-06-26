import { pool } from "../lib/db.js";
    import { logger } from "../lib/logger.js";

    export interface RiskState {
      dailyPnlPct: number; weeklyPnlPct: number;
      consecutiveLosses: number; openPositions: number;
      tradingEnabled: boolean; stopReason: string | null;
      lastResetDate: string; lastWeekKey: string;
    }

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

    export async function loadRiskState(): Promise<RiskState> {
      const { rows } = await pool.query("SELECT * FROM risk_state WHERE id=1");
      if (!rows.length) return {
        dailyPnlPct: 0, weeklyPnlPct: 0, consecutiveLosses: 0, openPositions: 0,
        tradingEnabled: true, stopReason: null, lastResetDate: todayKey(), lastWeekKey: weekKey(),
      };
      const r = rows[0] as Record<string, unknown>;
      let s: RiskState = {
        dailyPnlPct:       Number(r["daily_pnl_percent"]),
        weeklyPnlPct:      Number(r["weekly_pnl_percent"]),
        consecutiveLosses: Number(r["consecutive_losses"]),
        openPositions:     Number(r["open_positions_count"]),
        tradingEnabled:    true,  // learning mode: always enabled
        stopReason:        null,
        lastResetDate:     r["last_reset_date"] as string,
        lastWeekKey:       r["last_week_reset_date"] as string,
      };
      let dirty = false;
      if (s.lastResetDate !== todayKey()) {
        s.dailyPnlPct = 0; s.lastResetDate = todayKey(); dirty = true;
      }
      if (s.lastWeekKey !== weekKey()) {
        s.weeklyPnlPct = 0; s.lastWeekKey = weekKey(); dirty = true;
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

    // Learning mode: only structural limits (max positions, no duplicate symbols)
    // P&L loss limits are disabled — bot collects data freely for Self Learning Engine
    export async function canOpenTrade(symbol: string, openSymbols: string[]): Promise<{ allowed: boolean; reason: string }> {
      const s = await loadRiskState();
      if (s.openPositions >= 10)        return { allowed: false, reason: "Лимит: 10 открытых позиций" };
      if (openSymbols.includes(symbol)) return { allowed: false, reason: `Позиция ${symbol} уже открыта` };
      return { allowed: true, reason: "" };
    }

    export async function recordPositionOpened(): Promise<void> {
      const s = await loadRiskState();
      s.openPositions = s.openPositions + 1;
      await saveRiskState(s);
    }

    // Tracks P&L for stats only — no trading stops in learning mode
    export async function recordPositionClosed(pnlPct: number, isWin: boolean): Promise<string | null> {
      const s = await loadRiskState();
      s.openPositions      = Math.max(0, s.openPositions - 1);
      s.dailyPnlPct       += pnlPct;
      s.weeklyPnlPct      += pnlPct;
      s.consecutiveLosses  = isWin ? 0 : s.consecutiveLosses + 1;
      await saveRiskState(s);
      return null; // no alerts in learning mode
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
        `📚 *Режим обучения — лимиты убытков отключены*`, "",
        `📅 Дневной P&L: ${s.dailyPnlPct >= 0 ? "+" : ""}${s.dailyPnlPct.toFixed(2)}% (только стат.)`,
        `📆 Недельный P&L: ${s.weeklyPnlPct >= 0 ? "+" : ""}${s.weeklyPnlPct.toFixed(2)}% (только стат.)`,
        `📊 Убытков подряд: ${s.consecutiveLosses} (только стат.)`,
        `📂 Открытых позиций: ${s.openPositions}/10 — единственный лимит`,
      ].join("\n");
    }
  