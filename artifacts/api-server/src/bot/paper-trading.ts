import { getPrice } from "./binance.js";
import {
  loadPaperAccount,
  savePaperAccount,
  genId,
  type PaperPosition,
  type ClosedPaperTrade,
} from "./storage.js";
import { formatPrice } from "./risk.js";

export async function openPaperPosition(
  chatId: number,
  symbol: string,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  riskPercent: number
): Promise<{ success: boolean; message: string }> {
  const account = await loadPaperAccount(chatId);

  const maxLoss = account.balance * (riskPercent / 100);
  const stopDist = Math.abs(entryPrice - stopLoss);
  const size = stopDist > 0 ? maxLoss / stopDist : 0;

  if (size <= 0) {
    return { success: false, message: "❌ Ошибка расчёта размера позиции" };
  }

  const existing = account.positions.find(
    (p) => p.symbol === symbol && p.direction === direction
  );
  if (existing) {
    return {
      success: false,
      message: `⚠️ Позиция ${symbol} ${direction} уже открыта`,
    };
  }

  const position: PaperPosition = {
    id: genId(),
    symbol,
    direction,
    entryPrice,
    size,
    stopLoss,
    tp1,
    tp2,
    openedAt: new Date().toISOString(),
    chatId,
  };

  account.positions.push(position);
  await savePaperAccount(chatId, account);

  const maxLossUSD = maxLoss.toFixed(2);
  return {
    success: true,
    message:
      `✅ *Виртуальная позиция открыта*\n\n` +
      `Пара: ${symbol}\n` +
      `Направление: ${direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}\n` +
      `Вход: ${formatPrice(entryPrice)}\n` +
      `Стоп: ${formatPrice(stopLoss)}\n` +
      `TP1: ${formatPrice(tp1)}\n` +
      `TP2: ${formatPrice(tp2)}\n` +
      `Размер: ${size.toFixed(4)} ед.\n` +
      `Макс. убыток: $${maxLossUSD}`,
  };
}

export async function checkPaperPositions(chatId: number): Promise<string[]> {
  const account = await loadPaperAccount(chatId);
  const messages: string[] = [];

  for (const pos of [...account.positions]) {
    try {
      const price = await getPrice(pos.symbol);
      let outcome: string | null = null;
      let closePrice = price;

      if (pos.direction === "LONG") {
        if (price <= pos.stopLoss) { outcome = "SL"; closePrice = pos.stopLoss; }
        else if (price >= pos.tp2) { outcome = "TP2"; closePrice = pos.tp2; }
        else if (price >= pos.tp1) { outcome = "TP1"; closePrice = pos.tp1; }
      } else {
        if (price >= pos.stopLoss) { outcome = "SL"; closePrice = pos.stopLoss; }
        else if (price <= pos.tp2) { outcome = "TP2"; closePrice = pos.tp2; }
        else if (price <= pos.tp1) { outcome = "TP1"; closePrice = pos.tp1; }
      }

      if (outcome) {
        const pnl =
          pos.direction === "LONG"
            ? (closePrice - pos.entryPrice) * pos.size
            : (pos.entryPrice - closePrice) * pos.size;
        const pnlPct =
          pos.direction === "LONG"
            ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - closePrice) / pos.entryPrice) * 100;

        account.balance += pnl;

        const closed: ClosedPaperTrade = {
          id: pos.id,
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          closePrice,
          size: pos.size,
          pnl,
          pnlPercent: pnlPct,
          outcome,
          openedAt: pos.openedAt,
          closedAt: new Date().toISOString(),
        };

        account.positions = account.positions.filter((p) => p.id !== pos.id);
        account.closedTrades.push(closed);

        const emoji = outcome === "SL" ? "🔴" : "🟢";
        messages.push(
          `${emoji} *Позиция закрыта: ${pos.symbol}*\n` +
          `Результат: ${outcome}\n` +
          `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
          `Баланс: $${account.balance.toFixed(2)}`
        );
      }
    } catch {
    }
  }

  await savePaperAccount(chatId, account);
  return messages;
}

export async function getPaperStats(chatId: number): Promise<string> {
  const account = await loadPaperAccount(chatId);
  const trades = account.closedTrades;

  if (trades.length === 0) {
    return (
      `💼 *Виртуальный счёт*\n\n` +
      `Баланс: $${account.balance.toFixed(2)}\n` +
      `Открытых позиций: ${account.positions.length}\n\n` +
      `Сделок ещё нет. Открой позицию через /signal и /paper\\_open`
    );
  }

  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const profitFactor =
    Math.abs(losses.reduce((a, t) => a + t.pnl, 0)) > 0
      ? wins.reduce((a, t) => a + t.pnl, 0) /
        Math.abs(losses.reduce((a, t) => a + t.pnl, 0))
      : 999;

  const totalReturn =
    ((account.balance - account.initialBalance) / account.initialBalance) * 100;

  const openList =
    account.positions.length > 0
      ? account.positions.map((p) => `  • ${p.symbol} ${p.direction}`).join("\n")
      : "  нет";

  return [
    `💼 *Виртуальный счёт*`,
    ``,
    `Начальный баланс: $${account.initialBalance.toFixed(2)}`,
    `Текущий баланс: $${account.balance.toFixed(2)}`,
    `Доходность: ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
    ``,
    `📊 *Статистика*`,
    `Всего сделок: ${trades.length}`,
    `WinRate: ${winRate.toFixed(1)}%`,
    `Profit Factor: ${profitFactor.toFixed(2)}`,
    `Общий P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
    ``,
    `📂 *Открытые позиции:*`,
    openList,
  ].join("\n");
}
