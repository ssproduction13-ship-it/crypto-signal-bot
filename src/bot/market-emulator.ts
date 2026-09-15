import axios from "axios";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getFundingRate } from "./binance.js";
import { calculateRealisticFill, type BookLevel, type FillResult } from "./market-emulator-math.js";

export type EmulatorDirection = "LONG" | "SHORT";

export { calculateRealisticFill } from "./market-emulator-math.js";

const FUTURES_API = "https://api-futures.kucoin.com";
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const TP1_CLOSE_FRACTION = 0.5;
const MAX_POSITION_NOTIONAL_PCT = 0.20;
const DEFAULT_INITIAL_BALANCE = 10_000;

/**
 * KuCoin returns Futures quantities in contracts.  The emulator normalises
 * them to base-asset units before calculating a fill, so its position sizing
 * remains compatible with the existing signal/risk code.
 */
export interface FuturesContractSpec {
  symbol: string;
  multiplier: number;
  lotSize: number;
  tickSize: number;
}

export interface EmulatorPosition {
  id: string;
  symbol: string;
  direction: EmulatorDirection;
  strategy: string;
  entryPrice: number;
  size: number;
  remainingSize: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  openedAt: string;
  regime: string | null;
  interval: string;
  riskPercent: number | null;
  equityAtOpen: number;
  entryCommission: number;
  entrySlippagePct: number;
  entrySlippageCost: number;
  realizedPnl: number;
  realizedSize: number;
  exitNotional: number;
  totalCommission: number;
  totalSlippageCost: number;
  fundingCost: number;
  lastFundingAt: string;
  tp1Executed: boolean;
  breakevenMoved: boolean;
}

export interface EmulatorClosedTrade {
  id: string;
  symbol: string;
  direction: EmulatorDirection;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  pnlEquityPct: number;
  outcome: string;
  totalCommission: number;
  totalSlippageCost: number;
  fundingCost: number;
  openedAt: string;
  closedAt: string;
}

interface EmulatorOpenResult {
  success: boolean;
  message: string;
  position?: Pick<EmulatorPosition, "id">;
}

const contractCache = new Map<string, { spec: FuturesContractSpec; expiresAt: number }>();

function toFuturesSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase().replace(/[-_]/g, "");
  if (normalized === "BTCUSDT") return "XBTUSDTM";
  if (normalized.endsWith("USDT")) return `${normalized.slice(0, -4)}USDTM`;
  return `${normalized}M`;
}

function emulatorFeeRate(): number {
  const feePct = Number(process.env["EMULATOR_TAKER_FEE_PCT"] ?? "0.06");
  return Number.isFinite(feePct) && feePct >= 0 ? feePct / 100 : 0.0006;
}

function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseLevels(value: unknown, multiplier: number): BookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((level) => {
    if (!Array.isArray(level) || level.length < 2) return [];
    const price = toNumber(level[0]);
    const contracts = toNumber(level[1]);
    if (price <= 0 || contracts <= 0 || multiplier <= 0) return [];
    return [{ price, baseSize: contracts * multiplier }];
  });
}

async function getContractSpec(symbol: string): Promise<FuturesContractSpec> {
  const futuresSymbol = toFuturesSymbol(symbol);
  const cached = contractCache.get(futuresSymbol);
  if (cached && cached.expiresAt > Date.now()) return cached.spec;

  const response = await axios.get(`${FUTURES_API}/api/v1/contracts/${futuresSymbol}`, {
    timeout: 8_000,
  });
  const data = response.data?.data ?? {};
  const spec: FuturesContractSpec = {
    symbol: futuresSymbol,
    multiplier: toNumber(data.multiplier),
    lotSize: toNumber(data.lotSize, 1),
    tickSize: toNumber(data.tickSize, 0.00000001),
  };
  if (spec.multiplier <= 0) {
    throw new Error(`KuCoin contract multiplier unavailable for ${futuresSymbol}`);
  }
  contractCache.set(futuresSymbol, { spec, expiresAt: Date.now() + 15 * 60_000 });
  return spec;
}

async function getFuturesOrderBook(symbol: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  const spec = await getContractSpec(symbol);
  const response = await axios.get(`${FUTURES_API}/api/v1/level2/depth20`, {
    params: { symbol: spec.symbol },
    timeout: 8_000,
  });
  const data = response.data?.data ?? {};
  return {
    bids: parseLevels(data.bids, spec.multiplier),
    asks: parseLevels(data.asks, spec.multiplier),
  };
}

