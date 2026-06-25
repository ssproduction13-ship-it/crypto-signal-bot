import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";

export interface JournalEntry {
  id: string; chatId: number; symbol: string; interval: string;
  direction: "LONG"|"SHORT"; entryPrice: number; stopLoss: number;
  tp1: number; tp2: number; score: number; confidence: number;
  strategy: StrategyName;
  timestamp: string; closedAt?: string; closePrice?: number;
  outcome?: "TP1"|"TP2"|"SL"|"MANUAL"; pnlPercent?: number;
  errorAnalysis?: string; factors: Record<string,number>;
}
export interface PaperPosition {
  id: string; symbol: string; direction: "LONG"|"SHORT";
  entryPrice: number; size: number; stopLoss: number;
  tp1: number; tp2: number; openedAt: string; chatId: number;
  strategy: StrategyName;
  breakevenMoved: boolean; trailAtr: number|null;
}
export interface ClosedPaperTrade {
  id: string; symbol: string; direction: "LONG"|"SHORT";
  entryPrice: number; closePrice: number; size: number;
  pnl: number; pnlPercent: number; outcome: string;
  strategy: StrategyName;
  openedAt: string; closedAt: string;
}
export interface PaperAccount {
  balance: number; initialBalance: number; peakBalance: number;
  positions: PaperPosition[]; closedTrades: ClosedPaperTrade[];
}
export interface FactorWeights {
  trend: number; volume: number; momentum: number; levels: number; pattern: number;
}
export interface UserSettings {
  noTradeMode: boolean; minScore: number; riskPercent: number;
  accountSize: number; autoPaperTrade: boolean;
}

const DEF_W: FactorWeights = {trend:0.30,volume:0.25,momentum:0.20,levels:0.15,pattern:0.10};
const DEF_S: UserSettings  = {noTradeMode:false,minScore:62,riskPercent:1,accountSize:10000,autoPaperTrade:true};

function toJE(r: Record<string,unknown>): JournalEntry {
  return {
    id:r["id"] as string, chatId:Number(r["chat_id"]),
    symbol:r["symbol"] as string, interval:r["interval"] as string,
    direction:r["direction"] as "LONG"|"SHORT",
    entryPrice:Number(r["entry_price"]), stopLoss:Number(r["stop_loss"]),
    tp1:Number(r["tp1"]), tp2:Number(r["tp2"]),
    score:Number(r["score"]), confidence:Number(r["confidence"]),
    strategy:(r["strategy"] as StrategyName) ?? "TREND",
    timestamp:r["timestamp"] as string,
    closedAt:(r["closed_at"] as string|null)??undefined,
    closePrice:r["close_price"]!=null?Number(r["close_price"]):undefined,
    outcome:(r["outcome"] as JournalEntry["outcome"])??undefined,
    pnlPercent:r["pnl_percent"]!=null?Number(r["pnl_percent"]):undefined,
    errorAnalysis:(r["error_analysis"] as string|null)??undefined,
    factors:(r["factors"] as Record<string,number>)??{},
  };
}
function toPos(r: Record<string,unknown>): PaperPosition {
  return {
    id:r["id"] as string, chatId:Number(r["chat_id"]),
    symbol:r["symbol"] as string, direction:r["direction"] as "LONG"|"SHORT",
    entryPrice:Number(r["entry_price"]), size:Number(r["size"]),
    stopLoss:Number(r["stop_loss"]), tp1:Number(r["tp1"]), tp2:Number(r["tp2"]),
    openedAt:r["opened_at"] as string,
    strategy:(r["strategy"] as StrategyName) ?? "TREND",
    breakevenMoved:Boolean(r["breakeven_moved"]),
    trailAtr:r["trail_atr"]!=null?Number(r["trail_atr"]):null,
  };
}
function toTrade(r: Record<string,unknown>): ClosedPaperTrade {
  return {
    id:r["id"] as string, symbol:r["symbol"] as string,
    direction:r["direction"] as "LONG"|"SHORT",
    entryPrice:Number(r["entry_price"]), closePrice:Number(r["close_price"]),
    size:Number(r["size"]), pnl:Number(r["pnl"]),
    pnlPercent:Number(r["pnl_percent"]), outcome:r["outcome"] as string,
    strategy:(r["strategy"] as StrategyName) ?? "TREND",
    openedAt:r["opened_at"] as string, closedAt:r["closed_at"] as string,
  };
}

