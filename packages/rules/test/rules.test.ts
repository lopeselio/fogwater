import { describe, expect, it } from 'vitest';
import {
  ADMIRALS, CELLS, FLEET, FLEET_CELLS, MAX_MISSES, answer, checkReveal, commit, fire, forfeit, hitsBy, isLegal, layout, newDuel,
  nextShot, open, randomFleet, sealBoard, reveal, rng, seal, sunkClaim, verifyOpening, waitingOn, type Placement, type Seat,
} from '../src/index.ts';

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);
// rows A..E, each ship laid horizontally from column 1
const ROWS: Placement[] = FLEET.map((_, k) => ({ start: k * 10, vertical: false }));

describe('board', () => {
  it('lays out a legal fleet and rejects bad ones', () => {
    expect(layout(ROWS).filter((k) => k >= 0)).toHaveLength(FLEET_CELLS);
    expect(isLegal([...ROWS.slice(0, 4), { start: 9, vertical: false }])).toBe(false); // runs off the sea
    expect(isLegal([...ROWS.slice(0, 4), { start: 0, vertical: true }])).toBe(false); // overlaps
    expect(isLegal(ROWS.slice(0, 4))).toBe(false); // short a ship
    expect(isLegal([...ROWS.slice(0, 4), { start: 98, vertical: true }])).toBe(false); // off the bottom
  });
  it('random fleets are legal', () => {
    const r = rng('t');
    for (let i = 0; i < 200; i++) expect(isLegal(randomFleet(r))).toBe(true);
  });
});

describe('sealed fleets', () => {
  const f = seal('g1', SEED_A, ROWS);
  it('every cell opens against the root, and nothing else does', () => {
    for (let c = 0; c < CELLS; c++) expect(verifyOpening('g1', f.root, open(f, c))).toBe(true);
    const o = open(f, 0);
    expect(verifyOpening('g1', f.root, { ...o, occupied: false })).toBe(false); // lying about a hit
    expect(verifyOpening('g2', f.root, o)).toBe(false); // another game
    expect(verifyOpening('g1', f.root, { ...o, cell: 1 })).toBe(false); // another cell
    expect(verifyOpening('g1', f.root, { ...o, salt: 'c'.repeat(64) })).toBe(false);
  });
  it('the root binds game, seed and fleet', () => {
    expect(seal('g1', SEED_A, ROWS).root).toBe(f.root);
    expect(seal('g1', SEED_B, ROWS).root).not.toBe(f.root);
    expect(seal('g2', SEED_A, ROWS).root).not.toBe(f.root);
  });
  it('matches the contract test vector', () => {
    // same vector as contracts/fleet tests: game "vec", seed 0x11…, fleet in rows
    expect(seal('vec', '1'.repeat(64), ROWS).root).toBe(VECTOR_ROOT);
  });
});

// the Rust contract test (contracts/fleet/src/tests.rs) asserts the same root and openings
const VECTOR_ROOT = '7a5606e628236c4074b2a5a2d7bf0606b160397a2ab31f645404a4bbd5b84774';

function play(fleetA: Placement[], fleetB: Placement[], shootA: (n: number) => number, shootB: (n: number) => number) {
  const fa = seal('duel', SEED_A, fleetA), fb = seal('duel', SEED_B, fleetB);
  const d = newDuel('duel');
  commit(d, 0, fa.root);
  expect(waitingOn(d)).toBe(1);
  commit(d, 1, fb.root);
  const fleets = [fa, fb];
  let n = 0;
  while (d.phase === 'playing' && n < 400) {
    const s = d.turn;
    const cell = s === 0 ? shootA(n) : shootB(n);
    fire(d, s, cell);
    const def = (1 - s) as Seat;
    answer(d, def, open(fleets[def], cell), sunkClaim(fleets[def].board, d.shots[s], cell));
    n++;
  }
  return { d, fa, fb };
}