async function getFuturesPrice(symbol: string): Promise<number> {
  const futuresSymbol = toFuturesSymbol(symbol);
  const response = await axios.get(`${FUTURES_API}/api/v1/ticker`, {
    params: { symbol: futuresSymbol },
    timeout: 8_000,
  });
  const data = response.data?.data ?? {};
  const price = toNumber(data.price ?? data.lastTradePrice ?? data.markPrice);
  if (price <= 0) throw new Error(`No Futures price data for ${symbol}`);
  return price;
}

async function getFill(
  symbol: string,
  side: EmulatorDirection,
  size: number,
): Promise<FillResult> {
  const book = await getFuturesOrderBook(symbol);
  // A LONG entry or SHORT exit buys from asks. A SHORT entry or LONG exit
  // sells into bids.
  return calculateRealisticFill(side === "LONG" ? book.asks : book.bids, size);
}

function fromRow(row: Record<string, unknown>): EmulatorPosition {
  return {
    id: String(row["id"]),
    symbol: String(row["symbol"]),
    direction: String(row["direction"]) as EmulatorDirection,
    strategy: String(row["strategy"]),
    entryPrice: toNumber(row["entry_price"]),
    size: toNumber(row["size"]),
    remainingSize: toNumber(row["remaining_size"], toNumber(row["size"])),
    stopLoss: toNumber(row["stop_loss"]),
    tp1: toNumber(row["tp1"]),
    tp2: toNumber(row["tp2"]),
    openedAt: new Date(String(row["opened_at"])).toISOString(),
    regime: row["regime"] == null ? null : String(row["regime"]),
    interval: String(row["interval"] ?? "1h"),
    riskPercent: row["risk_percent"] == null ? null : toNumber(row["risk_percent"]),
    equityAtOpen: toNumber(row["equity_at_open"], DEFAULT_INITIAL_BALANCE),
    entryCommission: toNumber(row["entry_commission"]),
    entrySlippagePct: toNumber(row["entry_slippage_pct"]),
    entrySlippageCost: toNumber(row["entry_slippage_cost"]),
    realizedPnl: toNumber(row["realized_pnl"]),
    realizedSize: toNumber(row["realized_size"]),
    exitNotional: toNumber(row["exit_notional"]),
    totalCommission: toNumber(row["total_commission"]),
    totalSlippageCost: toNumber(row["total_slippage_cost"]),
    fundingCost: toNumber(row["funding_cost"]),
    lastFundingAt: new Date(String(row["last_funding_at"] ?? row["opened_at"])).toISOString(),
    tp1Executed: Boolean(row["tp1_executed"]),
    breakevenMoved: Boolean(row["breakeven_moved"]),
  };
}

