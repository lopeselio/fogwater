import { CELLS, FLEET, SIZE, colOf, rowOf, shipCells } from './board.ts';
import type { Shot } from './duel.ts';
import { rng } from './rng.ts';

// The AI admirals. They see exactly what a human sees: their own shots, hit or miss, and which ship
// went down. They never see the other fleet (it's sealed in the player's browser), so they plan from
// public information only. Choices are seeded, so a game replays the same way.

export interface Admiral { id: string; name: string; title: string; skill: 'easy' | 'medium' | 'hard'; blurb: string }

export const ADMIRALS: readonly Admiral[] = [
  { id: 'brine', name: 'Old Brine', title: 'Harbour Master', skill: 'easy', blurb: 'Fires by feel and loses track of wounded ships.' },
  { id: 'marrow', name: 'Captain Marrow', title: 'Privateer', skill: 'medium', blurb: 'Sweeps the sea in a checkerboard and hunts down every hit.' },
  { id: 'widow', name: 'The Grey Widow', title: 'Fleet Admiral', skill: 'hard', blurb: 'Counts every place a ship could still hide and fires where most of them meet.' },
];

export const admiral = (id: string): Admiral | undefined => ADMIRALS.find((a) => a.id === id);

/** What a shooter knows about the enemy sea from its own shots. */
export interface Chart {
  shot: Set<number>;
  misses: Set<number>;
  /** hits not yet known to belong to a sunk ship */
  open: Set<number>;
  /** hits that belong to sunk ships */
  closed: Set<number>;
  /** ships still afloat (indices into FLEET) */
  afloat: number[];
}

export function chart(shots: readonly Shot[]): Chart {
  const c: Chart = { shot: new Set(), misses: new Set(), open: new Set(), closed: new Set(), afloat: FLEET.map((_, k) => k) };
  for (const s of shots) {
    c.shot.add(s.cell);
    if (!s.hit) { c.misses.add(s.cell); continue; }
    c.open.add(s.cell);
    if (s.sunk === null) continue;
    c.afloat = c.afloat.filter((k) => k !== s.sunk);
    // the sunk ship is a straight run of open hits through this cell; close the first such run
    const len = FLEET[s.sunk].len;
    for (const vertical of [false, true]) {
      let done = false;
      for (let back = 0; back < len && !done; back++) {
        const start = s.cell - back * (vertical ? SIZE : 1);
        const cells = start >= 0 ? shipCells({ start, vertical }, len) : null;
        if (!cells || !cells.includes(s.cell) || !cells.every((x) => c.open.has(x))) continue;
        for (const x of cells) { c.open.delete(x); c.closed.add(x); }
        done = true;
      }
      if (done) break;
    }
  }
  return c;
}

/** For each cell, how many ways a ship still afloat could cover it, weighted toward open hits. */
export function density(c: Chart): number[] {
  const score = new Array<number>(CELLS).fill(0);
  const targeting = c.open.size > 0;
  for (const k of c.afloat) {
    const len = FLEET[k].len;
    for (let start = 0; start < CELLS; start++) {
      for (const vertical of [false, true]) {
        const cells = shipCells({ start, vertical }, len);
        if (!cells || cells.some((x) => c.misses.has(x) || c.closed.has(x))) continue;
        const covered = cells.filter((x) => c.open.has(x)).length;
        if (targeting && covered === 0) continue;
        const w = targeting ? covered ** 3 * 4 : 1;
        for (const x of cells) if (!c.shot.has(x)) score[x] += w;
      }
    }
  }
  return score;
}

function pickMax(score: number[], allowed: (c: number) => boolean, rand: () => number): number | null {
  let best = -1;
  let picks: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (!allowed(i)) continue;
    if (score[i] > best) { best = score[i]; picks = [i]; } else if (score[i] === best) picks.push(i);
  }
  return picks.length ? picks[Math.floor(rand() * picks.length)] : null;
}

const neighbours = (c: number): number[] => {
  const r = rowOf(c), k = colOf(c), out: number[] = [];
  if (r > 0) out.push(c - SIZE);
  if (r < SIZE - 1) out.push(c + SIZE);
  if (k > 0) out.push(c - 1);
  if (k < SIZE - 1) out.push(c + 1);
  return out;
};

/** The admiral's next target. `seed` makes ties and hunches replay the same way. */
export function nextShot(skill: Admiral['skill'], shots: readonly Shot[], seed: string): number {
  const rand = rng(`${seed}|${shots.length}`);
  const c = chart(shots);
  const free = (x: number): boolean => !c.shot.has(x);
  if (skill === 'easy') {
    // chases a neighbour of a fresh hit most of the time; otherwise fires anywhere
    const near = [...c.open].flatMap(neighbours).filter(free);
    if (near.length && rand() < 0.7) return near[Math.floor(rand() * near.length)];
    const any = Array.from({ length: CELLS }, (_, i) => i).filter(free);
    return any[Math.floor(rand() * any.length)];
  }
  const score = density(c);
  if (skill === 'medium' && c.open.size === 0) {
    // hunts on a checkerboard (the smallest ship always covers one of its squares), picking at random
    const parity = Array.from({ length: CELLS }, (_, i) => i).filter((i) => free(i) && (rowOf(i) + colOf(i)) % 2 === 0 && score[i] > 0);
    if (parity.length) return parity[Math.floor(rand() * parity.length)];
  }
  return pickMax(score, (x) => free(x) && score[x] > 0, rand) ?? pickMax(score, free, rand)!;
}
