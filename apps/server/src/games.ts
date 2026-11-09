import { createHash, randomBytes } from 'node:crypto';
import {
  FLEET, admiral, answer, cellName, commit, fire, forfeit, isHex32, newDuel, newSeed, nextShot, open, randomFleet, reveal, rng, seal,
  sunkClaim, waitingOn, type Opening, type Placement, type Seat, type SealedFleet,
} from '@fogwater/rules';
import { call, view } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { voice } from './nearai.ts';
import { allGames, loadGame, saveGame, type ChainOp, type GameRecord, type SeatRec } from './store.ts';

// The game server. It keeps each game's public state, speaks for guests and admirals onchain (as the
// referee), plays the admirals, and relays every shot and answer to the contract in small batches.
//
// It never holds a human captain's fleet: the browser keeps the seed and placements and sends only the
// opening of the one cell that was shot. Every answer is checked here with the same rules the contract
// uses, so a bad answer is refused at once instead of failing onchain later.

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const AI_TIMEOUT_S = 2 * 3600;
const FRIEND_TIMEOUT_S = 3 * 86400;

// ---------- change listeners (websocket pushes) ----------

type Listener = (g: GameRecord) => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };

function touch(g: GameRecord, acted = true): void {
  g.updatedAt = Date.now();
  if (acted) g.actedAt = g.updatedAt;
  saveGame(g);
  for (const l of listeners) { try { l(g); } catch { /* a dead socket */ } }
}

// ---------- views ----------

export function seatOf(g: GameRecord, token: string | undefined): Seat | null {
  if (!token) return null;
  const h = sha(token);
  if (g.seats[0].tokenHash === h) return 0;
  if (g.seats[1]?.tokenHash === h) return 1;
  return null;
}

const publicSeat = (s: SeatRec | null) => s && { kind: s.kind, label: s.label, name: s.name, account: s.account ?? null, admiral: s.admiral ?? null };

export function publicView(g: GameRecord, you: Seat | null = null) {
  const d = g.duel;
  const over = d.phase === 'done';
  const aiRevealed = g.mode === 'ai' && (d.revealed[1] || over);
  return {
    id: g.id,
    mode: g.mode,
    you,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    deadline: over || !g.seats[1] ? null : g.actedAt + g.timeoutS * 1000,
    seats: [publicSeat(g.seats[0]), publicSeat(g.seats[1])],
    duel: d,
    waitingOn: g.seats[1] ? waitingOn(d) : null,
    reveals: [g.reveals[0], g.mode === 'ai' && aiRevealed ? g.aiSecret ?? null : g.reveals[1]],
    lines: g.lines.map((l) => ({ who: l.who, text: l.text, signed: !!l.signature })),
    chain: {
      enabled: config.chainEnabled,
      contract: config.contract,
      created: g.chain.created,
      filled: g.chain.filled,
      queued: g.chain.pending.length,
      error: g.chain.error ?? null,
      retrying: g.chain.retry ? `retry ${g.chain.retry.n}/10: ${g.chain.retry.msg}` : null,
      txs: g.chain.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    },
  };
}
export type GameView = ReturnType<typeof publicView>;

/** Short summaries for the harbour list. */
export function summary(g: GameRecord, you: Seat | null) {
  const d = g.duel;
  return {
    id: g.id, mode: g.mode, you, phase: d.phase, updatedAt: g.updatedAt,
    names: [g.seats[0].name, g.seats[1]?.name ?? null],
    waitingOn: g.seats[1] ? waitingOn(d) : null, winner: d.winner,
    hits: [d.shots[0].filter((s) => s.hit).length, d.shots[1].filter((s) => s.hit).length],
  };
}

// ---------- the admirals' fleets ----------

const sealed = new Map<string, SealedFleet>();
function aiFleet(g: GameRecord): SealedFleet {
  let f = sealed.get(g.id);
  if (!f) { f = seal(g.id, g.aiSecret!.seed, g.aiSecret!.ships); sealed.set(g.id, f); }
  return f;
}

// ---------- creating and joining ----------

