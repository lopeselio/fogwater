import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duel, Opening, Placement } from '@fogwater/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Game records: one JSON file each under DATA_DIR/games (an Azure Files share when hosted, so games
// survive restarts and redeploys). Everything public about a game is also onchain; the files add the
// names, the seat tokens' hashes, the admirals' sealed fleets and the proof bundle.

export interface SeatRec {
  kind: 'guest' | 'account' | 'ai';
  /** what the contract calls this seat: "guest:…", "ai:…" or the NEAR account */
  label: string;
  name: string;
  account?: string;
  admiral?: string;
  /** sha256 of the seat's secret token (the browser keeps the token) */
  tokenHash?: string;
}

export type LoggedMove =
  | { t: 'fire'; seat: 0 | 1; cell: number; at: number }
  | { t: 'answer'; seat: 0 | 1; opening: Opening; sunk: number | null; at: number };

export interface ChainOp { what: string; method: string; args: Record<string, unknown>; gas: number }

export interface GameRecord {
  id: string;
  mode: 'ai' | 'friend';
  createdAt: number;
  updatedAt: number;
  /** last time a seat acted (the clock for timeouts) */
  actedAt: number;
  timeoutS: number;
  seats: [SeatRec, SeatRec | null];
  duel: Duel;
  /** the admiral's secret fleet (AI games only); served only once fleets are revealed */
  aiSecret?: { seed: string; ships: Placement[] };
  reveals: [{ seed: string; ships: Placement[] } | null, { seed: string; ships: Placement[] } | null];
  moves: LoggedMove[];
  lines: SignedLine[];
  chain: { created: boolean; filled: boolean; pending: ChainOp[]; txs: { what: string; hash: string }[]; error?: string };
}

const dir = join(config.dataDir, 'games');
mkdirSync(dir, { recursive: true });
const mem = new Map<string, GameRecord>();

export function saveGame(g: GameRecord): void {
  mem.set(g.id, g);
  // write-then-rename, so a crash never leaves half a file
  const file = join(dir, `${g.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(g));
  renameSync(`${file}.tmp`, file);
}

export const validId = (id: string): boolean => /^[a-z0-9-]{1,40}$/.test(id);

export function loadGame(id: string): GameRecord | null {
  if (!validId(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const g = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as GameRecord;
    mem.set(id, g);
    return g;
  } catch { return null; }
}

/** Every stored game (loaded lazily into memory). */
export function allGames(): GameRecord[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => loadGame(f.slice(0, -5))).filter((g): g is GameRecord => !!g);
}