export async function openEmulatorPosition(
  _chatId: number,
  symbol: string,
  direction: EmulatorDirection,
  signalEntryPrice: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  riskPercent: number,
  _atr?: number,
  strategy = "UNKNOWN",
  regime = "unknown",
  interval = "1h",
): Promise<EmulatorOpenResult> {
  const stopDistance = Math.abs(signalEntryPrice - stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { success: false, message: "❌ Эмулятор: некорректная дистанция стопа" };
  }

  await pool.query(
    `INSERT INTO emulator_account(id, balance, initial_balance, peak_balance)
     VALUES (1, $1, $1, $1) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_INITIAL_BALANCE],
  );
  const accountResult = await pool.query(
    "SELECT balance FROM emulator_account WHERE id=1",
  );
  const balance = toNumber(accountResult.rows[0]?.["balance"], DEFAULT_INITIAL_BALANCE);
  const maxLoss = balance * (Math.max(0, riskPercent) / 100);
  let size = maxLoss / stopDistance;
  const maxNotional = balance * MAX_POSITION_NOTIONAL_PCT;
  if (size * signalEntryPrice > maxNotional) size = maxNotional / signalEntryPrice;
  if (!Number.isFinite(size) || size <= 0) {
    return { success: false, message: "❌ Эмулятор: размер позиции не положительный" };
  }

  let fill = await getFill(symbol, direction, size);
  if (fill.fillPrice * size > maxNotional) {
    size = maxNotional / fill.fillPrice;
    fill = await getFill(symbol, direction, size);
  }
  const commission = fill.fillPrice * size * emulatorFeeRate();
  const now = new Date();
  const id = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT balance FROM emulator_account WHERE id=1 FOR UPDATE",
    );
    const lockedBalance = toNumber(locked.rows[0]?.["balance"], DEFAULT_INITIAL_BALANCE);
    const existing = await client.query(
      "SELECT id FROM emulator_positions WHERE symbol=$1 FOR UPDATE",
      [symbol.toUpperCase()],
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return { success: false, message: `⚠️ Эмулятор: позиция ${symbol} уже открыта` };
    }
    if (commission > lockedBalance) {
      await client.query("ROLLBACK");
      return { success: false, message: "⚠️ Эмулятор: недостаточно виртуального баланса" };
    }

    await client.query(
      `UPDATE emulator_account
       SET balance=balance-$1, peak_balance=GREATEST(peak_balance, balance-$1), updated_at=NOW()
       WHERE id=1`,
      [commission],
    );
    await client.query(
      `INSERT INTO emulator_positions
       (id,symbol,direction,strategy,entry_price,size,remaining_size,stop_loss,tp1,tp2,
        opened_at,regime,interval,risk_percent,equity_at_open,entry_commission,
        entry_slippage_pct,entry_slippage_cost,total_commission,total_slippage_cost,
        last_funding_at)
       VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$15,$18,$10)`,
      [
        id, symbol.toUpperCase(), direction, strategy, fill.fillPrice, size,
        stopLoss, tp1, tp2, now, regime, interval, riskPercent, lockedBalance,
        commission, fill.slippagePct, fill.slippageCost, fill.slippageCost,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  logger.info(
    { id, symbol, direction, size, fillPrice: fill.fillPrice, slippagePct: fill.slippagePct },
    "Emulator position opened",
  );
  return {
    success: true,
    position: { id },
    message:
      `✅ *Эмулятор: позиция открыта*\n\n` +
      `${direction === "LONG" ? "⬆️ LONG" : "⬇️ SHORT"} ${symbol}\n` +
      `Вход по стакану: ${fill.fillPrice}\n` +
      `Размер: ${size.toFixed(6)} ед.\n` +
      `Slippage: ${fill.slippagePct.toFixed(4)}%\n` +
      `Комиссия: -$${commission.toFixed(4)}`,
  };
}

async function executeEmulatorClose(
  position: EmulatorPosition,
  outcome: string,
  requestedSize: number,
): Promise<string | null> {
  const closeSide: EmulatorDirection = position.direction === "LONG" ? "SHORT" : "LONG";
  const size = Math.min(position.remainingSize, requestedSize);
  if (size <= 0) return null;
  const fill = await getFill(position.symbol, closeSide, size);
  const directionSign = position.direction === "LONG" ? 1 : -1;
  const grossPnl = directionSign * (fill.fillPrice - position.entryPrice) * size;
  const commission = fill.fillPrice * size * emulatorFeeRate();
  const netClosePnl = grossPnl - commission;
  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM emulator_positions WHERE id=$1 FOR UPDATE",
      [position.id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const current = fromRow(row);
    const actualSize = Math.min(current.remainingSize, size);
    const actualGross = directionSign * (fill.fillPrice - current.entryPrice) * actualSize;
    const actualCommission = fill.fillPrice * actualSize * emulatorFeeRate();
    const nextRemaining = Math.max(0, current.remainingSize - actualSize);
    const nextRealizedPnl = current.realizedPnl + actualGross - actualCommission;
    const nextRealizedSize = current.realizedSize + actualSize;
    const nextExitNotional = current.exitNotional + fill.fillPrice * actualSize;
    const nextCommission = current.totalCommission + actualCommission;
    const nextSlippage = current.totalSlippageCost + fill.slippageCost;

    await client.query(
      `UPDATE emulator_account
       SET balance=balance+$1, peak_balance=GREATEST(peak_balance, balance+$1), updated_at=NOW()
       WHERE id=1`,
      [actualGross - actualCommission],
    );

    if (nextRemaining > 1e-12 && outcome === "TP1") {
      await client.query(
        `UPDATE emulator_positions
         SET remaining_size=$1, realized_pnl=$2, realized_size=$3, exit_notional=$4,
             total_commission=$5, total_slippage_cost=$6, tp1_executed=true,
             breakeven_moved=true, stop_loss=entry_price
         WHERE id=$7`,
        [nextRemaining, nextRealizedPnl, nextRealizedSize, nextExitNotional,
          nextCommission, nextSlippage, current.id],
      );
      await client.query("COMMIT");
      return `🟡 Эмулятор TP1: ${current.symbol} ${current.direction}, закрыто ${(actualSize / current.size * 100).toFixed(1)}%`;
    }

    const totalPnl = nextRealizedPnl - current.entryCommission - current.fundingCost;
    const avgExitPrice = nextRealizedSize > 0 ? nextExitNotional / nextRealizedSize : fill.fillPrice;
    const pnlPercent = current.entryPrice * current.size > 0
      ? (totalPnl / (current.entryPrice * current.size)) * 100
      : 0;
    const pnlEquityPct = current.equityAtOpen > 0
      ? (totalPnl / current.equityAtOpen) * 100
      : 0;
    await client.query(
      `INSERT INTO emulator_closed_trades
       (id,symbol,direction,strategy,entry_price,exit_price,size,pnl,pnl_percent,
        pnl_equity_pct,outcome,total_commission,total_slippage_cost,funding_cost,opened_at,closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [randomUUID(), current.symbol, current.direction, current.strategy,
        current.entryPrice, avgExitPrice, current.size, totalPnl, pnlPercent,
        pnlEquityPct, outcome, nextCommission, nextSlippage, current.fundingCost,
        current.openedAt, now],
    );
    await client.query("DELETE FROM emulator_positions WHERE id=$1", [current.id]);
    await client.query("COMMIT");
    return `✅ Эмулятор: ${outcome} ${current.symbol} ${current.direction}, P&L ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} (${pnlEquityPct.toFixed(2)}%)`;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function checkEmulatorPositions(
  sendNotification?: (message: string) => Promise<void>,
): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT * FROM emulator_positions ORDER BY opened_at ASC",
  );
  const messages: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const position = fromRow(row);
    try {
      const price = await getFuturesPrice(position.symbol);
      const long = position.direction === "LONG";
      const hitStop = long ? price <= position.stopLoss : price >= position.stopLoss;
      const hitTp1 = !position.tp1Executed && (long ? price >= position.tp1 : price <= position.tp1);
      const hitTp2 = long ? price >= position.tp2 : price <= position.tp2;
      if (hitStop) {
        const message = await executeEmulatorClose(position, "SL", position.remainingSize);
        if (message) messages.push(message);
      } else if (hitTp1) {
        const message = await executeEmulatorClose(
          position,
          "TP1",
          position.remainingSize * TP1_CLOSE_FRACTION,
        );
        if (message) messages.push(message);
      } else if (hitTp2) {
        const message = await executeEmulatorClose(position, "TP2", position.remainingSize);
        if (message) messages.push(message);
      }
    } catch (err) {
      logger.warn({ err, positionId: position.id, symbol: position.symbol }, "Emulator position check failed");
    }
  }
  if (sendNotification) {
    for (const message of messages) await sendNotification(message).catch(() => {});
  }
  return messages;
}

