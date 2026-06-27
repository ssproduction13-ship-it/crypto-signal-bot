import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal } from "./signals.js";
  import { checkPaperPositions, openPaperPosition, getPaperStats } from "./paper-trading.js";
  import { canOpenTrade } from "./risk-manager.js";
  import { loadSettings, loadPaperAccount, loadWeights } from "./storage.js";
  import { kuCoinWs } from "./websocket.js";
  import { evaluateABVariants, checkDegradation } from "./ab-testing.js";
  import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";
  import {
    detectMarketRegime, isStrategyBlockedInRegime, loadStrategyWeights,
    getClosedTradeCount, runAdaptationCycle, generateLearningReport, snapshotStrategyVersion,
    selectBestStrategy, recordLossReason, classifyLossReason, getAllStrategyStatuses,
    type StrategySignalInput,
  } from "./learning-engine.js";
  import { isTimeRestricted } from "./time-analytics.js";
  import { getInstrumentPriority } from "./instrument-analytics.js";
  import { checkShadowPositions, openShadowPosition } from "./shadow-testing.js";
  import { saveTradeFeatures, type TradeFeatures } from "./similar-trades.js";
  import { calcFeatureImportance, applyFeatureWeightAdjustments, formatFeatureImportance } from "./feature-importance.js";
  import { runAIResearch } from "./ai-researcher.js";
  import { detectMarketDrift } from "./market-drift.js";
  import { checkLearningHealth } from "./health-monitor.js";
  import { makeTrace, saveDecisionTrace } from "./decision-trace.js";
  import { runWalkForwardTest } from "./walk-forward.js";
  import { evaluateCooldown } from "./auto-cooldown.js";
  import { generateWeeklyResearch } from "./weekly-research.js";
  import { autoSnapshotAfterLearning } from "./evolution-timeline.js";
  import { calcReadinessIndex } from "./readiness-index.js";
  import { checkNewListings } from "./listing-watcher.js";
