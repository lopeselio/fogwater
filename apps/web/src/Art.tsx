import type { ReactElement } from 'react';

// Procedural pixel art for the menus: the admirals' portraits and the welcome cards' pictures.
// Plain SVG rects from small character maps, so nothing is downloaded and it stays crisp at any size.

const PAL: Record<string, string> = {
  k: '#0b1222', s: '#f1c7a0', S: '#d39a74', e: '#0b1222', m: '#8e4a3a',
  w: '#eef2f7', W: '#c3ccd8', b: '#1d3b63', B: '#2a5d92', g: '#ffcf5a',
  r: '#c0392b', R: '#7d2a22', h: '#2a1d14', p: '#6b4426',
  G: '#8b93a3', L: '#c9ced8', D: '#3d4556',
};

// 16×16, one character per pixel ('.' is empty)
const FACES: Record<string, string[]> = {
  brine: [
    '....bbbbbbbb....',
    '...bbbbggbbbb...',
    '..kkkkkkkkkkkk..',
    '...ssssssssss...',
    '...sLLssssLLs...',
    '...ssesssseSs...',
    '...sssssSssss...',
    '..wwWWWWWWWWww..',
    '..wwwwwwwwwwppp.',
    '...wwwwwwwwww.p.',
    '...wwwwwwwwww...',
    '....wwwwwwww....',
    '..bbbbwwwwbbbb..',
    '.bbbbbbwwbbbbbb.',
    '.bbgbbbbbbbbgbb.',
    '.bbbbbbbbbbbbbb.',
  ],
  marrow: [
    '....rrrrrrrr....',
    '...rrrrrrrrrr...',
    '..rrrrrrrrrrrrR.',
    '..hsssssssssshR.',
    '..hkkkkssssksh..',
    '..hkkkksssseSh..',
    '..hsssssSssssh..',
    '..hhhhhhhhhhhhg.',
    '..hhhmmmmmmhhh..',
    '...hhhhhhhhhh...',
    '....hhhhhhhh....',
    '.....hhhhhh.....',
    '..RRRRwwwwRRRR..',
    '.RRRRRwwwwRRRRR.',
    '.RRgRRwwwwRRgRR.',
    '.RRRRRRRRRRRRRR.',
  ],
  widow: [
    '......DDDD......',
    '...DDDDDDDDDD...',
    '.DDDDDDggDDDDDD.',
    'gggggggggggggggg',
    '...GLssssssLG...',
    '..GLseSsssgegLG.',
    '..GLsssSsssgLG..',
    '..GLssmmmmssgLG.',
    '..GLLssssssgLLG.',
    '..GLLLssssLLLG..',
    '..DDDDkkkkDDDD..',
    '.DDDDDDkkDDDDDD.',
    '.DDggDDkkDDggDD.',
    'gDDggDDDDDDggDDg',
    '.DDDDDgDDgDDDDD.',
    '.DDDDDDDDDDDDDD.',
  ],
};

const BACKDROP: Record<string, [string, string]> = {
  brine: ['#163a5c', '#0b1d33'], marrow: ['#4a1e22', '#1d0e14'], widow: ['#2b3040', '#10131c'],
};