export async function accrueEmulatorFunding(now = new Date()): Promise<number> {
  const { rows } = await pool.query(
    "SELECT * FROM emulator_positions ORDER BY opened_at ASC",
  );
  let charged = 0;
  for (const row of rows as Record<string, unknown>[]) {
    const position = fromRow(row);
    let chargeAt = new Date(position.lastFundingAt).getTime() + FUNDING_INTERVAL_MS;
    while (chargeAt <= now.getTime()) {
      const rate = await getFundingRate(position.symbol);
      if (rate == null || !Number.isFinite(rate)) {
        logger.warn({ positionId: position.id, symbol: position.symbol }, "Emulator funding rate unavailable");
        break;
      }
      const notional = position.remainingSize * position.entryPrice;
      const directionSign = position.direction === "LONG" ? 1 : -1;
      const cost = notional * rate * directionSign;
      const eventId = `${position.id}:${new Date(chargeAt).toISOString()}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO emulator_funding_events
           (id,position_id,charged_at,rate,notional,cost)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (position_id, charged_at) DO NOTHING
           RETURNING id`,
          [eventId, position.id, new Date(chargeAt), rate, notional, cost],
        );
        if (inserted.rowCount) {
          const updated = await client.query(
            `UPDATE emulator_positions
             SET funding_cost=funding_cost+$1, last_funding_at=$2
             WHERE id=$3 RETURNING id`,
            [cost, new Date(chargeAt), position.id],
          );
          if (updated.rowCount) {
            await client.query(
              `UPDATE emulator_account SET balance=balance-$1, updated_at=NOW() WHERE id=1`,
              [cost],
            );
            charged++;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      chargeAt += FUNDING_INTERVAL_MS;
    }
  }
  return charged;
}

export async function getEmulatorSummary(): Promise<{
  balance: number;
  initialBalance: number;
  openPositions: number;
  closedTrades: number;
  totalPnl: number;
}> {
  const [account, positions, trades] = await Promise.all([
    pool.query("SELECT balance, initial_balance FROM emulator_account WHERE id=1"),
    pool.query("SELECT COUNT(*)::int AS count FROM emulator_positions"),
    pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(pnl),0) AS pnl FROM emulator_closed_trades"),
  ]);
  return {
    balance: toNumber(account.rows[0]?.["balance"], DEFAULT_INITIAL_BALANCE),
    initialBalance: toNumber(account.rows[0]?.["initial_balance"], DEFAULT_INITIAL_BALANCE),
    openPositions: toNumber(positions.rows[0]?.["count"]),
    closedTrades: toNumber(trades.rows[0]?.["count"]),
    totalPnl: toNumber(trades.rows[0]?.["pnl"]),
  };
}