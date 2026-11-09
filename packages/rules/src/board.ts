// The sea: a 10×10 grid, cells numbered row * 10 + col (A1 = 0, J10 = 99).

export const SIZE = 10;
export const CELLS = SIZE * SIZE;

export interface ShipKind { name: string; len: number }

/** The fleet every captain sails, in this order. Ship index = position in this list. */
export const FLEET: readonly ShipKind[] = [
  { name: 'Dreadnought', len: 5 },
  { name: 'Frigate', len: 4 },
  { name: 'Corvette', len: 3 },
  { name: 'Submarine', len: 3 },
  { name: 'Cutter', len: 2 },
];

/** Hits needed to sink a whole fleet. */
export const FLEET_CELLS = FLEET.reduce((n, s) => n + s.len, 0);
/** On a legal board, a captain can miss at most this many times. One more miss proves the board is short of ships. */
export const MAX_MISSES = CELLS - FLEET_CELLS;

/** One ship: its bow cell and whether it runs down (vertical) or right (horizontal). */
export interface Placement { start: number; vertical: boolean }

export const rowOf = (c: number): number => Math.floor(c / SIZE);
export const colOf = (c: number): number => c % SIZE;
export const cellName = (c: number): string => `${'ABCDEFGHIJ'[rowOf(c)]}${colOf(c) + 1}`;
export const isCell = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < CELLS;

/** The cells a ship of length `len` covers, or null if it runs off the sea. */
export function shipCells(p: Placement, len: number): number[] | null {
  if (!isCell(p.start)) return null;
  const r = rowOf(p.start), c = colOf(p.start);
  if (p.vertical ? r + len > SIZE : c + len > SIZE) return null;
  return Array.from({ length: len }, (_, i) => p.start + i * (p.vertical ? SIZE : 1));
}

/**
 * The board for a fleet: for each cell, the index of the ship on it, or -1 for open water.
 * Throws if the fleet isn't legal (wrong count, off the sea, overlapping).
 */
export function layout(ships: readonly Placement[]): number[] {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) throw new Error(`a fleet has exactly ${FLEET.length} ships`);
  const board = new Array<number>(CELLS).fill(-1);
  ships.forEach((p, k) => {
    const cells = shipCells(p, FLEET[k].len);
    if (!cells) throw new Error(`the ${FLEET[k].name} runs off the sea`);
    for (const c of cells) {
      if (board[c] !== -1) throw new Error(`the ${FLEET[k].name} overlaps the ${FLEET[board[c]].name}`);
      board[c] = k;
    }
  });
  return board;
}

export function isLegal(ships: readonly Placement[]): boolean {
  try { layout(ships); return true; } catch { return false; }
}

/** A random legal fleet. */
export function randomFleet(rand: () => number): Placement[] {
  for (;;) {
    const board = new Array<number>(CELLS).fill(-1);
    const out: Placement[] = [];
    let ok = true;
    for (let k = 0; k < FLEET.length && ok; k++) {
      ok = false;
      for (let tries = 0; tries < 200; tries++) {
        const p = { start: Math.floor(rand() * CELLS), vertical: rand() < 0.5 };
        const cells = shipCells(p, FLEET[k].len);
        if (!cells || cells.some((c) => board[c] !== -1)) continue;
        for (const c of cells) board[c] = k;
        out.push(p);
        ok = true;
        break;
      }
    }
    if (ok) return out;
  }
}