function pixels(rows: string[]): ReactElement[] {
  const out: ReactElement[] = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const fill = PAL[ch];
    if (fill) out.push(<rect key={`${x}.${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />);
  }));
  return out;
}

/** An admiral's pixel portrait on a lantern-lit backdrop. */
export function Portrait({ id, size = 64 }: { id: string; size?: number }) {
  const rows = FACES[id] ?? FACES.brine;
  const [hi, lo] = BACKDROP[id] ?? BACKDROP.brine;
  return (
    <svg className="portrait" width={size} height={size} viewBox="-2 -2 20 20" shapeRendering="crispEdges" aria-hidden="true">
      <defs>
        <radialGradient id={`pg-${id}`} cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor={hi} />
          <stop offset="1" stopColor={lo} />
        </radialGradient>
      </defs>
      <rect x={-2} y={-2} width={20} height={20} fill={`url(#pg-${id})`} />
      {pixels(rows)}
    </svg>
  );
}

// ---------- welcome cards ----------

const Sky = () => (
  <>
    <defs>
      <linearGradient id="ca-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#0a1530" />
        <stop offset="1" stopColor="#1b3560" />
      </linearGradient>
    </defs>
    <rect width="120" height="80" fill="url(#ca-sky)" />
    {[[12, 8], [30, 15], [52, 6], [98, 10], [110, 22], [76, 18]].map(([x, y]) => <rect key={`${x}`} x={x} y={y} width="1.5" height="1.5" fill="#cfd9ff" />)}
  </>
);

const Sea = ({ y = 50 }: { y?: number }) => (
  <>
    <rect y={y} width="120" height={80 - y} fill="#10284a" />
    {Array.from({ length: 12 }, (_, i) => <rect key={i} x={(i * 23) % 120} y={y + 4 + (i % 4) * 6} width="9" height="1.5" fill="#2a5d92" opacity=".8" />)}
  </>
);

const Ship = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="0" y="8" width="26" height="5" fill="#6b4426" />
    <rect x="2" y="13" width="22" height="2" fill="#3f2714" />
    <rect x="9" y="-6" width="1.6" height="14" fill="#3f2714" />
    <rect x="17" y="-2" width="1.6" height="10" fill="#3f2714" />
    <rect x="4" y="-4" width="11" height="9" fill="#e9dcc0" />
    <rect x="14" y="0" width="8" height="6" fill="#d9ccb0" />
    <rect x="23" y="5" width="2.4" height="2.4" fill="#ffcf5a" />
    <circle cx="24.2" cy="6.2" r="4" fill="#ffcf5a" opacity=".25" />
  </g>
);

/** Board of n×n cells drawn at (x,y), with a per-cell fill. */
const Grid = ({ x, y, n, c, fill }: { x: number; y: number; n: number; c: number; fill: (i: number, j: number) => string }) => (
  <g>
    {Array.from({ length: n * n }, (_, k) => {
      const i = k % n, j = Math.floor(k / n);
      return <rect key={k} x={x + i * c} y={y + j * c} width={c - 1} height={c - 1} rx="1" fill={fill(i, j)} />;
    })}
  </g>
);

const ARTS = [
  // 0: two fleets on a foggy night sea
  () => (
    <>
      <Sky />
      <circle cx="96" cy="18" r="12" fill="#f3efd8" opacity=".15" />
      <rect x="89.5" y="11.5" width="13" height="13" rx="4" fill="#f3efd8" />
      <rect x="92" y="15" width="3" height="3" fill="#d9d3b8" />
      <Sea y={52} />
      <Ship x={14} y={38} />
      <Ship x={74} y={42} s={0.8} />
      {[[54, 46, 22], [66, 50, 28], [40, 54, 26], [80, 57, 30], [96, 51, 22], [8, 58, 24]].map(([x, y, w], i) => <rect key={i} x={x} y={y} width={w} height="7" rx="3" fill="#c9d4ea" opacity=".55" />)}
    </>
  ),
  // 1: place your ships, then seal them
  () => (
    <>
      <rect width="120" height="80" fill="#0d1d38" />
      <Grid x={14} y={12} n={6} c={9.5} fill={(i, j) => ((j === 1 && i >= 1 && i <= 4) || (i === 4 && j >= 3 && j <= 5) ? '#a07040' : (i + j) % 2 ? '#1d4775' : '#2a5d92')} />
      <g transform="translate(82 24)">
        <rect x="0" y="12" width="26" height="22" rx="3" fill="#ffcf5a" />
        <rect x="5" y="0" width="16" height="16" rx="8" fill="none" stroke="#ffcf5a" strokeWidth="4" />
        <rect x="11" y="19" width="4" height="8" rx="2" fill="#5a3d10" />
      </g>
      <text x="95" y="72" textAnchor="middle" fontFamily="Silkscreen, monospace" fontSize="7" fill="#ffcf5a">SEALED</text>
    </>
  ),
  // 2: fire into the fog: a splash and a hit
  () => (
    <>
      <rect width="120" height="80" fill="#0d1d38" />
      <Grid x={38} y={12} n={6} c={9.5} fill={(i, j) => (i === 1 && j === 3 ? '#0b1a30' : i === 3 && j === 2 ? '#ff5a2a' : '#7d8db0')} />
      <rect x="50.5" y="42.5" width="4" height="4" fill="#eef2f7" />
      <rect x="66" y="26" width="7" height="5" fill="#ffd36b" />
      <rect x="67.5" y="22" width="4" height="4" fill="#ff8a3d" />
      <circle cx="70" cy="28" r="9" fill="#ff5a2a" opacity=".25" />
      <path d="M8 70 Q 30 0 66 28" fill="none" stroke="#ffcf5a" strokeWidth="1.4" strokeDasharray="3 3" />
      <rect x="4" y="66" width="10" height="7" fill="#3f2714" />
      <rect x="12" y="64" width="6" height="4" fill="#1b1b1b" />
    </>
  ),
  // 3: proven, not trusted: one cell opened up a hash tree to the sealed root
  () => (
    <>
      <rect width="120" height="80" fill="#0d1d38" />
      <g stroke="#3f5f8f" strokeWidth="1.4" fill="none">
        <path d="M60 18 L36 38 M60 18 L84 38 M36 38 L24 58 M36 38 L48 58 M84 38 L72 58 M84 38 L96 58" />
      </g>
      <g stroke="#6dffb0" strokeWidth="2.2" fill="none">
        <path d="M60 18 L36 38 L48 58" />
      </g>
      <rect x="50" y="9" width="20" height="12" rx="2" fill="#ffcf5a" />
      {[[30, 32], [78, 32]].map(([x, y]) => <rect key={x} x={x} y={y} width="12" height="10" rx="2" fill="#2a5d92" />)}
      {[[18, 54], [42, 54], [66, 54], [90, 54]].map(([x, y]) => <rect key={x} x={x} y={y} width="12" height="10" rx="2" fill={x === 42 ? '#6dffb0' : '#1d4775'} />)}
      <path d="M44 59 L47 62 L52 56" fill="none" stroke="#0d1d38" strokeWidth="1.8" />
    </>
  ),
];

/** The picture on welcome card i. */
export function CardArt({ i }: { i: number }) {
  const Art = ARTS[i] ?? ARTS[0];
  return (
    <svg className="card-art" viewBox="0 0 120 80" shapeRendering="geometricPrecision" aria-hidden="true">
      <Art />
    </svg>
  );
}