const cleanName = (n: unknown): string => String(n ?? '').replace(/[^\p{L}\p{N} _'.-]/gu, '').trim().slice(0, 24) || 'Captain';

function newSeat(name: string, account: string | null): { seat: SeatRec; token: string } {
  const token = randomBytes(24).toString('hex');
  const tokenHash = sha(token);
  const seat: SeatRec = account
    ? { kind: 'account', label: account, name, account, tokenHash }
    : { kind: 'guest', label: `guest:${tokenHash.slice(0, 16)}`, name, tokenHash };
  return { seat, token };
}

export function createGame(opts: { mode: 'ai' | 'friend'; admiral?: string; name: unknown; account: string | null }) {
  const id = randomBytes(6).toString('hex');
  const { seat, token } = newSeat(cleanName(opts.name), opts.account);
  const now = Date.now();
  const g: GameRecord = {
    id, mode: opts.mode, createdAt: now, updatedAt: now, actedAt: now,
    timeoutS: opts.mode === 'ai' ? AI_TIMEOUT_S : FRIEND_TIMEOUT_S,
    seats: [seat, null], duel: newDuel(id), reveals: [null, null], moves: [], lines: [],
    chain: { created: !config.chainEnabled, filled: !config.chainEnabled, pending: [], txs: [] },
  };
  if (opts.mode === 'ai') {
    const a = admiral(String(opts.admiral ?? '')) ?? admiral('marrow')!;
    g.seats[1] = { kind: 'ai', label: `ai:${a.id}`, name: a.name, admiral: a.id };
    const seed = newSeed();
    g.aiSecret = { seed, ships: randomFleet(rng(seed)) };
    commit(g.duel, 1, aiFleet(g).root);
    queue(g, { what: 'create_game', method: 'create_game', args: { id, seats: [seat.label, g.seats[1].label], timeout_s: g.timeoutS }, gas: 30 });
    queue(g, { what: 'seal (admiral)', method: 'commit_fleet', args: { id, seat: 1, root: aiFleet(g).root }, gas: 30 });
    g.chain.filled = true;
    say(g, 'intro');
  } else {
    queue(g, { what: 'create_game', method: 'create_game', args: { id, seats: [seat.label, 'open'], timeout_s: g.timeoutS }, gas: 30 });
  }
  touch(g);
  return { id, seat: 0 as Seat, token };
}

export function joinGame(g: GameRecord, name: unknown, account: string | null) {
  if (g.mode !== 'friend') throw new Error('that game is against an admiral');
  if (g.seats[1]) throw new Error('both seats are taken');
  if (account && g.seats[0].account === account) throw new Error('you can’t join your own game from the same account: send the link to a friend');
  const { seat, token } = newSeat(cleanName(name), account);
  g.seats[1] = seat;
  queue(g, { what: 'fill_seat', method: 'fill_seat', args: { id: g.id, seat: seat.label }, gas: 30 });
  touch(g);
  return { id: g.id, seat: 1 as Seat, token };
}

// ---------- sealing ----------

export async function commitFleet(g: GameRecord, seat: Seat, root: string): Promise<void> {
  if (!isHex32(root)) throw new Error('bad fleet root');
  const s = g.seats[seat]!;
  if (s.kind === 'account' && config.chainEnabled) {
    // a signed-in captain seals from their own wallet; we only record it once the chain has it
    let onchain: string | null = null;
    for (let i = 0; i < 6 && onchain !== root; i++) {
      const cg = await view<{ roots: (string | null)[] } | null>('get_game', { id: g.id }).catch(() => null);
      onchain = cg?.roots[seat] ?? null;
      if (onchain !== root) await new Promise((r) => setTimeout(r, 1500));
    }
    if (onchain !== root) throw new Error('your seal isn’t onchain yet: approve it in your wallet, then try again');
    commit(g.duel, seat, root);
  } else {
    commit(g.duel, seat, root);
    queue(g, { what: `seal (${s.name})`, method: 'commit_fleet', args: { id: g.id, seat, root }, gas: 30 });
  }
  touch(g);
}

// ---------- playing ----------

function logAnswer(g: GameRecord, seat: Seat, o: Opening, sunk: number | null): void {
  const shooter = g.duel.pending!.by;
  const shot = answer(g.duel, seat, o, sunk);
  g.moves.push({ t: 'answer', seat, opening: o, sunk: shot.sunk, at: Date.now() });
  queue(g, { what: 'play', method: 'play', args: { id: g.id, moves: [{ Answer: { seat, cell: o.cell, occupied: o.occupied, salt: o.salt, proof: o.proof, sunk: shot.sunk } }] }, gas: 0 });
  if (shot.sunk !== null) say(g, 'sunk', { shooter, ship: FLEET[shot.sunk].name });
  if (g.duel.phase === 'reveal' || g.duel.phase === 'done') say(g, 'end');
}

function logFire(g: GameRecord, seat: Seat, cell: number): void {
  fire(g.duel, seat, cell);
  g.moves.push({ t: 'fire', seat, cell, at: Date.now() });
  queue(g, { what: 'play', method: 'play', args: { id: g.id, moves: [{ Fire: { seat, cell } }] }, gas: 0 });
}

/** A captain's turn: answer the shot aimed at them (if any), then fire (if they want to now). */
export function move(g: GameRecord, seat: Seat, m: { answer?: { opening: Opening; sunk: number | null }; fire?: number }): void {
  if (!g.seats[1]) throw new Error('nobody has joined yet');
  if (m.answer) logAnswer(g, seat, sanitize(m.answer.opening), m.answer.sunk ?? null);
  if (m.fire !== undefined && g.duel.phase === 'playing') logFire(g, seat, Number(m.fire));
  if (g.mode === 'ai') admiralActs(g);
  touch(g);
}

function sanitize(o: Opening): Opening {
  return { cell: Number(o?.cell), occupied: !!o?.occupied, salt: String(o?.salt ?? ''), proof: Array.isArray(o?.proof) ? o.proof.slice(0, 7).map(String) : [] };
}

/** The admiral answers whatever is aimed at it, fires back, and reveals when the battle is decided. */
function admiralActs(g: GameRecord): void {
  const d = g.duel;
  const a = admiral(g.seats[1]!.admiral!)!;
  const f = aiFleet(g);
  if (d.phase === 'playing' && d.pending && d.pending.by === 0) {
    const cell = d.pending.cell;
    logAnswer(g, 1, open(f, cell), sunkClaim(f.board, d.shots[0], cell));
  }
  if (d.phase === 'playing' && !d.pending && d.turn === 1) logFire(g, 1, nextShot(a.skill, d.shots[1], g.aiSecret!.seed));
  if (d.phase === 'reveal' && !d.revealed[1]) revealSeat(g, 1, g.aiSecret!.seed, g.aiSecret!.ships);
}

function revealSeat(g: GameRecord, seat: Seat, seed: string, ships: Placement[]): void {
  const bad = reveal(g.duel, seat, seed, ships);
  g.reveals[seat] = { seed, ships };
  queue(g, { what: `reveal (${g.seats[seat]!.name})`, method: 'reveal_fleet', args: { id: g.id, seat, seed, ships }, gas: 200 });
  if (bad) console.warn(`game ${g.id}: seat ${seat} failed the reveal: ${bad}`);
}

export function revealFleet(g: GameRecord, seat: Seat, seed: unknown, ships: unknown): void {
  if (!isHex32(seed)) throw new Error('bad seed');
  const list = (Array.isArray(ships) ? ships : []).slice(0, 5).map((p: Placement) => ({ start: Number(p?.start), vertical: !!p?.vertical }));
  revealSeat(g, seat, seed, list);
  if (g.mode === 'ai') admiralActs(g);
  touch(g);
}

export function resign(g: GameRecord, seat: Seat): void {
  if (!g.seats[1]) throw new Error('nobody has joined yet: just leave it');
  forfeit(g.duel, seat, `${g.seats[seat]!.name} struck their colours`);
  queue(g, { what: 'resign', method: 'resign', args: { id: g.id, seat }, gas: 30 });
  say(g, 'end');
  touch(g);
}

// ---------- timeouts ----------

/** Seats that ran out of time lose; the contract is told too (anyone may claim a timeout there). */
export function sweepTimeouts(): void {
  const now = Date.now();
  for (const g of allGames()) {
    if (g.duel.phase === 'done' || !g.seats[1]) continue;
    // a margin over the contract's own clock, which starts when our transaction lands
    if (now < g.actedAt + g.timeoutS * 1000 + 3 * 60_000) continue;
    const late = waitingOn(g.duel);
    if (late === null) continue;
    forfeit(g.duel, late, `${g.seats[late]!.name} ran out of time`);
    queue(g, { what: 'claim_timeout', method: 'claim_timeout', args: { id: g.id }, gas: 30 });
    touch(g, false);
  }
}

// ---------- the admirals' voices (NEAR AI, signed) ----------

const PERSONA: Record<string, string> = {
  brine: 'You are Old Brine, a kindly, rambling old harbour master who commands a fleet in a night sea battle. Warm, folksy, a little forgetful.',
  marrow: 'You are Captain Marrow, a cocky privateer in a night sea battle. Swaggering, quick, teasing.',
  widow: 'You are the Grey Widow, a cold, precise fleet admiral in a night sea battle. Calm menace, few words.',
};

function say(g: GameRecord, moment: 'intro' | 'sunk' | 'end', info: { shooter?: Seat; ship?: string } = {}): void {
  if (g.mode !== 'ai' || g.lines.length >= 10) return;
  const a = admiral(g.seats[1]!.admiral!)!;
  const foe = g.seats[0].name;
  let prompt: string, fallback: string;
  if (moment === 'intro') {
    prompt = `Greet your opponent, Captain ${foe}, before the battle. One short sentence, in character. No quotation marks.`;
    fallback = `${a.name} raises a lantern: “Show me your fleet, Captain ${foe}. If you can find mine.”`;
  } else if (moment === 'sunk' && info.shooter === 1) {
    prompt = `You just sank Captain ${foe}'s ${info.ship}. Gloat in one short sentence, in character. No quotation marks.`;
    fallback = `“Your ${info.ship} rests on the bottom now.”`;
  } else if (moment === 'sunk') {
    prompt = `Captain ${foe} just sank your ${info.ship}. React in one short sentence, in character. No quotation marks.`;
    fallback = `“My ${info.ship}… you’ll pay for that.”`;
  } else {
    const won = g.duel.winner === 1;
    prompt = won ? `You won the battle against Captain ${foe}. One short sentence, in character. No quotation marks.` : `You lost the battle against Captain ${foe}. Concede in one short sentence, in character. No quotation marks.`;
    fallback = won ? '“The fog keeps its secrets. Better luck next tide.”' : '“Well fought, Captain. The sea is yours tonight.”';
  }
  const asked = Date.now();
  const system = `${PERSONA[a.id] ?? PERSONA.marrow} Speak to your opponent directly as "you"; never guess their gender.`;
  void voice(a.name, system, prompt, fallback).then((line) => {
    g.lines.push({ ...line, at: asked });
    g.lines.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
    touch(g, false);
  });
}

// ---------- the chain queue ----------

const timers = new Map<string, NodeJS.Timeout>();
const flushing = new Set<string>();

function queue(g: GameRecord, op: ChainOp): void {
  if (!config.chainEnabled) return;
  g.chain.pending.push(op);
  schedule(g.id, 1500);
}

function schedule(id: string, ms: number): void {
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => { timers.delete(id); void flush(id); }, ms));
}

