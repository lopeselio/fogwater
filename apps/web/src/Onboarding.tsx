import { useEffect, useState, type ReactNode } from 'react';
import { CardArt } from './Art.tsx';

// First-run experience, like the other arcade games: a few welcome cards, a hands-on walkthrough in
// your first battle that waits for you to actually do each thing, and a "How to play" sheet that's
// always one click (or "?") away. What you've seen is remembered in this browser.

const KEY = 'fogwater.onboarding.v1';
export interface Seen { welcomed?: boolean; toured?: boolean }
export const readSeen = (): Seen => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; } };
export const writeSeen = (patch: Seen): void => { try { localStorage.setItem(KEY, JSON.stringify({ ...readSeen(), ...patch })); } catch { /* private mode: shown again next time */ } };

function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="ob-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`ob-card${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

const CARDS: { art: string; title: string; body: string }[] = [
  { art: '🌫️', title: 'A sea battle in the fog', body: 'Two fleets, two 10×10 waters, one lantern-lit night. Take turns firing at the enemy’s waters. Sink all five of their ships (17 hits) before they sink yours.' },
  { art: '⚓', title: 'Place it, then seal it', body: 'Arrange your Dreadnought (5), Frigate (4), Corvette (3), Submarine (3) and Cutter (2). Ships run straight and can’t overlap. When you press Seal, a hash of your whole sea goes onchain, and your ships can’t move again.' },
  { art: '💥', title: 'Fire and answer', body: 'Click a cell in the fog to fire. A splash is a miss, fire is a hit, and a sunk ship is named. When the enemy fires at you, your browser answers by itself with a small proof that the contract checks against your seal. Nobody can lie about a hit.' },
  { art: '🔍', title: 'Proven, not trusted', body: 'Your ships never leave this browser until the battle is decided. Then both fleets are revealed and the NEAR contract rebuilds both seas: an illegal fleet or a false “sunk” loses. Battle an AI admiral, or send a friend a link.' },
];

