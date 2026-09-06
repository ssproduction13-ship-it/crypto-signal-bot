---
name: BUG-15/16 direction stats and silent-catch policy
description: Direction aggregate reconciliation and the project rule for asynchronous close-time metrics
---

## Implemented

- `recordDirectionTrade()` logs database write failures with strategy and direction context.
- `paper-trading.ts` logs failures from all seven close-time statistic recorders in both TP1 and final-close paths.
- Deep Analysis direction diagnostics and recommendations aggregate directly from `paper_closed_trades` using `COALESCE(pnl_equity_pct, pnl_percent)`.
- `scripts/reconcile-direction-stats.mjs` compares and rebuilds `strategy_direction_stats` without changing direction weights/quarantine metadata.

## Project rule

Every `.catch()` must log the error or return an explicitly handled fallback. Bare `.catch(() => {})` / `.catch(()=>{})` is forbidden for new code. Existing unrelated silent catches remain outside the BUG-15/16 scope and should be audited separately.