describe('a duel', () => {
  it('runs to a win, both reveals pass, and the game ends', () => {
    // A fires along the cells in order; B fires from the bottom and never finds A's fleet first
    const { d, fa, fb } = play(ROWS, ROWS, (n) => n >> 1, (n) => 99 - (n >> 1));
    expect(d.phase).toBe('reveal');
    expect(d.winner).toBe(0);
    expect(hitsBy(d, 0)).toBe(FLEET_CELLS);
    expect(d.shots[0].filter((s) => s.sunk !== null).map((s) => s.sunk)).toEqual([0, 1, 2, 3, 4]);
    expect(reveal(d, 1, SEED_B, fb.ships)).toBeNull();
    expect(d.phase).toBe('reveal');
    expect(reveal(d, 0, SEED_A, fa.ships)).toBeNull();
    expect(d.phase).toBe('done');
    expect(d.winner).toBe(0);
  });

  it('refuses out-of-turn shots, repeat shots and wrong answers', () => {
    const fa = seal('x', SEED_A, ROWS), fb = seal('x', SEED_B, ROWS);
    const d = newDuel('x');
    commit(d, 0, fa.root);
    commit(d, 1, fb.root);
    expect(() => fire(d, 1, 0)).toThrow(/not your turn/);
    fire(d, 0, 0);
    expect(() => fire(d, 0, 6)).toThrow(/hasn’t been answered/);
    expect(() => answer(d, 1, { ...open(fb, 0), occupied: false }, null)).toThrow(/doesn’t match/); // a hit called a miss
    expect(() => answer(d, 1, open(fb, 6), null)).toThrow(/different cell/);
    expect(() => answer(d, 0, open(fa, 0), null)).toThrow(/wasn’t aimed at you/);
    answer(d, 1, open(fb, 0), null);
    fire(d, 1, 50);
    answer(d, 0, open(fa, 50), null);
    expect(() => fire(d, 0, 0)).toThrow(/already fired/);
  });

  it('a false “sunk” report fails the reveal and loses', () => {
    const { d, fa, fb } = play(ROWS, ROWS, (n) => n >> 1, (n) => 99 - (n >> 1));
    d.shots[0][0].sunk = 4; // pretend B reported the Cutter sunk on the first hit
    expect(checkReveal(d, 1, SEED_B, fb.ships)).toMatch(/false “sunk”/);
    expect(reveal(d, 1, SEED_B, fb.ships)).toMatch(/false/);
    expect(d.phase).toBe('done');
    expect(d.winner).toBe(0);
    void fa;
  });

  it('a revealed fleet that differs from the sealed one loses', () => {
    const { d, fa } = play(ROWS, ROWS, (n) => n >> 1, (n) => 99 - (n >> 1));
    const moved = ROWS.map((p, k) => (k === 4 ? { start: 95, vertical: false } : p));
    expect(reveal(d, 0, SEED_A, moved)).toMatch(/isn’t the one that was sealed/);
    expect(d.winner).toBe(1);
    void fa;
  });

  it('a sea with too few ships is caught by the miss count', () => {
    // B seals an all-water board, so A can never hit; one miss past MAX_MISSES proves it
    const fa = seal('e', SEED_A, ROWS);
    const fb = sealBoard('e', SEED_B, new Array<number>(CELLS).fill(-1));
    const d = newDuel('e');
    commit(d, 0, fa.root);
    commit(d, 1, fb.root);
    for (let c = 0; d.phase === 'playing'; c++) {
      fire(d, 0, c);
      answer(d, 1, open(fb, c), null);
      if (d.phase !== 'playing') break;
      fire(d, 1, 99 - c);
      answer(d, 0, open(fa, 99 - c), sunkClaim(fa.board, d.shots[1], 99 - c));
    }
    expect(d.shots[0]).toHaveLength(MAX_MISSES + 1);
    expect(d.phase).toBe('done');
    expect(d.winner).toBe(0);
  });

  it('forfeit hands the win over', () => {
    const d = newDuel('f');
    forfeit(d, 0, 'timed out');
    expect(d.winner).toBe(1);
    expect(() => forfeit(d, 1, 'again')).toThrow();
  });
});

describe('admirals', () => {
  it('never fire twice at a cell and always finish', () => {
    for (const a of ADMIRALS) {
      for (let g = 0; g < 5; g++) {
        const enemy = seal(`ai${g}`, SEED_B, randomFleet(rng(`${a.id}${g}`)));
        const shots: { cell: number; hit: boolean; sunk: number | null }[] = [];
        while (shots.filter((s) => s.hit).length < FLEET_CELLS) {
          const c = nextShot(a.skill, shots, `seed${g}`);
          expect(shots.some((s) => s.cell === c)).toBe(false);
          shots.push({ cell: c, hit: enemy.board[c] >= 0, sunk: sunkClaim(enemy.board, shots, c) });
          expect(shots.length).toBeLessThanOrEqual(CELLS);
        }
      }
    }
  });
  it('replay the same way from the same seed', () => {
    const shots = [{ cell: 44, hit: true, sunk: null }];
    expect(nextShot('hard', shots, 's')).toBe(nextShot('hard', shots, 's'));
  });
});
