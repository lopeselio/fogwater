import { CELLS, newSeed, open, randomFleet, rng, seal, sunkClaim, type Seat } from '@fogwater/rules';

// Plays one whole game against an admiral the way the browser does: seal a fleet, answer every shot
// with an opening, fire, reveal at the end. Then prints the transactions.
//   pnpm --filter @fogwater/server e2e [baseUrl] [admiral]

const base = process.argv[2] ?? 'http://localhost:8787';
const adm = process.argv[3] ?? 'brine';

interface View {
  id: string; you: Seat;
  duel: { phase: string; turn: Seat; pending: { by: Seat; cell: number } | null; shots: { cell: number; hit: boolean; sunk: number | null }[][]; revealed: boolean[]; winner: Seat | null; reason: string };
  chain: { created: boolean; queued: number; error: string | null; txs: { what: string; url: string }[] };
}

async function api<T>(path: string, token?: string, b?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-seat-token': token } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

const { id, token } = await api<{ id: string; token: string }>('/games', undefined, { mode: 'ai', admiral: adm, name: 'E2E' });
console.log(`game ${id} vs ${adm}`);
const seed = newSeed();
const fleet = seal(id, seed, randomFleet(rng(seed)));
let v = await api<View>(`/games/${id}/commit`, token, { root: fleet.root });
const order = Array.from({ length: CELLS }, (_, i) => i).sort((a, b) => rng(`${seed}${a}`)() - rng(`${seed}${b}`)());
let k = 0;
while (v.duel.phase === 'playing') {
  const d = v.duel;
  let ans: { opening: ReturnType<typeof open>; sunk: number | null } | undefined;
  if (d.pending && d.pending.by === 1) ans = { opening: open(fleet, d.pending.cell), sunk: sunkClaim(fleet.board, d.shots[1], d.pending.cell) };
  while (d.shots[0].some((s) => s.cell === order[k])) k++;
  v = await api<View>(`/games/${id}/move`, token, { answer: ans, fire: order[k++] });
}
if (v.duel.phase === 'reveal') v = await api<View>(`/games/${id}/reveal`, token, { seed, ships: fleet.ships });
console.log(`phase ${v.duel.phase}, winner seat ${v.duel.winner} (${v.duel.reason}); shots ${v.duel.shots[0].length} vs ${v.duel.shots[1].length}`);
for (let i = 0; i < 60 && (v.chain.queued > 0 || !v.chain.created) && !v.chain.error; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  v = await api<View>(`/games/${id}`, token);
}
if (v.chain.error) throw new Error(`chain: ${v.chain.error}`);
for (const t of v.chain.txs) console.log(`  ${t.what.padEnd(22)} ${t.url}`);
console.log(`check it: pnpm verify ${id}${base === 'http://localhost:8787' ? '' : ` ${base}`}`);
