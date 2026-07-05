// ── AI Deep Analysis ────────────────────────────────────────────────────────
// Отдельный аналитический модуль. НЕ участвует в принятии торговых решений,
// НЕ влияет на производительность торгового цикла, ничего не меняет
// автоматически (веса/фильтры/TP/SL/FinalScore/Risk) — только анализирует
// уже накопленные данные и формирует рекомендации.
// Источники: paper_closed_trades, decision_log, strategy_stats/regime/direction,
// trade_features, time_analytics, instrument_analytics, shadow_closed_trades.
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

type Row = Record<string, unknown>;
const num = (v: unknown, d = 0) => (v === null || v === undefined ? d : Number(v));
const pf = (winPnl: number, lossPnl: number) => (lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0);

function fmtPF(v: number) { return v.toFixed(2); }
function fmtPct(v: number) { return `${(v * 100).toFixed(0)}%`; }

// ── Общие метрики по набору сделок (pnl% массив) ────────────────────────────
function calcMetrics(pnls: number[]) {
  const trades = pnls.length;
  const wins = pnls.filter(p => p > 0).length;
  const winPnl = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const lossPnl = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const total = pnls.reduce((a, b) => a + b, 0);
  return {
    trades, wins,
    wr: trades > 0 ? wins / trades : 0,
    pf: pf(winPnl, lossPnl),
    expectancy: trades > 0 ? total / trades : 0,
    total,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 1 — Root Cause Analysis: что сильнее всего повлияло на изменение PF
// ═══════════════════════════════════════════════════════════════════════════
async function blockRootCause(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT symbol, direction, strategy, pnl_percent, closed_at
     FROM paper_closed_trades ORDER BY closed_at DESC LIMIT 300`
  );
  const all = rows as Row[];
  if (all.length < 40) {
    return "*Блок 1 — Root Cause Analysis*\n\n⚠️ Недостаточно данных (нужно ≥40 закрытых сделок).";
  }
  const half = Math.floor(all.length / 2);
  const recent = all.slice(0, half);   // новее
  const prior = all.slice(half);       // старее

  const overallRecent = calcMetrics(recent.map(r => num(r["pnl_percent"])));
  const overallPrior = calcMetrics(prior.map(r => num(r["pnl_percent"])));

  type Bucket = { key: string; label: string };
  function bucketsFor(dim: (r: Row) => string): Record<string, Bucket> { return {}; }

  function groupBy(rowsIn: Row[], keyFn: (r: Row) => string) {
    const map = new Map<string, number[]>();
    for (const r of rowsIn) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(num(r["pnl_percent"]));
    }
    return map;
  }

  const hourBucket = (r: Row) => {
    const h = new Date(String(r["closed_at"])).getUTCHours();
    const b = Math.floor(h / 3) * 3;
    return `Часы ${String(b).padStart(2, "0")}–${String((b + 3) % 24).padStart(2, "0")} UTC`;
  };

  const dims: Array<{ label: string; keyFn: (r: Row) => string }> = [
    { label: "Strategy+Direction", keyFn: r => `${r["strategy"]} ${r["direction"]}` },
    { label: "Coin", keyFn: r => `Монета ${r["symbol"]}` },
    { label: "Time", keyFn: r => hourBucket(r) },
  ];

  type Cause = { name: string; pfBefore: number; pfAfter: number; contribution: number; n: number };
  const causes: Cause[] = [];

  for (const dim of dims) {
    const recentG = groupBy(recent, dim.keyFn);
    const priorG = groupBy(prior, dim.keyFn);
    const keys = new Set([...recentG.keys(), ...priorG.keys()]);
    for (const k of keys) {
      const rArr = recentG.get(k) ?? [];
      const pArr = priorG.get(k) ?? [];
      if (rArr.length < 5 && pArr.length < 5) continue;
      const mR = calcMetrics(rArr);
      const mP = calcMetrics(pArr);
      const share = rArr.length / recent.length;
      const contribution = share * Math.abs(mR.pf - mP.pf);
      causes.push({ name: k, pfBefore: mP.pf, pfAfter: mR.pf, contribution, n: rArr.length });
    }
  }

  // ATR bucket — из trade_features (независимый источник, свой pnl_percent)
  const { rows: featRows } = await pool.query(
    `SELECT (features->>'atrPercent')::float AS atr, pnl_percent, saved_at
     FROM trade_features WHERE is_win IS NOT NULL
     ORDER BY saved_at DESC LIMIT 300`
  );
  const feats = featRows as Row[];
  if (feats.length >= 40) {
    const fHalf = Math.floor(feats.length / 2);
    const fRecent = feats.slice(0, fHalf);
    const fPrior = feats.slice(fHalf);
    const atrBucket = (v: number) => v < 0.4 ? "ATR < 0.4%" : v < 0.8 ? "ATR 0.4–0.8%" : v < 1.2 ? "ATR 0.8–1.2%" : "ATR > 1.2%";
    const rG = groupBy(fRecent, r => atrBucket(num(r["atr"])));
    const pG = groupBy(fPrior, r => atrBucket(num(r["atr"])));
    const keys = new Set([...rG.keys(), ...pG.keys()]);
    for (const k of keys) {
      const rArr = rG.get(k) ?? [];
      const pArr = pG.get(k) ?? [];
      if (rArr.length < 5 && pArr.length < 5) continue;
      const mR = calcMetrics(rArr);
      const mP = calcMetrics(pArr);
      const share = rArr.length / fRecent.length;
      causes.push({ name: k, pfBefore: mP.pf, pfAfter: mR.pf, contribution: share * Math.abs(mR.pf - mP.pf), n: rArr.length });
    }
  }

  causes.sort((a, b) => b.contribution - a.contribution);
  const top = causes.slice(0, 10);
  const totalContribution = causes.reduce((s, c) => s + c.contribution, 0) || 1;

  const lines = [
    "*Блок 1 — Root Cause Analysis*",
    "",
    `Общий PF: ${fmtPF(overallPrior.pf)} → ${fmtPF(overallRecent.pf)} (${overallRecent.pf >= overallPrior.pf ? "рост" : "падение"})`,
    "",
    "ТОП причин изменения PF:",
  ];
  top.forEach((c, i) => {
    const arrow = c.pfAfter >= c.pfBefore ? "↑" : "↓";
    lines.push(
      `\n*Причина №${i + 1}*\n${c.name}\nPF: ${fmtPF(c.pfBefore)} ${arrow} ${fmtPF(c.pfAfter)}\nВклад: ${fmtPct(c.contribution / totalContribution)} (n=${c.n})`
    );
  });
  if (!top.length) lines.push("\nНедостаточно сделок в отдельных сегментах для выделения причин.");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 2 — Feature Discovery: что общего у лучших и худших сделок
// ═══════════════════════════════════════════════════════════════════════════
async function blockFeatureDiscovery(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT features, pnl_percent, is_win FROM trade_features
     WHERE is_win IS NOT NULL ORDER BY saved_at DESC LIMIT 500`
  );
  const feats = rows as Row[];
  if (feats.length < 40) {
    return "*Блок 2 — Feature Discovery*\n\n⚠️ Недостаточно данных (нужно ≥40 сделок с сохранёнными факторами).";
  }
  const sorted = [...feats].sort((a, b) => num(b["pnl_percent"]) - num(a["pnl_percent"]));
  const q = Math.max(10, Math.floor(sorted.length / 4));
  const topQ = sorted.slice(0, q);
  const botQ = sorted.slice(-q);

  const avg = (arr: Row[], key: string) => {
    const vals = arr.map(r => {
      const f = r["features"] as Record<string, unknown>;
      return Number(f?.[key] ?? 0);
    }).filter(v => !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const keys = ["rsi", "atrPercent", "ema20rel", "ema50rel", "ema200rel", "volumeAbove", "isSideways", "isHighVol"];
  const topAvg: Record<string, number> = {}; const botAvg: Record<string, number> = {};
  for (const k of keys) { topAvg[k] = avg(topQ, k); botAvg[k] = avg(botQ, k); }

  const topMetrics = calcMetrics(topQ.map(r => num(r["pnl_percent"])));
  const botMetrics = calcMetrics(botQ.map(r => num(r["pnl_percent"])));

  return [
    "*Блок 2 — Feature Discovery*",
    "",
    "Самые прибыльные сделки в среднем имеют:",
    `• RSI ≈ ${topAvg["rsi"].toFixed(0)}`,
    `• ATR ≈ ${topAvg["atrPercent"].toFixed(2)}%`,
    `• Above EMA20/50/200: ${topAvg["ema20rel"].toFixed(2)} / ${topAvg["ema50rel"].toFixed(2)} / ${topAvg["ema200rel"].toFixed(2)}`,
    `• Sideways-доля: ${(topAvg["isSideways"] * 100).toFixed(0)}% | High-vol доля: ${(topAvg["isHighVol"] * 100).toFixed(0)}%`,
    `PF: ${fmtPF(topMetrics.pf)} | Сделок: ${topMetrics.trades}`,
    "",
    "Самые убыточные сделки в среднем имеют:",
    `• RSI ≈ ${botAvg["rsi"].toFixed(0)}`,
    `• ATR ≈ ${botAvg["atrPercent"].toFixed(2)}%`,
    `• Above EMA20/50/200: ${botAvg["ema20rel"].toFixed(2)} / ${botAvg["ema50rel"].toFixed(2)} / ${botAvg["ema200rel"].toFixed(2)}`,
    `• Sideways-доля: ${(botAvg["isSideways"] * 100).toFixed(0)}% | High-vol доля: ${(botAvg["isHighVol"] * 100).toFixed(0)}%`,
    `PF: ${fmtPF(botMetrics.pf)} | Сделок: ${botMetrics.trades}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 3 — Filter Trust: сколько отклонено каждым фильтром и их полезность
// ═══════════════════════════════════════════════════════════════════════════
async function blockFilterTrust(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT steps FROM decision_log
     WHERE verdict='REJECT' AND timestamp::timestamptz > NOW() - INTERVAL '30 days'`
  );
  const traces = rows as Row[];
  if (!traces.length) {
    return "*Блок 3 — Filter Trust*\n\n⚠️ Нет данных decision_log за последние 30 дней.";
  }
  const failCounts = new Map<string, number>();
  let totalCandidates = traces.length;
  for (const t of traces) {
    const steps = (t["steps"] as Array<Record<string, unknown>>) ?? [];
    const failStep = steps.find(s => s["result"] === "FAIL");
    const name = String(failStep?.["check"] ?? "Неизвестно");
    failCounts.set(name, (failCounts.get(name) ?? 0) + 1);
  }
  const sorted = [...failCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Net-effect можно оценить только там, где есть shadow-данные по направлению
  const { rows: shadowRows } = await pool.query(
    `SELECT strategy, direction,
            SUM(CASE WHEN pnl_percent>0 THEN pnl_percent ELSE 0 END) AS win_pnl,
            SUM(CASE WHEN pnl_percent<0 THEN ABS(pnl_percent) ELSE 0 END) AS loss_pnl,
            COUNT(*) AS n
     FROM shadow_closed_trades
     WHERE is_direction_shadow = true AND closed_at::timestamptz > NOW() - INTERVAL '30 days'
     GROUP BY strategy, direction`
  );
  const shadowMap = new Map<string, { pf: number; n: number }>();
  for (const r of shadowRows as Row[]) {
    shadowMap.set(`${r["strategy"]} ${r["direction"]}`, { pf: pf(num(r["win_pnl"]), num(r["loss_pnl"])), n: num(r["n"]) });
  }

  const lines = ["*Блок 3 — Filter Trust*", "", `Всего отклонённых кандидатов (30д): ${totalCandidates}`, ""];
  for (const [name, cnt] of sorted) {
    lines.push(`*${name}*`);
    lines.push(`Отклонено: ${cnt} (${fmtPct(cnt / totalCandidates)} от всех отказов)`);
    lines.push(`Trust: нет прямых данных об исходе отклонённых сигналов без shadow-теста по этому фильтру.`);
    lines.push("");
  }
  if (shadowMap.size) {
    lines.push("Справочно — shadow PF по направлениям под карантином (доступные данные):");
    for (const [k, v] of shadowMap) lines.push(`• ${k}: shadow PF ${fmtPF(v.pf)} (n=${v.n})`);
  }
  return lines.join("\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 4 — Strategy Diagnostics: где стратегия сильна/слаба
// ═══════════════════════════════════════════════════════════════════════════
async function blockStrategyDiagnostics(): Promise<string> {
  const [{ rows: regimeRows }, { rows: dirRows }] = await Promise.all([
    pool.query(`SELECT strategy, regime, trades, wins, win_pnl, loss_pnl, total_pnl FROM strategy_regime_stats`),
    pool.query(`SELECT strategy, direction, trades, wins, win_pnl, loss_pnl, total_pnl FROM strategy_direction_stats`),
  ]);

  const lines = ["*Блок 4 — Strategy Diagnostics*", ""];
  const strategies = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];

  for (const strat of strategies) {
    const dirs = (dirRows as Row[]).filter(r => r["strategy"] === strat);
    const regimes = (regimeRows as Row[]).filter(r => r["strategy"] === strat);
    if (!dirs.length && !regimes.length) continue;

    lines.push(`*${strat}*`);
    for (const d of dirs) {
      const trades = num(d["trades"]);
      if (trades < 5) continue;
      const p = pf(num(d["win_pnl"]), num(d["loss_pnl"]));
      const wr = trades > 0 ? num(d["wins"]) / trades : 0;
      const exp = trades > 0 ? num(d["total_pnl"]) / trades : 0;
      const verdict = p >= 1.2 && trades >= 20 ? "✅ преимущество" : p < 0.8 ? "⚠️ ограничить" : "➖ нейтрально";
      lines.push(`  ${d["direction"]}: PF ${fmtPF(p)} | WR ${fmtPct(wr)} | Exp ${exp.toFixed(2)}% | n=${trades} — ${verdict}`);
    }
    for (const r of regimes) {
      const trades = num(r["trades"]);
      if (trades < 5) continue;
      const p = pf(num(r["win_pnl"]), num(r["loss_pnl"]));
      const wr = trades > 0 ? num(r["wins"]) / trades : 0;
      const exp = trades > 0 ? num(r["total_pnl"]) / trades : 0;
      const verdict = p >= 1.2 && trades >= 20 ? "✅ преимущество" : p < 0.8 ? "⚠️ ограничить" : "➖ нейтрально";
      lines.push(`  ${r["regime"]}: PF ${fmtPF(p)} | WR ${fmtPct(wr)} | Exp ${exp.toFixed(2)}% | n=${trades} — ${verdict}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 5 — Coin Diagnostics
// ═══════════════════════════════════════════════════════════════════════════
async function blockCoinDiagnostics(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT symbol, direction, strategy, pnl_percent FROM paper_closed_trades`
  );
  const trades = rows as Row[];
  const bySymbol = new Map<string, Row[]>();
  for (const t of trades) {
    const s = String(t["symbol"]);
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s)!.push(t);
  }
  const lines = ["*Блок 5 — Coin Diagnostics*", ""];
  const ranked = [...bySymbol.entries()]
    .map(([symbol, arr]) => ({ symbol, n: arr.length, arr }))
    .filter(x => x.n >= 10)
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);

  if (!ranked.length) return lines.concat("⚠️ Недостаточно данных (нужно ≥10 сделок по монете).").join("\n");

  for (const { symbol, arr } of ranked) {
    const longs = arr.filter(t => t["direction"] === "LONG").map(t => num(t["pnl_percent"]));
    const shorts = arr.filter(t => t["direction"] === "SHORT").map(t => num(t["pnl_percent"]));
    const longPF = calcMetrics(longs).pf;
    const shortPF = calcMetrics(shorts).pf;
    const byStrat = new Map<string, number[]>();
    for (const t of arr) {
      const s = String(t["strategy"]);
      if (!byStrat.has(s)) byStrat.set(s, []);
      byStrat.get(s)!.push(num(t["pnl_percent"]));
    }
    const stratPF = [...byStrat.entries()].map(([s, p]) => ({ s, pf: calcMetrics(p).pf, n: p.length })).sort((a, b) => b.pf - a.pf);
    const best = stratPF[0];
    const worst = stratPF[stratPF.length - 1];
    const overallPF = calcMetrics(arr.map(t => num(t["pnl_percent"]))).pf;
    const rec = overallPF < 0.7 && arr.length >= 20 ? "исключить" : overallPF < 1.0 ? "ограничить" : "оставить";

    lines.push(
      `*${symbol}* (n=${arr.length})\n` +
      `LONG PF: ${fmtPF(longPF)} (n=${longs.length}) | SHORT PF: ${fmtPF(shortPF)} (n=${shorts.length})\n` +
      `Лучшая стратегия: ${best ? `${best.s} (PF ${fmtPF(best.pf)})` : "—"} | Худшая: ${worst && worst !== best ? `${worst.s} (PF ${fmtPF(worst.pf)})` : "—"}\n` +
      `Рекомендация: *${rec}*\n`
    );
  }
  return lines.join("\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 6 — Trade Management Analysis (TP1/TP2/SL/BE/Trail)
// ═══════════════════════════════════════════════════════════════════════════
async function blockTradeManagement(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, outcome, pnl_percent FROM paper_closed_trades
     WHERE closed_at::timestamptz > NOW() - INTERVAL '60 days'`
  );
  const trades = rows as Row[];
  if (trades.length < 20) return "*Блок 6 — Trade Management Analysis*\n\n⚠️ Недостаточно данных.";

  const byOutcome = new Map<string, number[]>();
  for (const t of trades) {
    const o = String(t["outcome"]);
    if (!byOutcome.has(o)) byOutcome.set(o, []);
    byOutcome.get(o)!.push(num(t["pnl_percent"]));
  }
  const lines = ["*Блок 6 — Trade Management Analysis*", "", "Распределение по исходам:"];
  for (const [outcome, pnls] of [...byOutcome.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    lines.push(`• ${outcome}: ${pnls.length} сделок (${fmtPct(pnls.length / trades.length)}), avg PnL ${avgPnl.toFixed(2)}%`);
  }

  const tp1 = byOutcome.get("TP1")?.length ?? 0;
  const tp2 = byOutcome.get("TP2")?.length ?? 0;
  const sl = byOutcome.get("SL")?.length ?? 0;
  const be = (byOutcome.get("BE")?.length ?? 0) + (byOutcome.get("BREAKEVEN")?.length ?? 0);
  const total = trades.length;

  lines.push("", "Выводы:");
  if (tp1 + tp2 > 0 && tp1 / (tp1 + tp2) > 0.75) {
    lines.push(`• TP1 достигается в ${fmtPct(tp1 / (tp1 + tp2))} случаев из TP-закрытий, TP2 — редко. Есть смысл рассмотреть более консервативный TP2 или частичное закрытие раньше.`);
  } else if (tp1 + tp2 > 0) {
    lines.push(`• Баланс TP1/TP2 сбалансирован (TP1 ${fmtPct(tp1 / (tp1 + tp2))}), явных проблем с целями не выявлено.`);
  }
  if (sl / total > 0.4) {
    lines.push(`• Доля закрытий по SL высокая (${fmtPct(sl / total)}) — возможно, стоп слишком близко к входу или вход недостаточно точен.`);
  }
  if (be / total > 0.2) {
    lines.push(`• Значительная доля сделок закрывается в безубытке (${fmtPct(be / total)}) — перенос в BE может срабатывать слишком рано, отсекая потенциальный профит.`);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 7 — Equity Analysis: разбивка истории на участки
// ═══════════════════════════════════════════════════════════════════════════
async function blockEquityAnalysis(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, direction, pnl_percent, closed_at FROM paper_closed_trades ORDER BY closed_at ASC`
  );
  const trades = rows as Row[];
  if (trades.length < 50) return "*Блок 7 — Equity Analysis*\n\n⚠️ Недостаточно данных (нужно ≥50 сделок).";

  const segCount = 5;
  const segSize = Math.floor(trades.length / segCount);
  const lines = ["*Блок 7 — Equity Analysis*", ""];
  let prevPF: number | null = null;
  for (let i = 0; i < segCount; i++) {
    const seg = trades.slice(i * segSize, i === segCount - 1 ? trades.length : (i + 1) * segSize);
    if (!seg.length) continue;
    const m = calcMetrics(seg.map(t => num(t["pnl_percent"])));
    const stratCounts = new Map<string, number>();
    for (const t of seg) {
      const k = `${t["strategy"]} ${t["direction"]}`;
      stratCounts.set(k, (stratCounts.get(k) ?? 0) + 1);
    }
    const dominant = [...stratCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const from = String(seg[0]["closed_at"]).slice(0, 10);
    const to = String(seg[seg.length - 1]["closed_at"]).slice(0, 10);
    const trend = prevPF === null ? "" : m.pf > prevPF ? " (рост)" : m.pf < prevPF ? " (падение)" : "";
    lines.push(
      `Участок ${i + 1} (${from} — ${to}): PF ${fmtPF(m.pf)}${trend}, n=${m.trades}\n` +
      `  Доминирует: ${dominant ? `${dominant[0]} (${dominant[1]} сд.)` : "—"}`
    );
    prevPF = m.pf;
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// БЛОК 8 — Recommendations: синтез рекомендаций по всем блокам (без авто-применения)
// ═══════════════════════════════════════════════════════════════════════════
async function blockRecommendations(): Promise<string> {
  const [{ rows: dirRows }, { rows: regimeRows }] = await Promise.all([
    pool.query(`SELECT strategy, direction, trades, win_pnl, loss_pnl FROM strategy_direction_stats`),
    pool.query(`SELECT strategy, regime, trades, win_pnl, loss_pnl FROM strategy_regime_stats`),
  ]);

  type Rec = { text: string; confidence: 1 | 2 | 3 | 4 | 5; impact: number; n: number };
  const recs: Rec[] = [];

  for (const r of regimeRows as Row[]) {
    const trades = num(r["trades"]);
    if (trades < 15) continue;
    const p = pf(num(r["win_pnl"]), num(r["loss_pnl"]));
    if (p < 0.7) {
      const conf: Rec["confidence"] = trades >= 50 ? 5 : trades >= 20 ? 3 : 2;
      recs.push({
        text: `Ограничить ${r["strategy"]} в режиме ${r["regime"]} (PF ${fmtPF(p)}, n=${trades})`,
        confidence: conf,
        impact: Math.max(0, 1.0 - p) * 0.2,
        n: trades,
      });
    }
  }
  for (const r of dirRows as Row[]) {
    const trades = num(r["trades"]);
    if (trades < 15) continue;
    const p = pf(num(r["win_pnl"]), num(r["loss_pnl"]));
    if (p < 0.7) {
      const conf: Rec["confidence"] = trades >= 50 ? 5 : trades >= 20 ? 3 : 2;
      recs.push({
        text: `Пересмотреть ${r["strategy"]} ${r["direction"]} (PF ${fmtPF(p)}, n=${trades}) — слабое направление`,
        confidence: conf,
        impact: Math.max(0, 1.0 - p) * 0.15,
        n: trades,
      });
    } else if (p > 1.5 && trades >= 20) {
      recs.push({
        text: `${r["strategy"]} ${r["direction"]} показывает высокий PF (${fmtPF(p)}, n=${trades}) — кандидат на увеличение веса/лимита`,
        confidence: trades >= 50 ? 4 : 3,
        impact: 0.05,
        n: trades,
      });
    }
  }

  recs.sort((a, b) => b.impact - a.impact);
  const top = recs.slice(0, 8);
  const lines = ["*Блок 8 — Recommendations*", "", "⚠️ Модуль ничего не меняет автоматически — все изменения через /adapt или вручную.", ""];
  if (!top.length) {
    lines.push("Явных проблемных зон не найдено — метрики в пределах нормы.");
  }
  top.forEach(r => {
    const stars = "★".repeat(r.confidence) + "☆".repeat(5 - r.confidence);
    lines.push(`${stars}\n${r.text}\nОжидаемый прирост PF: +${r.impact.toFixed(2)} (оценочно)\n`);
  });
  return lines.join("\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Главная функция — собрать полный отчёт (не блокирует торговый цикл: только SELECT)
// ═══════════════════════════════════════════════════════════════════════════
export async function generateDeepAnalysis(): Promise<string[]> {
  const blocks = await Promise.all([
    blockRootCause(),
    blockFeatureDiscovery(),
    blockFilterTrust(),
    blockStrategyDiagnostics(),
    blockCoinDiagnostics(),
    blockTradeManagement(),
    blockEquityAnalysis(),
    blockRecommendations(),
  ]).catch(err => {
    logger.error({ err }, "generateDeepAnalysis failed");
    throw err;
  });

  const header = "🧠 *AI Deep Analysis*\n_Отдельный аналитический модуль — не влияет на торговлю, ничего не меняет автоматически._\n";
  const full = [header, ...blocks];

  const chunks: string[] = [];
  let cur = "";
  for (const part of full) {
    const next = cur ? cur + "\n\n" + part : part;
    if (next.length > 3800) { if (cur) chunks.push(cur); cur = part; }
    else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── Авто-триггер: раз в сутки ИЛИ каждые 500+ новых сделок ──────────────────
export async function maybeRunAutoDeepAnalysis(): Promise<string[] | null> {
  const { rows } = await pool.query(`SELECT last_run_at, trades_at_last_run FROM deep_analysis_state WHERE id=1`);
  const state = (rows[0] ?? {}) as Row;
  const lastRunAt = state["last_run_at"] ? new Date(String(state["last_run_at"])) : null;
  const tradesAtLastRun = num(state["trades_at_last_run"]);

  const { rows: cntRows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM paper_closed_trades`);
  const currentTrades = num((cntRows[0] as Row)["cnt"]);

  const hoursSinceRun = lastRunAt ? (Date.now() - lastRunAt.getTime()) / 3_600_000 : Infinity;
  const tradesSinceRun = currentTrades - tradesAtLastRun;

  if (hoursSinceRun < 24 && tradesSinceRun < 500) return null;

  const report = await generateDeepAnalysis();
  await pool.query(
    `UPDATE deep_analysis_state SET last_run_at=NOW(), trades_at_last_run=$1 WHERE id=1`,
    [currentTrades]
  );
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML-отчёт — тот же набор блоков, собранный в единый HTML-документ
// (удобнее читать целиком, чем постранично в Telegram). Ничего не меняет,
// только форматирует уже посчитанные данные.
// ═══════════════════════════════════════════════════════════════════════════
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(md)
    .replace(/\*(.+?)\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .split("\n").join("<br>\n");
}

export async function generateDeepAnalysisHtml(): Promise<string> {
  const blockDefs: Array<{ title: string; run: () => Promise<string> }> = [
    { title: "Root Cause Analysis", run: blockRootCause },
    { title: "Feature Discovery", run: blockFeatureDiscovery },
    { title: "Filter Trust", run: blockFilterTrust },
    { title: "Strategy Diagnostics", run: blockStrategyDiagnostics },
    { title: "Coin Diagnostics", run: blockCoinDiagnostics },
    { title: "Trade Management Analysis", run: blockTradeManagement },
    { title: "Equity Analysis", run: blockEquityAnalysis },
    { title: "Recommendations", run: blockRecommendations },
  ];

  const results = await Promise.all(blockDefs.map(b => b.run())).catch(err => {
    logger.error({ err }, "generateDeepAnalysisHtml failed");
    throw err;
  });

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const sections = blockDefs.map((b, i) => {
    const body = mdToHtml(results[i]).replace(new RegExp(`^<strong>Блок \\d+ — ${b.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/strong><br>\\s*<br>\\s*`), "");
    return `
      <section class="block">
        <h2><span class="badge">${i + 1}</span> ${b.title}</h2>
        <div class="content">${body}</div>
      </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>AI Deep Analysis — ${generatedAt}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#0f1117; color:#e6e8ee; margin:0; padding:0 0 60px; }
  header { background:linear-gradient(135deg,#1a1d29,#0f1117); padding:32px 24px; border-bottom:1px solid #2a2e3d; }
  header h1 { margin:0 0 6px; font-size:24px; }
  header p { margin:0; color:#9aa0b4; font-size:13px; }
  main { max-width:900px; margin:24px auto; padding:0 20px; }
  .block { background:#171a24; border:1px solid #262a38; border-radius:12px; padding:20px 24px; margin-bottom:20px; }
  .block h2 { margin:0 0 14px; font-size:17px; display:flex; align-items:center; gap:10px; }
  .badge { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:50%; background:#3a5cf0; color:#fff; font-size:13px; font-weight:600; }
  .content { font-size:14px; line-height:1.65; color:#c9cddb; }
  .content strong { color:#fff; }
  .warn { color:#f0a83a; }
  footer { text-align:center; color:#5c6178; font-size:12px; margin-top:30px; }
</style>
</head>
<body>
  <header>
    <h1>🧠 AI Deep Analysis</h1>
    <p>Отдельный аналитический модуль — не влияет на торговлю, ничего не меняет автоматически. Сформирован: ${generatedAt}</p>
  </header>
  <main>
    ${sections}
  </main>
  <footer>crypto-signal-bot · AI Deep Analysis · read-only отчёт</footer>
</body>
</html>`;
}
