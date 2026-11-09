import type { Placement, Seat } from '@fogwater/rules';

// What this browser keeps for each game it plays: the seat token, and the fleet's secret seed and
// placements. The fleet secret never leaves the browser except as single-cell openings, and in full
// only once the battle is decided.

export interface LocalSeat { seat: Seat; token: string; seed?: string; ships?: Placement[]; name?: string }

const KEY = 'fogwater:seats';

function readAll(): Record<string, LocalSeat> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, LocalSeat>; } catch { return {}; }
}
function writeAll(all: Record<string, LocalSeat>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: the game still plays this session */ }
}

const session: Record<string, LocalSeat> = {};

export const getSeat = (id: string): LocalSeat | null => session[id] ?? readAll()[id] ?? null;
export function putSeat(id: string, s: LocalSeat): void {
  session[id] = s;
  writeAll({ ...readAll(), [id]: s });
}
export const allSeats = (): { id: string; token: string }[] =>
  Object.entries({ ...readAll(), ...session }).map(([id, s]) => ({ id, token: s.token }));

export function getName(): string {
  try { return localStorage.getItem('fogwater:name') ?? ''; } catch { return ''; }
}
export function setName(n: string): void {
  try { localStorage.setItem('fogwater:name', n); } catch { /* fine */ }
}
