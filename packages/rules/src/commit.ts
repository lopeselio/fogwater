import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { CELLS, layout, type Placement } from './board.ts';

// Sealed fleets. A captain picks a secret 32-byte seed. Every cell gets its own salt from it, and every
// cell becomes a leaf: sha256("fogwater|leaf|<game>|<cell>|<0 or 1>|<salt>"). The 100 leaves (padded
// to 128) form a Merkle tree, and only its root goes onchain before the first shot.
//
// Answering a shot opens one leaf: its occupancy, its salt and 7 sibling hashes. Anyone can check that
// against the root, so a captain can't say "miss" when a ship is there, and nobody learns any other
// cell. At the end the seed and the ship placements are revealed; the contract rebuilds the tree from
// them, which proves the fleet was legal all along.
//
// The contract (contracts/fleet/src/lib.rs) computes exactly the same bytes.

export const DEPTH = 7;
export const LEAVES = 1 << DEPTH; // 128

const enc = (s: string): Uint8Array => utf8ToBytes(s);
const h = (s: string): Uint8Array => sha256(enc(s));

export const isHex32 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** The salt of one cell, derived from the captain's secret seed. */
export const cellSalt = (seed: string, cell: number): string => bytesToHex(h(`fogwater|salt|${seed}|${cell}`));

export const leafHash = (gameId: string, cell: number, occupied: boolean, salt: string): Uint8Array =>
  h(`fogwater|leaf|${gameId}|${cell}|${occupied ? 1 : 0}|${salt}`);

const PAD = h('fogwater|pad');

function node(a: Uint8Array, b: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(a, 0);
  buf.set(b, 32);
  return sha256(buf);
}

/** Every level of the tree, leaves first. */
function levels(leaves: Uint8Array[]): Uint8Array[][] {
  const out: Uint8Array[][] = [[...leaves, ...Array.from({ length: LEAVES - leaves.length }, () => PAD)]];
  while (out[out.length - 1].length > 1) {
    const prev = out[out.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(node(prev[i], prev[i + 1]));
    out.push(next);
  }
  return out;
}

/** Everything a captain keeps secret, plus the public root. Lives only in the captain's browser (or the server, for an AI). */
export interface SealedFleet {
  gameId: string;
  seed: string;
  ships: Placement[];
  board: number[];
  root: string;
  tree: Uint8Array[][];
}

export function seal(gameId: string, seed: string, ships: Placement[]): SealedFleet {
  return { ...sealBoard(gameId, seed, layout(ships)), ships };
}

/** Seals any board, legal or not (seal() is the normal way in; tests use this to build a cheater's board). */
export function sealBoard(gameId: string, seed: string, board: number[]): SealedFleet {
  if (!isHex32(seed)) throw new Error('the seed must be 32 bytes of hex');
  const leaves = board.map((k, cell) => leafHash(gameId, cell, k >= 0, cellSalt(seed, cell)));
  const tree = levels(leaves);
  return { gameId, seed, ships: [], board, root: bytesToHex(tree[DEPTH][0]), tree };
}

/** The root a revealed seed and fleet produce (throws if the fleet isn't legal). */
export const rootOf = (gameId: string, seed: string, ships: Placement[]): string => seal(gameId, seed, ships).root;

/** The answer to a shot at `cell`: one opened leaf. */
export interface Opening { cell: number; occupied: boolean; salt: string; proof: string[] }

export function open(f: SealedFleet, cell: number): Opening {
  const proof: string[] = [];
  let i = cell;
  for (let d = 0; d < DEPTH; d++) {
    proof.push(bytesToHex(f.tree[d][i ^ 1]));
    i >>= 1;
  }
  return { cell, occupied: f.board[cell] >= 0, salt: cellSalt(f.seed, cell), proof };
}

/** Does this opening belong to the tree with this root? */
export function verifyOpening(gameId: string, root: string, o: Opening): boolean {
  if (!Number.isInteger(o.cell) || o.cell < 0 || o.cell >= CELLS) return false;
  if (!isHex32(o.salt) || !isHex32(root) || !Array.isArray(o.proof) || o.proof.length !== DEPTH || !o.proof.every(isHex32)) return false;
  let acc = leafHash(gameId, o.cell, !!o.occupied, o.salt);
  let i = o.cell;
  for (const sib of o.proof) {
    const s = hexToBytes(sib);
    acc = i & 1 ? node(s, acc) : node(acc, s);
    i >>= 1;
  }
  return bytesToHex(acc) === root;
}

/** A fresh secret seed (browser or Node). */
export function newSeed(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

export { bytesToHex };