export async function loadJournal(): Promise<JournalEntry[]> {
  const {rows} = await pool.query("SELECT * FROM journal_entries ORDER BY timestamp DESC");
  return rows.map(r=>toJE(r as Record<string,unknown>));
}
export async function addJournalEntry(e: JournalEntry): Promise<void> {
  await pool.query(
    `INSERT INTO journal_entries(id,chat_id,symbol,interval,direction,entry_price,stop_loss,tp1,tp2,score,confidence,strategy,timestamp,factors)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`,
    [e.id,e.chatId??0,e.symbol,e.interval,e.direction,e.entryPrice,e.stopLoss,
     e.tp1,e.tp2,e.score,e.confidence,e.strategy??'TREND',e.timestamp,JSON.stringify(e.factors)]
  );
}
export async function updateJournalEntry(id: string, u: Partial<JournalEntry>): Promise<boolean> {
  const sets: string[]=[], vals: unknown[]=[]; let i=1;
  if(u.closedAt!==undefined)      {sets.push(`closed_at=$${i++}`);     vals.push(u.closedAt);}
  if(u.closePrice!==undefined)    {sets.push(`close_price=$${i++}`);   vals.push(u.closePrice);}
  if(u.outcome!==undefined)       {sets.push(`outcome=$${i++}`);       vals.push(u.outcome);}
  if(u.pnlPercent!==undefined)    {sets.push(`pnl_percent=$${i++}`);   vals.push(u.pnlPercent);}
  if(u.errorAnalysis!==undefined) {sets.push(`error_analysis=$${i++}`);vals.push(u.errorAnalysis);}
  if(!sets.length) return false;
  vals.push(id);
  const {rowCount} = await pool.query(`UPDATE journal_entries SET ${sets.join(",")} WHERE id=$${i}`,vals);
  return (rowCount??0)>0;
}
export async function loadPaperAccount(chatId: number): Promise<PaperAccount> {
  const [a,p,t] = await Promise.all([
    pool.query("SELECT * FROM paper_accounts WHERE chat_id=$1",[chatId]),
    pool.query("SELECT * FROM paper_positions WHERE chat_id=$1",[chatId]),
    pool.query("SELECT * FROM paper_closed_trades WHERE chat_id=$1 ORDER BY closed_at DESC",[chatId]),
  ]);
  const acc = a.rows[0] as Record<string,unknown>|undefined;
  const balance = acc?Number(acc["balance"]):10000;
  return {
    balance,
    initialBalance: acc?Number(acc["initial_balance"]):10000,
    peakBalance:    acc?Number(acc["peak_balance"]):balance,
    positions:   p.rows.map(r=>toPos(r as Record<string,unknown>)),
    closedTrades:t.rows.map(r=>toTrade(r as Record<string,unknown>)),
  };
}
export async function savePaperAccount(chatId: number, a: PaperAccount): Promise<void> {
  const peak = Math.max(a.balance, a.peakBalance ?? a.balance);
  await pool.query(
    `INSERT INTO paper_accounts(chat_id,balance,initial_balance,peak_balance) VALUES($1,$2,$3,$4)
     ON CONFLICT(chat_id) DO UPDATE SET balance=EXCLUDED.balance, peak_balance=EXCLUDED.peak_balance`,
    [chatId,a.balance,a.initialBalance,peak]
  );
  await pool.query("DELETE FROM paper_positions WHERE chat_id=$1",[chatId]);
  for (const pos of a.positions) {
    await pool.query(
      `INSERT INTO paper_positions(id,chat_id,symbol,direction,entry_price,size,stop_loss,tp1,tp2,strategy,opened_at,breakeven_moved,trail_atr)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [pos.id,chatId,pos.symbol,pos.direction,pos.entryPrice,pos.size,
       pos.stopLoss,pos.tp1,pos.tp2,pos.strategy??'TREND',pos.openedAt,pos.breakevenMoved,pos.trailAtr]
    );
  }
  for (const t of a.closedTrades) {
    await pool.query(
      `INSERT INTO paper_closed_trades(id,chat_id,symbol,direction,entry_price,close_price,size,pnl,pnl_percent,outcome,strategy,opened_at,closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
      [t.id,chatId,t.symbol,t.direction,t.entryPrice,t.closePrice,
       t.size,t.pnl,t.pnlPercent,t.outcome,t.strategy??'TREND',t.openedAt,t.closedAt]
    );
  }
}
export async function loadWeights(): Promise<FactorWeights> {
  const {rows} = await pool.query("SELECT * FROM factor_weights WHERE id=1");
  if(!rows.length) return {...DEF_W};
  const r=rows[0] as Record<string,unknown>;
  return {trend:Number(r["trend"]),volume:Number(r["volume"]),momentum:Number(r["momentum"]),
          levels:Number(r["levels"]),pattern:Number(r["pattern"])};
}
export async function saveWeights(w: FactorWeights): Promise<void> {
  await pool.query(
    `INSERT INTO factor_weights(id,trend,volume,momentum,levels,pattern) VALUES(1,$1,$2,$3,$4,$5)
     ON CONFLICT(id) DO UPDATE SET trend=EXCLUDED.trend,volume=EXCLUDED.volume,
       momentum=EXCLUDED.momentum,levels=EXCLUDED.levels,pattern=EXCLUDED.pattern`,
    [w.trend,w.volume,w.momentum,w.levels,w.pattern]
  );
}
export async function loadSettings(chatId: number): Promise<UserSettings> {
  const {rows} = await pool.query("SELECT * FROM user_settings WHERE chat_id=$1",[chatId]);
  if(!rows.length) return {...DEF_S};
  const r=rows[0] as Record<string,unknown>;
  return {
    noTradeMode:Boolean(r["no_trade_mode"]), minScore:Number(r["min_score"]),
    riskPercent:Number(r["risk_percent"]),   accountSize:Number(r["account_size"]),
    autoPaperTrade: r["auto_paper_trade"]!=null ? Boolean(r["auto_paper_trade"]) : true,
  };
}
export async function saveSettings(chatId: number, s: UserSettings): Promise<void> {
  await pool.query(
    `INSERT INTO user_settings(chat_id,no_trade_mode,min_score,risk_percent,account_size,auto_paper_trade)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(chat_id) DO UPDATE SET no_trade_mode=EXCLUDED.no_trade_mode,
       min_score=EXCLUDED.min_score,risk_percent=EXCLUDED.risk_percent,
       account_size=EXCLUDED.account_size,auto_paper_trade=EXCLUDED.auto_paper_trade`,
    [chatId,s.noTradeMode,s.minScore,s.riskPercent,s.accountSize,s.autoPaperTrade]
  );
}
export function genId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

logger.info("PostgreSQL storage initialized");
