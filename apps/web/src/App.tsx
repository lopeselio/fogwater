import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ServerConfig, type Stats, type Summary } from './api.ts';
import { Game } from './Game.tsx';
import { allSeats, getName, putSeat, setName } from './local.ts';
import { Sea, isMuted, setMuted } from './scene.ts';
import { setContract, signIn, signOut } from './wallet.ts';

// The shell: one three.js sea behind everything, the harbour (menu) and the game screen on top.

const gameIdFromPath = (): string | null => /^\/g\/([a-z0-9-]{1,40})\/?$/.exec(location.pathname)?.[1] ?? null;

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [sea, setSea] = useState<Sea | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(gameIdFromPath());
  const [mute, setMute] = useState(isMuted());

  useEffect(() => {
    if (!host.current) return;
    const s = new Sea(host.current);
    setSea(s);
    return () => { s.renderer.setAnimationLoop(null); s.renderer.domElement.remove(); };
  }, []);

  useEffect(() => {
    void api<ServerConfig>('/config').then((c) => { setCfg(c); setContract(c.contract); }).catch(() => undefined);
    void api<{ accountId: string }>('/me').then((m) => setAccount(m.accountId)).catch(() => setAccount(null));
    const pop = (): void => setGameId(gameIdFromPath());
    window.addEventListener('popstate', pop);
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') { const m = !isMuted(); setMuted(m); setMute(m); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('keydown', key); };
  }, []);

  const go = useCallback((id: string | null) => {
    history.pushState(null, '', id ? `/g/${id}` : '/');
    setGameId(id);
  }, []);

  return (
    <>
      <div ref={host} className="sea" />
      <header className="top">
        <a className="logo" href="/" onClick={(e) => { e.preventDefault(); go(null); }}>FOGWATER</a>
        <span className="grow" />
        <button className="ghost small" onClick={() => { const m = !mute; setMuted(m); setMute(m); }} title="Sound (M)">{mute ? '♪ off' : '♪ on'}</button>
        <Account account={account} setAccount={setAccount} />
      </header>
      {sea && (gameId
        ? <Game key={gameId} id={gameId} sea={sea} cfg={cfg} account={account} go={go} />
        : <Harbour sea={sea} cfg={cfg} account={account} go={go} />)}
    </>
  );
}