/** The welcome cards, shown once (and again from How to play). */
export function Welcome({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const done = (): void => { writeSeen({ welcomed: true }); onDone(); };
  const c = CARDS[i];
  return (
    <Modal label="Welcome to Fogwater" onClose={done}>
      <div className="ob-art" aria-hidden="true"><CardArt i={i} /></div>
      <h2>{c.title}</h2>
      <p>{c.body}</p>
      <div className="ob-dots" aria-hidden="true">{CARDS.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      <div className="row ob-row">
        <button className="ghost" onClick={done}>Skip</button>
        <span className="grow" />
        {i > 0 && <button className="ghost" onClick={() => setI(i - 1)}>Back</button>}
        {i < CARDS.length - 1 ? <button autoFocus onClick={() => setI(i + 1)}>Next</button> : <button autoFocus onClick={done}>Set sail</button>}
      </div>
    </Modal>
  );
}

/** Rules, controls and the fairness story, always one "?" away. */
export function HowToPlay({ onClose, onReplay }: { onClose: () => void; onReplay: () => void }) {
  return (
    <Modal label="How to play" onClose={onClose} wide>
      <h2>How to play</h2>
      <div className="ob-sheet">
        <section>
          <h3>The battle</h3>
          <ul>
            <li>Each captain has five ships: Dreadnought 5, Frigate 4, Corvette 3, Submarine 3, Cutter 2.</li>
            <li>Turns alternate, one shot each. The first captain to land 17 hits wins.</li>
            <li>When a ship’s last cell is hit, its captain must say which ship sank.</li>
            <li>Against an admiral you have 2 hours per move; between friends, 3 days. Run out and you lose.</li>
          </ul>
        </section>
        <section>
          <h3>Controls</h3>
          <ul>
            <li><b>Placing:</b> drag a ship (or click it, then click where it goes). <kbd>R</kbd>, right-click or the wheel turns it. <kbd>Esc</kbd> puts it back. <b>Shuffle</b> deals a random fleet.</li>
            <li><b>Battle:</b> click a cell in the enemy’s fog or on the enemy chart, or aim with the arrow keys (or <kbd>WASD</kbd>) and fire with <kbd>Enter</kbd>.</li>
            <li>On a narrow screen, switch between <b>Your waters</b> and <b>Enemy waters</b> under the status bar.</li>
            <li><kbd>M</kbd> sound on or off, <kbd>?</kbd> this sheet.</li>
          </ul>
        </section>
        <section>
          <h3>Why nobody can cheat</h3>
          <ul>
            <li><b>Seal:</b> your browser picks a secret seed and hashes every cell into a Merkle tree. Only the root goes to the contract.</li>
            <li><b>Answer:</b> each shot is answered by opening that one cell with 7 hashes. The contract refuses any answer that doesn’t match your root.</li>
            <li><b>Reveal:</b> at the end both seeds are revealed. The contract rebuilds both seas: moved ships, illegal fleets or false “sunk” calls lose. A sea with no ships is caught after 84 misses.</li>
            <li>The admirals plan from their own hits and misses only. Their lines come from a TEE model on NEAR AI and are signed; the model never picks a shot.</li>
          </ul>
        </section>
        <section>
          <h3>Accounts</h3>
          <ul>
            <li>Play as a guest with no wallet. Your fleet’s secret stays in this browser, so finish a game on the device where you started it.</li>
            <li><b>Sign in with NEAR</b> to be ranked on the Admirals’ ledger. You’ll seal your fleet from your own wallet, gaslessly.</li>
            <li>After a game, <b>Proof (JSON)</b> has every move; <code>pnpm verify &lt;id&gt;</code> re-checks it against the contract.</li>
          </ul>
        </section>
      </div>
      <div className="row ob-row">
        <button className="ghost" onClick={onReplay}>Replay the tour</button>
        <span className="grow" />
        <button autoFocus onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}

/** What the walkthrough can see of the game. */
export interface CoachState {
  placing: boolean;
  holding: boolean;
  sealed: boolean;
  phase: string;
  myShots: number;
  theirShots: number;
}

interface Step {
  title: string;
  body: string;
  /** where the card sits: next to a DOM element, or over one of the two waters */
  at: 'mine' | 'enemy' | 'center' | string;
  /** moves on by itself once true; otherwise a Next button */
  done?: (s: CoachState) => boolean;
}

/** How this screen is used: a finger or a mouse, and whether the two waters sit side by side or behind tabs
 *  (the same breakpoint as `.narrow-tabs` in style.css). The tour's words and placement follow it. */
interface Device { touch: boolean; tabs: boolean; sheets: boolean }
const mq = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches;
const device = (): Device => ({
  touch: mq('(pointer: coarse)'),
  tabs: mq('(max-aspect-ratio: 5/4)'),
  // the side panel becomes the Info sheet (style.css, max-width: 600px)
  sheets: mq('(max-width: 600px)'),
});

const steps = ({ touch, tabs, sheets }: Device): Step[] => [
  { title: 'Your waters', body: `This is your fleet, already placed at random. The enemy’s waters${tabs ? ' (the Enemy waters tab)' : ', on the right,'} are hidden in fog.`, at: 'mine' },
  { title: 'Move a ship', body: touch ? 'Tap one of your ships to pick it up.' : 'Drag one of your ships, or click it to pick it up.', at: 'mine', done: (s) => s.holding || !s.placing },
  { title: 'Put it down', body: touch ? 'Tap where its bow goes: green means it fits, red means it doesn’t. Turn (under your waters) rotates it.' : 'Drop it where you like: green means it fits, red means it doesn’t. R, right-click or the mouse wheel turns it.', at: 'mine', done: (s) => !s.holding || !s.placing },
  { title: 'Seal your fleet', body: 'Happy with it? Press Seal fleet. A hash of your sea goes onchain, and your ships are locked in.', at: '.dock', done: (s) => s.sealed },
  { title: 'Fire into the fog', body: touch ? `Your turn: tap any cell in the enemy’s waters${tabs ? ' (the view switches there by itself)' : ''}, or on the Chart.` : `Your turn: click any cell in the enemy’s waters, or on the enemy chart${tabs ? '' : ' on the left'}. Arrow keys and Enter work too.`, at: 'enemy', done: (s) => s.myShots > 0 },
  { title: 'Hit or miss', body: 'A splash is a miss, fire is a hit. Then the enemy fires back, and your browser answers for you with a proof that the contract checks.', at: 'center' },
  sheets
    ? { title: 'Keep score', body: 'Hits so far are up top. Info (bottom right) shows both fleets (sunk ships get crossed out), the admiral’s signed lines and every transaction onchain; Chart shows every shot.', at: '.phonebar' }
    : { title: 'Keep score', body: 'Hits so far are up top. Here you see both fleets (sunk ships get crossed out), the admiral’s signed lines, and every transaction onchain.', at: '.side' },
  { title: 'That’s it', body: `Land 17 hits to win. Then both fleets are revealed and checked onchain, and Proof (JSON) has the whole battle. ${touch ? 'Tap ?' : 'Press ?'} any time for the rules.`, at: 'center' },
];

/** The hands-on walkthrough in your first battle. */
export function Coach({ state, onDone }: { state: CoachState; onDone: () => void }) {
  const [i, setI] = useState(() => (state.sealed ? 4 : 0));
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dev, setDev] = useState(device);
  useEffect(() => { const on = (): void => setDev(device()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const STEPS = steps(dev);
  const step = STEPS[i];
  const finish = (): void => { writeSeen({ toured: true }); onDone(); };
  const next = (): void => { if (i < STEPS.length - 1) setI(i + 1); else finish(); };

  // steps that wait for an action move on when it happens
  useEffect(() => { if (step.done?.(state)) next(); }); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the target element (the HUD re-renders)
  useEffect(() => {
    const sel = step.at.startsWith('.') ? step.at : null;
    if (!sel) { setRect(null); return; }
    const tick = (): void => setRect(document.querySelector(sel)?.getBoundingClientRect() ?? null);
    tick();
    const t = window.setInterval(tick, 300);
    return () => window.clearInterval(t);
  }, [step.at]);

  let style: React.CSSProperties;
  if (rect) {
    const below = rect.top < window.innerHeight / 2;
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - 160), window.innerWidth - 336);
    style = below ? { top: rect.bottom + 12, left } : { top: Math.max(60, rect.top - 12), left, transform: 'translateY(-100%)' };
  } else if (dev.tabs) {
    // one water fills the width: sit just above the bottom controls, under the board, never over its rows
    const bar = [...document.querySelectorAll('.dock, .phonebar')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const top = bar.length ? Math.min(...bar.map((r) => r.top)) : window.innerHeight;
    style = { left: '50%', bottom: window.innerHeight - top + 8, transform: 'translateX(-50%)' };
  } else if (step.at === 'mine') style = { left: '4%', bottom: '18%' };
  else if (step.at === 'enemy') style = { right: '4%', bottom: '18%' };
  else style = { left: '50%', bottom: '14%', transform: 'translateX(-50%)' };

  return (
    <>
      {rect && <div className="ob-ring" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className="ob-coach" style={style} role="status" aria-live="polite">
        <small>Step {i + 1} of {STEPS.length}</small>
        <b>{step.title}</b>
        <p>{step.body}</p>
        <div className="row">
          <button className="ghost small" onClick={finish}>Skip tour</button>
          <span className="grow" />
          {!step.done && <button className="small" onClick={next}>{i < STEPS.length - 1 ? 'Next' : 'Done'}</button>}
        </div>
      </div>
    </>
  );
}
