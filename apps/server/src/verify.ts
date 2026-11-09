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

const bundle = (await (await fetch(`${base}/api/games/${id}/proof`)).json()) as Bundle & { error?: string };
if (bundle.error) fail(bundle.error);
if (!bundle.over) fail('the game isn’t over yet');

const RPCS = ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'];
async function viewGame(): Promise<ChainGame> {
  for (const rpc of RPCS) {
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: bundle.contract, method_name: 'get_game', args_base64: Buffer.from(JSON.stringify({ id })).toString('base64') } }),
      })).json()) as { result?: { result: number[] } };
      if (r.result) return JSON.parse(Buffer.from(r.result.result).toString('utf8')) as ChainGame;
    } catch { /* next RPC */ }
  }
  return fail('could not read the game from the contract');
}
const cg = await viewGame();

if (cg.roots[0] !== bundle.roots[0] || cg.roots[1] !== bundle.roots[1]) fail('the sealed roots differ from the contract’s');
ok(`both fleet roots match the contract (${bundle.contract})`);

// replay every move with the rules; each answer must open the defender's sealed root
const d = newDuel(id);
commit(d, 0, cg.roots[0]!);
commit(d, 1, cg.roots[1]!);
let answers = 0;
for (const m of bundle.moves) {
  if (m.t === 'fire') { fire(d, m.seat, m.cell); continue; }
  if (!verifyOpening(id, cg.roots[m.seat]!, m.opening)) fail(`answer to ${m.opening.cell} doesn’t open seat ${m.seat + 1}’s root`);
  answer(d, m.seat, m.opening, m.sunk);
  answers++;
}
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
