import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal } from "./signals.js";
  import { checkPaperPositions, openPaperPosition, getPaperStats } from "./paper-trading.js";
  import { canOpenTrade } from "./risk-manager.js";
  import { loadSettings, loadPaperAccount, loadWeights, linkJournalToPosition } from "./storage.js";
  import { kuCoinWs } from "./websocket.js";
  import { evaluateABVariants, checkDegradation } from "./ab-testing.js";
  import { pool, resetAllData } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";
  import {
    detectMarketRegime, isStrategyBlockedInRegime, loadStrategyWeights,
    getClosedTradeCount, runAdaptationCycle, generateLearningReport, snapshotStrategyVersion,
    selectBestStrategy, recordLossReason, classifyLossReason, getAllStrategyStatuses,
    generateWeeklyRanking,
    type StrategySignalInput, type StrategySelectionResult,
  } from "./learning-engine.js";
  import { isTimeRestricted } from "./time-analytics.js";
  import { getInstrumentPriority } from "./instrument-analytics.js";
import { generateDailyReport } from "./report-generator.js";
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

  // M5: exported so tests and external monitors can reference the same threshold
  export const MIN_FINAL_SCORE = 10;

  interface Sub { chatId: number; symbol: string; interval: Interval; }
  const subs    = new Map<string, Sub>();
  const chatIds = new Set<number>();
  let _bot: Telegraf | null = null;
  let _lastMilestoneTrades  = 0;
  let _lastAdaptationTrades = 0; // for 12h time-based adaptation guard

  // Restore milestone counter from DB so restarts don't re-trigger the same report
  async function initLastMilestoneTrades(): Promise<void> {
    try {
      const total = await getClosedTradeCount();
      _lastMilestoneTrades = Math.floor(total / 100) * 100;
      logger.info({ total, _lastMilestoneTrades }, 'Milestone counter restored from DB');
    } catch (err) {
      logger.warn({ err }, 'Could not restore milestone counter — defaulting to 0');
    }
  }

  // Restore timed-adaptation baseline from DB so restarts don't re-trigger immediately
  async function initLastAdaptationTrades(): Promise<void> {
    try {
      const total = await getClosedTradeCount();
      _lastAdaptationTrades = total;
      logger.info({ total }, 'Adaptation baseline restored from DB');
    } catch (err) {
      logger.warn({ err }, 'Could not restore adaptation baseline');
    }
  }

  const recentlyProcessed = new Map<string, number>();
  const DEBOUNCE_MS = 30_000;

  // ── One-per-hour notification dedup maps ──────────────────────────────────
  const lastCorrGuardNotify = new Map<number, number>(); // chatId → timestamp
  const CORR_GUARD_NOTIFY_MS = 60 * 60 * 1000; // 1 hour

  // ── Concurrency guard: prevents checkPositions from running in parallel ──────
  // Without this, setInterval fires a new cycle every 30s regardless of whether
  // the previous one finished. With 18+ open positions (18 API calls + DB ops),
  // execution takes >30s and two concurrent cycles double-close the same positions.
  let _checkPositionsRunning = false;

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

  function dynamicMinScore(marketIndex: number): number {
    if (marketIndex >= 70) return 32;
    if (marketIndex >= 50) return 35;
    if (marketIndex >= 30) return 38;
    return 42;
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
      const selectionResult: StrategySelectionResult | null = strategySignals.length > 0
        ? await selectBestStrategy(strategySignals, regime).catch(() => null)
        : null;
      if (!selectionResult) {
        logger.warn({ symbol: sub.symbol, reason: 'NO_STRATEGY_SELECTED' }, 'Decision Engine: NO TRADE — no valid strategy selected');
        return;
      }
      const bestSig = selectionResult.selected;
      const strat = bestSig.strategy;
      const stratTrust  = selectionResult.trustScore;
      const stratFScore = selectionResult.finalScore;
      const stratRanking = selectionResult.ranking ?? [];
      const isExploration = selectionResult.isExploration ?? false;

      const [stratStatuses, stratWeights] = await Promise.all([
        getAllStrategyStatuses().catch(() => [] as any[]),
        loadStrategyWeights().catch(() => ({} as Record<string,number>)),
      ]);
      const stratStatus = stratStatuses.find((s: any) => s.strategy === strat);
      const stratWeight = stratWeights[strat] ?? 1;
      const minScore = dynamicMinScore(sig.marketRating.index);

      const gate = makeTrace(sub.symbol, sig.score.direction, regime, strat);

      if (sig.market.isChaotic) {
        gate.fail("Рынок: хаос", "Хаотичный рынок", `ATR ${sig.market.atrPercent?.toFixed(1)}%`);
      } else {
        gate.pass("Рынок: хаос", "OK");
      }

      if (!gate.rejected && sig.score.direction === "NEUTRAL") {
        gate.fail("Направление", "Нейтральный сигнал", "NEUTRAL");
      } else if (!gate.rejected) {
        gate.pass("Направление", sig.score.direction);
      }

      if (!gate.rejected && sig.score.total < minScore) {
        gate.fail("Score", `Score ниже порога`, sig.score.total, minScore);
      } else if (!gate.rejected) {
        gate.pass("Score", `${sig.score.total} / мин ${minScore}`);
      }

      if (!gate.rejected && sig.confidence.score < 8) {
        gate.fail("Confidence", "Низкая уверенность сигнала", `${sig.confidence.score}%`, "12%");
      } else if (!gate.rejected) {
        gate.pass("Confidence", `${sig.confidence.score}%`);
      }

      // ── ATR Filter ────────────────────────────────────────────────────────────────────────
      let atrSizeMultiplier = 1.0;
      if (!gate.rejected && sig.risk.atr != null && sig.risk.entryPrice > 0) {
        const atrPercent = (sig.risk.atr / sig.risk.entryPrice) * 100;
        if (atrPercent > 4.0) {
          gate.fail("ATR Filter", "Слишком высокая волатильность", `ATR ${atrPercent.toFixed(2)}%`, "макс 4%");
        } else if (atrPercent >= 2.5) {
          atrSizeMultiplier = 0.5;
          gate.pass("ATR Filter", `ATR ${atrPercent.toFixed(2)}% — размер снижен до 50%`);
        } else {
          gate.pass("ATR Filter", `ATR ${atrPercent.toFixed(2)}% — OK`);
        }
      } else if (!gate.rejected) {
        gate.pass("ATR Filter", "ATR недоступен — пропуск фильтра");
      } else {
        gate.skip("ATR Filter", "Предыдущий шаг не прошёл");
      }

      // ── Quarantine gate ───────────────────────────────────────────────────────────────────────
      // Стратегия в карантине допускается только при высоком качестве сигнала
      if (!gate.rejected && stratStatus?.status === "quarantine") {
        const qScore = sig.score.total >= 75;
        const qConf  = sig.confidence.score >= 40;
        const qFS    = stratFScore >= 20;
        if (!qScore || !qConf || !qFS) {
          const why = !qScore
            ? `Score ${sig.score.total} < 75`
            : !qConf
            ? `Conf ${sig.confidence.score}% < 40%`
            : `FinalScore ${stratFScore.toFixed(1)} < 20`;
          gate.fail("Карантин", "Стратегия в карантине — недостаточное качество сигнала", why, "Score≥75 | Conf≥40% | FS≥20");
        } else {
          gate.pass("Карантин", `Score=${sig.score.total} Conf=${sig.confidence.score}% FS=${stratFScore.toFixed(1)} — допуск`);
        }
      } else if (!gate.rejected) {
        gate.skip("Карантин", "Стратегия активна");
      }

      const minTrust = stratStatus?.status === "quarantine" ? 20 : 5;
      if (!gate.rejected && stratStatus && stratStatus.trades >= 20 && stratStatus.trustScore < minTrust) {
        gate.fail("Trust Score", `Trust Score стратегии ниже порога`, stratStatus.trustScore, minTrust);
      } else {
        if (!gate.rejected) gate.pass("Trust Score", stratStatus && stratStatus.trades >= 20 ? `${stratStatus.trustScore}/100` : `bootstrap (${stratStatus?.trades ?? 0}/20 сделок)`);
      }

      if (!gate.rejected && stratStatus && stratStatus.trades >= 20 && stratStatus.profitFactor < 0.1) {
        gate.fail("Strategy PF", `PF стратегии критически низкий`, stratStatus.profitFactor.toFixed(2), "0.75");
      } else {
        if (!gate.rejected) gate.pass("Strategy PF", stratStatus?.trades >= 5 ? stratStatus.profitFactor.toFixed(2) : "мало данных");
      }

      const { blocked: regimeBlocked, reason: regimeReason } = await isStrategyBlockedInRegime(strat, regime, sub.interval).catch(() => ({ blocked: false, reason: '' }));
      if (!gate.rejected && regimeBlocked) {
        gate.fail("Режим рынка", regimeReason, `${strat} в ${regime}`);
      } else if (!gate.rejected) {
        gate.pass("Режим рынка", `${regime} → ${strat} OK`);
      }

      if (!gate.rejected && stratWeight === 0) {
        gate.fail("Вес стратегии", "Стратегия отключена движком адаптации", "0%");
      } else if (!gate.rejected) {
        gate.pass("Вес стратегии", `${(stratWeight * 100).toFixed(0)}%`);
      }

      const { restricted: timeBlocked, reason: timeReason } = await isTimeRestricted(
        now.getHours(), (now.getDay() + 6) % 7
      ).catch(() => ({ restricted: false, reason: '' }));
      if (!gate.rejected && timeBlocked) {
        gate.fail("Временной слот", timeReason);
      } else if (!gate.rejected) {
        gate.pass("Временной слот", `${now.getHours()}h OK`);
      }

      let mtfSizeMultiplier = 1.0;
      if (!gate.rejected) {
        const mtf = await checkMTFAlignment(sub.symbol, sig.score.direction as 'LONG'|'SHORT').catch(() => ({ allowed: true, trend4h: 'NEUTRAL' as const, reason: 'MTF ошибка — пропуск', ema20_4h: null, ema50_4h: null, sizeMultiplier: 1.0 }));
        mtfSizeMultiplier = mtf.sizeMultiplier ?? 1.0;
        if (!mtf.allowed) {
          gate.fail('MTF фильтр (4H)', mtf.reason, `4H: ${mtf.trend4h}`);
        } else {
          const mtfNote = mtfSizeMultiplier < 1 ? ` (контртренд ×${mtfSizeMultiplier})` : ' OK';
          gate.pass('MTF фильтр (4H)', `4H ${mtf.trend4h} → ${sig.score.direction}${mtfNote}`);
        }
      } else {
        gate.skip('MTF фильтр (4H)', 'Предыдущий шаг не прошёл');
      }

      // ── FinalScore Gate (Decision Engine v1.1) ────────────────────────────────────────────
      // MIN_FINAL_SCORE is a module-level export (M5 fix — was local const, not testable)
      if (!gate.rejected && stratFScore < MIN_FINAL_SCORE) {
        gate.fail("FinalScore Gate", "FinalScore ниже минимального порога", stratFScore.toFixed(1), MIN_FINAL_SCORE);
        logger.warn({ symbol: sub.symbol, strat, finalScore: stratFScore, min: MIN_FINAL_SCORE, reason: 'FINAL_SCORE_TOO_LOW' },
          `Decision Engine: FINAL_SCORE_TOO_LOW — ${stratFScore.toFixed(1)} < ${MIN_FINAL_SCORE}`);
      } else if (!gate.rejected) {
        gate.pass("FinalScore Gate", `${stratFScore.toFixed(1)} >= ${MIN_FINAL_SCORE} ✓`);
      } else {
        gate.skip("FinalScore Gate", "Предыдущий шаг не прошёл");
      }

      const rankingNote = stratRanking.length > 1
        ? stratRanking.slice(1).map(r =>
            `${r.strategy}: score=${r.finalScore.toFixed(1)} trust=${r.trustScore} w=${(r.weight*100).toFixed(0)}%`
          ).join(" | ")
        : undefined;
      saveDecisionTrace({
        symbol: sub.symbol, strategy: strat,
        direction: sig.score.direction, regime,
        timestamp: now.toISOString(),
        steps: [
          ...gate.steps,
          ...(stratRanking.length > 1 ? [{
            check: "Выбор стратегии",
            result: "PASS" as const,
            value: `${strat} (finalScore=${stratFScore.toFixed(1)}, trust=${stratTrust}, ${isExploration?"exploration":"best"})`,
            note: rankingNote,
          }] : []),
        ],
        verdict: gate.rejected ? "REJECT" : "OPEN",
        rejectReason: gate.rejectReason || undefined,
        score: sig.score.total, confidence: sig.confidence.score,
      }).catch(() => {});

      if (gate.rejected) {
        const rejectCode =
          gate.rejectReason?.toLowerCase().includes('карантин')
            ? 'QUARANTINE_RULE'
            : gate.rejectReason?.includes('FinalScore')
            ? 'FINAL_SCORE_TOO_LOW'
            : 'GATE_REJECTED';
        logger.warn({ symbol: sub.symbol, reason: rejectCode, rejectDetail: gate.rejectReason, strat },
          `Decision Engine: ${rejectCode}`);
        return;
      }

      logger.debug({ symbol: sub.symbol, strat, regime, score: sig.score.total }, "Trade Quality Gate: PASS");

      const settings = await loadSettings(sub.chatId).catch(async () => { const def = await loadSettings(sub.chatId).catch(() => null); return def ?? { autoPaperTrade: true, riskPercent: 1, minScore: 62, noTradeMode: false, accountSize: 10000 }; });
      if (!settings.autoPaperTrade) return;

      const account  = await loadPaperAccount(sub.chatId);
      const openSyms = account.positions.map(p => `${p.symbol}:${p.interval ?? '1h'}`);
      const { allowed, reason } = await canOpenTrade(`${sub.symbol}:${sub.interval}`, openSyms, account.positions.length, sig.score.direction as "LONG"|"SHORT", account.positions);

      if (!allowed) {
        if (reason.includes("DAILY_LIMIT") || reason.includes("WEEKLY_LIMIT") || reason.includes("3 убытка")) {
          await safeSend(sub.chatId, `🛑 *Торговля остановлена*\n${reason}`);
        }
        return;
      }

      const corrRisk = await checkCorrelationRisk(
        sub.chatId, sub.symbol,
        sig.score.direction as 'LONG'|'SHORT',
        settings.riskPercent
      ).catch(() => ({ allowed: true, sizeMultiplier: 1.0, reason: '', portfolioRisk: 0, correlatedRisk: 0, maxAllowedRisk: 5, message: '' }));

      if (!corrRisk.allowed) {
        logger.debug({ symbol: sub.symbol, reason: corrRisk.reason }, 'Correlation Guard: REJECT');
        const lastNotify = lastCorrGuardNotify.get(sub.chatId) ?? 0;
        if (Date.now() - lastNotify > CORR_GUARD_NOTIFY_MS) {
          lastCorrGuardNotify.set(sub.chatId, Date.now());
          await safeSend(sub.chatId, `🚫 *Correlation Guard*\n${corrRisk.message}\n_${corrRisk.reason}_`);
        }
        return;
      }
      const cooldown = await evaluateCooldown(sub.chatId).catch(() => ({
        level: 'none' as const, sizeMultiplier: 1.0, minConfidenceBoost: 0,
        skipProbability: 0, reason: '', lastChecked: '',
      }));
      if (Math.random() < cooldown.skipProbability) {
        logger.debug({ symbol: sub.symbol, prob: cooldown.skipProbability, level: cooldown.level }, 'Auto-cooldown: trade skipped');
        return;
      }
      // M2: guard against NaN/zero effectiveRiskPct (riskPercent null/0 in DB → silent 0-size position)
      const baseRisk = (settings.riskPercent > 0 && isFinite(settings.riskPercent)) ? settings.riskPercent : 2;
      if (settings.riskPercent <= 0 || !isFinite(settings.riskPercent)) {
        logger.warn({ symbol: sub.symbol, rawRiskPct: settings.riskPercent }, 'RISK_INVALID: riskPercent null/0/NaN — using default 2%');
      }
      const effectiveRiskPct = baseRisk * corrRisk.sizeMultiplier * mtfSizeMultiplier * cooldown.sizeMultiplier * atrSizeMultiplier;
      if (!isFinite(effectiveRiskPct) || effectiveRiskPct <= 0) {
        logger.warn({ symbol: sub.symbol, effectiveRiskPct }, 'RISK_INVALID: effectiveRiskPct not finite/positive — skipping trade');
        return;
      }
      if (corrRisk.sizeMultiplier < 1.0 || mtfSizeMultiplier < 1.0 || cooldown.sizeMultiplier < 1.0 || atrSizeMultiplier < 1.0) {
        logger.debug({ symbol: sub.symbol, corrMult: corrRisk.sizeMultiplier, mtfMult: mtfSizeMultiplier, cooldownMult: cooldown.sizeMultiplier, atrMult: atrSizeMultiplier }, 'Size reduced by guards');
      }

      const res = await openPaperPosition(
        sub.chatId, sub.symbol, sig.score.direction,
        sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
        effectiveRiskPct, sig.risk.atr,
        strat, regime, sub.interval
      );

      if (res.success) {
        if (res.position) {
          // H2: link the journal entry to the position ID so updateJournalClose
          // finds the exact right entry on close (prevents wrong-entry closure)
          linkJournalToPosition(
            sub.chatId, sub.symbol,
            sig.score.direction as "LONG"|"SHORT",
            res.position.id
          ).catch(() => {});

          const now = new Date();
          const features: TradeFeatures = {
            symbol: sub.symbol,
            strategy: strat,
            direction: sig.score.direction,
            interval: sub.interval,
            score: sig.score.total,
            confidence: sig.confidence.score,
            rsi: sig.score.factorScores["momentum"] ?? 50,
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

        loadWeights().then(w =>
          openShadowPosition(sub.symbol, (sig.score.direction === "NEUTRAL" ? "LONG" : sig.score.direction) as "LONG"|"SHORT",
            sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
            strat, w, regime
          ).catch(() => {})
        ).catch(() => {});

        const rankLines = stratRanking.length > 1
          ? stratRanking.map((r, i) => {
              const medal = i === 0 ? (isExploration ? "🎲" : "👑") : ["2️⃣","3️⃣","4️⃣"][i-1] ?? `${i+1}.`;
              const chosenMark = r.strategy === strat ? " ← выбрана" : "";
              return `${medal} ${r.strategy}: score=${r.finalScore.toFixed(1)} | trust=${r.trustScore} | w=${(r.weight*100).toFixed(0)}%${chosenMark}`;
            }).join("\n")
          : null;

        await safeSend(sub.chatId,
          `🤖 *Новая позиция${isExploration ? " 🎲 [Exploration]" : ""}*\n\n` +
          `${dir} *${sub.symbol}*\n` +
          `Стратегия: ${stratNames[strat] ?? strat} (вес ${(stratWeight * 100).toFixed(0)}% | trust ${stratStatus?.trustScore ?? stratTrust}/100)\n` +
          `Режим: ${regimeLabels[regime] ?? regime} | FinalScore: ${stratFScore.toFixed(1)}\n` +
          `Score: ${sig.score.total}/100 | Min: ${minScore} | Conf: ${sig.confidence.score}%\n` +
          `${sig.marketRating.emoji} Рынок: ${sig.marketRating.label} (${sig.marketRating.index}/100)\n` +
          `Вход: \`${sig.risk.entryPrice.toPrecision(6)}\`\n` +
          `Стоп: \`${sig.risk.stopLoss.toPrecision(6)}\`\n` +
          `TP1: \`${sig.risk.tp1.toPrecision(6)}\` | TP2: \`${sig.risk.tp2.toPrecision(6)}\`` +
          (rankLines ? `\n\n📊 *Рейтинг стратегий:*\n${rankLines}` : "")
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? (err.stack ?? '').slice(0, 400) : '';
      logger.error({ err, symbol: sub.symbol, errorMessage: errMsg, errorStack: errStack }, "analyzeAndTrade error");
    }
  }

  // ── Position monitor + Learning milestone check ─────────────────────────────
  // IMPORTANT: Uses _checkPositionsRunning guard to prevent concurrent execution.
  // Without the guard, setInterval fires a new cycle every 30s even if the previous
  // one is still running, causing multiple cycles to double-close the same positions.
  async function checkPositions(): Promise<void> {
    if (_checkPositionsRunning) {
      logger.debug("checkPositions already running — skipping this 30s tick to prevent double-close");
      return;
    }
    _checkPositionsRunning = true;
    try {
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
    } finally {
      _checkPositionsRunning = false;
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
            : `_Жду сигнал ≥48/100 по ${subs.size} монетам_ 👀`)
        );
      } catch (err) { logger.error({ err, chatId }, "sendStartupSummary failed"); }
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  export async function startScheduler(bot: Telegraf): Promise<void> {
    _bot = bot;
    if (process.env["RESET_DATA"] === "true") {
      const resetChatIds = await resetAllData();
      const resetMsg = "♻️ База данных сброшена. Виртуальный счёт и вся статистика обнулены. Бот начинает обучение с нуля.";
      for (const cid of resetChatIds) await bot.telegram.sendMessage(cid, resetMsg).catch(() => {});
      logger.warn("RESET_DATA completed — all tables truncated");
    }
    void initLastMilestoneTrades();    // restore from DB before first 30s tick
    void initLastAdaptationTrades();   // restore adaptation baseline from DB

    kuCoinWs.onNewCandle((sym, iv) => void onNewCandle(sym, iv));
    kuCoinWs.start().catch(err => logger.error({ err }, "KuCoin WS start error"));
    initSubscriptions()
      .then(() => sendStartupSummary())
      .catch(err => logger.error({ err }, "initSubscriptions error"));

    // Position monitor every 30 seconds — guarded by _checkPositionsRunning to prevent overlap
    setInterval(() => { void checkPositions(); }, 30_000);

    cron.schedule("*/5 * * * *", async () => {
      checkShadowPositions().catch(() => {});
    });

    cron.schedule("*/15 * * * *", async () => {
      if (!subs.size) return;
      logger.debug({ count: subs.size }, "Silent fallback scan");
      let _stagger = 0;
      for (const sub of subs.values()) {
        const _s = sub;
        setTimeout(() => { void analyzeAndTrade(_s); }, _stagger);
        _stagger += 250;
      }
    });

    cron.schedule("0 */6 * * *", async () => { void runABEvaluation(); });

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

    cron.schedule("0 */6 * * *", async () => {
      // Watchdog: alert if bot stopped trading for 24+ hours
      try {
        const { rows } = await pool.query(`
          SELECT GREATEST(
            (SELECT MAX(closed_at) FROM paper_closed_trades),
            (SELECT MAX(opened_at) FROM paper_positions)
          ) AS last_activity`,
        );
        const lastActivity = rows[0]?.last_activity as string | null;
        if (lastActivity) {
          const hoursAgo = (Date.now() - new Date(lastActivity).getTime()) / 3_600_000;
          if (hoursAgo > 24) {
            const warnMsg = `⚠️ Бот не совершал сделок больше 24 часов. Проверь Railway logs и состояние подписок.`;
            for (const chatId of chatIds) await safeSend(chatId, warnMsg);
          }
        }
      } catch (err) { logger.error({ err }, "Watchdog check failed"); }
    });

    cron.schedule("0 * * * *", async () => {
      try {
        await checkLearningHealth();
        for (const chatId of chatIds) {
          await evaluateCooldown(chatId);
        }
      } catch (err) { logger.warn({ err }, "Health monitor silent collection error"); }
    });

    cron.schedule("0 18 * * *", async () => {
      try {
        const health = await checkLearningHealth();
        if (health.overall === "excellent" || health.overall === "good") return;

        const trendIcon = health.trend === "improving" ? "📈" : health.trend === "degrading" ? "📉" : "➡️";
        const p30 = health.periods[0];
        const p100 = health.periods[1];

        if (!p30 || p30.trades < 15) return;

        const lines = [
          `📊 *Ежедневная статистика обучения*`,
          ``,
          `${trendIcon} Тренд: ${health.trend === "improving" ? "Улучшается" : health.trend === "degrading" ? "Ухудшается" : "Стабильно"}`,
          ``,
          `*Последние 30 сделок:*`,
          `PF: ${p30.profitFactor.toFixed(2)} | WR: ${(p30.winRate * 100).toFixed(0)}% | Просадка: ${p30.maxDrawdown.toFixed(1)}%`,
          ...(p100 && p100.trades >= 30 ? [
            `*Последние 100 сделок:*`,
            `PF: ${p100.profitFactor.toFixed(2)} | WR: ${(p100.winRate * 100).toFixed(0)}%`,
          ] : []),
          ``,
          `_Это информационный дайджест. В режиме обучения бот торгует в полную силу._`,
          `_Используй /whynotrade и /stats для детального анализа._`,
        ];

        for (const chatId of chatIds) await safeSend(chatId, lines.join("\n"));
      } catch (err) { logger.warn({ err }, "Daily health digest error"); }
    });

    cron.schedule("0 */12 * * *", async () => {
      try {
        const strategies: Array<"TREND" | "BREAKOUT" | "VOLUME_IMPULSE" | "MEAN_REVERSION"> = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];
        for (const st of strategies) await runWalkForwardTest(st).catch(() => {});
        await autoSnapshotAfterLearning();
        await calcReadinessIndex().catch(() => {});
      } catch (err) { logger.warn({ err }, "Walk-forward / snapshot error"); }
    });

    // ── Timed strategy adaptation every 12h (only if ≥5 new trades since last run) ──
    cron.schedule("0 */12 * * *", async () => {
      if (!chatIds.size) return;
      try {
        const total    = await getClosedTradeCount();
        const newTrades = total - _lastAdaptationTrades;
        if (newTrades < 5) {
          logger.debug({ total, newTrades }, "12h adaptation skipped — fewer than 5 new trades");
          return;
        }
        logger.info({ total, newTrades }, "12h adaptation cycle triggered");
        _lastAdaptationTrades = total;
        const changes = await runAdaptationCycle(chatIds);
        await snapshotStrategyVersion(changes);
        const report  = await generateLearningReport();
        for (const chatId of chatIds) {
          await safeSend(chatId, `⚙️ *Авто-адаптация стратегий* (12ч)\n\n${changes || "_Изменений нет_"}`);
          await safeSend(chatId, report);
        }
      } catch (err) { logger.warn({ err }, "12h adaptation error"); }
    });

    cron.schedule("0 20 * * 0", async () => {
      try {
        const ranking = await generateWeeklyRanking();
        for (const chatId of chatIds) await safeSend(chatId, ranking);
      } catch (err) { logger.warn({ err }, "Weekly ranking error"); }
    });

    
  // Daily HTML report at 08:00 UTC
  cron.schedule("0 8 * * *", async () => {
    if (!chatIds.size) return;
    logger.info("Generating daily HTML report…");
    for (const chatId of chatIds) {
      try {
        const { html, filename, summary } = await generateDailyReport(chatId);
        await _bot?.telegram.sendMessage(chatId, summary, { parse_mode: "Markdown" });
        await _bot?.telegram.sendDocument(chatId, { source: html, filename }, { caption: "📄 Полный HTML-отчёт" });
        // Daily backup of strategy weights
        try {
          const [ss, fw, sw, srs] = await Promise.all([
            pool.query("SELECT * FROM strategy_stats"),
            pool.query("SELECT * FROM factor_weights"),
            pool.query("SELECT * FROM strategy_weights"),
            pool.query("SELECT * FROM strategy_regime_stats"),
          ]);
          const backupData = {
            strategy_stats: ss.rows, factor_weights: fw.rows,
            strategy_weights: sw.rows, strategy_regime_stats: srs.rows,
            exported_at: new Date().toISOString(),
          };
          const dateStr = new Date().toISOString().slice(0, 10);
          const backupFilename = `backup-${dateStr}.json`;
          const backupSource = Buffer.from(JSON.stringify(backupData, null, 2));
          await _bot?.telegram.sendDocument(chatId, { source: backupSource, filename: backupFilename },
            { caption: "📦 Бэкап весов стратегий" });
        } catch (backupErr) { logger.error({ err: backupErr, chatId }, "Daily backup failed"); }
        logger.info({ chatId, filename }, "Daily HTML report sent");
      } catch (err) {
        logger.error({ err, chatId }, "Daily HTML report failed");
      }
    }
  });

cron.schedule("0 9 * * 1", async () => {
      try {
        const report = await generateWeeklyResearch();
        const msg = report.fullText.slice(0, 4000);
        for (const chatId of chatIds) await safeSend(chatId, msg);
      } catch (err) { logger.warn({ err }, "Weekly research error"); }
    });

    logger.info("Scheduler started — Self Learning Engine v2 + RC modules active");
  }
