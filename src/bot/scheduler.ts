import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal } from "./signals.js";
import type { TradeSignal } from "./signals.js";
  import { checkPaperPositions, openPaperPosition, getPaperStats } from "./paper-trading.js";
  import { canOpenTrade, checkConcentrationLimits, getPortfolioTiltMultiplier, loadRiskState } from "./risk-manager.js";
  import { loadSettings, loadPaperAccount, loadWeights, linkJournalToPosition } from "./storage.js";
  import { kuCoinWs } from "./websocket.js";
  import { evaluateABVariants, checkDegradation } from "./ab-testing.js";
  import { pool, resetAllData } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";
  import {
    detectMarketRegime, isStrategyBlockedInRegime, loadStrategyWeights,
    getClosedTradeCount, runAdaptationCycle, generateLearningReport, snapshotStrategyVersion,
    selectBestStrategy, recordLossReason, classifyLossReason, getAllEntityStatuses,
    generateWeeklyRanking, runDecayCycle, canRunDriftAdaptation, markDriftAdaptationRun,
    type StrategySignalInput, type StrategySelectionResult,
  } from "./learning-engine.js";
  import { isTimeRestricted } from "./time-analytics.js";
  import { getInstrumentPriority, getInstrumentStatus, updateAllInstrumentStatuses } from "./instrument-analytics.js";
  import { getInstrumentRegimeModifier } from "./instrument-regime-stats.js";
  import { isEntitySymbolOnCooldown } from "./entity-cooldown.js";
import { generateDailyReport } from "./report-generator.js";
  import { checkShadowPositions, openEntityShadowPosition, openShadowPosition } from "./shadow-testing.js";
  import { saveTradeFeatures, type TradeFeatures } from "./similar-trades.js";
  import { calcFeatureImportance, applyFeatureWeightAdjustments, formatFeatureImportance } from "./feature-importance.js";
  import { runAIResearch } from "./ai-researcher.js";
  import { detectMarketDrift } from "./market-drift.js";
  import { checkLearningHealth } from "./health-monitor.js";
  import { makeTrace, saveDecisionTrace, type DecisionStep } from "./decision-trace.js";
  import type { StrategyName } from "./strategies.js";
  import type { MarketRegime } from "./learning-engine.js";
  import { runWalkForwardTest } from "./walk-forward.js";
  import { evaluateCooldown } from "./auto-cooldown.js";
  import { generateWeeklyResearch } from "./weekly-research.js";
  import { autoSnapshotAfterLearning } from "./evolution-timeline.js";
  import { calcReadinessIndex } from "./readiness-index.js";
  import { checkNewListings } from "./listing-watcher.js";
