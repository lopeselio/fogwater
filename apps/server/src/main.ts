import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ADMIRALS, type Seat } from '@fogwater/rules';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import {
  commitFleet, createGame, joinGame, move, onChange, publicView, resign, resumeQueues, revealFleet, seatOf, summary, sweepTimeouts,
} from './games.ts';
import { attestation, nearAiEnabled } from './nearai.ts';
import { allGames, loadGame, type GameRecord } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body<T>(req: IncomingMessage, max = 200_000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// one change at a time per game, so a turn's answer and shot can't interleave with another request
const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(id, run);
  void run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => undefined);
  return run;
}

// a little brake on game creation per address (every game costs the referee gas)
const creates = new Map<string, number[]>();
function allowCreate(ip: string): boolean {
  const now = Date.now();
  const list = (creates.get(ip) ?? []).filter((t) => t > now - 3600_000);
  if (list.length >= 40) return false;
  list.push(now);
  creates.set(ip, list);
  return true;
}
const ipOf = (req: IncomingMessage): string => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

function gameAndSeat(req: IncomingMessage, id: string): { g: GameRecord; seat: Seat | null } {
  const g = loadGame(id);
  if (!g) throw Object.assign(new Error('no such game'), { code: 404 });
  return { g, seat: seatOf(g, String(req.headers['x-seat-token'] ?? '')) };
}
function mustSeat(seat: Seat | null): Seat {
  if (seat === null) throw Object.assign(new Error('you’re not a captain in this game'), { code: 403 });
  return seat;
}

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const post = req.method === 'POST';
  try {
    // wallet sign-in, sessions and the gasless relay: Better Auth + better-near-auth
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev' });
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, referee: config.referee, chain: config.chainEnabled,
        relayer: hasKey(config.relayer) ? config.relayer : null, nearAi: nearAiEnabled(), admirals: ADMIRALS,
      });
    }
    if (p === '/api/me') return me ? json(res, 200, { accountId: me, stats: config.chainEnabled ? await view('stats_of', { account_id: me }).catch(() => null) : null }) : json(res, 401, { error: 'not signed in' });
    if (p === '/api/leaderboard') return json(res, 200, config.chainEnabled ? await view('leaderboard', { limit: 20 }).catch(() => []) : []);
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/recent') {
      const done = allGames().filter((g) => g.duel.phase === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
      return json(res, 200, done.map((g) => summary(g, null)));
    }
    if (p === '/api/harbour' && post) {
      // the browser sends the games it holds seat tokens for; a signed-in captain also gets games bound to their account
      const b = await body<{ seats?: { id: string; token: string }[] }>(req);
      const out = new Map<string, ReturnType<typeof summary>>();
      for (const s of (b.seats ?? []).slice(0, 100)) {
        const g = loadGame(String(s?.id ?? ''));
        const seat = g ? seatOf(g, String(s?.token ?? '')) : null;
        if (g && seat !== null) out.set(g.id, summary(g, seat));
      }
      if (me) for (const g of allGames()) {
        const seat = g.seats[0].account === me ? 0 : g.seats[1]?.account === me ? 1 : null;
        if (seat !== null && !out.has(g.id)) out.set(g.id, summary(g, seat));
      }
      return json(res, 200, [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    }
    if (p === '/api/games' && post) {
      if (!allowCreate(ipOf(req))) return json(res, 429, { error: 'that’s a lot of battles: try again in a while' });
      const b = await body<{ mode?: string; admiral?: string; name?: string }>(req);
      return json(res, 200, createGame({ mode: b.mode === 'friend' ? 'friend' : 'ai', admiral: b.admiral, name: b.name, account: me }));
    }
    const m = /^\/api\/games\/([a-z0-9-]{1,40})(?:\/(join|commit|move|reveal|resign|proof))?$/.exec(p);
    if (m) {
      const [, id, action] = m;
      if (!action) {
        const { g, seat } = gameAndSeat(req, id);
        return json(res, 200, publicView(g, seat));
      }
      if (action === 'proof') return json(res, 200, proofBundle(gameAndSeat(req, id).g));
      if (!post) return json(res, 405, { error: 'POST only' });
      const b = await body<Record<string, unknown>>(req);
      const out = await locked(id, async () => {
        const { g, seat } = gameAndSeat(req, id);
        switch (action) {
          case 'join': return joinGame(g, b.name, me);
          case 'commit': await commitFleet(g, mustSeat(seat), String(b.root ?? '')); break;
          case 'move': move(g, mustSeat(seat), { answer: b.answer as never, fire: b.fire === undefined ? undefined : Number(b.fire) }); break;
          case 'reveal': revealFleet(g, mustSeat(seat), b.seed, b.ships); break;
          case 'resign': resign(g, mustSeat(seat)); break;
        }
        return publicView(g, seat);
      });
      return json(res, 200, out);
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    const code = (e as { code?: number }).code;
    json(res, typeof code === 'number' ? code : 400, { error: (e as Error).message });
  }
}

/** Everything needed to re-check a finished game without trusting this server (`pnpm verify <id>`). */
function proofBundle(g: GameRecord) {
  const over = g.duel.phase === 'done';
  return {
    id: g.id,
    contract: config.contract,
    over,
    seats: g.seats.map((s) => s && { label: s.label, name: s.name }),
    roots: g.duel.roots,
    winner: g.duel.winner,
    reason: g.duel.reason,
    moves: g.moves,
    reveals: [g.reveals[0], g.mode === 'ai' && (over || g.duel.revealed[1]) ? g.aiSecret ?? null : g.reveals[1]],
    txs: g.chain.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    lines: g.lines,
  };
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: live game updates ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4_000 });
const watchers = new Map<WebSocket, { id: string; seat: Seat | null }>();
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    let m: { t?: string; id?: string; token?: string };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t !== 'watch') return;
    const g = loadGame(String(m.id ?? ''));
    if (!g) return;
    const seat = seatOf(g, m.token);
    watchers.set(ws, { id: g.id, seat });
    ws.send(JSON.stringify({ t: 'game', game: publicView(g, seat) }));
  });
  ws.on('close', () => watchers.delete(ws));
});
onChange((g) => {
  for (const [ws, w] of watchers) {
    if (w.id === g.id && ws.readyState === 1) ws.send(JSON.stringify({ t: 'game', game: publicView(g, w.seat) }));
  }
});
// keep idle sockets alive through proxies
setInterval(() => { for (const ws of watchers.keys()) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(config.port, () => {
  console.log(`Fogwater on :${config.port} (contract ${config.contract}, chain ${config.chainEnabled ? 'on' : 'off'})`);
});
resumeQueues();
setInterval(sweepTimeouts, 60_000).unref();
