---
name: BUG-13 — R/R filter text vs threshold mismatch
description: Root-cause analysis of the 74.5% R/R rejection rate observed in live reports despite code that should never reject R/R.
---

## Root cause

In `signals.ts` the filter text read `"ниже мин. 1:2.0"` while the actual threshold in `risk.ts` was `rrRatio1 >= 1.5`.

`calcRisk()` in `risk.ts` always produces `rrRatio1 = 4 ATR / 2 ATR = 2.0` (TP1 at 4×ATR, stop at 2×ATR).  
With threshold `>= 1.5`, `isRRViable` is therefore **always true** — the filter *cannot* fire in the current codebase.

## Why the live bot showed 74.5% rejections with this reason

The Railway deployment was running **older code** (pre-widening fix) that used `TP1 = 3×ATR / stop = 1.3×ATR`, giving `rrRatio1 ≈ 2.31`, with a threshold of `>= 2.0`.  After the ATR widening commit (stop `1.3→2.0`, TP1 `3→4`) `rrRatio1` dropped to exactly `2.0`, so any deployment still running the old threshold `> 2.0` (strict greater-than) would reject *every* signal.  The text "1:2.0" in the rejection message is a residue of that earlier threshold.

## Fix applied (BUG-13)

`signals.ts`: filter reason text corrected from `"ниже мин. 1:2.0"` → `"ниже мин. 1:1.5"` to match the actual `>= 1.5` threshold in `risk.ts`.

**Why:** Consistent text prevents confusion when reading filter stats.  The underlying code is already correct; after redeploying from the current branch the rejection rate from this gate should drop to ~0 % because `rrRatio1 = 2.0 >= 1.5` always passes.

## How to monitor

After next deploy, watch `/learning` or the weekly report for `R/R ниже мин.` in filter reasons.  
If it still appears at >1 %, re-check whether Railway is running the latest commit from `main`.
