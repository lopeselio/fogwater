import { FLEET, FLEET_CELLS, MAX_MISSES, isCell, layout, type Placement } from './board.ts';
import { isHex32, rootOf, verifyOpening, type Opening } from './commit.ts';

// One game between two captains (seat 0 fires first). The server and the browser both run this, and
// the contract enforces the same rules onchain. Turns alternate, one shot each.
//
// A turn has two halves: the shooter names a cell (`fire`), then the defender opens that cell's leaf
// (`answer`), and only then may the defender fire back. A defender who has just lost a whole ship
// says which one; that claim is checked against the revealed fleet at the end.

export type Seat = 0 | 1;
export type Phase = 'placing' | 'playing' | 'reveal' | 'done';

export interface Shot { cell: number; hit: boolean; sunk: number | null }

export interface Duel {
  id: string;
  phase: Phase;
  roots: [string | null, string | null];
  /** who fires next, once nothing is pending */
  turn: Seat;
  /** a shot fired and not yet answered */
  pending: { by: Seat; cell: number } | null;
  /** shots fired BY each seat, in order */
  shots: [Shot[], Shot[]];
  revealed: [boolean, boolean];
  winner: Seat | null;
  reason: string;
}

export const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

export function newDuel(id: string): Duel {
  return { id, phase: 'placing', roots: [null, null], turn: 0, pending: null, shots: [[], []], revealed: [false, false], winner: null, reason: '' };
}

export const hitsBy = (d: Duel, s: Seat): number => d.shots[s].filter((x) => x.hit).length;
export const missesBy = (d: Duel, s: Seat): number => d.shots[s].filter((x) => !x.hit).length;

/** The seat the game is waiting on, or null when it's over. */
export function waitingOn(d: Duel): Seat | null {
  if (d.phase === 'placing') return d.roots[0] ? 1 : 0;
  if (d.phase === 'playing') return d.pending ? other(d.pending.by) : d.turn;
  if (d.phase === 'reveal') return d.revealed[d.winner ?? 0] ? other(d.winner ?? 0) : (d.winner ?? 0);
  return null;
}

export function commit(d: Duel, seat: Seat, root: string): void {
  if (d.phase !== 'placing') throw new Error('fleets are already sealed');
  if (!isHex32(root)) throw new Error('bad fleet root');
  if (d.roots[seat]) throw new Error('your fleet is already sealed');
  d.roots[seat] = root;
  if (d.roots[0] && d.roots[1]) d.phase = 'playing';
}

export function fire(d: Duel, seat: Seat, cell: number): void {
  if (d.phase !== 'playing') throw new Error('the battle isn’t on');
  if (d.pending) throw new Error('the last shot hasn’t been answered yet');
  if (d.turn !== seat) throw new Error('not your turn');
  if (!isCell(cell)) throw new Error('that cell isn’t on the sea');
  if (d.shots[seat].some((s) => s.cell === cell)) throw new Error('you already fired there');
  d.pending = { by: seat, cell };
}

/** The defender answers the pending shot with an opening of that cell (and names a ship it just lost, if any). */
export function answer(d: Duel, seat: Seat, o: Opening, sunk: number | null): Shot {
  if (d.phase !== 'playing' || !d.pending) throw new Error('there is no shot to answer');
  const shooter = d.pending.by;
  if (seat !== other(shooter)) throw new Error('that shot wasn’t aimed at you');
  if (o.cell !== d.pending.cell) throw new Error('that answer is for a different cell');
  if (!verifyOpening(d.id, d.roots[seat]!, o)) throw new Error('that answer doesn’t match your sealed fleet');
  if (sunk !== null) {
    if (!o.occupied) throw new Error('a miss can’t sink a ship');
    if (!Number.isInteger(sunk) || sunk < 0 || sunk >= FLEET.length) throw new Error('no such ship');
    if (d.shots[shooter].some((s) => s.sunk === sunk)) throw new Error('that ship is already sunk');
  }
  const shot: Shot = { cell: o.cell, hit: !!o.occupied, sunk: o.occupied ? sunk : null };
  d.shots[shooter].push(shot);
  d.pending = null;
  d.turn = seat;
  if (hitsBy(d, shooter) >= FLEET_CELLS) {
    // fleet sunk: the shooter wins once both fleets are revealed and found legal
    d.phase = 'reveal';
    d.winner = shooter;
    d.reason = 'fleet sunk';
  } else if (missesBy(d, shooter) > MAX_MISSES) {
    d.phase = 'done';
    d.winner = shooter;
    d.reason = 'the defender’s sea held fewer ships than a fleet';
  }
  return shot;
}

/** The ship each shot against a revealed board should have reported sunk (null if none). */
export function expectedSunk(board: number[], against: Shot[]): (number | null)[] {
  const left = FLEET.map((s) => s.len);
  return against.map((s) => {
    const k = board[s.cell];
    if (k < 0) return null;
    left[k]--;
    return left[k] === 0 ? k : null;
  });
}

/** What a defender must report when the shot at `cell` lands after `against`: the ship it sinks, or null. */
export const sunkClaim = (board: number[], against: Shot[], cell: number): number | null =>
  expectedSunk(board, [...against, { cell, hit: board[cell] >= 0, sunk: null }]).at(-1) ?? null;

/**
 * Checks a revealed fleet against everything said during the game. Returns null if it holds,
 * otherwise what went wrong.
 */
export function checkReveal(d: Duel, seat: Seat, seed: string, ships: Placement[]): string | null {
  let board: number[];
  try { board = layout(ships); } catch (e) { return `illegal fleet: ${(e as Error).message}`; }
  if (!isHex32(seed)) return 'bad seed';
  if (rootOf(d.id, seed, ships) !== d.roots[seat]) return 'the revealed fleet isn’t the one that was sealed';
  const against = d.shots[other(seat)];
  const want = expectedSunk(board, against);
  for (let i = 0; i < against.length; i++) {
    if (against[i].hit !== board[against[i].cell] >= 0) return 'an answer doesn’t match the fleet';
    if (against[i].sunk !== want[i]) return `a false “sunk” report at shot ${i + 1}`;
  }
  return null;
}

/** A captain reveals their fleet once the battle is decided. A fleet that fails the check loses. */
export function reveal(d: Duel, seat: Seat, seed: string, ships: Placement[]): string | null {
  if (d.phase !== 'reveal') throw new Error('fleets are revealed only when the battle is decided');
  if (d.revealed[seat]) throw new Error('already revealed');
  const bad = checkReveal(d, seat, seed, ships);
  if (bad) {
    d.phase = 'done';
    d.winner = other(seat);
    d.reason = `seat ${seat + 1} failed the fleet check: ${bad}`;
    return bad;
  }
  d.revealed[seat] = true;
  if (d.revealed[0] && d.revealed[1]) d.phase = 'done';
  return null;
}

/** A seat that gives up or runs out of time loses. */
export function forfeit(d: Duel, seat: Seat, reason: string): void {
  if (d.phase === 'done') throw new Error('the game is over');
  d.phase = 'done';
  d.winner = other(seat);
  d.reason = reason;
  d.pending = null;
}
