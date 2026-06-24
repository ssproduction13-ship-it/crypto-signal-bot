import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");
const PAPER_FILE = path.join(DATA_DIR, "paper.json");
const WEIGHTS_FILE = path.join(DATA_DIR, "weights.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir();
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

export interface JournalEntry {
  id: string;
  symbol: string;
  interval: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  score: number;
  confidence: number;
  timestamp: string;
  closedAt?: string;
  closePrice?: number;
  outcome?: "TP1" | "TP2" | "SL" | "MANUAL";
  pnlPercent?: number;
  errorAnalysis?: string;
  factors: Record<string, number>;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  size: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  openedAt: string;
  chatId: number;
}

export interface PaperAccount {
  balance: number;
  initialBalance: number;
  positions: PaperPosition[];
  closedTrades: ClosedPaperTrade[];
}

export interface ClosedPaperTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  closePrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  outcome: string;
  openedAt: string;
  closedAt: string;
}

export interface FactorWeights {
  trend: number;
  volume: number;
  momentum: number;
  levels: number;
  pattern: number;
}

export interface UserSettings {
  noTradeMode: boolean;
  minScore: number;
  riskPercent: number;
  accountSize: number;
}

const DEFAULT_WEIGHTS: FactorWeights = {
  trend: 0.30,
  volume: 0.25,
  momentum: 0.20,
  levels: 0.15,
  pattern: 0.10,
};

const DEFAULT_SETTINGS: UserSettings = {
  noTradeMode: false,
  minScore: 70,
  riskPercent: 1,
  accountSize: 1000,
};

export async function loadJournal(): Promise<JournalEntry[]> {
  return readJson<JournalEntry[]>(JOURNAL_FILE, []);
}

export async function saveJournal(entries: JournalEntry[]): Promise<void> {
  await writeJson(JOURNAL_FILE, entries);
}

export async function addJournalEntry(entry: JournalEntry): Promise<void> {
  const journal = await loadJournal();
  journal.push(entry);
  await saveJournal(journal);
}

export async function updateJournalEntry(
  id: string,
  update: Partial<JournalEntry>
): Promise<boolean> {
  const journal = await loadJournal();
  const idx = journal.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  journal[idx] = { ...journal[idx]!, ...update };
  await saveJournal(journal);
  return true;
}

export async function loadPaperAccount(chatId: number): Promise<PaperAccount> {
  const all = await readJson<Record<string, PaperAccount>>(PAPER_FILE, {});
  return all[String(chatId)] ?? {
    balance: 10000,
    initialBalance: 10000,
    positions: [],
    closedTrades: [],
  };
}

export async function savePaperAccount(
  chatId: number,
  account: PaperAccount
): Promise<void> {
  const all = await readJson<Record<string, PaperAccount>>(PAPER_FILE, {});
  all[String(chatId)] = account;
  await writeJson(PAPER_FILE, all);
}

export async function loadWeights(): Promise<FactorWeights> {
  return readJson<FactorWeights>(WEIGHTS_FILE, DEFAULT_WEIGHTS);
}

export async function saveWeights(w: FactorWeights): Promise<void> {
  await writeJson(WEIGHTS_FILE, w);
}

export async function loadSettings(chatId: number): Promise<UserSettings> {
  const all = await readJson<Record<string, UserSettings>>(SETTINGS_FILE, {});
  return all[String(chatId)] ?? { ...DEFAULT_SETTINGS };
}

export async function saveSettings(
  chatId: number,
  settings: UserSettings
): Promise<void> {
  const all = await readJson<Record<string, UserSettings>>(SETTINGS_FILE, {});
  all[String(chatId)] = settings;
  await writeJson(SETTINGS_FILE, all);
}

export function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

logger.info({ dataDir: DATA_DIR }, "Storage initialized");
