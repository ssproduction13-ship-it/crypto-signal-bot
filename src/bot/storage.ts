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
    llmSentiment?: string; llmRisk?: string; llmConfidence?: number;
    /** Balance at the moment position was opened — used for equity-based PnL % */
    equityAtOpen?: number;
    /** Partial entry: remaining units to add on pullback (set at open, cleared when filled or closed) */
    pendingEntrySize?: number;
    /** Partial entry: price level that triggers the second entry */
    pendingEntryTrigger?: number;
    marketRegime?: string;
    interval?: string;
  }
  export interface ClosedPaperTrade {
    id: string; symbol: string; direction: "LONG"|"SHORT";
    entryPrice: number; closePrice: number; size: number;
    pnl: number; pnlPercent: number; outcome: string;
    strategy: StrategyName;
    openedAt: string; closedAt: string;
    llmSentiment?: string; llmRisk?: string; llmConfidence?: number;
    /** Total commission paid (open + close) in $ */
    commission?: number;
    /** Slippage cost in $ (always negative impact) */
    slippage?: number;
    /** PnL as % of account equity at trade open — the real account impact metric */
    pnlEquityPct?: number;
  }
  export interface PaperAccount {
    balance: number; initialBalance: number; peakBalance: number;
    positions: PaperPosition[]; closedTrades: ClosedPaperTrade[];
    totalCommission: number;
    totalSlippage: number;
  }
  export interface FactorWeights {
    trend: number; volume: number; momentum: number; levels: number; pattern: number;
  }
  export interface UserSettings {
    noTradeMode: boolean; minScore: number; riskPercent: number;
    accountSize: number; autoPaperTrade: boolean;
  }
  export interface GeminiWeights {
    minConfidence: number;
    blockOnConflict: boolean;
    highRiskMultiplier: number;
    conflictAccuracy: number;
    confidenceAccuracy: number;
    tradesAnalyzed: number;
  }

  const DEF_W: FactorWeights = {trend:0.30,volume:0.25,momentum:0.20,levels:0.15,pattern:0.10};
  const DEF_S: UserSettings  = {noTradeMode:false,minScore:62,riskPercent:1,accountSize:10000,autoPaperTrade:true};
  const DEF_G: GeminiWeights = {minConfidence:45,blockOnConflict:true,highRiskMultiplier:0.5,conflictAccuracy:0,confidenceAccuracy:0,tradesAnalyzed:0};

  function toJE(r: Record<string,unknown>): JournalEntry {
    return {
      id:r["id"] as string, chatId:Number(r["chat_id"]),
      symbol:r["symbol"] as string, interval:r["interval"] as string,
      direction:r["direction"] as "LONG"|"SHORT",
      entryPrice:Number(r["entry_price"]), stopLoss:Number(r["stop_loss"]),
      tp1:Number(r["tp1"]), tp2:Number(r["tp2"]),
      score:Number(r["score"]), confidence:Number(r["confidence"]),
      strategy:(r["strategy"] as StrategyName) ?? "UNKNOWN",
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
      strategy:(r["strategy"] as StrategyName) ?? "UNKNOWN",
      breakevenMoved:Boolean(r["breakeven_moved"]),
      trailAtr:r["trail_atr"]!=null?Number(r["trail_atr"]):null,
      llmSentiment:(r["llm_sentiment"] as string|null)??undefined,
      llmRisk:(r["llm_risk"] as string|null)??undefined,
      llmConfidence:r["llm_confidence"]!=null?Number(r["llm_confidence"]):undefined,
      equityAtOpen:r["equity_at_open"]!=null?Number(r["equity_at_open"]):undefined,
      pendingEntrySize:r["pending_entry_size"]!=null?Number(r["pending_entry_size"]):undefined,
      pendingEntryTrigger:r["pending_entry_trigger"]!=null?Number(r["pending_entry_trigger"]):undefined,
      marketRegime:(r["market_regime"] as string|null)??undefined,
      interval:(r["interval"] as string|null)??undefined,
    };
  }
  function toTrade(r: Record<string,unknown>): ClosedPaperTrade {
    return {
      id:r["id"] as string, symbol:r["symbol"] as string,
      direction:r["direction"] as "LONG"|"SHORT",
      entryPrice:Number(r["entry_price"]), closePrice:Number(r["close_price"]),
      size:Number(r["size"]), pnl:Number(r["pnl"]),
      pnlPercent:Number(r["pnl_percent"]), outcome:r["outcome"] as string,
      strategy:(r["strategy"] as StrategyName) ?? "UNKNOWN",
      openedAt:r["opened_at"] as string, closedAt:r["closed_at"] as string,
      llmSentiment:(r["llm_sentiment"] as string|null)??undefined,
      llmRisk:(r["llm_risk"] as string|null)??undefined,
      llmConfidence:r["llm_confidence"]!=null?Number(r["llm_confidence"]):undefined,
      commission:r["commission"]!=null?Number(r["commission"]):undefined,
      slippage:r["slippage"]!=null?Number(r["slippage"]):undefined,
      pnlEquityPct:r["pnl_equity_pct"]!=null?Number(r["pnl_equity_pct"]):undefined,
    };
  }

  /** Run once at startup — safe to call multiple times (IF NOT EXISTS) */
  export async function migrateGeminiColumns(): Promise<void> {
    await pool.query(`ALTER TABLE paper_positions    ADD COLUMN IF NOT EXISTS llm_sentiment TEXT`);
    await pool.query(`ALTER TABLE paper_positions    ADD COLUMN IF NOT EXISTS llm_risk      TEXT`);
    await pool.query(`ALTER TABLE paper_positions    ADD COLUMN IF NOT EXISTS llm_confidence INTEGER`);
    await pool.query(`ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_sentiment TEXT`);
    await pool.query(`ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_risk      TEXT`);
    await pool.query(`ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_confidence INTEGER`);
    await pool.query(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS pending_entry_size    NUMERIC`);
    await pool.query(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS pending_entry_trigger NUMERIC`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gemini_weights (
        id TEXT PRIMARY KEY DEFAULT 'global',
        min_confidence   INTEGER NOT NULL DEFAULT 45,
        block_on_conflict BOOLEAN NOT NULL DEFAULT true,
        high_risk_multiplier NUMERIC NOT NULL DEFAULT 0.5,
        conflict_accuracy    NUMERIC NOT NULL DEFAULT 0,
        confidence_accuracy  NUMERIC NOT NULL DEFAULT 0,
        trades_analyzed  INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    logger.info("Gemini DB migration complete");
  }

  export async function loadJournal(): Promise<JournalEntry[]> {
    const {rows} = await pool.query("SELECT * FROM journal_entries ORDER BY timestamp DESC");
    return rows.map(r=>toJE(r as Record<string,unknown>));
  }
  export async function loadClosedTrades(chatId?: number): Promise<ClosedPaperTrade[]> {
    const {rows} = chatId != null
      ? await pool.query("SELECT * FROM paper_closed_trades WHERE chat_id=$1 ORDER BY closed_at DESC", [chatId])
      : await pool.query("SELECT * FROM paper_closed_trades ORDER BY closed_at DESC");
    return rows.map(r => toTrade(r as Record<string,unknown>));
  }
  export async function addJournalEntry(e: JournalEntry): Promise<void> {
    await pool.query(
      `INSERT INTO journal_entries(id,chat_id,symbol,interval,direction,entry_price,stop_loss,tp1,tp2,score,confidence,strategy,timestamp,factors)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`,
      [e.id,e.chatId??0,e.symbol,e.interval,e.direction,e.entryPrice,e.stopLoss,
       e.tp1,e.tp2,e.score,e.confidence,e.strategy??'UNKNOWN',e.timestamp,JSON.stringify(e.factors)]
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

  /**
   * Close the most recent open journal_entry for a given chatId+symbol+direction.
   * Called whenever a paper position closes (TP1, TP2, SL, BE, TIMEOUT).
   * positionId (H2 fix): when provided, restricts update to the specific linked position,
   * preventing accidental closure of a wrong journal entry if two entries exist.
   */
  export async function updateJournalClose(
    chatId: number,
    symbol: string,
    direction: "LONG"|"SHORT",
    closePrice: number,
    outcome: string,
    pnlPercent: number,
    positionId?: string
  ): Promise<void> {
    await pool.query(
      `UPDATE journal_entries
       SET closed_at=$1, close_price=$2, outcome=$3, pnl_percent=$4
       WHERE id = (
         SELECT id FROM journal_entries
         WHERE chat_id=$5 AND symbol=$6 AND direction=$7 AND closed_at IS NULL
           AND ($8::TEXT IS NULL OR position_id = $8)
         ORDER BY timestamp DESC LIMIT 1
       )`,
      [new Date().toISOString(), closePrice, outcome, pnlPercent, chatId, symbol, direction, positionId ?? null]
    );
  }

  /**
   * Links a journal entry to the paper position that was opened for it.
   * Called in scheduler.ts after openPaperPosition returns position.id.
   * Enables updateJournalClose to find the exact right entry on close.
   */
  export async function linkJournalToPosition(
    chatId: number,
    symbol: string,
    direction: "LONG"|"SHORT",
    positionId: string
  ): Promise<void> {
    await pool.query(
      `UPDATE journal_entries SET position_id=$1
       WHERE id = (
         SELECT id FROM journal_entries
         WHERE chat_id=$2 AND symbol=$3 AND direction=$4 AND closed_at IS NULL AND position_id IS NULL
         ORDER BY timestamp DESC LIMIT 1
       )`,
      [positionId, chatId, symbol, direction]
    );
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
      initialBalance:   acc?Number(acc["initial_balance"]):10000,
      peakBalance:      acc?Number(acc["peak_balance"]):balance,
      totalCommission:  acc?Number(acc["total_commission"]??0):0,
      totalSlippage:    acc?Number(acc["total_slippage"]??0):0,
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
        `INSERT INTO paper_positions(id,chat_id,symbol,direction,entry_price,size,stop_loss,tp1,tp2,strategy,opened_at,breakeven_moved,trail_atr,llm_sentiment,llm_risk,llm_confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [pos.id,chatId,pos.symbol,pos.direction,pos.entryPrice,pos.size,
         pos.stopLoss,pos.tp1,pos.tp2,pos.strategy??'TREND',pos.openedAt,pos.breakevenMoved,pos.trailAtr,
         pos.llmSentiment??null,pos.llmRisk??null,pos.llmConfidence??null]
      );
    }
    for (const t of a.closedTrades) {
      await pool.query(
        `INSERT INTO paper_closed_trades(id,chat_id,symbol,direction,entry_price,close_price,size,pnl,pnl_percent,outcome,strategy,opened_at,closed_at,llm_sentiment,llm_risk,llm_confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING`,
        [t.id,chatId,t.symbol,t.direction,t.entryPrice,t.closePrice,
         t.size,t.pnl,t.pnlPercent,t.outcome,t.strategy??'TREND',t.openedAt,t.closedAt,
         t.llmSentiment??null,t.llmRisk??null,t.llmConfidence??null]
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
  export async function loadGeminiWeights(): Promise<GeminiWeights> {
    const {rows} = await pool.query("SELECT * FROM gemini_weights WHERE id='global'");
    if(!rows.length) return {...DEF_G};
    const r=rows[0] as Record<string,unknown>;
    return {
      minConfidence:Number(r["min_confidence"]),
      blockOnConflict:Boolean(r["block_on_conflict"]),
      highRiskMultiplier:Number(r["high_risk_multiplier"]),
      conflictAccuracy:Number(r["conflict_accuracy"]),
      confidenceAccuracy:Number(r["confidence_accuracy"]),
      tradesAnalyzed:Number(r["trades_analyzed"]),
    };
  }
  export async function saveGeminiWeights(w: GeminiWeights): Promise<void> {
    await pool.query(
      `INSERT INTO gemini_weights(id,min_confidence,block_on_conflict,high_risk_multiplier,conflict_accuracy,confidence_accuracy,trades_analyzed,updated_at)
       VALUES('global',$1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(id) DO UPDATE SET min_confidence=$1,block_on_conflict=$2,high_risk_multiplier=$3,
         conflict_accuracy=$4,confidence_accuracy=$5,trades_analyzed=$6,updated_at=NOW()`,
      [w.minConfidence,w.blockOnConflict,w.highRiskMultiplier,w.conflictAccuracy,w.confidenceAccuracy,w.tradesAnalyzed]
    );
  }
  export async function adaptGeminiWeights(): Promise<GeminiWeights|null> {
    const {rows} = await pool.query(
      `SELECT pnl_percent, llm_sentiment, llm_risk, llm_confidence, direction
       FROM paper_closed_trades WHERE llm_confidence IS NOT NULL ORDER BY closed_at DESC LIMIT 500`
    );
    if(rows.length < 100) return null;

    const current = await loadGeminiWeights();
    type Row = {pnl:number;sentiment:string;risk:string;confidence:number;direction:string;win:boolean};
    const trades: Row[] = (rows as Record<string,unknown>[]).map(r=>({
      pnl:Number(r["pnl_percent"]), sentiment:String(r["llm_sentiment"]??'neutral'),
      risk:String(r["llm_risk"]??'medium'), confidence:Number(r["llm_confidence"]),
      direction:String(r["direction"]), win:Number(r["pnl_percent"])>0,
    }));

    const allWR = trades.filter(t=>t.win).length / trades.length;

    const conflict = trades.filter(t=>
      (t.sentiment==="bearish"&&t.direction==="LONG")||
      (t.sentiment==="bullish"&&t.direction==="SHORT")
    );
    const conflictWR  = conflict.length ? conflict.filter(t=>t.win).length/conflict.length : allWR;
    const conflictAcc = conflict.length>=20 ? Math.max(0, 1 - conflictWR/Math.max(allWR,0.01)) : current.conflictAccuracy;
    const blockOnConflict = conflictAcc > 0.15;

    const hiConf = trades.filter(t=>t.confidence>=70);
    const loConf = trades.filter(t=>t.confidence<40);
    const hiWR   = hiConf.length ? hiConf.filter(t=>t.win).length/hiConf.length : allWR;
    const loWR   = loConf.length ? loConf.filter(t=>t.win).length/loConf.length : allWR;
    const confAcc = hiConf.length>=10&&loConf.length>=10 ? hiWR-loWR : current.confidenceAccuracy;
    let minConf = current.minConfidence;
    if(confAcc > 0.10) minConf = Math.min(minConf + 3, 65);
    else if(confAcc < 0.02) minConf = Math.max(minConf - 3, 30);

    const hiRisk  = trades.filter(t=>t.risk==="high");
    const hiRiskWR = hiRisk.length ? hiRisk.filter(t=>t.win).length/hiRisk.length : allWR;
    let riskMult = current.highRiskMultiplier;
    if(hiRisk.length>=10) {
      if(hiRiskWR < allWR - 0.10) riskMult = Math.max(riskMult - 0.05, 0.25);
      else if(hiRiskWR >= allWR)   riskMult = Math.min(riskMult + 0.10, 1.00);
    }

    const updated: GeminiWeights = {minConfidence:minConf,blockOnConflict,highRiskMultiplier:riskMult,
      conflictAccuracy:conflictAcc,confidenceAccuracy:confAcc,tradesAnalyzed:rows.length};
    await saveGeminiWeights(updated);
    logger.info({updated}, "Gemini weights adapted");
    return updated;
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
  export async function saveBalance(chatId: number, balance: number, initialBalance: number, peakBalance: number): Promise<void> {
    const peak = Math.max(balance, peakBalance);
    await pool.query(
      `INSERT INTO paper_accounts(chat_id,balance,initial_balance,peak_balance) VALUES($1,$2,$3,$4)
       ON CONFLICT(chat_id) DO UPDATE SET balance=EXCLUDED.balance, peak_balance=EXCLUDED.peak_balance`,
      [chatId, balance, initialBalance, peak]
    );
  }
  export async function addAccountCosts(chatId: number, commission: number, slippage: number): Promise<void> {
    await pool.query(
      `UPDATE paper_accounts SET
         total_commission = COALESCE(total_commission,0) + $1,
         total_slippage   = COALESCE(total_slippage,0)   + $2
       WHERE chat_id = $3`,
      [commission, slippage, chatId]
    );
  }
  export async function insertPosition(chatId: number, pos: PaperPosition): Promise<void> {
    await pool.query(
      `INSERT INTO paper_positions(id,chat_id,symbol,direction,entry_price,size,stop_loss,tp1,tp2,strategy,opened_at,breakeven_moved,trail_atr,llm_sentiment,llm_risk,llm_confidence,equity_at_open,pending_entry_size,pending_entry_trigger,market_regime,interval)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(id) DO NOTHING`,
      [pos.id,chatId,pos.symbol,pos.direction,pos.entryPrice,pos.size,
       pos.stopLoss,pos.tp1,pos.tp2,pos.strategy??'TREND',pos.openedAt,pos.breakevenMoved,pos.trailAtr,
       pos.llmSentiment??null,pos.llmRisk??null,pos.llmConfidence??null,pos.equityAtOpen??null,
       pos.pendingEntrySize??null,pos.pendingEntryTrigger??null, pos.marketRegime??'sideways', pos.interval??'1h']
    );
  }
  export async function deletePosition(chatId: number, posId: string): Promise<void> {
    await pool.query("DELETE FROM paper_positions WHERE chat_id=$1 AND id=$2", [chatId, posId]);
  }
  export async function updatePosition(chatId: number, pos: PaperPosition): Promise<void> {
    await pool.query(
      `UPDATE paper_positions SET stop_loss=$1,breakeven_moved=$2,trail_atr=$3,size=$4,pending_entry_size=$5,pending_entry_trigger=$6,market_regime=$7 WHERE chat_id=$8 AND id=$9`,
      [pos.stopLoss, pos.breakevenMoved, pos.trailAtr, pos.size,
       pos.pendingEntrySize??null, pos.pendingEntryTrigger??null, pos.marketRegime??'sideways', chatId, pos.id]
    );
  }
  export async function insertClosedTrade(chatId: number, t: ClosedPaperTrade): Promise<void> {
    await pool.query(
      `INSERT INTO paper_closed_trades(id,chat_id,symbol,direction,entry_price,close_price,size,pnl,pnl_percent,outcome,strategy,opened_at,closed_at,llm_sentiment,llm_risk,llm_confidence,commission,slippage,pnl_equity_pct)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO NOTHING`,
      [t.id,chatId,t.symbol,t.direction,t.entryPrice,t.closePrice,
       t.size,t.pnl,t.pnlPercent,t.outcome,t.strategy??'TREND',t.openedAt,t.closedAt,
       t.llmSentiment??null,t.llmRisk??null,t.llmConfidence??null,
       t.commission??0,t.slippage??0,t.pnlEquityPct??null]
    );
  }
  export function genId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

  /**
   * Atomically claim a position for closing by deleting it from the DB.
   * Returns true if we deleted exactly 1 row (this caller "won" the race).
   * Returns false if 0 rows deleted (another concurrent cycle already closed it).
   * This is the primary guard against double-close in concurrent checkPaperPositions calls.
   */
  export async function tryClaimPosition(chatId: number, posId: string): Promise<boolean> {
    const result = await pool.query(
      "DELETE FROM paper_positions WHERE chat_id=$1 AND id=$2",
      [chatId, posId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomically mark TP1 as processed (sets breakeven_moved = true).
   * Returns true if the update succeeded (position existed with breakeven_moved=false).
   * Returns false if already true — another concurrent cycle already processed TP1.
   */
  export async function tryMarkTP1(chatId: number, posId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE paper_positions SET breakeven_moved=true
       WHERE chat_id=$1 AND id=$2 AND breakeven_moved=false`,
      [chatId, posId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  logger.info("PostgreSQL storage initialized");