function Account({ account, setAccount }: { account: string | null; setAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (account) {
    return (
      <span className="acct">
        <a href={`https://testnet.nearblocks.io/address/${account}`} target="_blank" rel="noreferrer">{account.length > 22 ? `${account.slice(0, 10)}…${account.slice(-8)}` : account}</a>
        <button className="ghost small" onClick={() => { void signOut().then(() => setAccount(null)); }}>Sign out</button>
      </span>
    );
  }
  return (
    <span className="acct">
      {err && <small className="err" title={err}>sign-in failed</small>}
      <button className="small" disabled={busy} onClick={() => {
        setBusy(true); setErr('');
        signIn().then(setAccount).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
      }}>{busy ? 'Waiting for wallet…' : 'Sign in with NEAR'}</button>
    </span>
  );
}

function Harbour({ sea, cfg, account, go }: { sea: Sea; cfg: ServerConfig | null; account: string | null; go: (id: string | null) => void }) {
  const [name, setNameState] = useState(getName());
  const [list, setList] = useState<Summary[]>([]);
  const [board, setBoard] = useState<[string, Stats][]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    sea.clearMarks(); sea.setFleet(0, []); sea.setFleet(1, []); sea.resetFog(); sea.setFocus('both'); sea.events = {};
    sea.setHover(0, null);
    document.title = 'Fogwater';
  }, [sea]);
  useEffect(() => {
    void api<Summary[]>('/harbour', { seats: allSeats() }).then(setList).catch(() => undefined);
    void api<[string, Stats][]>('/leaderboard').then(setBoard).catch(() => undefined);
  }, [account]);

  const start = async (mode: 'ai' | 'friend', admiral?: string): Promise<void> => {
    setBusy(true); setErr('');
    try {
      const nm = name.trim() || 'Captain';
      setName(nm);
      const r = await api<{ id: string; seat: 0 | 1; token: string }>('/games', { mode, admiral, name: nm });
      putSeat(r.id, { seat: r.seat, token: r.token, name: nm });
      go(r.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const status = (s: Summary): string => {
    if (s.phase === 'done') return s.winner === s.you ? 'Victory' : 'Defeat';
    if (s.names[1] === null) return 'Waiting for your friend';
    if (s.phase === 'placing') return s.waitingOn === s.you ? 'Place your fleet' : 'They’re placing';
    return s.waitingOn === s.you ? 'Your move' : 'Their move';
  };

  return (
    <main className="harbour">
      <section className="hero">
        <h1>FOGWATER</h1>
        <p>A sea battle by lantern light. Your fleet is <b>sealed onchain</b> before the first shot, and every “hit” or “miss” is proven against that seal by a NEAR contract. Nobody sees your ships, not your rival, not the AI, not our server, until the last one sinks.</p>
        <label className="name">Captain’s name <input value={name} maxLength={24} placeholder="Captain" onChange={(e) => setNameState(e.target.value)} /></label>
        {err && <p className="err">{err}</p>}
      </section>

      <section className="panel">
        <h2>Battle an admiral</h2>
        <div className="admirals">
          {(cfg?.admirals ?? []).map((a) => (
            <button key={a.id} className={`admiral ${a.skill}`} disabled={busy} onClick={() => void start('ai', a.id)}>
              <b>{a.name}</b><small>{a.title} · {a.skill}</small><span>{a.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Challenge a friend</h2>
        <p className="dim">Get a link, send it in any chat. Take your shots whenever you like: the game waits (3 days per move), and plays live when you’re both here.</p>
        <button disabled={busy} onClick={() => void start('friend')}>Create a challenge link</button>
      </section>

      {list.length > 0 && (
        <section className="panel">
          <h2>Your battles</h2>
          <ul className="battles">
            {list.map((s) => (
              <li key={s.id}>
                <a href={`/g/${s.id}`} onClick={(e) => { e.preventDefault(); go(s.id); }}>
                  <span>{s.names[s.you ?? 0]} <i>vs</i> {s.names[s.you === 0 ? 1 : 0] ?? '…'}</span>
                  <em className={status(s) === 'Your move' || status(s) === 'Place your fleet' ? 'hot' : ''}>{status(s)}</em>
                  <small>{s.hits[s.you ?? 0]}/17 hits</small>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Admirals’ ledger</h2>
        <p className="dim">Wins by signed-in captains, recorded by the contract{cfg ? <> <a href={`https://testnet.nearblocks.io/address/${cfg.contract}`} target="_blank" rel="noreferrer">{cfg.contract}</a></> : null}. {account ? '' : 'Sign in with a NEAR wallet to be ranked.'}</p>
        {board.length === 0 ? <p className="dim">No ranked wins yet. Be the first.</p> : (
          <table className="ledger"><tbody>
            {board.map(([a, s], i) => <tr key={a}><td>{i + 1}</td><td>{a.length > 24 ? `${a.slice(0, 12)}…` : a}</td><td>{s.wins} W</td><td>{s.losses} L</td><td>{s.best ? `best ${s.best} shots` : ''}</td></tr>)}
          </tbody></table>
        )}
      </section>

      <section className="panel how">
        <h2>How the fog is kept honest</h2>
        <ol>
          <li><b>Seal.</b> Your browser picks a secret seed and hashes every cell of your sea into a Merkle tree. Only the root goes to the contract.</li>
          <li><b>Answer.</b> When a shot lands, your browser opens just that cell: hit or miss, its salt and 7 hashes. The contract refuses any answer that doesn’t match your root.</li>
          <li><b>Reveal.</b> When a fleet is sunk, both seeds are revealed. The contract rebuilds both seas: illegal fleets, moved ships or false “sunk” calls lose.</li>
        </ol>
        <p className="dim">The admirals play from what they’ve seen (hits and misses), and their lines come from a TEE-hosted model on NEAR AI, signed. Keys: <b>M</b> sound, <b>R</b> rotate a ship while placing.</p>
      </section>
      <footer className="foot">Testnet only · <a href="https://github.com/lopeselio/fogwater" target="_blank" rel="noreferrer">source</a> · part of the <a href="https://arcade.lopeselio.online/" target="_blank" rel="noreferrer">NEAR Arcade</a></footer>
    </main>
  );
}
