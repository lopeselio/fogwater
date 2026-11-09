/// <reference types="node" />
import { FLEET_CELLS, randomFleet } from './board.ts';
import { open, seal } from './commit.ts';
import { ADMIRALS, nextShot } from './admiral.ts';
import { answer, commit, expectedSunk, fire, hitsBy, newDuel, type Seat } from './duel.ts';
import { rng } from './rng.ts';

// Headless balance check: each admiral plays N games against random fleets. Prints shots to win.
//   pnpm sim 200

const n = Number(process.argv[2] ?? 100);
for (const a of ADMIRALS) {
  const counts: number[] = [];
  for (let g = 0; g < n; g++) {
    const id = `sim-${a.id}-${g}`;
    const r = rng(id);
    const seeds = ['0'.repeat(63) + '1', '0'.repeat(63) + '2'];
    const fleets = [seal(id, seeds[0], randomFleet(r)), seal(id, seeds[1], randomFleet(r))];
    const d = newDuel(id);
    commit(d, 0, fleets[0].root);
    commit(d, 1, fleets[1].root);
    // seat 0 is the admiral; seat 1 never fires back (only the admiral's shot count matters)
    while (hitsBy(d, 0) < FLEET_CELLS) {
      const cell = nextShot(a.skill, d.shots[0], id);
      fire(d, 0, cell);
      const sunkNow = expectedSunk(fleets[1].board, [...d.shots[0], { cell, hit: fleets[1].board[cell] >= 0, sunk: null }]).at(-1) ?? null;
      answer(d, 1 as Seat, open(fleets[1], cell), sunkNow);
      d.turn = 0;
    }
    counts.push(d.shots[0].length);
  }
  counts.sort((x, y) => x - y);
  const mean = counts.reduce((s, x) => s + x, 0) / counts.length;
  console.log(`${a.name.padEnd(16)} ${a.skill.padEnd(6)} mean ${mean.toFixed(1)} shots, median ${counts[counts.length >> 1]}, best ${counts[0]}, worst ${counts.at(-1)}`);
}
