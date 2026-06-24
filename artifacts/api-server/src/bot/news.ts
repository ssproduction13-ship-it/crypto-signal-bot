import axios from "axios";
import { logger } from "../lib/logger.js";
import type { NewsItem } from "./llm-hook.js";

const BASE_URL = "https://min-api.cryptocompare.com/data/v2/news/";

const SYMBOL_TO_CATEGORY: Record<string, string> = {
  BTC: "BTC",
  ETH: "ETH",
  SOL: "SOL,Solana",
  BNB: "BNB",
  XRP: "XRP",
  DOGE: "DOGE",
  ADA: "ADA,Cardano",
  AVAX: "AVAX,Avalanche",
  DOT: "DOT,Polkadot",
  MATIC: "MATIC,Polygon",
  LINK: "LINK,Chainlink",
  UNI: "UNI,Uniswap",
  LTC: "LTC",
  ATOM: "ATOM,Cosmos",
};

function extractBase(symbol: string): string {
  return symbol.replace(/USDT$|USDC$|BUSD$|BTC$|ETH$/i, "").toUpperCase();
}

function classifySentiment(title: string, body: string): NewsItem["sentiment"] {
  const text = `${title} ${body}`.toLowerCase();

  const bullishWords = [
    "surge", "rally", "pump", "bull", "gain", "rise", "high", "growth",
    "adoption", "partnership", "launch", "upgrade", "buy", "bullish",
    "record", "ath", "moon", "boost", "positive", "approval", "listed",
    "рост", "буллиш", "покупают", "рекорд",
  ];
  const bearishWords = [
    "crash", "dump", "bear", "drop", "fall", "low", "decline", "sell",
    "hack", "ban", "scam", "fraud", "fear", "loss", "bearish", "warning",
    "risk", "concern", "plunge", "collapse", "regulation", "lawsuit",
    "падение", "медвежий", "обвал", "запрет",
  ];

  let bullScore = 0;
  let bearScore = 0;

  for (const w of bullishWords) if (text.includes(w)) bullScore++;
  for (const w of bearishWords) if (text.includes(w)) bearScore++;

  if (bullScore > bearScore) return "positive";
  if (bearScore > bullScore) return "negative";
  return "neutral";
}

export async function fetchNews(symbol: string, limit = 5): Promise<NewsItem[]> {
  const base = extractBase(symbol);
  const categories = SYMBOL_TO_CATEGORY[base] ?? base;

  try {
    const apiKey = process.env["CRYPTOCOMPARE_API_KEY"];
    const params: Record<string, string | number> = {
      lang: "EN",
      categories,
      limit,
      sortOrder: "latest",
    };
    if (apiKey) params["api_key"] = apiKey;

    const res = await axios.get(BASE_URL, { params, timeout: 8000 });
    const data = res.data as { Data?: { title: string; body: string; source: string; published_on: number }[] };

    if (!data.Data?.length) return [];

    return data.Data.slice(0, limit).map((item) => ({
      title: item.title,
      sentiment: classifySentiment(item.title, item.body ?? ""),
      source: item.source,
      publishedAt: new Date(item.published_on * 1000).toISOString(),
    }));
  } catch (err) {
    logger.warn({ err, symbol }, "Failed to fetch news from CryptoCompare");
    return [];
  }
}

export function summarizeNewsSentiment(news: NewsItem[]): {
  overall: "bullish" | "bearish" | "neutral";
  positive: number;
  negative: number;
  neutral: number;
} {
  if (news.length === 0) {
    return { overall: "neutral", positive: 0, negative: 0, neutral: 0 };
  }

  const positive = news.filter((n) => n.sentiment === "positive").length;
  const negative = news.filter((n) => n.sentiment === "negative").length;
  const neutral = news.filter((n) => n.sentiment === "neutral").length;

  let overall: "bullish" | "bearish" | "neutral" = "neutral";
  if (positive > negative + neutral * 0.5) overall = "bullish";
  else if (negative > positive + neutral * 0.5) overall = "bearish";

  return { overall, positive, negative, neutral };
}
