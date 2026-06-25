import { getPrice } from "./binance.js";
  import {
    loadPaperAccount, savePaperAccount, loadSettings, genId,
    type PaperPosition, type ClosedPaperTrade,
  } from "./storage.js";
  import { recordPositionClosed, recordPositionOpened, canOpenTrade } from "./risk-manager.js";
  import { formatPrice } from "./risk.js";
  import { logger } from "../lib/logger.js";

  export async function openPaperPosition(
    chatId: number, symbol: string, direction: "LONG"|"SHORT",
    entryPrice: number, stopLoss: number, tp1: number, tp2: number,
    riskPercent?: number, atr?: number
  ): Promise<{success:boolean;message:string;position?:PaperPosition}> {
    const account  = await loadPaperAccount(chatId);
    const settings = await loadSettings(chatId);
    const rp = riskPercent ?? settings.riskPercent;
    const maxLoss  = account.balance * (rp / 100);
    const stopDist = Math.abs(entryPrice - stopLoss);
    const size     = stopDist > 0 ? maxLoss / stopDist : 0;
    if (size <= 0) return {success:false,message:"❌ Ошибка расчёта размера позиции"};

    const existing = account.positions.find(p=>p.symbol===symbol&&p.direction===direction);
    if (existing) return {success:false,message:`⚠️ Позиция ${symbol} ${direction} уже открыта`};

    const pos: PaperPosition = {
      id:genId(), symbol, direction, entryPrice, size,
      stopLoss, tp1, tp2, openedAt:new Date().toISOString(),
      chatId, breakevenMoved:false, trailAtr:atr??null,
    };
    account.positions.push(pos);
    await savePaperAccount(chatId, account);
    await recordPositionOpened();

    return {
      success:true, position:pos,
      message:
        `✅ *Виртуальная позиция открыта*\n\n` +
        `${direction==="LONG"?"🟢 LONG":"🔴 SHORT"} ${symbol}\n` +
        `Вход: ${formatPrice(entryPrice)}\n` +
        `Стоп: ${formatPrice(stopLoss)}\n` +
        `TP1: ${formatPrice(tp1)} | TP2: ${formatPrice(tp2)}\n` +
        `Размер: ${size.toFixed(4)} ед. | Риск: $${maxLoss.toFixed(2)}`
    };
  }

  /** Returns string[] of alert messages — keeps the existing API surface */
  export async function checkPaperPositions(chatId: number): Promise<string[]> {
    const account  = await loadPaperAccount(chatId);
    const msgs: string[] = [];
    const remaining: PaperPosition[] = [];

    for (const pos of account.positions) {
      try {
        const price = await getPrice(pos.symbol);

        // ── breakeven: move SL when position reaches +1R ────────────────
        if (!pos.breakevenMoved && pos.trailAtr != null) {
          const r1 = Math.abs(pos.tp1 - pos.entryPrice);
          const gain = pos.direction==="LONG" ? price-pos.entryPrice : pos.entryPrice-price;
          if (gain >= r1) {
            pos.stopLoss = pos.entryPrice;
            pos.breakevenMoved = true;
            msgs.push(`🟡 *${pos.symbol}*: стоп перенесён в безубыток (${formatPrice(pos.entryPrice)})`);
          }
        }

        // ── trailing stop: after breakeven, trail by 1.5×ATR ────────────
        if (pos.breakevenMoved && pos.trailAtr != null && pos.trailAtr > 0) {
          const trail = pos.direction==="LONG"
            ? price - pos.trailAtr * 1.5
            : price + pos.trailAtr * 1.5;
          if (pos.direction==="LONG"  && trail > pos.stopLoss) pos.stopLoss = trail;
          if (pos.direction==="SHORT" && trail < pos.stopLoss) pos.stopLoss = trail;
        }

        // ── check close conditions ───────────────────────────────────────
        let closeReason: string|null = null, closePrice = price;
        if (pos.direction==="LONG") {
          if (price<=pos.stopLoss)  { closeReason=pos.breakevenMoved?"BE":"SL"; closePrice=pos.stopLoss; }
          else if (price>=pos.tp2)  { closeReason="TP2"; closePrice=pos.tp2; }
          else if (price>=pos.tp1)  { closeReason="TP1"; closePrice=pos.tp1; }
        } else {
          if (price>=pos.stopLoss)  { closeReason=pos.breakevenMoved?"BE":"SL"; closePrice=pos.stopLoss; }
          else if (price<=pos.tp2)  { closeReason="TP2"; closePrice=pos.tp2; }
          else if (price<=pos.tp1)  { closeReason="TP1"; closePrice=pos.tp1; }
        }

        if (closeReason) {
          const pnl = pos.direction==="LONG"
            ? (closePrice-pos.entryPrice)*pos.size
            : (pos.entryPrice-closePrice)*pos.size;
          const pnlPct = pos.direction==="LONG"
            ? ((closePrice-pos.entryPrice)/pos.entryPrice)*100
            : ((pos.entryPrice-closePrice)/pos.entryPrice)*100;

          const trade: ClosedPaperTrade = {
            id:genId(), symbol:pos.symbol, direction:pos.direction,
            entryPrice:pos.entryPrice, closePrice, size:pos.size,
            pnl, pnlPercent:pnlPct, outcome:closeReason,
            openedAt:pos.openedAt, closedAt:new Date().toISOString(),
          };
          account.balance += pnl;
          account.closedTrades.unshift(trade);

          const em = pnl>0 ? (closeReason==="TP2"?"🚀":"✅") : (closeReason==="BE"?"🟡":"❌");
          msgs.push(
            `${em} *${pos.symbol} закрыта (${closeReason})*\n` +
            `P&L: ${pnl>=0?"+":""}${pnl.toFixed(2)} (${pnlPct>=0?"+":""}${pnlPct.toFixed(2)}%)\n` +
            `Баланс: $${account.balance.toFixed(2)}`
          );
          const riskAlert = await recordPositionClosed((pnl/(account.balance-pnl))*100, pnl>0);
          if (riskAlert) msgs.push(riskAlert);
        } else {
          remaining.push(pos);
        }
      } catch(err) {
        logger.warn({err,symbol:pos.symbol},"checkPaperPositions: getPrice failed");
        remaining.push(pos);
      }
    }

    account.positions = remaining;
    await savePaperAccount(chatId, account);
    return msgs;
  }

  export async function getPaperStats(chatId: number): Promise<string> {
    const account = await loadPaperAccount(chatId);
    const trades  = account.closedTrades;
    const wins    = trades.filter(t=>t.pnl>0);
    const losses  = trades.filter(t=>t.pnl<=0);
    const avgW    = wins.length  ? wins.reduce((a,t)=>a+t.pnlPercent,0)/wins.length   : 0;
    const avgL    = losses.length? Math.abs(losses.reduce((a,t)=>a+t.pnlPercent,0)/losses.length): 0;
    const gW      = wins.reduce((a,t)=>a+t.pnl,0);
    const gL      = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
    const pf      = gL>0 ? gW/gL : gW>0?999:0;
    const ret     = ((account.balance-account.initialBalance)/account.initialBalance)*100;

    const posLines = account.positions.length===0
      ? ["  нет открытых позиций"]
      : account.positions.map(p=>{
          const dir = p.direction==="LONG"?"🟢":"🔴";
          const be  = p.breakevenMoved?" [BE✓]":"";
          return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be} | SL: ${formatPrice(p.stopLoss)}`;
        });

    return [
      `💼 *Виртуальный счёт*`, "",
      `Баланс: *$${account.balance.toFixed(2)}*`,
      `${ret>=0?"📈":"📉"} P&L: ${ret>=0?"+":""}${ret.toFixed(2)}%`, "",
      `📊 Сделок: ${trades.length} | WR: ${trades.length?(wins.length/trades.length*100).toFixed(1):0}%`,
      `Win avg: +${avgW.toFixed(2)}% | Loss avg: -${avgL.toFixed(2)}%`,
      `Profit Factor: ${pf===999?"∞":pf.toFixed(2)}`, "",
      `📂 Открытых позиций (${account.positions.length}/3):`,
      ...posLines,
    ].join("\n");
  }
  