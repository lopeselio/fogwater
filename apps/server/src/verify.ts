import { FLEET_CELLS, answer, checkReveal, commit, fire, newDuel, verifyOpening, type Opening, type Placement, type Seat } from '@fogwater/rules';

// Re-checks a finished game without trusting the game server:
//   pnpm verify <gameId> [baseUrl]
// It fetches the proof bundle from the server and the game record from the contract (via public RPC),
// then checks every answer against the sealed roots, replays the turns with the same rules, checks
// both revealed fleets, and compares the result with what the contract recorded.

const [id, base = 'https://fogwater.lopeselio.online'] = process.argv.slice(2);
if (!id) { console.error('usage: pnpm verify <gameId> [baseUrl]'); process.exit(2); }

const ok = (s: string): void => console.log(`✓ ${s}`);
const fail = (s: string): never => { console.log(`✗ ${s}`); process.exit(1); };

interface Bundle {
  id: string; contract: string; over: boolean; roots: (string | null)[]; winner: Seat | null; reason: string;
  moves: ({ t: 'fire'; seat: Seat; cell: number } | { t: 'answer'; seat: Seat; opening: Opening; sunk: number | null })[];
  reveals: ({ seed: string; ships: Placement[] } | null)[];
  txs: { what: string; url: string }[];
}
interface ChainGame { seats: string[]; roots: (string | null)[]; phase: number; shots: { cell: number; hit: boolean; sunk: number | null }[][]; winner: number | null; reason: string; revealed: boolean[] }

const res = await fetch(`${base}/api/games/${id}/proof`).catch((e: Error) => fail(`couldn't reach ${base} (${(e.cause as { code?: string } | undefined)?.code ?? e.message})`));
const bundle = (await res.json().catch(() => fail(`${base} didn't answer with a proof bundle (HTTP ${res.status})`))) as Bundle & { error?: string };
if (bundle.error) fail(bundle.error);
if (!bundle.over) fail('the game isn’t over yet');

// public testnet RPCs; fastnear goes last because it answers most keyless calls with 429 today.
// VERIFY_RPC puts another endpoint first.
const RPCS = [process.env.VERIFY_RPC, 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.fastnear.com']
  .filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One read of the game from the contract, starting at RPC `from`; three rounds over every RPC with backoff. */
async function viewGame(from = 0): Promise<ChainGame> {
  for (let round = 0; round < 3; round++, await sleep(1000 * 2 ** round)) for (let k = 0; k < RPCS.length; k++) {
    const rpc = RPCS[(from + k) % RPCS.length];
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: bundle.contract, method_name: 'get_game', args_base64: Buffer.from(JSON.stringify({ id })).toString('base64') } }),
        signal: AbortSignal.timeout(15_000),
      })).json()) as { result?: { result?: number[] } };
      const g = r.result?.result ? (JSON.parse(Buffer.from(r.result.result).toString('utf8')) as ChainGame | null) : null;
      if (g) return g;
    } catch { /* next RPC */ }
  }
  return fail('could not read the game from the contract on any public testnet RPC; try again in a minute');
}

// replay every move with the rules from the proof bundle; each answer must open the defender's sealed root
const d = newDuel(id);
if (!bundle.roots[0] || !bundle.roots[1]) fail('the proof bundle has no sealed roots');
commit(d, 0, bundle.roots[0]!);
commit(d, 1, bundle.roots[1]!);
let answers = 0;
for (const m of bundle.moves) {
  if (m.t === 'fire') { fire(d, m.seat, m.cell); continue; }
  if (!verifyOpening(id, bundle.roots[m.seat]!, m.opening)) fail(`answer to ${m.opening.cell} doesn’t open seat ${m.seat + 1}’s root`);
  answer(d, m.seat, m.opening, m.sunk);
  answers++;
}

// The referee sends moves in batches and the last ones (and the reveals) can still be landing when a game has just
// ended, and a lagging RPC node can serve an older block. Until the contract shows the game settled with every move,
// read again (from the next RPC) instead of reporting a mismatch on a partial record.
const caughtUp = (g: ChainGame): boolean => g.phase === 3 && [0, 1].every((s) => g.shots[s].length >= d.shots[s].length);
let cg = await viewGame();
for (let tries = 1; !caughtUp(cg) && tries < 5; tries++) {
  console.log(`· the contract has ${cg.shots[0].length + cg.shots[1].length} of ${d.shots[0].length + d.shots[1].length} shots${cg.phase === 3 ? '' : ' and hasn’t settled yet'}; reading again…`);
  await sleep(3000 * tries);
  cg = await viewGame(tries);
}
if (!caughtUp(cg)) {
  console.log(`✗ the contract hasn’t recorded the whole game yet (${cg.shots[0].length + cg.shots[1].length} of ${d.shots[0].length + d.shots[1].length} shots, ${cg.phase === 3 ? 'settled' : 'not settled'}): its last moves may still be on their way. Try again in a minute.`);
  process.exit(2);
}

if (cg.roots[0] !== bundle.roots[0] || cg.roots[1] !== bundle.roots[1]) fail('the sealed roots differ from the contract’s');
ok(`both fleet roots match the contract (${bundle.contract})`);
ok(`all ${answers} answers open the sealed roots (Merkle proofs checked)`);

for (const s of [0, 1] as const) {
  if (JSON.stringify(d.shots[s]) !== JSON.stringify(cg.shots[s])) fail(`seat ${s + 1}'s shots differ from the contract's`);
}
ok('the replayed shots match the contract’s record');

for (const s of [0, 1] as const) {
  const r = bundle.reveals[s];
  if (!r) { console.log(`· seat ${s + 1} did not reveal (${cg.revealed[s] ? 'but the contract says it did' : 'the game ended another way'})`); continue; }
  const bad = checkReveal(d, s, r.seed, r.ships);
  if (bad) console.log(`· seat ${s + 1}'s revealed fleet fails: ${bad} (so it lost)`);
  else ok(`seat ${s + 1}'s revealed fleet is legal, matches its root and every “sunk” report`);
}

const hits = [0, 1].map((s) => d.shots[s].filter((x) => x.hit).length);
if (cg.phase !== 3) fail('the contract hasn’t settled the game');
if (cg.winner !== bundle.winner) fail(`winner differs: contract ${cg.winner}, server ${bundle.winner}`);
ok(`winner: seat ${cg.winner! + 1} (${cg.reason}); hits ${hits[0]}/${FLEET_CELLS} vs ${hits[1]}/${FLEET_CELLS}`);
