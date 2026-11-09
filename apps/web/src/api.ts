import type { Duel, Placement, Seat } from '@fogwater/rules';

// Server API. The wallet session is Better Auth's HttpOnly cookie (same origin); a seat is proven by
// the token this browser got when it created or joined the game.

export async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-seat-token'] = token;
  const res = await fetch(`/api${path}`, body === undefined ? { headers, credentials: 'same-origin' } : { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface AdmiralInfo { id: string; name: string; title: string; skill: string; blurb: string }
export interface ServerConfig { network: string; contract: string; referee: string; chain: boolean; relayer: string | null; nearAi: boolean; admirals: AdmiralInfo[] }

export interface SeatView { kind: 'guest' | 'account' | 'ai'; label: string; name: string; account: string | null; admiral: string | null }
export interface GameView {
  id: string;
  mode: 'ai' | 'friend';
  you: Seat | null;
  createdAt: number;
  updatedAt: number;
  deadline: number | null;
  seats: [SeatView, SeatView | null];
  duel: Duel;
  waitingOn: Seat | null;
  reveals: ({ seed: string; ships: Placement[] } | null)[];
  lines: { who: string; text: string; signed: boolean }[];
  chain: { enabled: boolean; contract: string; created: boolean; filled: boolean; queued: number; error: string | null; txs: { what: string; hash: string; url: string }[] };
}

export interface Summary {
  id: string; mode: 'ai' | 'friend'; you: Seat | null; phase: string; updatedAt: number;
  names: [string, string | null]; waitingOn: Seat | null; winner: Seat | null; hits: [number, number];
}

export interface Stats { games: number; wins: number; losses: number; best: number; ships_sunk: number }

export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
