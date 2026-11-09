import { FLEET, cellName, chart, type Seat, type Shot } from '@fogwater/rules';

// The chart table: a flat 2D view of both waters next to the 3D sea. The enemy chart is clickable
// (handy on small screens and for precise aiming); yours shows your ships and where they've been hit.

interface ChartsProps {
  myShots: Shot[];
  theirShots: Shot[];
  myBoard: number[] | null;
  aim: number | null;
  canFire: boolean;
  onAim: (cell: number) => void;
  onFire: (cell: number) => void;
}

export function Charts({ myShots, theirShots, myBoard, aim, canFire, onAim, onFire }: ChartsProps) {
  const closed = chart(myShots).closed;
  const mine = new Map(myShots.map((s) => [s.cell, s]));
  const theirs = new Map(theirShots.map((s) => [s.cell, s]));
  const last = [myShots.at(-1)?.cell, theirShots.at(-1)?.cell];
  return (
    <div className="charts">
      <figure>
        <figcaption>Enemy chart</figcaption>
        <div className={`grid enemy${canFire ? ' live' : ''}`} role="grid" aria-label="Enemy waters">
          {Array.from({ length: 100 }, (_, c) => {
            const s = mine.get(c);
            const cls = s ? (closed.has(c) ? 'wreck' : s.hit ? 'hit' : 'miss') : 'fog';
            return (
              <button
                key={c}
                className={`cell ${cls}${aim === c && canFire ? ' aim' : ''}${last[0] === c ? ' last' : ''}`}
                title={`${cellName(c)}${s ? (s.hit ? ' · hit' : ' · miss') : ''}`}
                disabled={!canFire || !!s}
                onMouseEnter={() => onAim(c)}
                onClick={() => onFire(c)}
                aria-label={cellName(c)}
              />
            );
          })}
        </div>
      </figure>
      <figure>
        <figcaption>Your fleet</figcaption>
        <div className="grid mine" aria-label="Your waters">
          {Array.from({ length: 100 }, (_, c) => {
            const s = theirs.get(c);
            const ship = myBoard ? myBoard[c] >= 0 : false;
            const cls = s ? (s.hit ? 'hit' : 'miss') : ship ? 'ship' : 'water';
            return <i key={c} className={`cell ${cls}${last[1] === c ? ' last' : ''}`} title={cellName(c)} />;
          })}
        </div>
      </figure>
    </div>
  );
}

/** The last few shots, newest first. */
export function ShotLog({ shots, names, me }: { shots: [Shot[], Shot[]]; names: [string, string]; me: Seat }) {
  // interleave: seat 0 fired first, then turns alternate
  const rows: { by: Seat; s: Shot; n: number }[] = [];
  const n = Math.max(shots[0].length, shots[1].length);
  for (let i = 0; i < n; i++) for (const by of [0, 1] as const) if (shots[by][i]) rows.push({ by, s: shots[by][i], n: rows.length + 1 });
  return (
    <ol className="log">
      {rows.slice(-7).reverse().map(({ by, s, n: k }) => (
        <li key={k} className={by === me ? 'me' : 'them'}>
          <span>{by === me ? 'You' : names[by]}</span>
          <b>{cellName(s.cell)}</b>
          <em className={s.hit ? 'hit' : 'miss'}>{s.sunk !== null ? `sank the ${FLEET[s.sunk].name}` : s.hit ? 'hit' : 'miss'}</em>
        </li>
      ))}
    </ol>
  );
}

/** Accuracy and the current run of hits. */
export function aimStats(shots: Shot[]): { accuracy: number; streak: number } {
  let streak = 0;
  for (let i = shots.length - 1; i >= 0 && shots[i].hit; i--) streak++;
  const hits = shots.filter((s) => s.hit).length;
  return { accuracy: shots.length ? Math.round((100 * hits) / shots.length) : 0, streak };
}