const MAX_MOVES = 12;
const MAX_RETRIES = 10;

/** Sends a game's queued operations in order, merging runs of moves into one `play` call. */
async function flush(id: string): Promise<void> {
  if (flushing.has(id)) { schedule(id, 1000); return; }
  const g = loadGame(id);
  if (!g || g.chain.error) return;
  flushing.add(id);
  try {
    while (g.chain.pending.length) {
      const first = g.chain.pending[0];
      let take = 1;
      let op = first;
      if (first.method === 'play') {
        const moves: unknown[] = [];
        take = 0;
        while (take < g.chain.pending.length && g.chain.pending[take].method === 'play' && moves.length < MAX_MOVES) {
          moves.push(...(g.chain.pending[take].args.moves as unknown[]));
          take++;
        }
        op = { what: `play ×${moves.length}`, method: 'play', args: { id, moves }, gas: Math.min(300, 30 + moves.length * 15) };
      }
      const r = await call(config.referee, op.method, op.args, op.gas);
      g.chain.pending.splice(0, take);
      g.chain.txs.push({ what: op.what, hash: r.tx });
      if (op.method === 'create_game') g.chain.created = true;
      if (op.method === 'fill_seat') g.chain.filled = true;
      touch(g, false);
    }
    g.chain.retry = undefined;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    // a refusal from the contract is final; anything else (RPCs down, rate limits, a stale nonce) never ran, so try again later
    const refused = /failed:/.test(msg);
    const n = (g.chain.retry?.n ?? 0) + 1;
    if (refused || n > MAX_RETRIES) {
      g.chain.error = msg;
      g.chain.retry = undefined;
    } else {
      g.chain.retry = { n, msg };
      schedule(id, Math.min(300_000, 15_000 * 2 ** (n - 1)));
    }
    console.warn(`chain ${id}: ${refused ? 'refused' : `attempt ${n}`}: ${msg}`);
    touch(g, false);
  } finally {
    flushing.delete(id);
  }
}

/** On startup: carry on sending what was queued before a restart. */
export function resumeQueues(): void {
  for (const g of allGames()) {
    if (!g.chain.pending.length) continue;
    // games that stopped on a network or nonce failure (not a contract refusal) get another go
    if (g.chain.error && !/failed:/.test(g.chain.error)) { g.chain.error = undefined; saveGame(g); }
    if (!g.chain.error) schedule(g.id, 2000);
  }
}

export { cellName };