import { checkMTFAlignment } from "./mtf-filter.js";
import { checkCorrelationRisk } from "./correlation-risk.js";
import { maybeRunAutoDeepAnalysis, generateDeepAnalysisHtml } from "./deep-analysis.js";
import { saveStatsSnapshot } from "./stats-snapshot.js";

  // M5: exported so tests and external monitors can reference the same threshold
  export const MIN_FINAL_SCORE = 3; // bootstrap: lowered from 8 (restore when most entities have 30+ trades)

  interface Sub { chatId: number; symbol: string; interval: Interval; }

  // ── Candidate for batch signal prioritization ──────────────────────────────
  interface TradeCandidate {
    sub: Sub;
    sig: TradeSignal;
    strat: StrategyName;
    stratFScore: number;
    stratTrust: number;
    stratWeight: number;
    stratStatus: { trades: number; trustScore: number; profitFactor: number; status: string } | undefined;
    stratRanking: Array<{ strategy: string; finalScore: number; trustScore: number; weight: number }>;
    isExploration: boolean;
    regime: MarketRegime;
    minScore: number;
    effectiveRiskPct: number;
    gateSteps: DecisionStep[];
  }
  const subs    = new Map<string, Sub>();
  const chatIds = new Set<number>();
  let _bot: Telegraf | null = null;
  let _lastMilestoneTrades  = 0;
  let _lastAdaptationTrades = 0; // for 12h time-based adaptation guard
  // ТЗ Feature 3: minimum gap between drift-triggered unscheduled adaptation cycles
  const DRIFT_ADAPTATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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

  // Restore timed-adaptation baseline from DB so restarts don't re-trigger immediately.
  //
  // BUG FIX: this used to reset the baseline to the CURRENT closed-trade count on every
  // boot. That means every redeploy/restart pushed the "5 new trades since last
  // adaptation" requirement forward to right now — if restarts happen more often than
  // trades close (e.g. several deploys in a row, or a slow trading period), the 12h
  // adaptation cycle never accumulates enough new trades and never fires. This silently
  // stalls the "ЖУРНАЛ ОБУЧЕНИЯ AI" section of the HTML report, since it's populated from
  // learning_reports rows written only when an adaptation cycle actually runs.
  // Fix: restore the baseline from the last REAL adaptation cycle's trade count
  // (persisted in learning_reports), not from a value derived at boot time. Only fall
  // back to the current total if no adaptation has ever run yet.
  async function initLastAdaptationTrades(): Promise<void> {
    try {
      const { rows } = await pool.query(
        "SELECT trade_count_at_report FROM learning_reports ORDER BY created_at DESC LIMIT 1"
      );
      if (rows.length) {
        _lastAdaptationTrades = Number(rows[0]!["trade_count_at_report"]);
        logger.info({ _lastAdaptationTrades }, 'Adaptation baseline restored from last learning_reports row');
      } else {
        const total = await getClosedTradeCount();
        _lastAdaptationTrades = total;
        logger.info({ total }, 'No prior learning_reports — adaptation baseline set to current trade count');
      }
    } catch (err) {
      logger.warn({ err }, 'Could not restore adaptation baseline');
    }
  }

  const recentlyProcessed = new Map<string, number>();
  const DEBOUNCE_MS = 30_000;
  // Shadow position debounce for banned coins — open at most once per 4h per symbol
  const shadowBannedDebounce = new Map<string, number>();
  const SHADOW_BANNED_DEBOUNCE_MS = 4 * 60 * 60 * 1000;

  // ── One-per-hour notification dedup maps ──────────────────────────────────
  const lastCorrGuardNotify = new Map<number, number>(); // chatId → timestamp
  const CORR_GUARD_NOTIFY_MS = 60 * 60 * 1000; // 1 hour

  // fix: these Maps grow indefinitely — on 100+ pairs × 30 days the process
  // accumulates hundreds of MB of stale entries. Clean up old keys hourly.
  setInterval(() => {
    const cutoff = Date.now() - 2 * 3600 * 1000; // keep last 2 hours
    for (const [k, ts] of recentlyProcessed)    if (ts < cutoff) recentlyProcessed.delete(k);
    for (const [k, ts] of shadowBannedDebounce) if (ts < cutoff) shadowBannedDebounce.delete(k);
    for (const [k, ts] of lastCorrGuardNotify)  if (ts < cutoff) lastCorrGuardNotify.delete(k);
  }, 3600 * 1000);

  // ── Concurrency guard: prevents checkPositions from running in parallel ──────
  // Without this, setInterval fires a new cycle every 30s regardless of whether
  // the previous one finished. With 18+ open positions (18 API calls + DB ops),
  // execution takes >30s and two concurrent cycles double-close the same positions.
  let _checkPositionsRunning = false;

  // FIX Critical#2: key includes interval so multi-interval subscriptions co-exist in the Map
  function key(chatId: number, symbol: string, interval?: string) {
    return interval ? `${chatId}:${symbol}:${interval}` : `${chatId}:${symbol}`;
  }

  async function safeSend(chatId: number, text: string) {
    try { await _bot?.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" }); }
    catch (err) { logger.error({ err, chatId }, "safeSend failed"); }
  }

  async function safeSendHtmlDocument(chatId: number, html: string, filename: string, caption: string) {
    try {
      await _bot?.telegram.sendDocument(chatId, { source: Buffer.from(html, "utf-8"), filename }, { caption });
    } catch (err) { logger.error({ err, chatId }, "safeSendHtmlDocument failed"); }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  export async function initSubscriptions(): Promise<void> {
    const { rows } = await pool.query("SELECT chat_id,symbol,interval FROM subscriptions");
    for (const r of rows as Record<string, unknown>[]) {
      const chatId = Number(r["chat_id"]);
      const sym    = r["symbol"] as string;
      const intv   = r["interval"] as Interval;
            subs.set(key(chatId, sym, intv), { chatId, symbol: sym, interval: intv });
      chatIds.add(chatId);
      kuCoinWs.addSubscription(sym, intv);
    }
    logger.info({ count: subs.size }, "Subscriptions restored");
  }

  export function subscribe(chatId: number, symbol: string, interval: Interval = "1h"): void {
    subs.set(key(chatId, symbol, interval), { chatId, symbol, interval });
    chatIds.add(chatId);
    kuCoinWs.addSubscription(symbol, interval);
    pool.query(
      // FIX Critical#2: use new 3-column PK; DO NOTHING keeps all intervals
      "INSERT INTO subscriptions(chat_id,symbol,interval) VALUES($1,$2,$3) ON CONFLICT(chat_id,symbol,interval) DO NOTHING",
      [chatId, symbol, interval]
    ).catch((err: unknown) => logger.error({ err }, "subscribe DB error"));
  }

  export function unsubscribe(chatId: number, symbol: string): boolean {
    // FIX Critical#2: remove ALL interval entries for this chatId:symbol from Map
    let removed = false;
    const intervalsToRemove: string[] = [];
    for (const [k, s] of subs.entries()) {
      if (s.chatId === chatId && s.symbol === symbol) {
        subs.delete(k); removed = true;
        intervalsToRemove.push(s.interval);
      }
    }
    for (const iv of intervalsToRemove) {
      if (![...subs.values()].some(s => s.symbol === symbol && s.interval === iv))
        kuCoinWs.removeSubscription(symbol, iv);
    }
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

  // ── ТЗ: Динамический Score порог на основе накопленной статистики PF по бакетам ──
  // Заменяет прежнюю dynamicMinScore(marketIndex) — теперь порог кэшируется и
  // обновляется в cron раз в 12 часов на основе реального PF по бакетам score.
  let cachedMinScore = 45;

  async function adaptiveMinScore(): Promise<number> {
    const BASE_MIN = 45;
    try {
      const { rows: totalRows } = await pool.query(
        "SELECT COUNT(*) as total FROM trade_features WHERE pnl_percent IS NOT NULL"
      );
      const total = Number((totalRows[0] as Record<string, unknown> | undefined)?.["total"] ?? 0);
      if (total < 100) return BASE_MIN;

      const { rows: buckets } = await pool.query(
        `SELECT
           FLOOR((features->>'score')::float / 5) * 5 AS bucket,
           COUNT(*) as trades,
           SUM(CASE WHEN pnl_percent > 0 THEN pnl_percent ELSE 0 END) as win_pnl,
           ABS(SUM(CASE WHEN pnl_percent < 0 THEN pnl_percent ELSE 0 END)) as loss_pnl
         FROM trade_features
         WHERE pnl_percent IS NOT NULL AND (features->>'score') IS NOT NULL
         GROUP BY bucket
         HAVING COUNT(*) >= 10
         ORDER BY bucket DESC`
      );

      for (const row of buckets as Record<string, unknown>[]) {
        const winPnl = Number(row["win_pnl"]);
        const lossPnl = Number(row["loss_pnl"]);
        const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
        if (pf >= 1.0) {
          return Math.min(57, Math.max(BASE_MIN, Number(row["bucket"])));
        }
      }
      return BASE_MIN;
    } catch (err) {
      logger.warn({ err }, "adaptiveMinScore: query failed, falling back to base");
      return BASE_MIN;
    }
  }

  async function refreshAdaptiveMinScore(): Promise<void> {
    const oldScore = cachedMinScore;
    const newScore = await adaptiveMinScore();
    if (newScore !== oldScore) {
      logger.info({ from: oldScore, to: newScore }, "Adaptive minScore updated");
    }
    cachedMinScore = newScore;
  }

  // ── Signal analysis + auto-trade ─────────────────────────────────────────────

  // ── Signal analysis + auto-trade ─────────────────────────────────────────────
  // ── Evaluate trade candidate: all gates + corrRisk/cooldown → candidate or null ────
  // Trace saved immediately for rejections; deferred for passes (caller adds Concentration step).
  async function finalScoreSizeMultiplier(finalScore: number): Promise<number> {
    if (finalScore >= 60) return 1.20; // отличный сигнал — +20%
    if (finalScore >= 40) return 1.00; // хороший — норма
    if (finalScore >= 25) return 0.75; // средний — -25%
    if (finalScore >= 15) return 0.50; // слабый — -50%
    // FIX: bootstrap зона — было 0.30 (-70%), теперь 0.50 (-50%).
    // При MIN_FINAL_SCORE=3 большинство сигналов попадают сюда и в связке с 9 другими
    // множителями итоговый размер схлопывался до < 0.05% депозита.
    return 0.50;                       // пограничный — -50%
  }

  async function evaluateTradeCandidate(sub: Sub): Promise<TradeCandidate | null> {
    const debounceKey = `${sub.chatId}:${sub.symbol}`;
    const lastRun = recentlyProcessed.get(debounceKey) ?? 0;
    if (Date.now() - lastRun < DEBOUNCE_MS) return null;
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
        return null;
      }
      const bestSig = selectionResult.selected;
      const strat = bestSig.strategy;
      const stratTrust  = selectionResult.trustScore;
      const stratFScore = selectionResult.finalScore;
      const stratRanking = selectionResult.ranking ?? [];
      const isExploration = selectionResult.isExploration ?? false;

      const [entityStatuses, stratWeights] = await Promise.all([
        getAllEntityStatuses(regime).catch(() => []),
        loadStrategyWeights().catch(() => ({} as Record<string,number>)),
      ]);
      const entityKey = `${strat}_${sig.score.direction}`;
      const stratStatus = entityStatuses.find(s => s.entity === entityKey);
      const stratWeight = stratWeights[strat] ?? 1;
      // Load user settings early so the score gate uses the user-configured min_score,
      // not just the adaptive cachedMinScore (which can drift to 45–57 even when the
      // user has explicitly set min_score = 70 in user_settings).
      const settingsEarly = await loadSettings(sub.chatId).catch(() => null);
      const minScore = Math.max(cachedMinScore, settingsEarly?.minScore ?? 0);

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

      if (!gate.rejected && sig.confidence.score < 12) {
        gate.fail("Confidence", "Низкая уверенность сигнала", `${sig.confidence.score}%`, "12%");
      } else if (!gate.rejected) {
        gate.pass("Confidence", `${sig.confidence.score}%`);
      }

      // ── ATR Filter ────────────────────────────────────────────────────────────────────────
      let atrSizeMultiplier = 1.0;
      if (!gate.rejected && sig.risk.atr != null && sig.risk.entryPrice > 0) {
        const atrPercent = (sig.risk.atr / sig.risk.entryPrice) * 100;
        if (atrPercent > 3.5) {
          gate.fail("ATR Filter", "Слишком высокая волатильность", `ATR ${atrPercent.toFixed(2)}%`, "макс 3.5%");
        } else if (atrPercent >= 2.0) {
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
        const qScore = sig.score.total >= 65;
        const qConf  = sig.confidence.score >= 40;
        const qFS    = stratFScore >= 20;
        if (!qScore || !qConf || !qFS) {
          const why = !qScore
            ? `Score ${sig.score.total} < 65`
            : !qConf
            ? `Conf ${sig.confidence.score}% < 40%`
            : `FinalScore ${stratFScore.toFixed(1)} < 20`;
          gate.fail("Карантин", "Стратегия в карантине — недостаточное качество сигнала", why, "Score≥65 | Conf≥40% | FS≥20");
        } else {
          gate.pass("Карантин", `Score=${sig.score.total} Conf=${sig.confidence.score}% FS=${stratFScore.toFixed(1)} — допуск`);
        }
      } else if (!gate.rejected) {
        gate.skip("Карантин", "Стратегия активна");
      }

      // ── Instrument Watchlist gate ──────────────────────────────────────────────────────────
      // Shadow-карантин на уровне символа: слабые сигналы по монетам с устойчиво плохим PF
      // блокируются, но монета не выключается полностью — обучение и feature-логирование продолжаются.
      let instrumentSizeMultiplier = 1.0;
      const instrumentStatus = await getInstrumentStatus(sub.symbol).catch(() => "normal" as const);
      if (!gate.rejected && instrumentStatus === "watchlist") {
        if (sig.score.total < 65 || sig.confidence.score < 55 || stratFScore < 30) {
          gate.fail(
            "Instrument Watchlist",
            `${sub.symbol} в watchlist — нужен сильный сигнал`,
            `Score ${sig.score.total} Conf ${sig.confidence.score}% FS ${stratFScore.toFixed(1)}`,
            "мин Score≥65 / Conf≥55% / FS≥30"
          );
        } else {
          gate.pass("Instrument Watchlist", `${sub.symbol} watchlist, сигнал сильный — пропущено`);
        }
      } else if (!gate.rejected && instrumentStatus === "deep_watchlist") {
        if (sig.score.total < 75 || sig.confidence.score < 65 || stratFScore < 40) {
          gate.fail(
            "Instrument Watchlist",
            `${sub.symbol} в глубоком watchlist — нужен исключительный сигнал`,
            `Score ${sig.score.total} Conf ${sig.confidence.score}% FS ${stratFScore.toFixed(1)}`,
            "мин Score≥75 / Conf≥65% / FS≥40"
          );
        } else {
          instrumentSizeMultiplier = 0.5;
          gate.pass("Instrument Watchlist", `${sub.symbol} deep watchlist, сигнал прошёл повышенный порог (размер ×0.5)`);
        }
      } else if (!gate.rejected && instrumentStatus === "banned") {
        // Полный бан: WR < 25% или PF < 0.4 на 10+ сделках — инструмент-аутсайдер.
        // Разблокируется автоматически через updateAllInstrumentStatuses когда WR ≥ 25% и PF ≥ 0.4.
        gate.fail(
          "Instrument Banned",
          `${sub.symbol} заблокирован (WR < 25% или PF < 0.4 на 10+ сделок)`,
          `status: banned`,
          "Разблокируется при WR ≥ 25% и PF ≥ 0.4"
        );
        // Coin shadow trading: продолжаем отслеживание забаненных монет через shadow positions
        const shadowBannedKey = `shadow:${sub.symbol}`;
        if (Date.now() - (shadowBannedDebounce.get(shadowBannedKey) ?? 0) > SHADOW_BANNED_DEBOUNCE_MS) {
          shadowBannedDebounce.set(shadowBannedKey, Date.now());
          loadWeights().then(w =>
            openShadowPosition(
              sub.symbol,
              (sig.score.direction === "NEUTRAL" ? "LONG" : sig.score.direction) as "LONG"|"SHORT",
              sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
              strat, w, regime
            ).catch(() => {})
          ).catch(() => {});
        }
      } else if (!gate.rejected) {
        gate.skip("Instrument Watchlist", instrumentStatus === "normal" ? "Инструмент в норме" : "Предыдущий шаг не прошёл");
      }

      const minTrust = stratStatus?.status === "quarantine" ? 20 : 5;
      if (!gate.rejected && stratStatus && stratStatus.trades >= 20 && stratStatus.trustScore < minTrust) {
        gate.fail("Trust Score", `Trust Score стратегии ниже порога`, stratStatus.trustScore, minTrust);
      } else {
        if (!gate.rejected) gate.pass("Trust Score", stratStatus && stratStatus.trades >= 20 ? `${stratStatus.trustScore}/100` : `bootstrap (${stratStatus?.trades ?? 0}/20 сделок)`);
      }

      // Порог 0.75: стратегия с PF < 0.75 на 20+ сделках системно убыточна и должна блокироваться.
      // FIX: было < 0.1 (порог не работал), message при этом показывал "0.75" — несоответствие устранено.
      if (!gate.rejected && stratStatus && stratStatus.trades >= 20 && stratStatus.profitFactor < 0.75) {
        gate.fail("Strategy PF", `PF стратегии ниже минимального порога`, stratStatus.profitFactor.toFixed(2), "0.75");
      } else {
        if (!gate.rejected) gate.pass("Strategy PF", (stratStatus?.trades ?? 0) >= 5 ? stratStatus!.profitFactor.toFixed(2) : "мало данных");
      }

      // Явный фильтр TREND+sideways на уровне входа (не постфактум-адаптация).
      // Данные: TREND имеет 52 убытка с причиной sideways_market — системная проблема.
      // В боковике следует использовать REVERSAL или PULLBACK, а не TREND.
      if (!gate.rejected && strat === "TREND" && (regime === "sideways" || regime === "low_vol")) {
        gate.fail(
          "TREND Sideways Filter",
          `TREND запрещён в режиме ${regime} — высокая вероятность убытка`,
          `strategy=${strat}, regime=${regime}`,
          "Используйте REVERSAL или PULLBACK в боковике"
        );
      } else if (!gate.rejected) {
        gate.skip("TREND Sideways Filter", strat !== "TREND" ? `${strat} — фильтр не применяется` : `regime=${regime} — тренд есть, OK`);
      }

      const { blocked: regimeBlocked, reason: regimeReason } = await isStrategyBlockedInRegime(strat, regime, sub.interval).catch(() => ({ blocked: false, reason: '' }));
      if (!gate.rejected && regimeBlocked) {
        gate.fail("Режим рынка", regimeReason, `${strat} в ${regime}`);
      } else if (!gate.rejected) {
        gate.pass("Режим рынка", `${regime} → ${strat} OK`);
      }

      // ── Entity Guard — независимый карантин/вес по strategy+direction ────────
      const { rows: entityWeightRows } = await pool.query(
        "SELECT weight, quarantine FROM strategy_entity_weights WHERE entity=$1",
        [entityKey]
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      const entityRow = entityWeightRows[0] as Record<string, unknown> | undefined;
      const entityWeight = entityRow ? Number(entityRow["weight"]) : 1.0;
      const entityQuarantine = entityRow ? Boolean(entityRow["quarantine"]) : false;
      if (!gate.rejected && entityQuarantine) {
        const highQuality = sig.score.total >= 65
          && sig.confidence.score >= 40
          && stratFScore >= 20;
        if (highQuality) {
          gate.pass("Entity Guard", `${entityKey} карантин — сильный сигнал пропущен (Score=${sig.score.total} Conf=${sig.confidence.score}% FS=${stratFScore.toFixed(1)})`);
        } else {
          gate.fail(
            "Entity Guard",
            `${entityKey} в карантине — недостаточное качество сигнала`,
            `Score=${sig.score.total} Conf=${sig.confidence.score}% FS=${stratFScore.toFixed(1)}`,
            "Score≥65 | Conf≥40% | FS≥20"
          );
          // Shadow quarantine: заблокированный сигнал уходит в виртуальную сделку.
          // Learning-engine отслеживает shadow PF/WR и выводит entity из карантина
          // автоматически, не дожидаясь накопления реальных сделок (которые частично
          // блокируются карантином — иначе получается deadlock: не торгует → нет данных → не выходит).
          const shadowEntityKey = `shadowq:${entityKey}`;
          if (Date.now() - (shadowBannedDebounce.get(shadowEntityKey) ?? 0) > SHADOW_BANNED_DEBOUNCE_MS) {
            shadowBannedDebounce.set(shadowEntityKey, Date.now());
            loadWeights().then(w =>
              openEntityShadowPosition(
                entityKey,
                sub.symbol,
                (sig.score.direction === "NEUTRAL" ? "LONG" : sig.score.direction) as "LONG"|"SHORT",
                sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
                strat, w, regime
              ).catch(() => {})
            ).catch(() => {});
          }
        }
      } else if (!gate.rejected) {
        gate.pass("Entity Guard", entityRow ? `${entityKey} вес ${(entityWeight * 100).toFixed(0)}%` : "bootstrap");
      }

      // ── Entity × Symbol Cooldown — серийные убытки по одной монете ──────────
      let irdSizeMult = 1.0;
      const { blocked: cooldownBlocked, until: cooldownUntil, consecutiveLosses } =
        await isEntitySymbolOnCooldown(entityKey, sub.symbol).catch(() => ({ blocked: false, until: null, consecutiveLosses: 0 }));
      if (!gate.rejected && cooldownBlocked) {
        const untilStr = cooldownUntil ? new Date(cooldownUntil).toISOString().slice(0, 16) : "?";
        gate.fail("Entity Cooldown", `${entityKey}/${sub.symbol}: ${consecutiveLosses} убытков подряд`, `до ${untilStr} UTC`, "");
      } else if (!gate.rejected) {
        gate.pass("Entity Cooldown", consecutiveLosses > 0 ? `${consecutiveLosses} убытков подряд (норма)` : "OK");
      }

      // ── Instrument × Direction × Regime — размер по комбо-статистике ─────────
      const { blocked: irdBlocked, sizeMultiplier: _irdMult, reason: irdReason } =
        await getInstrumentRegimeModifier(sub.symbol, sig.score.direction, regime)
          .catch(() => ({ blocked: false, sizeMultiplier: 1.0, reason: "" }));
      irdSizeMult = _irdMult;
      if (!gate.rejected && irdBlocked) {
        gate.fail("IRD Filter", `${sub.symbol} заблокирован в режиме ${regime}`, irdReason, "PF<0.6");
      } else if (!gate.rejected) {
        gate.pass("IRD Filter", irdReason || `${sub.symbol} ${sig.score.direction}/${regime}: OK`);
      }

      if (!gate.rejected && stratWeight === 0) {
        gate.fail("Вес стратегии", "Стратегия отключена движком адаптации", "0%");
      } else if (!gate.rejected) {
        gate.pass("Вес стратегии", `${(stratWeight * 100).toFixed(0)}%`);
      }

      // UTC to match recordTimeTrade which stores UTC buckets
      const { restricted: timeBlocked, reason: timeReason, sizeMultiplier: timeSizeMultiplier } = await isTimeRestricted(
        now.getUTCHours(), (now.getUTCDay() + 6) % 7
      ).catch(() => ({ restricted: false, reason: '', sizeMultiplier: 1.0 }));
      if (!gate.rejected && timeBlocked) {
        gate.fail("Временной слот", timeReason);
      } else if (!gate.rejected) {
        gate.pass("Временной слот", `${now.getUTCHours()}h UTC OK`);
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

        if (gate.rejected) {
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
            verdict: "REJECT",
            rejectReason: gate.rejectReason || undefined,
            score: sig.score.total, confidence: sig.confidence.score,
          }).catch(() => {});
          const rejectCode =
            gate.rejectReason?.toLowerCase().includes('карантин')
              ? 'QUARANTINE_RULE'
              : gate.rejectReason?.includes('FinalScore')
              ? 'FINAL_SCORE_TOO_LOW'
              : 'GATE_REJECTED';
          logger.warn({ symbol: sub.symbol, reason: rejectCode, rejectDetail: gate.rejectReason, strat },
            `Decision Engine: ${rejectCode}`);
          return null;
        }
        // Passing candidate — trace deferred to caller (includes Concentration Limit step)

        logger.debug({ symbol: sub.symbol, strat, regime, score: sig.score.total }, "Trade Quality Gate: PASS");
      const settings = await loadSettings(sub.chatId).catch(async () => { const def = await loadSettings(sub.chatId).catch(() => null); return def ?? { autoPaperTrade: true, riskPercent: 1, minScore: 62, noTradeMode: false, accountSize: 10000 }; });
      if (!settings.autoPaperTrade) return null;

      const account  = await loadPaperAccount(sub.chatId);
      const openSyms = account.positions.map(p => `${p.symbol}:${p.interval ?? '1h'}`);
      const { allowed, reason } = await canOpenTrade(`${sub.symbol}:${sub.interval}`, openSyms, account.positions.length, sig.score.direction as "LONG"|"SHORT", account.positions);

      if (!allowed) {
        if (reason.includes("DAILY_LIMIT") || reason.includes("WEEKLY_LIMIT") || reason.includes("3 убытка")) {
          await safeSend(sub.chatId, `🛑 *Торговля остановлена*\n${reason}`);
        }
        return null;
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
        return null;
      }
      const cooldown = await evaluateCooldown(sub.chatId).catch(() => ({
        level: 'none' as const, sizeMultiplier: 1.0, minConfidenceBoost: 0,
        skipProbability: 0, reason: '', lastChecked: '',
      }));
      if (Math.random() < cooldown.skipProbability) {
        logger.debug({ symbol: sub.symbol, prob: cooldown.skipProbability, level: cooldown.level }, 'Auto-cooldown: trade skipped');
        return null;
      }
      // FIX Critical#9: apply minConfidenceBoost as a hard confidence gate (was stored but never enforced)
      if (cooldown.minConfidenceBoost > 0) {
        const minConfRequired = 8 + cooldown.minConfidenceBoost;
        if (sig.confidence.score < minConfRequired) {
          logger.debug({ symbol: sub.symbol, conf: sig.confidence.score, required: minConfRequired, level: cooldown.level }, 'Auto-cooldown: confidence gate — trade skipped');
          return null;
        }
      }
      // M2: guard against NaN/zero effectiveRiskPct (riskPercent null/0 in DB → silent 0-size position)
      const baseRisk = (settings.riskPercent > 0 && isFinite(settings.riskPercent)) ? settings.riskPercent : 2;
      if (settings.riskPercent <= 0 || !isFinite(settings.riskPercent)) {
        logger.warn({ symbol: sub.symbol, rawRiskPct: settings.riskPercent }, 'RISK_INVALID: riskPercent null/0/NaN — using default 2%');
      }
      const portfolioRiskState = await loadRiskState();
      const portfolioTiltMult  = getPortfolioTiltMultiplier(portfolioRiskState.consecutiveLosses);
      const fsMult             = await finalScoreSizeMultiplier(stratFScore);
      const safeCorr     = isFinite(corrRisk.sizeMultiplier)  && corrRisk.sizeMultiplier  > 0 ? corrRisk.sizeMultiplier  : 1.0;
        const safeMtf      = isFinite(mtfSizeMultiplier)        && mtfSizeMultiplier        > 0 ? mtfSizeMultiplier        : 1.0;
        const safeCooldown = isFinite(cooldown.sizeMultiplier)  && cooldown.sizeMultiplier  > 0 ? cooldown.sizeMultiplier  : 1.0;
        const safeAtr      = isFinite(atrSizeMultiplier)        && atrSizeMultiplier        > 0 ? atrSizeMultiplier        : 1.0;
        const safeInstr    = isFinite(instrumentSizeMultiplier) && instrumentSizeMultiplier > 0 ? instrumentSizeMultiplier : 1.0;
        const safeTime     = isFinite(timeSizeMultiplier)       && timeSizeMultiplier       > 0 ? timeSizeMultiplier       : 1.0;
        const safeEntity   = isFinite(entityWeight)             && entityWeight             > 0 ? entityWeight             : 1.0;
        const safeIrd      = isFinite(irdSizeMult)              && irdSizeMult              > 0 ? irdSizeMult              : 1.0;
        const safePTilt    = isFinite(portfolioTiltMult)        && portfolioTiltMult        > 0 ? portfolioTiltMult        : 1.0;
        const safeFs       = isFinite(fsMult)                   && fsMult                   > 0 ? fsMult                   : 1.0;
        // FIX: 10 множителей перемножаются — итог может схлопнуться до < 0.05% депозита.
        // Нижняя граница: effectiveRiskPct не ниже 30% от baseRisk.
        // Пример: baseRisk=2%, 0.30 пол → минимум 0.6% — разумный минимум для paper trading.
        const rawEffectiveRiskPct = baseRisk * safeCorr * safeMtf * safeCooldown * safeAtr * safeInstr * safeTime * safeEntity * safeIrd * safePTilt * safeFs;
        const effectiveRiskPct = Math.max(rawEffectiveRiskPct, baseRisk * 0.30);
      if (!isFinite(effectiveRiskPct) || effectiveRiskPct <= 0) {
        logger.warn({
          baseRisk,
          corrRiskMult: corrRisk.sizeMultiplier,
          mtfSizeMult: mtfSizeMultiplier,
          cooldownMult: cooldown.sizeMultiplier,
          atrSizeMult: atrSizeMultiplier,
          instrumentSizeMult: instrumentSizeMultiplier,
          timeSizeMult: timeSizeMultiplier,
          entityWeight,
          irdSizeMult,
          portfolioTiltMult,
          fsMult,
          effectiveRiskPct,
        }, "RISK_INVALID: effectiveRiskPct not finite/positive — skipping trade");
        return null;
      }
      if (portfolioTiltMult < 1.0) {
        gate.pass("Portfolio Tilt", `${portfolioRiskState.consecutiveLosses} убытков подряд → размер ×${(portfolioTiltMult * 100).toFixed(0)}%`);
      }
      gate.pass("FinalScore Size", `FS ${stratFScore.toFixed(1)} → размер ×${(fsMult * 100).toFixed(0)}%`);
      if (corrRisk.sizeMultiplier < 1.0 || mtfSizeMultiplier < 1.0 || cooldown.sizeMultiplier < 1.0 || atrSizeMultiplier < 1.0 || instrumentSizeMultiplier < 1.0 || timeSizeMultiplier < 1.0 || irdSizeMult < 1.0) {
        logger.debug({ symbol: sub.symbol, corrMult: corrRisk.sizeMultiplier, mtfMult: mtfSizeMultiplier, cooldownMult: cooldown.sizeMultiplier, atrMult: atrSizeMultiplier, instrMult: instrumentSizeMultiplier, timeMult: timeSizeMultiplier, irdMult: irdSizeMult }, 'Size reduced by guards');
      }

      return {
        sub, sig, strat, stratFScore, stratTrust, stratWeight, stratStatus,
        stratRanking, isExploration, regime, minScore, effectiveRiskPct,
        gateSteps: [
          ...gate.steps,
          ...(stratRanking.length > 1 ? [{
            check: "Выбор стратегии",
            result: "PASS" as const,
            value: `${strat} (finalScore=${stratFScore.toFixed(1)}, trust=${stratTrust}, ${isExploration?"exploration":"best"})`,
            note: rankingNote,
          }] : []),
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? (err.stack ?? '').slice(0, 400) : '';
      logger.error({ err, symbol: sub.symbol, errorMessage: errMsg, errorStack: errStack }, "evaluateTradeCandidate error");
      return null;
    }
  }

  // ── Execute trade candidate: open position + notification ─────────────────────────
  async function executeTradeCandidate(candidate: TradeCandidate): Promise<boolean> {
    const { sub, sig, strat, stratFScore, stratTrust, stratWeight, stratStatus, stratRanking,
      isExploration, regime, minScore, effectiveRiskPct } = candidate;
    const res = await openPaperPosition(
      sub.chatId, sub.symbol, sig.score.direction as "LONG"|"SHORT",
      sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
      effectiveRiskPct, sig.risk.atr,
      strat, regime, sub.interval,
      stratFScore
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
          direction: sig.score.direction as "LONG"|"SHORT",
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
          hour: now.getUTCHours(),           // UTC for ML feature consistency
          dayOfWeek: (now.getUTCDay() + 6) % 7, // 0=Mon…6=Sun — matches time_analytics buckets
        };
        saveTradeFeatures(res.position.id, features).catch(() => {});
      }
      const dir = sig.score.direction === "LONG" ? "⬆️ LONG" : "⬇️ SHORT";
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
      return true;
    }
    return false;
  }

  // ── WebSocket wrapper: evaluate → concentration check → execute ─────────────────
  async function analyzeAndTrade(sub: Sub): Promise<void> {
    try {
      const candidate = await evaluateTradeCandidate(sub);
      if (!candidate) return;
      const account = await loadPaperAccount(candidate.sub.chatId);
      const concCheck = checkConcentrationLimits(
        candidate.sub.symbol, candidate.strat,
        candidate.sig.score.direction as "LONG"|"SHORT",
        candidate.regime, candidate.effectiveRiskPct, account.positions
      );
      if (concCheck.blocked) {
        logger.debug({ symbol: candidate.sub.symbol, reason: concCheck.reason }, "Concentration Limit: REJECT");
        saveDecisionTrace({
          symbol: candidate.sub.symbol, strategy: candidate.strat,
          direction: candidate.sig.score.direction, regime: candidate.regime,
          timestamp: new Date().toISOString(),
          steps: [...candidate.gateSteps, { check: "Concentration Limit", result: "FAIL" as const, value: concCheck.reason ?? "Лимит концентрации" }],
          verdict: "REJECT", rejectReason: concCheck.reason,
          score: candidate.sig.score.total, confidence: candidate.sig.confidence.score,
        }).catch(() => {});
        return;
      }
      saveDecisionTrace({
        symbol: candidate.sub.symbol, strategy: candidate.strat,
        direction: candidate.sig.score.direction, regime: candidate.regime,
        timestamp: new Date().toISOString(),
        steps: [...candidate.gateSteps, { check: "Concentration Limit", result: "PASS" as const, value: "OK" }],
        verdict: "OPEN",
        score: candidate.sig.score.total, confidence: candidate.sig.confidence.score,
      }).catch(() => {});
      await executeTradeCandidate(candidate);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? (err.stack ?? '').slice(0, 400) : '';
      logger.error({ err, symbol: sub.symbol, errorMessage: errMsg, errorStack: errStack }, "analyzeAndTrade error");
    }
  }

  // ── Batch scan: collect all candidates, sort by FinalScore, open in priority order ─
  // Wrapped by the caller (cron callback) in try/catch too, but this function is also
  // exported/awaited directly elsewhere — keep its own top-level guard so a single bad
  // candidate/DB hiccup can never escape as an unhandled rejection during a month-long run.
  async function runBatchScanCycle(): Promise<void> {
    try {
      await runBatchScanCycleInner();
    } catch (err) {
      logger.error({ err }, "runBatchScanCycle error — cycle aborted, will retry next tick");
    }
  }

  async function runBatchScanCycleInner(): Promise<void> {
    if (!subs.size) return;
    logger.debug({ count: subs.size }, "Batch scan cycle: collecting candidates");
    const candidates: TradeCandidate[] = [];
    for (const sub of subs.values()) {
      const c = await evaluateTradeCandidate(sub).catch(err => {
        logger.error({ err, symbol: sub.symbol }, "evaluateTradeCandidate error in batch");
        return null;
      });
      if (c) candidates.push(c);
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => b.stratFScore - a.stratFScore);
    logger.info(
      { count: candidates.length, ranked: candidates.map(c => `${c.sub.symbol}:${c.stratFScore.toFixed(1)}`).join(", ") },
      "Batch scan: candidates sorted by FinalScore"
    );
    // ── ТЗ: race condition fix — локальный in-memory счётчик позиций на время batch-цикла,
    // чтобы не терять только что открытые позиции из-за задержки записи в БД ──────
    const localPositionsByChat = new Map<number, import("./storage.js").PaperPosition[]>();
    async function getLocalPositions(chatId: number): Promise<import("./storage.js").PaperPosition[]> {
      let list = localPositionsByChat.get(chatId);
      if (!list) {
        const account = await loadPaperAccount(chatId);
        list = [...account.positions];
        localPositionsByChat.set(chatId, list);
      }
      return list;
    }

    for (const candidate of candidates) {
      const localPositions = await getLocalPositions(candidate.sub.chatId);
      const concCheck = checkConcentrationLimits(
        candidate.sub.symbol, candidate.strat,
        candidate.sig.score.direction as "LONG"|"SHORT",
        candidate.regime, candidate.effectiveRiskPct, localPositions
      );
      if (concCheck.blocked) {
        logger.debug({ symbol: candidate.sub.symbol, reason: concCheck.reason }, "Concentration Limit: REJECT (batch)");
        saveDecisionTrace({
          symbol: candidate.sub.symbol, strategy: candidate.strat,
          direction: candidate.sig.score.direction, regime: candidate.regime,
          timestamp: new Date().toISOString(),
          steps: [...candidate.gateSteps, { check: "Concentration Limit", result: "FAIL" as const, value: concCheck.reason ?? "Лимит концентрации" }],
          verdict: "REJECT", rejectReason: concCheck.reason,
          score: candidate.sig.score.total, confidence: candidate.sig.confidence.score,
        }).catch(() => {});
        continue;
      }
      saveDecisionTrace({
        symbol: candidate.sub.symbol, strategy: candidate.strat,
        direction: candidate.sig.score.direction, regime: candidate.regime,
        timestamp: new Date().toISOString(),
        steps: [...candidate.gateSteps, { check: "Concentration Limit", result: "PASS" as const, value: "OK" }],
        verdict: "OPEN",
        score: candidate.sig.score.total, confidence: candidate.sig.confidence.score,
      }).catch(() => {});
      const opened = await executeTradeCandidate(candidate).catch(err => {
        logger.error({ err, symbol: candidate.sub.symbol }, "executeTradeCandidate error in batch");
        return false;
      });
      // После успешного открытия — сразу отразить в локальном счётчике,
      // чтобы следующие кандидаты в этом же цикле видели актуальный риск
      if (opened) {
        localPositions.push({
          id: `local-${candidate.sub.symbol}-${Date.now()}`,
          chatId: candidate.sub.chatId,
          symbol: candidate.sub.symbol,
          direction: candidate.sig.score.direction as "LONG"|"SHORT",
          entryPrice: candidate.sig.risk.entryPrice,
          size: 0,
          stopLoss: candidate.sig.risk.stopLoss,
          tp1: candidate.sig.risk.tp1,
          tp2: candidate.sig.risk.tp2,
          openedAt: new Date().toISOString(),
          breakevenMoved: false,
          trailAtr: null,
          strategy: candidate.strat,
          marketRegime: candidate.regime,
          riskPercent: candidate.effectiveRiskPct,
        });
      }
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
        // FIX High: msgs are already sent via sendFn inside checkPaperPositions.
        // Iterating the returned array and calling safeSend again causes duplicate notifications.
        await checkPaperPositions(chatId, sendFn).catch(() => {});
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
              const dir = p.direction === "LONG" ? "⬆️" : "⬇️";
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
    void refreshAdaptiveMinScore().catch((err) => logger.warn({ err }, "adaptiveMinScore initial refresh error"));

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
      // Batch scan: collect all signals, sort by FinalScore, open in priority order
      void runBatchScanCycle();
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

        // ── ТЗ "Три фичи ускорения адаптации" Feature 3: severe drift triggers
        // an unscheduled adaptation cycle instead of waiting for the next 12h
        // tick — but only every 6h at most (module-level cooldown in
        // learning-engine.ts), and never let a failure here break the drift
        // check above.
        if (drift.hasDrift && drift.severity === "severe" && chatIds.size) {
          if (canRunDriftAdaptation(DRIFT_ADAPTATION_COOLDOWN_MS)) {
            try {
              markDriftAdaptationRun();
              logger.info({ severity: drift.severity }, "Severe market drift — running unscheduled adaptation cycle");
              const changes = await runAdaptationCycle(chatIds);
              await snapshotStrategyVersion(changes);
              const report = await generateLearningReport();
              for (const chatId of chatIds) {
                await safeSend(chatId, `🚨 *Внеплановая адаптация* (market drift)\n\n${changes || "_Изменений нет_"}`);
                await safeSend(chatId, report);
              }
            } catch (err) {
              logger.error({ err }, "Drift-triggered adaptation cycle failed");
            }
          } else {
            logger.debug("Severe drift detected but drift-adaptation cooldown still active — skipping");
          }
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

    // AI Deep Analysis — read-only аналитический модуль, ничего не меняет автоматически.
    // Проверяем раз в час, сам модуль решает нужно ли фактически запускать анализ
    // (не чаще одного раза в сутки, см. deep_analysis_state в БД).
    cron.schedule("0 * * * *", async () => {
      try {
        const chunks = await maybeRunAutoDeepAnalysis();
        if (!chunks) return;
        const html = await generateDeepAnalysisHtml();
        const filename = `deep-analysis-${new Date().toISOString().slice(0, 10)}.html`;
        for (const chatId of chatIds) {
          await safeSendHtmlDocument(chatId, html, filename, "🧠 AI Deep Analysis (авто) — открой файл в браузере");
        }
      } catch (err) { logger.warn({ err }, "Auto deep analysis error"); }
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
      await refreshAdaptiveMinScore().catch((err) => logger.warn({ err }, "adaptiveMinScore refresh error"));
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

    
  // Weekly decay cycle — Sunday 04:00 UTC
  // Умножает накопленные PnL-суммы аналитических таблиц на 0.95,
  // чтобы недавние сделки имели больший вес чем 3-6 месячные данные.
  cron.schedule("0 4 * * 0", async () => {
    try {
      const result = await runDecayCycle();
      logger.info({ result }, "Weekly decay cycle complete");
    } catch (err) {
      logger.error({ err }, "Weekly decay cycle failed");
    }
  });

  // Daily analytics snapshot at 03:00 UTC (before cleanup window)
  cron.schedule("0 3 * * *", async () => {
    try {
      const id = await saveStatsSnapshot("daily");
      logger.info({ id }, "Daily stats snapshot saved");
    } catch (err) {
      logger.error({ err }, "Daily stats snapshot failed");
    }
  });

  // Daily HTML report at 08:00 UTC
  cron.schedule("0 8 * * *", async () => {
    if (!chatIds.size) return;
    logger.info("Generating daily HTML report…");
    // ── Instrument Watchlist: ежедневный пересчёт статусов монет ─────────────
    try {
      const statusChanges = await updateAllInstrumentStatuses();
      for (const change of statusChanges) {
        const toWatchlist   = change.newStatus !== "normal";
        const fromWatchlist = change.oldStatus !== "normal" && change.newStatus === "normal";
        if (!toWatchlist && !fromWatchlist) continue;
        for (const chatId of chatIds) {
          if (toWatchlist) {
            const label = change.newStatus === "deep_watchlist" ? "🔴 Deep Watchlist" : "👁 Watchlist";
            const icon  = change.newStatus === "deep_watchlist" ? "🔴" : "👁";
            await safeSend(chatId,
              `${icon} *${change.symbol} переведена в ${label}*
` +
              `PF: ${change.pf === 99 ? "∞" : change.pf.toFixed(2)} | WR: ${change.wr.toFixed(0)}% | Сделок: ${change.trades}
` +
              `Требования к сигналам повышены. Слабые сигналы по этой монете будут отклоняться.`
            );
          } else {
            await safeSend(chatId,
              `✅ *${change.symbol} снята с watchlist*
` +
              `PF: ${change.pf === 99 ? "∞" : change.pf.toFixed(2)} | WR: ${change.wr.toFixed(0)}% | Сделок: ${change.trades}
` +
              `Ограничения на сигналы сняты — инструмент в норме.`
            );
          }
        }
      }
    } catch (err) { logger.error({ err }, "Instrument watchlist daily update failed"); }
    for (const chatId of chatIds) {
      try {
        const { html, filename, summary } = await generateDailyReport(chatId);
        await _bot?.telegram.sendMessage(chatId, summary, { parse_mode: "Markdown" });
        await _bot?.telegram.sendDocument(chatId, { source: html, filename }, { caption: "📄 Полный HTML-отчёт" });
        // Daily backup of strategy weights
        try {
          const [ss, fw, sew, sw, srs] = await Promise.all([
            pool.query("SELECT * FROM strategy_stats"),
            pool.query("SELECT * FROM factor_weights"),
            pool.query("SELECT * FROM strategy_entity_weights"),
            pool.query("SELECT * FROM strategy_weights"),
            pool.query("SELECT * FROM strategy_regime_stats"),
          ]);
          const backupData = {
            strategy_stats: ss.rows, factor_weights: fw.rows,
            strategy_entity_weights: sew.rows,
            strategy_weights: sw.rows,
            strategy_regime_stats: srs.rows,
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

    // FIX High: schedule checkNewListings — was imported but never called in a cron
    cron.schedule("0 * * * *", async () => {
      try {
        await checkNewListings(async (id, msg) => { await safeSend(id, msg); });
      } catch (err) { logger.warn({ err }, "Listings check error"); }
    });

    logger.info("Scheduler started — Self Learning Engine v2 + RC modules active");
  }