import { checkMTFAlignment } from "./mtf-filter.js";
import { checkCorrelationRisk } from "./correlation-risk.js";

  interface Sub { chatId: number; symbol: string; interval: Interval; }
  const subs    = new Map<string, Sub>();
  const chatIds = new Set<number>();
  let _bot: Telegraf | null = null;
  let _lastMilestoneTrades = 0;

  const recentlyProcessed = new Map<string, number>();
  const DEBOUNCE_MS = 30_000;

  function key(chatId: number, symbol: string) { return `${chatId}:${symbol}`; }

  async function safeSend(chatId: number, text: string) {
    try { await _bot?.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" }); }
    catch (err) { logger.error({ err, chatId }, "safeSend failed"); }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  export async function initSubscriptions(): Promise<void> {
    const { rows } = await pool.query("SELECT chat_id,symbol,interval FROM subscriptions");
    for (const r of rows as Record<string, unknown>[]) {
      const chatId = Number(r["chat_id"]);
      const sym    = r["symbol"] as string;
      const intv   = r["interval"] as Interval;
      subs.set(key(chatId, sym), { chatId, symbol: sym, interval: intv });
      chatIds.add(chatId);
      kuCoinWs.addSubscription(sym, intv);
    }
    logger.info({ count: subs.size }, "Subscriptions restored");
  }

  export function subscribe(chatId: number, symbol: string, interval: Interval = "1h"): void {
    subs.set(key(chatId, symbol), { chatId, symbol, interval });
    chatIds.add(chatId);
    kuCoinWs.addSubscription(symbol, interval);
    pool.query(
      "INSERT INTO subscriptions(chat_id,symbol,interval) VALUES($1,$2,$3) ON CONFLICT(chat_id,symbol) DO UPDATE SET interval=EXCLUDED.interval",
      [chatId, symbol, interval]
    ).catch((err: unknown) => logger.error({ err }, "subscribe DB error"));
  }

  export function unsubscribe(chatId: number, symbol: string): boolean {
    const sub     = subs.get(key(chatId, symbol));
    const removed = subs.delete(key(chatId, symbol));
    if (sub && ![...subs.values()].some(s => s.symbol === symbol && s.interval === sub.interval))
      kuCoinWs.removeSubscription(symbol, sub.interval);
    if (![...subs.values()].some(s => s.chatId === chatId)) chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1 AND symbol=$2", [chatId, symbol])
      .catch((err: unknown) => logger.error({ err }, "unsubscribe DB error"));
    return removed;
  }

  export function unsubscribeAll(chatId: number): number {
    let n = 0;
    for (const [k, s] of subs.entries()) if (s.chatId === chatId) { subs.delete(k); n++; }
    chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1", [chatId])
      .catch((err: unknown) => logger.error({ err }, "unsubscribeAll DB error"));
    return n;
  }

  export function listSubscriptions(chatId: number): Sub[] {
    return [...subs.values()].filter(s => s.chatId === chatId);
  }

  // ── Dynamic score threshold ─────────────────────────────────────────────────
  // Learning mode: lower thresholds to collect more trade data
  function dynamicMinScore(marketIndex: number): number {
    if (marketIndex >= 70) return 30;
    if (marketIndex >= 50) return 33;
    if (marketIndex >= 30) return 36;
    return 40;
  }
  // ── Signal analysis + auto-trade ─────────────────────────────────────────────
  async function analyzeAndTrade(sub: Sub): Promise<void> {
    const debounceKey = `${sub.chatId}:${sub.symbol}`;
    const lastRun = recentlyProcessed.get(debounceKey) ?? 0;
    if (Date.now() - lastRun < DEBOUNCE_MS) return;
    recentlyProcessed.set(debounceKey, Date.now());

    try {
      const sig = await generateSignal(sub.symbol, sub.interval, sub.chatId);
      const now = new Date();
      const regime = detectMarketRegime(sig.market, sig.marketRating);

      // ── Build strategy selection ───────────────────────────────────────────
      const strategySignals: StrategySignalInput[] = [];
      if (sig.strategies?.length) {
        for (const s of sig.strategies) {
          strategySignals.push({
            strategy: s.strategy,
            score: s.score ?? sig.score.total,
            confidence: s.confidence ?? sig.confidence.score,
            direction: sig.score.direction as "LONG"|"SHORT",
          });
        }
      } else if (sig.bestStrategy?.strategy) {
        strategySignals.push({
          strategy: sig.bestStrategy.strategy,
          score: sig.score.total,
          confidence: sig.confidence.score,
          direction: sig.score.direction as "LONG"|"SHORT",
        });
      }
      const bestSig = strategySignals.length > 0
        ? await selectBestStrategy(strategySignals, regime)
        : null;
      const strat = bestSig?.strategy ?? sig.bestStrategy?.strategy ?? "TREND";

      // ── Load strategy status for gate checks ──────────────────────────────
      const [stratStatuses, stratWeights] = await Promise.all([
        getAllStrategyStatuses().catch(() => [] as any[]),
        loadStrategyWeights(),
      ]);
      const stratStatus = stratStatuses.find((s: any) => s.strategy === strat);
      const stratWeight = stratWeights[strat] ?? 1;
      const minScore = dynamicMinScore(sig.marketRating.index);

      // ── TRADE QUALITY GATE — 8 sequential checks ──────────────────────────
      const gate = makeTrace(sub.symbol, sig.score.direction, regime, strat);

      // 1. Market Chaos
      if (sig.market.isChaotic) {
        gate.fail("Рынок: хаос", "Хаотичный рынок", `ATR ${sig.market.atrPercent?.toFixed(1)}%`);
      } else {
        gate.pass("Рынок: хаос", "OK");
      }

      // 2. Signal Direction
      if (!gate.rejected && sig.score.direction === "NEUTRAL") {
        gate.fail("Направление", "Нейтральный сигнал", "NEUTRAL");
      } else if (!gate.rejected) {
        gate.pass("Направление", sig.score.direction);
      }

      // 3. Score & Confidence
      if (!gate.rejected && sig.score.total < minScore) {
        gate.fail("Score", `Score ниже порога`, sig.score.total, minScore);
      } else if (!gate.rejected) {
        gate.pass("Score", `${sig.score.total} / мин ${minScore}`);
      }

      if (!gate.rejected && sig.confidence.score < 12) {
        gate.fail("Confidence", "Низкая уверенность сигнала", `${sig.confidence.score}%`, "12%");
      } else if (!gate.rejected) {
        gate.pass("Confidence", `${sig.confidence.score}%`);
      }

      // 4. Strategy Trust Score — skip on cold-start (< 10 trades, no data yet)
      const minTrust = stratStatus?.quarantine ? 45 : 20;
      if (!gate.rejected && stratStatus && stratStatus.trades >= 10 && stratStatus.trustScore < minTrust) {
        gate.fail("Trust Score", `Trust Score стратегии ниже порога`, stratStatus.trustScore, minTrust);
      } else {
        if (!gate.rejected) gate.pass("Trust Score", stratStatus && stratStatus.trades >= 10 ? `${stratStatus.trustScore}/100` : "bootstrap (<10 сделок)");
      }

      // 5. Strategy Profit Factor (minimum 0.75 unless too few trades)
      if (!gate.rejected && stratStatus && stratStatus.trades >= 20 && stratStatus.profitFactor < 0.75) {
        gate.fail("Strategy PF", `PF стратегии критически низкий`, stratStatus.profitFactor.toFixed(2), "0.75");
      } else {
        if (!gate.rejected) gate.pass("Strategy PF", stratStatus?.trades >= 5 ? stratStatus.profitFactor.toFixed(2) : "мало данных");
      }

      // 6. Market Regime compatibility
      const { blocked: regimeBlocked, reason: regimeReason } = await isStrategyBlockedInRegime(strat, regime);
      if (!gate.rejected && regimeBlocked) {
        gate.fail("Режим рынка", regimeReason, `${strat} в ${regime}`);
      } else if (!gate.rejected) {
        gate.pass("Режим рынка", `${regime} → ${strat} OK`);
      }

      // 7. Strategy weight (disabled = 0)
      if (!gate.rejected && stratWeight === 0) {
        gate.fail("Вес стратегии", "Стратегия отключена движком адаптации", "0%");
      } else if (!gate.rejected) {
        gate.pass("Вес стратегии", `${(stratWeight * 100).toFixed(0)}%`);
      }

      // 8. Time restriction (historically bad hour/day)
      const { restricted: timeBlocked, reason: timeReason } = await isTimeRestricted(
        now.getHours(), (now.getDay() + 6) % 7
      );
      if (!gate.rejected && timeBlocked) {
        gate.fail("Временной слот", timeReason);
      } else if (!gate.rejected) {
        gate.pass("Временной слот", `${now.getHours()}h OK`);
      }


      // 9. MTF Alignment — block trades against 4H trend
      if (!gate.rejected) {
        const mtf = await checkMTFAlignment(sub.symbol, sig.score.direction as 'LONG'|'SHORT').catch(() => ({ allowed: true, trend4h: 'NEUTRAL' as const, reason: 'MTF ошибка — пропуск', ema20_4h: null, ema50_4h: null }));
        if (!mtf.allowed) {
          gate.fail('MTF фильтр (4H)', mtf.reason, `4H: ${mtf.trend4h}`);
        } else {
          gate.pass('MTF фильтр (4H)', `4H ${mtf.trend4h} → ${sig.score.direction} OK`);
        }
      } else {
        gate.skip('MTF фильтр (4H)', 'Предыдущий шаг не прошёл');
      }

      // ── Save decision trace async (non-blocking) ───────────────────────────
      saveDecisionTrace({
        symbol: sub.symbol, strategy: strat,
        direction: sig.score.direction, regime,
        timestamp: now.toISOString(),
        steps: gate.steps,
        verdict: gate.rejected ? "REJECT" : "OPEN",
        rejectReason: gate.rejectReason || undefined,
        score: sig.score.total, confidence: sig.confidence.score,
      }).catch(() => {});

      if (gate.rejected) {
        logger.debug({ symbol: sub.symbol, reason: gate.rejectReason, strat }, "Trade Quality Gate: REJECT");
        return;
      }

      logger.debug({ symbol: sub.symbol, strat, regime, score: sig.score.total }, "Trade Quality Gate: PASS");
      // ── End Trade Quality Gate ─────────────────────────────────────────────

      const settings = await loadSettings(sub.chatId);
      if (!settings.autoPaperTrade) return;

      const account  = await loadPaperAccount(sub.chatId);
      const openSyms = account.positions.map(p => p.symbol);
      // Pass actual positions count as source of truth (avoids risk_state counter desync)
      const { allowed, reason } = await canOpenTrade(sub.symbol, openSyms, account.positions.length, sig.score.direction as "LONG"|"SHORT", account.positions);

      if (!allowed) {
        if (reason.includes("DAILY_LIMIT") || reason.includes("WEEKLY_LIMIT") || reason.includes("3 убытка")) {
          await safeSend(sub.chatId, `🛑 *Торговля остановлена*\n${reason}`);
        }
        return;
      }


      // ── Correlation Guard ──────────────────────────────────────────────────
      const corrRisk = await checkCorrelationRisk(
        sub.chatId, sub.symbol,
        sig.score.direction as 'LONG'|'SHORT',
        settings.riskPercent
      ).catch(() => ({ allowed: true, sizeMultiplier: 1.0, reason: '', portfolioRisk: 0, correlatedRisk: 0, maxAllowedRisk: 5, message: '' }));

      if (!corrRisk.allowed) {
        logger.debug({ symbol: sub.symbol, reason: corrRisk.reason }, 'Correlation Guard: REJECT');
        await safeSend(sub.chatId, `🚫 *Correlation Guard*
${corrRisk.message}
_${corrRisk.reason}_`);
        return;
      }
      const effectiveRiskPct = settings.riskPercent * corrRisk.sizeMultiplier;
      if (corrRisk.sizeMultiplier < 1.0) {
        logger.debug({ symbol: sub.symbol, sizeMultiplier: corrRisk.sizeMultiplier }, 'Correlation Guard: size reduced');
      }

      const res = await openPaperPosition(
        sub.chatId, sub.symbol, sig.score.direction,
        sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
        effectiveRiskPct, sig.risk.atr,
        strat, regime
      );

      if (res.success) {
        // AI Learning Engine v3: save trade features for Similar Trades Engine
        if (res.position) {
          const now = new Date();
          const features: TradeFeatures = {
            symbol: sub.symbol,
            strategy: strat,
            direction: sig.score.direction,
            interval: sub.interval,
            score: sig.score.total,
            confidence: sig.confidence.score,
            rsi: sig.confidence.factors.recentPerformance, // use available data
            macdHistogram: 0,
            adxValue: 0,
            atrPercent: sig.risk.atr ? (sig.risk.atr / sig.risk.entryPrice) * 100 : 1,
            bbPercent: 50,
            ema20rel: 1, ema50rel: 1, ema200rel: 1,
            volumeAbove: 0,
            isSideways: sig.market.isSideways ? 1 : 0,
            isHighVol: sig.market.isHighVolatility ? 1 : 0,
            hour: now.getHours(),
            dayOfWeek: now.getDay(),
          };
          saveTradeFeatures(res.position.id, features).catch(() => {});
        }
        const dir = sig.score.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        const stratNames: Record<string, string> = {
          TREND: "📈 Тренд", BREAKOUT: "🚀 Пробой",
          VOLUME_IMPULSE: "⚡ Объёмный импульс", MEAN_REVERSION: "↩️ Возврат к среднему",
        };
        const regimeLabels: Record<string, string> = {
          trend_up: "📈 Тренд↑", trend_down: "📉 Тренд↓",
          sideways: "↔️ Боковик", high_vol: "⚡ Волат.", low_vol: "😴 Затишье",
        };
        logger.info({ symbol: sub.symbol, score: sig.score.total, direction: sig.score.direction, strat, regime }, "Auto trade opened");

        // Open shadow position in parallel for comparison
        loadWeights().then(w =>
          openShadowPosition(sub.symbol, (sig.score.direction === "NEUTRAL" ? "LONG" : sig.score.direction) as "LONG"|"SHORT",
            sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
            strat, w, regime
          ).catch(() => {})
        ).catch(() => {});

        await safeSend(sub.chatId,
          `🤖 *Новая позиция*\n\n` +
          `${dir} *${sub.symbol}*\n` +
          `Стратегия: ${stratNames[strat] ?? strat} (вес ${(stratWeight * 100).toFixed(0)}%)\n` +
          `Режим: ${regimeLabels[regime] ?? regime}\n` +
          `Score: ${sig.score.total}/100 | Min: ${minScore} | Conf: ${sig.confidence.score}%\n` +
          `${sig.marketRating.emoji} Рынок: ${sig.marketRating.label} (${sig.marketRating.index}/100)\n` +
          `Вход: \`${sig.risk.entryPrice.toPrecision(6)}\`\n` +
          `Стоп: \`${sig.risk.stopLoss.toPrecision(6)}\`\n` +
          `TP1: \`${sig.risk.tp1.toPrecision(6)}\` | TP2: \`${sig.risk.tp2.toPrecision(6)}\``
        );
      }
    } catch (err) {
      logger.error({ err, symbol: sub.symbol }, "analyzeAndTrade error");
    }
  }

  // ── Position monitor + Learning milestone check ─────────────────────────────
  async function checkPositions(): Promise<void> {
    for (const chatId of chatIds) {
      const sendFn = (msg: string) => safeSend(chatId, msg);
      const msgs = await checkPaperPositions(chatId, sendFn).catch(() => []);
      for (const m of msgs) await safeSend(chatId, m);
    }

    // Self Learning: every 100 trades → adapt weights, snapshot version, send report
    try {
      const total = await getClosedTradeCount();
      const milestone = Math.floor(total / 100) * 100;
      if (milestone > 0 && milestone > _lastMilestoneTrades) {
        _lastMilestoneTrades = milestone;
        logger.info({ total, milestone }, "100-trade milestone — running Self Learning cycle");
        const changes = await runAdaptationCycle(chatIds);
        await snapshotStrategyVersion(changes);
        const report = await generateLearningReport();
        for (const chatId of chatIds) await safeSend(chatId, report);

        // AI Learning Engine v3: Feature Importance + AI Researcher
        try {
          const importances = await calcFeatureImportance();
          if (importances.length) {
            const weightChanges = await applyFeatureWeightAdjustments(importances);
            const importanceReport = formatFeatureImportance(importances);
            const weightNote = weightChanges.length
              ? `\n\n⚙️ *Веса факторов скорректированы:*\n${weightChanges.join("\n")}`
              : "\n\n_Веса факторов не изменились_";
            for (const chatId of chatIds)
              await safeSend(chatId, importanceReport + weightNote);
          }
        } catch (err) {
          logger.error({ err }, "Feature importance cycle error");
        }

        try {
          const researchReport = await runAIResearch(total);
          for (const chatId of chatIds) await safeSend(chatId, researchReport);
        } catch (err) {
          logger.error({ err }, "AI Researcher cycle error");
        }
      }
    } catch (err) {
      logger.error({ err }, "Learning milestone cycle error");
    }
  }

  // ── WebSocket: new candle → analyze ─────────────────────────────────────────
  async function onNewCandle(symbol: string, interval: string): Promise<void> {
    for (const sub of subs.values()) {
      if (sub.symbol === symbol && sub.interval === interval)
        void analyzeAndTrade(sub);
    }
  }

  // ── AB evaluator (every 6 hours) ─────────────────────────────────────────────
  async function runABEvaluation(): Promise<void> {
    try {
      const championMsg = await evaluateABVariants();
      if (championMsg) for (const chatId of chatIds) await safeSend(chatId, championMsg);
      const degradationMsg = await checkDegradation();
      if (degradationMsg) for (const chatId of chatIds) await safeSend(chatId, degradationMsg);
    } catch (err) { logger.error({ err }, "AB evaluation error"); }
  }

  // ── Startup summary ─────────────────────────────────────────────────────────
  async function sendStartupSummary(): Promise<void> {
    await new Promise(r => setTimeout(r, 3000));
    if (!chatIds.size) return;
    const { loadPaperAccount: lpa } = await import("./storage.js");
    const { formatPrice } = await import("./risk.js");

    for (const chatId of chatIds) {
      try {
        const account = await lpa(chatId);
        const pos = account.positions;
        const ret = ((account.balance - account.initialBalance) / account.initialBalance * 100).toFixed(2);
        const posLines = pos.length === 0
          ? ["  нет открытых позиций"]
          : pos.map(p => {
              const dir = p.direction === "LONG" ? "🟢" : "🔴";
              const be  = p.breakevenMoved ? " [BE✓]" : "";
              return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be}\n     SL: ${formatPrice(p.stopLoss)} | TP1: ${formatPrice(p.tp1)}`;
            });
        const statusIcon = pos.length > 0 ? "🟡" : "🟢";
        await safeSend(chatId,
          `🤖 *Бот перезапущен* — слежу за рынком 24/7\n\n` +
          `${statusIcon} Позиций: *${pos.length}* | Баланс: *$${account.balance.toFixed(2)}* (${Number(ret) >= 0 ? "+" : ""}${ret}%)\n\n` +
          (pos.length > 0
            ? `📂 *Открытые позиции:*\n${posLines.join("\n")}\n\n_Уведомлю когда закроются_ 🔔`
            : `_Жду сигнал ≥48/100 по 21 монете_ 👀`)
        );
      } catch (err) { logger.error({ err, chatId }, "sendStartupSummary failed"); }
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  export function startScheduler(bot: Telegraf): void {
    _bot = bot;

    kuCoinWs.onNewCandle((sym, iv) => void onNewCandle(sym, iv));
    kuCoinWs.start().catch(err => logger.error({ err }, "KuCoin WS start error"));
    initSubscriptions()
      .then(() => sendStartupSummary())
      .catch(err => logger.error({ err }, "initSubscriptions error"));

    // Position monitor + learning milestone check every 30 seconds
    setInterval(() => { void checkPositions(); }, 30_000);

    // Shadow positions check every 5 minutes
    cron.schedule("*/5 * * * *", async () => {
      checkShadowPositions().catch(() => {});
    });

    // Silent fallback: re-analyze all subscriptions every 15 minutes
    cron.schedule("*/15 * * * *", async () => {
      if (!subs.size) return;
      logger.debug({ count: subs.size }, "Silent fallback scan");
      // Stagger: 250ms delay per pair to avoid KuCoin API rate limit burst
      let _stagger = 0;
      for (const sub of subs.values()) {
        const _s = sub;
        setTimeout(() => { void analyzeAndTrade(_s); }, _stagger);
        _stagger += 250;
      }
    });

    // A/B evaluation + degradation check every 6 hours
    cron.schedule("0 */6 * * *", async () => { void runABEvaluation(); });

    // Market rating broadcast every 4 hours (only on extremes)
    cron.schedule("0 */4 * * *", async () => {
      if (!chatIds.size) return;
      try {
        const { getCandles } = await import("./binance.js");
        const { calcIndicators } = await import("./indicators.js");
        const { assessMarket } = await import("./chaos-filter.js");
        const { calcMarketRating, formatMarketRating } = await import("./market-rating.js");
        const candles = await getCandles("BTCUSDT", "1h", 200);
        const ind    = calcIndicators(candles);
        const market = assessMarket(candles, ind);
        const rating = calcMarketRating(ind, market, candles);
        if (rating.index < 30 || rating.index > 75) {
          const msg = `📊 *Обновление рынка*\n\n` + formatMarketRating(rating);
          for (const chatId of chatIds) await safeSend(chatId, msg);
        }
      } catch (err) { logger.debug({ err }, "Market rating broadcast error"); }
    });

    // ── Release Candidate: New module cron jobs ──────────────────────────
    // Market Drift Detection — every 6 hours
    cron.schedule("0 */6 * * *", async () => {
      try {
        const drift = await detectMarketDrift();
        if (drift.hasDrift && (drift.severity === "moderate" || drift.severity === "severe")) {
          const icon = drift.severity === "severe" ? "🚨" : "⚠️";
          const msg = `${icon} *Market Drift обнаружен!*\n\n${drift.message}\n\nConfidence снижен на ${drift.confidenceReduction}%`;
          for (const chatId of chatIds) await safeSend(chatId, msg);
        }
      } catch (err) { logger.warn({ err }, "Market drift check error"); }
    });

    // Learning Health Monitor + Auto Cooldown — every hour (single combined message)
    cron.schedule("0 * * * *", async () => {
      try {
        const health = await checkLearningHealth();
        for (const chatId of chatIds) {
          const cooldown = await evaluateCooldown(chatId);
          const isCritical = health.overall === "critical" && health.alerts.length > 0;
          const isSevere   = cooldown.level === "severe";
          const isModerate = cooldown.level === "moderate";

          if (!isCritical && !isSevere && !isModerate) continue;

          const lines: string[] = [];

          // Header — single icon based on worst condition
          if (isSevere) {
            lines.push(`🚨 *Бот снизил активность до ${Math.round(cooldown.sizeMultiplier * 100)}%*`);
          } else if (isCritical) {
            lines.push(`🔴 *Слабая статистика последних 30 сделок*`);
          } else {
            lines.push(`⚠️ *Умеренное снижение активности до ${Math.round(cooldown.sizeMultiplier * 100)}%*`);
          }
          lines.push(``);

          // Health details (if critical)
          if (isCritical) {
            for (const alert of health.alerts) lines.push(alert);
            lines.push(``);
          }

          // Cooldown action (if active)
          if (isSevere || isModerate) {
            lines.push(`📉 Причина: ${cooldown.reason}`);
            lines.push(`📐 PF(30): ${cooldown.recentPF.toFixed(2)} | Просадка: ${cooldown.recentDrawdown.toFixed(1)}%`);
            lines.push(`🔧 Размер позиции: ${Math.round(cooldown.sizeMultiplier * 100)}% | Мин. Confidence +${cooldown.minConfidenceBoost}%`);
            lines.push(``);
            lines.push(`_Ограничения снимутся автоматически когда статистика улучшится._`);
          }

          await safeSend(chatId, lines.join("\n"));
        }
      } catch (err) { logger.warn({ err }, "Health monitor / cooldown error"); }
    });

    // Walk-Forward Testing — after every adaptation cycle (every 12 hours)
    cron.schedule("0 */12 * * *", async () => {
      try {
        const strategies: Array<"TREND" | "BREAKOUT" | "VOLUME_IMPULSE" | "MEAN_REVERSION"> = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];
        for (const st of strategies) await runWalkForwardTest(st).catch(() => {});
        await autoSnapshotAfterLearning();
        await calcReadinessIndex().catch(() => {});
      } catch (err) { logger.warn({ err }, "Walk-forward / snapshot error"); }
    });

    // AI Weekly Research — every 7 days at Monday 09:00
    cron.schedule("0 9 * * 1", async () => {
      try {
        const report = await generateWeeklyResearch();
        const msg = report.fullText.slice(0, 4000);
        for (const chatId of chatIds) await safeSend(chatId, msg);
      } catch (err) { logger.warn({ err }, "Weekly research error"); }
    });

    logger.info("Scheduler started — Self Learning Engine v2 + RC modules active");
  }
  