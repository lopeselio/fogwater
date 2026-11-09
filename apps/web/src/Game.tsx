import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FLEET, FLEET_CELLS, cellName, chart, isLegal, layout, newSeed, open, randomFleet, rng, seal, shipCells, sunkClaim,
  type Placement, type Seat, type SealedFleet,
} from '@fogwater/rules';
import { api, type GameView, type ServerConfig } from './api.ts';
import { getName, getSeat, putSeat, setName, type LocalSeat } from './local.ts';
import { sound, type Board, type Sea } from './scene.ts';
import { call as walletCall } from './wallet.ts';

// One game: placing and sealing your fleet, then the battle. The scene shows your waters on the left
// and the enemy's on the right; this component keeps the scene in step with the server's view and
// plays each shot as a cannonball before its mark appears.

interface Props { id: string; sea: Sea; cfg: ServerConfig | null; account: string | null; go: (id: string | null) => void }

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

export function Game({ id, sea, cfg, account, go }: Props) {
  const [view, setView] = useState<GameView | null>(null);
  const [local, setLocal] = useState<LocalSeat | null>(getSeat(id));
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [ships, setShips] = useState<Placement[]>(() => local?.ships ?? randomFleet(rng(newSeed())));
  const [holding, setHolding] = useState<number | null>(null);
  const [vertical, setVertical] = useState(false);
  const [hover, setHover] = useState<{ board: Board; cell: number } | null>(null);
  const [focus, setFocus] = useState<Board>(0);
  const [joinName, setJoinName] = useState(getName());
  const viewRef = useRef<GameView | null>(null);
  viewRef.current = view;

  const token = local?.token;
  const me: Seat = view?.you ?? 0;
  const them = other(me);
  const seated = view?.you !== null && view?.you !== undefined;
  const fleet: SealedFleet | null = useMemo(() => (local?.seed && local.ships ? seal(id, local.seed, local.ships) : null), [id, local?.seed, local?.ships]);
  const d = view?.duel;
  const placing = !!d && seated && d.phase === 'placing' && !d.roots[me];

  const flash = useCallback((t: string) => { setToast(t); window.setTimeout(() => setToast((x) => (x === t ? '' : x)), 3200); }, []);

  // ---------- loading + live updates ----------

  useEffect(() => {
    sea.clearMarks(); sea.resetFog(); sea.setFleet(0, []); sea.setFleet(1, []);
    let alive = true;
    let ws: WebSocket | null = null;
    const load = (): void => { void api<GameView>(`/games/${id}`, undefined, token).then((v) => alive && setView(v)).catch((e: Error) => alive && setErr(e.message)); };
    const connect = (): void => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ t: 'watch', id, token }));
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as { t: string; game: GameView }; if (m.t === 'game' && alive) setView(m.game); };
      ws.onclose = () => { if (alive) window.setTimeout(() => { if (alive) { load(); connect(); } }, 2500); };
    };
    load();
    connect();
    return () => { alive = false; ws?.close(); };
  }, [id, token, sea]);

  // ---------- animation: each new shot flies before its mark lands ----------

  const anim = useRef({ shown: new Set<string>(), queue: Promise.resolve() as Promise<unknown>, ready: false, answering: '', revealing: false });

  const enqueue = useCallback((task: () => Promise<unknown> | void) => {
    anim.current.queue = anim.current.queue.then(task).catch(() => undefined);
  }, []);

  const wrecks = useCallback((v: GameView) => {
    // enemy ships known to be sunk: their cells, as far as the shots tell
    for (const c of chart(v.duel.shots[me]).closed) sea.mark(1, c, 'wreck');
  }, [me, sea]);

  const sendAnswer = useCallback(async () => {
    const v = viewRef.current;
    if (!v || !fleet || v.you === null) return;
    const p = v.duel.pending;
    if (!p || p.by !== other(v.you) || v.duel.phase !== 'playing') return;
    const key = `${p.cell}:${v.duel.shots[p.by].length}`;
    if (anim.current.answering === key) return;
    anim.current.answering = key;
    try {
      const sunk = sunkClaim(fleet.board, v.duel.shots[p.by], p.cell);
      const nv = await api<GameView>(`/games/${id}/move`, { answer: { opening: open(fleet, p.cell), sunk } }, token);
      setView(nv);
    } catch (e) { anim.current.answering = ''; setErr((e as Error).message); }
  }, [fleet, id, token]);

  useEffect(() => {
    if (!view || !d) return;
    const A = anim.current;
    const sides: [Seat, Board, Board][] = [[me, 0, 1], [them, 1, 0]]; // shooter, from board, target board
    const hitOrMiss = (h: boolean) => (h ? 'hit' : 'miss') as 'hit' | 'miss';
    if (!A.ready) {
      // first view: draw everything as it stands, no animation
      for (const [s, , target] of sides) d.shots[s].forEach((shot, i) => { A.shown.add(`s:${s}:${i}`); sea.mark(target, shot.cell, hitOrMiss(shot.hit)); });
      wrecks(view);
      A.ready = true;
    } else {
      for (const [s, from, target] of sides) {
        d.shots[s].forEach((shot, i) => {
          const key = `s:${s}:${i}`;
          if (A.shown.has(key)) return;
          A.shown.add(key);
          const p = `p:${s}:${shot.cell}`;
          if (A.shown.has(`${p}:impact`)) { /* already landed */ } else if (A.shown.has(p)) enqueue(() => sea.impact(target, shot.cell, hitOrMiss(shot.hit)));
          else enqueue(() => sea.shoot(from, shot.cell, hitOrMiss(shot.hit)));
          if (shot.sunk !== null) {
            const k = shot.sunk;
            enqueue(() => {
              if (s === me) { flash(`You sank their ${FLEET[k].name}!`); wrecks(viewRef.current ?? view); } else flash(`Your ${FLEET[k].name} went down.`);
              sound('bell');
            });
          }
        });
      }
    }
    // a shot in flight
    const p = d.pending;
    if (p && d.phase === 'playing') {
      const key = `p:${p.by}:${p.cell}`;
      const atMe = seated && p.by === them;
      if (!A.shown.has(key)) {
        A.shown.add(key);
        const from: Board = p.by === me ? 0 : 1;
        if (atMe && fleet) {
          A.shown.add(`${key}:impact`);
          enqueue(() => sea.shoot(from, p.cell, fleet.board[p.cell] >= 0 ? 'hit' : 'miss'));
        } else enqueue(() => sea.shoot(from, p.cell, 'pending'));
      }
      if (atMe && fleet) enqueue(() => sendAnswer());
    }
    // fleets are revealed once the battle is decided
    if (seated && fleet && d.phase === 'reveal' && !d.revealed[me] && !A.revealing) {
      A.revealing = true;
      enqueue(async () => {
        try { setView(await api<GameView>(`/games/${id}/reveal`, { seed: fleet.seed, ships: fleet.ships }, token)); } catch (e) { A.revealing = false; setErr((e as Error).message); }
      });
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- fleets in the scene ----------

  const mySunk = useMemo(() => FLEET.map((_, k) => !!d?.shots[them].some((s) => s.sunk === k)), [d, them]);
  const theirSunk = useMemo(() => FLEET.map((_, k) => !!d?.shots[me].some((s) => s.sunk === k)), [d, me]);
  const myShips: Placement[] | null = placing ? ships : seated ? fleet?.ships ?? null : (view?.reveals[0]?.ships ?? null);
  const theirShips = view?.reveals[them]?.ships ?? null;
  const fleetKey = JSON.stringify([myShips, mySunk, theirShips, theirSunk]);
  useEffect(() => {
    sea.setFleet(0, myShips ?? [], mySunk);
    sea.setFleet(1, theirShips ?? [], theirShips ? theirSunk : []);
    if (theirShips) sea.liftFog();
  }, [fleetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { sea.hideShip(placing ? holding : null); }, [sea, placing, holding, fleetKey]);

  // ---------- input ----------

  const myTurn = !!d && seated && d.phase === 'playing' && !d.pending && d.turn === me;
  const shotCells = useMemo(() => new Set(d?.shots[me].map((s) => s.cell) ?? []), [d, me]);

  const fire = useCallback(async (cell: number) => {
    if (!myTurn || busy || shotCells.has(cell)) return;
    setBusy(true); setErr('');
    anim.current.shown.add(`p:${me}:${cell}`);
    enqueue(() => sea.shoot(0, cell, 'pending'));
    try { setView(await api<GameView>(`/games/${id}/move`, { fire: cell }, token)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [myTurn, busy, shotCells, me, enqueue, sea, id, token]);

  const shipAt = (cell: number): number => { try { return layout(ships)[cell]; } catch { return -1; } };
  const candidate = (k: number, cell: number, v: boolean): Placement[] => ships.map((p, i) => (i === k ? { start: cell, vertical: v } : p));

  useEffect(() => {
    sea.events = {
      onHover: (board, cell) => setHover(cell === null ? null : { board, cell }),
      onClick: (board, cell, button) => {
        if (placing && board === 0) {
          if (button === 2) { setVertical((x) => !x); return; }
          if (holding === null) {
            const k = shipAt(cell);
            if (k >= 0) { setHolding(k); setVertical(ships[k].vertical); }
          } else if (isLegal(candidate(holding, cell, vertical))) {
            setShips(candidate(holding, cell, vertical));
            setHolding(null);
          }
        } else if (board === 1) void fire(cell);
      },
    };
  });

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if ((e.key === 'r' || e.key === 'R') && placing) setVertical((x) => !x);
      if (e.key === 'Escape') setHolding(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [placing]);

  // hover feedback: a ghost while placing, a target frame on the enemy sea on your turn
  useEffect(() => {
    if (placing && holding !== null && hover?.board === 0) {
      const p = { start: hover.cell, vertical };
      sea.showGhost(holding, shipCells(p, FLEET[holding].len) ? p : { start: hover.cell, vertical }, isLegal(candidate(holding, hover.cell, vertical)));
      sea.setHover(0, null);
    } else {
      sea.showGhost(null);
      if (hover?.board === 1 && myTurn) sea.setHover(1, hover.cell, shotCells.has(hover.cell) ? 0x667799 : 0xffe27a);
      else if (hover?.board === 0 && placing) sea.setHover(0, hover.cell, shipAt(hover.cell) >= 0 ? 0x6dffb0 : 0x667799);
      else sea.setHover(0, null);
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // on narrow screens, look where the action is
  useEffect(() => {
    if (!d) return;
    setFocus(placing || d.phase === 'placing' ? 0 : myTurn ? 1 : d.pending && d.pending.by === them ? 0 : d.phase === 'done' ? 1 : focus);
  }, [placing, myTurn, d?.pending?.cell, d?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sea.setFocus(focus); }, [sea, focus]);

  // tab title tells you when it's your move
  useEffect(() => {
    const yours = !!view && seated && view.waitingOn === me && view.duel.phase !== 'done';
    document.title = `${yours ? '● Your move · ' : ''}Fogwater`;
  }, [view, seated, me]);

  // ---------- actions ----------

  const sealFleet = async (): Promise<void> => {
    if (!view || !local || !isLegal(ships)) return;
    setBusy(true); setErr('');
    try {
      const seed = local.seed && local.ships && JSON.stringify(local.ships) === JSON.stringify(ships) ? local.seed : newSeed();
      const f = seal(id, seed, ships);
      const next = { ...local, seed, ships };
      putSeat(id, next); // keep the secret before anything else can fail
      setLocal(next);
      if (view.seats[me]?.kind === 'account' && view.chain.enabled) {
        if (account !== view.seats[me]?.account) throw new Error(`Sign in as ${view.seats[me]?.account} to seal this fleet.`);
        if (!view.chain.created || (me === 1 && !view.chain.filled)) throw new Error('The game is still landing onchain: try again in a few seconds.');
        await walletCall('commit_fleet', { id, seat: me, root: f.root });
      }
      setView(await api<GameView>(`/games/${id}/commit`, { root: f.root }, local.token));
      sound('bell');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const join = async (): Promise<void> => {
    setBusy(true); setErr('');
    try {
      const nm = joinName.trim() || 'Captain';
      setName(nm);
      const r = await api<{ id: string; seat: Seat; token: string }>(`/games/${id}/join`, { name: nm });
      const s = { seat: r.seat, token: r.token, name: nm };
      putSeat(id, s);
      setLocal(s);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const resign = async (): Promise<void> => {
    if (!confirmResign.current) { confirmResign.current = true; flash('Press “Strike colours” again to resign.'); window.setTimeout(() => { confirmResign.current = false; }, 4000); return; }
    try { setView(await api<GameView>(`/games/${id}/resign`, {}, token)); } catch (e) { setErr((e as Error).message); }
  };
  const confirmResign = useRef(false);

  const rematch = async (): Promise<void> => {
    if (!view) return;
    const r = await api<{ id: string; seat: Seat; token: string }>('/games', { mode: view.mode, admiral: view.seats[1]?.admiral ?? undefined, name: local?.name ?? getName() });
    putSeat(r.id, { seat: r.seat, token: r.token, name: local?.name ?? getName() });
    go(r.id);
  };

  // ---------- render ----------

  if (!view || !d) return <div className="hud"><div className="card status">{err || 'Rowing out…'}</div></div>;
  const foe = view.seats[them];
  const mine = view.seats[me];
  const lastLine = view.lines.at(-1);
  const hits = [d.shots[0].filter((s) => s.hit).length, d.shots[1].filter((s) => s.hit).length];
  const link = `${location.origin}/g/${id}`;
  const canJoin = !seated && view.mode === 'friend' && !view.seats[1];

  let status: string;
  if (canJoin) status = `${view.seats[0].name} challenges you to a sea battle.`;
  else if (!seated) status = 'You’re watching this battle.';
  else if (d.phase === 'placing') status = placing ? (holding === null ? 'Place your fleet: click a ship to move it, or Shuffle.' : `Placing the ${FLEET[holding].name}: click a cell for its bow. R or right-click turns it.`) : !view.seats[1] ? 'Fleet sealed. Send the link to a friend.' : `Fleet sealed. Waiting for ${foe?.name} to place theirs…`;
  else if (d.phase === 'playing') {
    if (d.pending?.by === me) status = `Your shot at ${cellName(d.pending.cell)} is in the air… waiting for ${foe?.name} to answer.`;
    else if (d.pending) status = `${foe?.name} fired at ${cellName(d.pending.cell)}…`;
    else status = d.turn === me ? 'Your shot: pick a cell in the fog.' : `${foe?.name} is taking aim…`;
  } else if (d.phase === 'reveal') status = 'The battle is decided. Fleets are being revealed and checked onchain…';
  else status = d.winner === me ? 'Victory!' : seated ? 'Defeat.' : `${view.seats[d.winner ?? 0]?.name} won.`;

  const deadline = view.deadline && d.phase !== 'done' ? Math.max(0, view.deadline - Date.now()) : null;
  const left = deadline === null ? '' : deadline > 86400000 ? `${Math.floor(deadline / 86400000)}d ${Math.floor((deadline % 86400000) / 3600000)}h` : `${Math.floor(deadline / 3600000)}h ${Math.floor((deadline % 3600000) / 60000)}m`;

  return (
    <div className="hud">
      <div className="card status">
        <div className="vs">
          <span className="me">{mine?.name ?? '…'}</span>
          <b>{hits[me]}</b><i>/{FLEET_CELLS}</i>
          <span className="sep">vs</span>
          <b>{hits[them]}</b><i>/{FLEET_CELLS}</i>
          <span className="them">{foe?.name ?? '…'}</span>
        </div>
        <p className={myTurn || placing ? 'go' : ''}>{status}</p>
        {left && seated && view.waitingOn === me && <small className="dim">Move within {left} or the battle is forfeit.</small>}
        {err && <p className="err">{err}</p>}
      </div>

      <div className="narrow-tabs">
        <button className={focus === 0 ? 'on' : ''} onClick={() => setFocus(0)}>Your waters</button>
        <button className={focus === 1 ? 'on' : ''} onClick={() => setFocus(1)}>Enemy waters</button>
      </div>

      {canJoin && (
        <div className="card center">
          <h2>Join the battle</h2>
          <label className="name">Captain’s name <input value={joinName} maxLength={24} onChange={(e) => setJoinName(e.target.value)} /></label>
          <p className="dim">{account ? `You’ll play as ${account}, ranked on the ledger.` : 'Playing as a guest. Sign in with NEAR (top right) first to be ranked.'}</p>
          <button disabled={busy} onClick={() => void join()}>Take the second seat</button>
        </div>
      )}

      {placing && (
        <div className="card dock">
          <div className="row">
            <button className="ghost" onClick={() => { setShips(randomFleet(rng(newSeed()))); setHolding(null); }}>Shuffle</button>
            <button className="ghost" disabled={holding === null} onClick={() => setVertical((x) => !x)}>Turn (R)</button>
            <button disabled={busy || holding !== null || !isLegal(ships)} onClick={() => void sealFleet()}>{busy ? 'Sealing…' : 'Seal fleet'}</button>
          </div>
          <small className="dim">Sealing puts a hash of your sea onchain{mine?.kind === 'account' ? ' from your wallet (gasless)' : ''}. Your ships stay in this browser.</small>
        </div>
      )}

      {seated && view.mode === 'friend' && !view.seats[1] && (
        <div className="card dock invite">
          <b>Send this to a friend</b>
          <div className="row"><input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button onClick={() => { void navigator.clipboard?.writeText(link).then(() => flash('Link copied')); }}>Copy</button>
            {'share' in navigator && <button className="ghost" onClick={() => { void navigator.share({ title: 'Fogwater', text: `${mine?.name} challenges you to a sea battle on NEAR`, url: link }).catch(() => undefined); }}>Share</button>}
          </div>
        </div>
      )}

      {seated && !fleet && d.phase !== 'placing' && d.phase !== 'done' && (
        <div className="card dock"><p className="err">This browser doesn’t hold your fleet’s secret, so it can’t answer shots. Open the game where you placed your fleet.</p></div>
      )}

      <aside className="card side">
        <h3>Fleets</h3>
        <div className="fleets">
          <ul>{FLEET.map((s, k) => <li key={k} className={mySunk[k] ? 'sunk' : ''}>{s.name} <i>{'■'.repeat(s.len)}</i></li>)}</ul>
          <ul>{FLEET.map((s, k) => <li key={k} className={theirSunk[k] ? 'sunk' : ''}>{s.name} <i>{'■'.repeat(s.len)}</i></li>)}</ul>
        </div>
        {lastLine && <blockquote><b>{lastLine.who}</b> {lastLine.text}{lastLine.signed && <small className="signed" title="Signed by a TEE model on NEAR AI; the signature is in the proof bundle"> ✓ signed by NEAR AI TEE</small>}</blockquote>}
        <h3>Onchain</h3>
        <p className="dim small">
          {view.chain.enabled ? <>Contract <a href={`https://testnet.nearblocks.io/address/${view.chain.contract}`} target="_blank" rel="noreferrer">{view.chain.contract}</a>: {view.chain.txs.length} txs{view.chain.queued ? `, ${view.chain.queued} queued` : ''}.</> : 'Chain off (local play).'}
          {d.roots[me] && <><br />Your seal: <code title={d.roots[me] ?? ''}>{d.roots[me]!.slice(0, 12)}…</code></>}
        </p>
        {view.chain.error && <p className="err small">Chain: {view.chain.error}</p>}
        <ul className="txs">{view.chain.txs.slice(-4).reverse().map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul>
        {seated && d.phase !== 'done' && d.phase !== 'placing' && <button className="ghost small" onClick={() => void resign()}>Strike colours</button>}
      </aside>

      {d.phase === 'done' && (
        <div className="card center result">
          <h2 className={d.winner === me && seated ? 'win' : 'lose'}>{seated ? (d.winner === me ? 'VICTORY' : 'DEFEAT') : `${view.seats[d.winner ?? 0]?.name} WINS`}</h2>
          <p>{d.reason}. {d.shots[d.winner ?? 0].length} shots, {Math.round((100 * hits[d.winner ?? 0]) / Math.max(1, d.shots[d.winner ?? 0].length))}% on target.</p>
          {view.chain.enabled
            ? <p className="dim small">The contract checked every answer against the sealed fleets{d.revealed[0] && d.revealed[1] ? ', then rebuilt both seas from their seeds and found them legal' : ''}. Check it yourself: <code>pnpm verify {id}</code></p>
            : <p className="dim small">Offline mode: the server checked every answer against the sealed fleets; nothing was written onchain.</p>}
          <div className="row">
            {seated && <button onClick={() => void rematch()}>{view.mode === 'ai' ? 'Rematch' : 'New challenge'}</button>}
            <a className="btn ghost" href={`/api/games/${id}/proof`} target="_blank" rel="noreferrer">Proof (JSON)</a>
            <button className="ghost" onClick={() => go(null)}>Harbour</button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      {cfg && !cfg.chain && <div className="badge">offline mode</div>}
    </div>
  );
}
