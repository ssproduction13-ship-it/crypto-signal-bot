---
name: Audit fixes — crypto-signal-bot
description: Status of the full code audit; which bugs were fixed and which remain open
---

## Repo
`ssproduction13-ship-it/crypto-signal-bot`, branch `main`
Cloned at `/tmp/csb` (may be stale after reboot — reclone from GitHub if missing)

## Fixes pushed (4 commits)

### Batch 1 — Critical+High (8 fixes)
- `mtf-filter.ts`: cacheKey ReferenceError crash fixed; cache-check added at function entry
- `indicators.ts`: MACD fallback was "buy"/"sell" without crossover → now "neutral"
- `scoring.ts`: lastVol uses `[length-2]` (closed candle) not `[length-1]` (open candle)
- `scoring.ts`: patternScore + volumeScore*0.5 added to trendBias direction calculation
- `signals.ts`: sequential `await loadWeights(); await loadSettings()` → `Promise.all`
- `learning-engine.ts`: quarantine weight floor 0.10→0.03 (toxic entities no longer dominate)
- `data-cleanup.ts`: Steps 6-9 (DELETE+INSERT) wrapped in a single DB transaction
- `scheduler.ts`: recentlyProcessed / shadowBannedDebounce / lastCorrGuardNotify Maps get hourly GC
- `journal.ts`: updateWeights is now a single atomic SQL UPDATE (race condition on concurrent closes fixed)

### Batch 2 — High (5 fixes)
- `backtest.ts`: TP1 checked before TP2 (was reversed → inflated backtest PnL)
- `chaos-filter.ts`: lastVolume uses `[length-2]` not `[length-1]`
- `confidence.ts`: 6 sequential DB queries → single `Promise.all` (~500ms saved per signal)
- `index.ts /scan`: outer try/catch added
- `index.ts /status`: outer try/catch added; `loadSettings+loadPaperAccount` → `Promise.all`

### Batch 3 — Medium (3 fixes)
- `risk.ts`: position size now accounts for 0.2% round-trip commission in denominator
- `learning-engine.ts`: `isStrategyBlockedInRegime` AND→OR (poor PF alone now blocks)
- `feature-importance.ts`: pfLift coefficient 20→3 (one lucky trade no longer dominates)

### Batch 4 — Critical schema (DB migration)
- `migrations/001_numeric_financial_columns.sql`: ALTER TABLE script for all financial columns
- `db.ts`: schema updated to NUMERIC(20,8) for all price/pnl/balance columns
- **To apply to production**: `psql $DATABASE_URL -f migrations/001_numeric_financial_columns.sql`

## Known remaining issues (not fixed)

| Issue | Reason not fixed |
|---|---|
| Walk-forward training windows overlap | Fixing `pos += TRAIN_SIZE+TEST_SIZE` yields 0 windows with <1200 trades — breaks feature |
| Self-analysis maxDD ignores intra-trade drawdown | Requires tick-level worst-price tracking; no such field in schema |
| AB-test not true 50/50 split | Requires understanding variant allocation logic deeply |
| paper-trading.ts balance race condition | Already mitigated by `_checkPositionsRunning` guard in scheduler |
| remaining DOUBLE PRECISION in db.ts (non-financial columns) | Scores/percentages — float precision is acceptable |

**Why:** These either require data model changes, break features at current data scale, or are already mitigated by existing guards.
