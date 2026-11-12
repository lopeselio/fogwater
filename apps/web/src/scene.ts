import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CELLS, FLEET, SIZE, colOf, rowOf, shipCells, type Placement } from '@fogwater/rules';

// The night sea, built from voxels: two 10×10 waters side by side on a moonlit ocean. Your fleet sits
// in your waters; the enemy's waters are under a bank of fog that clears only where a shot lands.
// Everything is procedural (boxes, instanced where there are many); no model files.

export type Board = 0 | 1; // 0 = your waters (left), 1 = enemy waters (right)
export type Mark = 'miss' | 'hit' | 'wreck';

// integers, so board cells line up with the ocean's voxels
const BOARD_X: [number, number] = [-6, 6];
const OCEAN_W = 64, OCEAN_D = 44;

const C = {
  sky: 0x070d1c, fog: 0x0a1428, sea: 0x10284a, seaHi: 0x1b3d66, board: 0x1d4775, boardHi: 0x2a5d92,
  wood: 0x6b4426, woodDark: 0x3f2714, deck: 0xa77b4f, sail: 0xe9dcc0, lantern: 0xffcf5a, rock: 0x2c3240, rockHi: 0x3b4356,
  hit: 0xff5a2a, miss: 0xdfe8f5, smoke: 0x4a4f5c, moon: 0xf3efd8, hover: 0xffe27a, bad: 0xff4d4d, good: 0x6dffb0,
};

export const cellPos = (b: Board, cell: number): THREE.Vector3 =>
  new THREE.Vector3(BOARD_X[b] + (colOf(cell) - (SIZE - 1) / 2), 0, rowOf(cell) - (SIZE - 1) / 2);

const box = (w: number, h: number, d: number, color: number, emissive = 0): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 1 : 0 }));
  m.castShadow = false;
  return m;
};

// a soft additive halo for lanterns and fires (bloom makes it glow)
let glowTex: THREE.Texture | null = null;
function glow(color: number, size: number): THREE.Sprite {
  if (!glowTex) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(cv);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }));
  s.scale.set(size, size, 1);
  s.userData.glow = true;
  return s;
}

/** A voxel ship of FLEET[k], lying along +x, centred on the origin. */
function buildShip(k: number): THREE.Group {
  const len = FLEET[k].len;
  const g = new THREE.Group();
  const L = len * 0.92;
  if (FLEET[k].name === 'Submarine') {
    const hull = box(L, 0.28, 0.42, 0x2b3a4a); hull.position.y = 0.02; g.add(hull);
    const nose = box(0.3, 0.2, 0.3, 0x2b3a4a); nose.position.set(L / 2 + 0.1, 0.02, 0); g.add(nose);
    const tower = box(0.5, 0.35, 0.26, 0x3a4c5e); tower.position.set(-0.2, 0.3, 0); g.add(tower);
    const scope = box(0.06, 0.3, 0.06, 0x1d2833); scope.position.set(-0.1, 0.6, 0); g.add(scope);
    const lamp = box(0.08, 0.08, 0.08, C.lantern, C.lantern); lamp.position.set(-0.35, 0.52, 0); g.add(lamp);
    const halo = glow(C.lantern, 0.7); halo.position.copy(lamp.position); g.add(halo);
    return g;
  }
  const keel = box(L * 0.86, 0.18, 0.42, C.woodDark); keel.position.y = -0.08; g.add(keel);
  const hull = box(L, 0.3, 0.62, C.wood); hull.position.y = 0.14; g.add(hull);
  const bow = box(0.34, 0.24, 0.4, C.wood); bow.position.set(L / 2 + 0.12, 0.2, 0); g.add(bow);
  const bowtip = box(0.2, 0.16, 0.2, C.wood); bowtip.position.set(L / 2 + 0.34, 0.26, 0); g.add(bowtip);
  const deck = box(L * 0.94, 0.05, 0.5, C.deck); deck.position.y = 0.31; g.add(deck);
  const rail1 = box(L, 0.08, 0.05, C.woodDark); rail1.position.set(0, 0.36, 0.29); g.add(rail1);
  const rail2 = rail1.clone(); rail2.position.z = -0.29; g.add(rail2);
  const stern = box(0.5, 0.32, 0.56, C.woodDark); stern.position.set(-L / 2 + 0.25, 0.46, 0); g.add(stern);
  const lamp = box(0.1, 0.12, 0.1, C.lantern, C.lantern); lamp.position.set(-L / 2 + 0.05, 0.7, 0); g.add(lamp);
  const halo = glow(C.lantern, 0.9); halo.position.copy(lamp.position); g.add(halo);
  const masts = Math.max(1, Math.ceil(len / 2));
  for (let i = 0; i < masts; i++) {
    const x = -L / 2 + 0.7 + (i + 0.5) * ((L - 0.9) / masts);
    const h = 0.9 + len * 0.12 - i * 0.06;
    const mast = box(0.07, h, 0.07, C.woodDark); mast.position.set(x, 0.32 + h / 2, 0); g.add(mast);
    const sail = box(0.05, h * 0.55, 0.52, C.sail); sail.position.set(x + 0.05, 0.42 + h * 0.5, 0); g.add(sail);
    const yard = box(0.05, 0.05, 0.62, C.woodDark); yard.position.set(x + 0.02, 0.42 + h * 0.78, 0); g.add(yard);
  }
  if (len >= 4) {
    const flag = box(0.03, 0.14, 0.24, 0x2fd39a, 0x0b4a35); flag.position.set(-L / 2 + 0.7 + 0.5 * ((L - 0.9) / masts), 0.36 + 0.9 + len * 0.12 + 0.05, 0.13); g.add(flag);
  }
  return g;
}

interface Particle { i: number; life: number; max: number; vel: THREE.Vector3; pos: THREE.Vector3; size: number; color: THREE.Color; grow: number }

/** Pooled voxel particles (fire, smoke, splash, muzzle flash) in one instanced mesh. */
class Particles {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private live: Particle[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  constructor(scene: THREE.Scene, n = 900) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) { this.free.push(i); this.mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); this.mesh.setColorAt(i, new THREE.Color(0)); }
    scene.add(this.mesh);
  }
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: number, size: number, life: number, grow = -0.6): void {
    const i = this.free.pop();
    if (i === undefined) return;
    this.live.push({ i, life, max: life, vel, pos: pos.clone(), size, color: new THREE.Color(color), grow });
  }
  update(dt: number): void {
    const keep: Particle[] = [];
    for (const p of this.live) {
      p.life -= dt;
      if (p.life <= 0) { this.mesh.setMatrixAt(p.i, this.m.makeScale(0, 0, 0)); this.free.push(p.i); continue; }
      p.pos.addScaledVector(p.vel, dt);
      const t = p.life / p.max;
      const s = Math.max(0.001, p.size * (p.grow < 0 ? t : 1 + (1 - t) * p.grow));
      this.m.compose(p.pos, this.q, new THREE.Vector3(s, s, s));
      this.mesh.setMatrixAt(p.i, this.m);
      this.mesh.setColorAt(p.i, p.color.clone().multiplyScalar(0.35 + 0.65 * t));
      keep.push(p);
    }
    this.live = keep;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  splashGravity(dt: number): void { for (const p of this.live) if (p.grow === 0) p.vel.y -= 9 * dt; }
}

function textSprite(text: string, size = 0.5, color = '#c9d8f0'): THREE.Sprite {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d')!;
  const font = `700 64px Silkscreen, monospace`;
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + 16;
  cv.height = 80;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 42);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.scale.set((size * cv.width) / cv.height, size, 1);
  return s;
}

export interface SceneEvents {
  onHover?: (board: Board, cell: number | null) => void;
  onClick?: (board: Board, cell: number, button: number) => void;
  /** pointer released over a cell (for drag-and-drop placement) */
  onRelease?: (board: Board, cell: number | null) => void;
  /** mouse wheel over the sea */
  onWheel?: (dy: number) => void;
}

export class Sea {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  events: SceneEvents = {};

  private clock = new THREE.Clock();
  private ocean!: THREE.InstancedMesh;
  private oceanBase: { x: number; z: number; board: Board | -1; cell: number }[] = [];
  private tileTint = new Map<string, number>(); // `${board}:${cell}` -> color
  private fog!: THREE.InstancedMesh;
  private fogCells: { cell: number; x: number; z: number; ph: number; s: number }[] = [];
  private fogGone = new Set<number>();
  private fogLifted = false;
  private particles: Particles;
  private ships: (THREE.Group | null)[][] = [[], []];
  private shipState: { p: Placement; k: number; sunk: boolean }[][] = [[], []];
  private ghost: THREE.Group | null = null;
  private ghostOk = true;
  private hoverBox: THREE.LineSegments;
  private reticle: THREE.Group;
  private lastRings: [THREE.Mesh, THREE.Mesh];
  private callouts: { s: THREE.Sprite; t: number }[] = [];
  private markers = new Map<string, THREE.Object3D>();
  private fires: { board: Board; cell: number; strong: boolean }[] = [];
  private beam!: THREE.Mesh;
  private balls: { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; done: () => void }[] = [];
  private focus: 'both' | Board = 'both';
  private camGoal = { pos: new THREE.Vector3(0, 17, 15.5), look: new THREE.Vector3(0, 0, 1) };
  private camLook = new THREE.Vector3(0, 0, 1);
  private shake = 0;
  private raycaster = new THREE.Raycaster();
  private planes: THREE.Mesh[] = [];
  private hovered: { board: Board; cell: number } | null = null;
  private labels: THREE.Sprite[] = [];
  private m4 = new THREE.Matrix4();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private fireLights: THREE.PointLight[] = [];
  private flash: THREE.PointLight;
  private moonPath: number[] = []; // per ocean voxel: how much moonlight it catches
  private frames = new THREE.Group(); // the two waters' frames, posts and coordinates
  private harbour = false; // the menu's vignette: open sea, no boards, ships sailing past
  private sailing: { g: THREE.Group; speed: number; z: number; x0: number }[] = [];

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.scene.background = new THREE.Color(C.sky);
    this.scene.fog = new THREE.FogExp2(C.fog, 0.03);

    this.scene.add(new THREE.HemisphereLight(0x5a78b8, 0x0a0f1c, 1.1));
    const moonLight = new THREE.DirectionalLight(0xbcd0ff, 1.6);
    moonLight.position.set(-8, 14, -10);
    this.scene.add(moonLight);
    const rim = new THREE.DirectionalLight(0x6f8fd8, 0.5);
    rim.position.set(10, 6, 12);
    this.scene.add(rim);
    // lantern light pooled on each water, from the near posts
    for (const x of BOARD_X) {
      const l = new THREE.PointLight(0xffb45a, 10, 13, 1.6);
      l.position.set(x, 2.4, 6.2);
      this.scene.add(l);
    }
    // firelight follows the newest burning hits; a flash lights each cannon shot
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xff7a30, 0, 5, 1.6);
      this.fireLights.push(l);
      this.scene.add(l);
    }
    this.flash = new THREE.PointLight(0xffd8a0, 0, 10, 1.5);
    this.scene.add(this.flash);

    this.particles = new Particles(this.scene);
    this.buildOcean();
    this.buildSky();
    this.buildFrames();
    this.buildIsland();
    this.buildFog();
    this.buildSailing();

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.5, 0.98));
    this.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: C.hover, toneMapped: false }));
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    // a crosshair over the cell you're aiming at, on your turn
    this.reticle = new THREE.Group();
    const rm = new THREE.MeshBasicMaterial({ color: 0xff6a3c, toneMapped: false });
    for (const [w, d, x, z] of [[0.36, 0.07, -0.32, 0], [0.36, 0.07, 0.32, 0], [0.07, 0.36, 0, -0.32], [0.07, 0.36, 0, 0.32]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), rm);
      b.position.set(x, 0, z);
      this.reticle.add(b);
    }
    const dot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), rm);
    this.reticle.add(dot);
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    // the last shot on each water pulses
    const ringGeo = new THREE.RingGeometry(0.42, 0.5, 4, 1);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.rotateY(Math.PI / 4);
    const ring = (): THREE.Mesh => {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.lastRings = [ring(), ring()];

    for (const b of [0, 1] as const) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), new THREE.MeshBasicMaterial({ visible: false }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(BOARD_X[b], 0.05, 0);
      plane.userData.board = b;
      this.planes.push(plane);
      this.scene.add(plane);
    }

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.pointer(e, false));
    el.addEventListener('pointerdown', (e) => this.pointer(e, true));
    el.addEventListener('pointerup', () => this.events.onRelease?.(this.hovered?.board ?? 0, this.hovered?.cell ?? null));
    el.addEventListener('wheel', (e) => { if (this.events.onWheel) { e.preventDefault(); this.events.onWheel(e.deltaY); } }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerleave', () => { this.hovered = null; this.hoverBox.visible = false; this.events.onHover?.(0, null); });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- world ----------

  private buildOcean(): void {
    const n = OCEAN_W * OCEAN_D;
    this.ocean = new THREE.InstancedMesh(new THREE.BoxGeometry(0.97, 1, 0.97), new THREE.MeshLambertMaterial({}), n);
    this.ocean.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    let i = 0;
    for (let zi = 0; zi < OCEAN_D; zi++) {
      for (let xi = 0; xi < OCEAN_W; xi++) {
        const x = xi - OCEAN_W / 2 + 0.5, z = zi - OCEAN_D / 2 + 0.5 - 4;
        let board: Board | -1 = -1, cell = -1;
        for (const b of [0, 1] as const) {
          const cx = Math.round(x - BOARD_X[b] + (SIZE - 1) / 2), cz = Math.round(z + (SIZE - 1) / 2);
          if (cx >= 0 && cx < SIZE && cz >= 0 && cz < SIZE) { board = b; cell = cz * SIZE + cx; }
        }
        this.oceanBase.push({ x, z, board, cell });
        // the moon hangs back-left: its reflection runs from the far left toward the viewer
        // only on the far sea, behind the boards
        const along = x - (-24 + ((z + 26) / 44) * 22);
        this.moonPath.push(board < 0 && z < -6.5 ? Math.max(0, 1 - Math.abs(along) / (1 + (z + 26) * 0.06)) : 0);
        this.ocean.setColorAt(i, new THREE.Color(board >= 0 ? C.board : C.sea));
        i++;
      }
    }
    this.scene.add(this.ocean);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x040810 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.9;
    this.scene.add(floor);
  }

  private buildSky(): void {
    const pts: number[] = [];
    for (let i = 0; i < 700; i++) {
      const a = Math.random() * Math.PI * 2, h = 0.15 + Math.random() * 0.8;
      pts.push(Math.cos(a) * 90 * Math.cos(h), 8 + Math.sin(h) * 70, Math.sin(a) * 90 * Math.cos(h) - 20);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd9ff, size: 0.35, fog: false, sizeAttenuation: true })));
    // a blocky moon
    const moon = new THREE.Group();
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
      if (x * x + y * y > 11) continue;
      const shade = (x + y) % 3 === 0 && Math.abs(x) < 2 ? 0xd9d3b8 : C.moon;
      const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.4), new THREE.MeshBasicMaterial({ color: shade, fog: false }));
      b.position.set(x, y, 0);
      moon.add(b);
    }
    moon.position.set(-24, 22, -46);
    moon.lookAt(0, 0, 0);
    this.scene.add(moon);
  }

  private buildFrames(): void {
    for (const b of [0, 1] as const) {
      const g = new THREE.Group();
      const x0 = BOARD_X[b];
      const h = SIZE / 2 + 0.25;
      const beams = [
        [SIZE + 0.5, 0.18, 0.18, x0, 0, -h], [SIZE + 0.5, 0.18, 0.18, x0, 0, h],
        [0.18, 0.18, SIZE + 0.5, x0 - h, 0, 0], [0.18, 0.18, SIZE + 0.5, x0 + h, 0, 0],
      ];
      for (const [w, hh, d, x, y, z] of beams) { const m = box(w, hh, d, C.woodDark); m.position.set(x, y + 0.08, z); g.add(m); }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const post = box(0.32, 1.1, 0.32, C.wood); post.position.set(x0 + sx * h, 0.4, sz * h); g.add(post);
        const lamp = box(0.2, 0.2, 0.2, C.lantern, C.lantern); lamp.position.set(x0 + sx * h, 1.05, sz * h); g.add(lamp);
        const halo = glow(C.lantern, 0.9); halo.position.copy(lamp.position); g.add(halo);
      }
      this.frames.add(g);
      // coordinates: A–J down the side, 1–10 along the near edge
      for (let i = 0; i < SIZE; i++) {
        const r = textSprite('ABCDEFGHIJ'[i], 0.42, '#8fa6c8');
        r.position.set(x0 - h - 0.55, 0.3, i - 4.5);
        const c = textSprite(String(i + 1), 0.42, '#8fa6c8');
        c.position.set(x0 + i - 4.5, 0.3, h + 0.6);
        this.frames.add(r, c);
      }
      const title = textSprite(b === 0 ? 'YOUR WATERS' : 'ENEMY WATERS', 0.62, b === 0 ? '#9fe3c4' : '#ffb59c');
      title.position.set(x0, 0.4, h + 1.45);
      this.labels.push(title);
      this.frames.add(title);
    }
    this.scene.add(this.frames);
  }

  /** A few ships sailing past the lighthouse, seen only from the harbour. */
  private buildSailing(): void {
    for (const [k, z, speed, x0] of [[0, 3, 0.5, -4], [2, -3.5, -0.42, 12], [1, -8, 0.3, -16]] as const) {
      const g = buildShip(k);
      g.visible = false;
      if (speed < 0) g.rotation.y = Math.PI;
      this.scene.add(g);
      this.sailing.push({ g, speed, z, x0 });
    }
  }

  /** The harbour vignette: open sea, the lighthouse and the moon, ships sailing past. */
  setHarbour(on: boolean): void {
    this.harbour = on;
    this.frames.visible = !on;
    this.fog.visible = !on;
    for (const s of this.sailing) s.g.visible = on;
    this.renderer.toneMappingExposure = on ? 1.3 : 1.15;
    (this.beam.material as THREE.MeshBasicMaterial).opacity = on ? 0.03 : 0.05;
    this.resize();
  }

  private buildIsland(): void {
    // a rock with a lighthouse between the two waters, at the back
    const g = new THREE.Group();
    const rng = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
    for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) {
      const d = Math.hypot(x, z * 1.4);
      if (d > 3.2) continue;
      const h = Math.max(1, Math.round(3 - d + Math.abs(rng(x * 7 + z))));
      for (let y = 0; y < h; y++) {
        const m = box(1, 1, 1, (x + z + y) % 2 ? C.rock : C.rockHi);
        m.position.set(x, y - 0.4, z);
        g.add(m);
      }
    }
    const tower = [0xe9e4d6, 0xc0392b, 0xe9e4d6, 0xc0392b, 0xe9e4d6];
    tower.forEach((col, i) => { const t = box(1 - i * 0.08, 1, 1 - i * 0.08, col); t.position.set(0, 3.1 + i, 0); g.add(t); });
    const lamp = box(0.7, 0.6, 0.7, 0xfff1b0, 0xffe27a); lamp.position.set(0, 8.4, 0); g.add(lamp);
    const halo = glow(0xffe9a0, 4); halo.position.copy(lamp.position); g.add(halo);
    const keeper = new THREE.PointLight(0xffd98a, 18, 14, 1.5); keeper.position.set(0, 8.4, 0); g.add(keeper);
    const roof = box(0.9, 0.3, 0.9, 0x2a2f3a); roof.position.set(0, 8.85, 0); g.add(roof);
    const cone = new THREE.ConeGeometry(1.1, 9, 16, 1, true);
    cone.translate(0, -4.5, 0);
    cone.rotateZ(Math.PI / 2);
    this.beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.beam.position.set(0, 8.4, 0);
    g.add(this.beam);
    g.position.set(0, 0, -10.5);
    this.scene.add(g);
    // a few rocks in the dark
    for (const [x, z, s] of [[-17, -6, 1.4], [18, -4, 1.1], [-19, 7, 0.9], [20, 9, 1.3], [-2, 12, 0.7]]) {
      const r = box(s, s * 0.9, s, C.rock); r.position.set(x, 0.1, z); this.scene.add(r);
    }
  }

  private buildFog(): void {
    const per = 3;
    this.fog = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xc9d4ea, emissive: 0x27344d, transparent: true, opacity: 0.5, depthWrite: false }), CELLS * per);
    this.fog.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let cell = 0; cell < CELLS; cell++) {
      for (let k = 0; k < per; k++) {
        const p = cellPos(1, cell);
        this.fogCells.push({ cell, x: p.x + (Math.random() - 0.5) * 0.5, z: p.z + (Math.random() - 0.5) * 0.5, ph: Math.random() * 10, s: 0.55 + Math.random() * 0.4 });
      }
    }
    this.scene.add(this.fog);
  }

  // ---------- state ----------

  /** Places (or replaces) a board's fleet. `sunk[k]` lays that ship over as a wreck. */
  setFleet(board: Board, ships: Placement[], sunk: boolean[] = []): void {
    for (const s of this.ships[board]) if (s) this.scene.remove(s);
    this.ships[board] = [];
    this.shipState[board] = [];
    ships.forEach((p, k) => {
      const g = buildShip(k);
      this.placeShip(g, board, p, k);
      if (sunk[k]) this.wreck(g);
      this.scene.add(g);
      this.ships[board][k] = g;
      this.shipState[board][k] = { p, k, sunk: !!sunk[k] };
    });
  }

  private placeShip(g: THREE.Object3D, board: Board, p: Placement, k: number): void {
    const cells = shipCells(p, FLEET[k].len);
    if (!cells) return;
    const a = cellPos(board, cells[0]), b = cellPos(board, cells[cells.length - 1]);
    g.position.set((a.x + b.x) / 2, 0.08, (a.z + b.z) / 2);
    g.rotation.set(0, p.vertical ? -Math.PI / 2 : 0, 0);
    g.userData.base = g.position.y;
    g.userData.k = k;
  }

  private wreck(g: THREE.Group): void {
    g.userData.wreck = true;
    g.traverse((o) => {
      if (o.userData.glow) { o.visible = false; return; }
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (m?.color) { m.color.multiplyScalar(0.35); m.emissiveIntensity = 0; }
    });
  }

  /** Lifts the fog over the whole enemy sea (the battle is decided). */
  liftFog(): void { this.fogLifted = true; }
  resetFog(): void { this.fogLifted = false; this.fogGone.clear(); }

  clearMarks(): void {
    for (const m of this.markers.values()) this.scene.remove(m);
    this.markers.clear();
    this.fires = [];
    this.fogGone.clear();
    this.tileTint.clear();
  }

  /** A shot's mark on a board (no animation). */
  mark(board: Board, cell: number, kind: Mark): void {
    const key = `${board}:${cell}`;
    const old = this.markers.get(key);
    if (old) this.scene.remove(old);
    this.fires = this.fires.filter((f) => !(f.board === board && f.cell === cell));
    if (board === 1) this.fogGone.add(cell);
    const p = cellPos(board, cell);
    const g = new THREE.Group();
    if (kind === 'miss') {
      // a pale buoy on cleared, darker water: reads as "empty" even on a small screen
      const peg = box(0.24, 0.42, 0.24, C.miss, 0x5f7da6); peg.position.y = 0.25; g.add(peg);
      const cap = box(0.3, 0.1, 0.3, 0x9fd0ff, 0x3f7fc0); cap.position.y = 0.5; g.add(cap);
      this.tileTint.set(key, 0x0b1a30);
    } else {
      const char = box(0.36, 0.1, 0.36, 0x1a0d08); char.position.y = 0.06; g.add(char);
      const ember = box(0.3, 0.26, 0.3, C.hit, C.hit); ember.position.y = 0.22; g.add(ember);
      // a warm halo so a hit reads at a glance, even small on a phone
      const halo = glow(kind === 'wreck' ? 0xff7a40 : C.hit, kind === 'wreck' ? 0.9 : 1.4); halo.position.y = 0.35; g.add(halo);
      // a hit tile glows red-orange; a sunk ship's tiles go darker but stay warm
      this.tileTint.set(key, kind === 'wreck' ? 0x6a2414 : 0xb0361a);
      this.fires.push({ board, cell, strong: kind === 'hit' });
    }
    g.position.copy(p);
    this.markers.set(key, g);
    this.scene.add(g);
  }

  /** Marks a ship of yours as sunk. */
  sinkShip(board: Board, k: number): void {
    const s = this.ships[board][k];
    const st = this.shipState[board][k];
    if (!s || !st || st.sunk) return;
    st.sunk = true;
    this.wreck(s);
  }

  // ---------- placement ghost ----------

  showGhost(k: number | null, p?: Placement, ok = true): void {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    if (k === null || !p) return;
    this.ghost = buildShip(k);
    this.ghost.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (o.userData.glow) o.visible = false;
      else if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: ok ? C.good : C.bad, transparent: true, opacity: 0.55, toneMapped: false });
    });
    this.placeShip(this.ghost, 0, p, k);
    this.ghost.position.y += 0.25;
    this.ghostOk = ok;
    this.scene.add(this.ghost);
  }

  /** Hides one of your ships while it's being moved. */
  hideShip(k: number | null): void {
    this.ships[0].forEach((s, i) => { if (s) s.visible = i !== k; });
  }

  // ---------- shots ----------

  /** A cannonball from one side to a cell on the other board, then the impact. */
  shoot(from: Board, cell: number, result: 'hit' | 'miss' | 'pending'): Promise<void> {
    const target: Board = from === 0 ? 1 : 0;
    const src = from === 0
      ? new THREE.Vector3(BOARD_X[0] + 1.5, 0.9, 6.3)
      : new THREE.Vector3(BOARD_X[1] - 1.5, 0.9, 6.3);
    const to = cellPos(target, cell);
    for (let i = 0; i < 14; i++) {
      this.particles.spawn(src, new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2), i < 6 ? 0xffe0a0 : C.smoke, 0.25 + Math.random() * 0.2, 0.5 + Math.random() * 0.5);
    }
    sound('boom');
    this.flash.position.copy(src).setY(1.4);
    this.flash.intensity = 40;
    const ball = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    ball.position.copy(src);
    this.scene.add(ball);
    const dur = 0.55 + src.distanceTo(to) * 0.045;
    return new Promise((resolve) => {
      this.balls.push({ mesh: ball, from: src, to, t: 0, dur, done: () => {
        this.scene.remove(ball);
        if (result !== 'pending') this.impact(target, cell, result);
        resolve();
      } });
    });
  }

  impact(board: Board, cell: number, result: 'hit' | 'miss'): void {
    const p = cellPos(board, cell);
    if (result === 'miss') {
      sound('splash');
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.2;
        this.particles.spawn(p.clone().setY(0.2), new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 3, Math.sin(a) * sp), C.miss, 0.12 + Math.random() * 0.1, 0.9, 0);
      }
    } else {
      sound('blast');
      this.shake = 0.35;
      this.flash.position.copy(p).setY(1.2);
      this.flash.intensity = 50;
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.5 + Math.random() * 2.5;
        this.particles.spawn(p.clone().setY(0.4), new THREE.Vector3(Math.cos(a) * sp, 1 + Math.random() * 3, Math.sin(a) * sp), i % 3 ? C.hit : 0xffd36b, 0.18 + Math.random() * 0.2, 0.7 + Math.random() * 0.4);
      }
    }
    this.mark(board, cell, result);
    this.setLastShot(board, cell);
    this.callout(board, cell, result === 'hit' ? 'HIT!' : 'MISS', result === 'hit' ? '#ff8a5c' : '#cfe2ff');
    if (result === 'hit' && board === 0) try { navigator.vibrate?.(120); } catch { /* no haptics */ }
  }

  // ---------- feedback ----------

  /** Big floating text where a shot landed ("HIT!", "MISS", "SUNK"). */
  callout(board: Board, cell: number, text: string, color: string): void {
    const s = textSprite(text, 0.7, color);
    s.position.copy(cellPos(board, cell)).setY(1.2);
    s.material.depthTest = false;
    s.renderOrder = 10;
    this.scene.add(s);
    this.callouts.push({ s, t: 0 });
  }

  /** The pulsing marker on the last shot that landed on a water (null hides it). */
  setLastShot(board: Board, cell: number | null): void {
    const r = this.lastRings[board];
    r.visible = cell !== null;
    if (cell !== null) r.position.copy(cellPos(board, cell)).setY(0.12);
  }

  /** The aiming crosshair (null hides it). */
  setReticle(cell: number | null): void {
    this.reticle.visible = cell !== null;
    if (cell !== null) this.reticle.position.copy(cellPos(1, cell)).setY(0.62);
  }

  // ---------- camera, input, loop ----------

  /** On narrow screens the camera looks at one board at a time. */
  setFocus(f: 'both' | Board): void { this.focus = f; this.resize(); }

  private resize(): void {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.bloom?.resolution.set(w, h);
    this.camera.aspect = w / h;
    const narrow = this.camera.aspect < 1.25;
    this.camera.fov = narrow ? 50 : 40;
    this.camera.updateProjectionMatrix();
    if (this.harbour) {
      // from the near water, across the open sea to the lighthouse with the moon above it
      this.camGoal.pos.set(9, narrow ? 5.4 : 4.6, 16);
      this.camGoal.look.set(-4, narrow ? 3.2 : 2.6, -20);
    } else if (!narrow || this.focus === 'both') {
      // fit both boards: back off as the screen gets narrower, and further until both waters with their
      // row letters and column numbers sit between the side panels (the chart on the left, fleets on the
      // right: about 290px each on a wide screen) instead of under them
      let dist = Math.max(15.5, 26 / Math.min(1.9, this.camera.aspect));
      const limit = w > 900 ? 1 - Math.min(0.5, (2 * 290) / w) : 0.97;
      const probe = this.camera.clone();
      const corners = [-1, 1].flatMap((sx) => [6.4, -5.6].map((z) => new THREE.Vector3(sx * 12.6, 0, z)));
      // with panels at the sides, look more steeply down: the near edge then widens less, so the boards fit closer
      // (and aim a little further out, so the boards sit lower, clear of the status card)
      const [ky, kz, lz] = limit < 0.9 ? [1.15, 0.7, -0.6] : [1.02, 0.92, 0.8];
      for (let i = 0; i < 40; i++) {
        probe.position.set(0, dist * ky, dist * kz);
        probe.lookAt(0, 0, lz);
        probe.updateMatrixWorld();
        if (corners.every((c) => Math.abs(c.clone().project(probe).x) <= limit)) break;
        dist += 0.5;
      }
      this.camGoal.pos.set(0, dist * ky, dist * kz);
      this.camGoal.look.set(0, 0, lz);
    } else {
      // one water at a time: back off until the board and its labels fit the screen's width,
      // and look more steeply down so a tall phone screen shows the whole water
      const x = BOARD_X[this.focus];
      const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
      const dist = Math.max(12, 6.6 / tanH);
      this.camGoal.pos.set(x, dist * 0.93, dist * 0.4);
      this.camGoal.look.set(x, 0, 0.9);
    }
    for (const l of this.labels) l.visible = true;
  }

  private pointer(e: PointerEvent, click: boolean): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.planes)[0];
    if (!hit) {
      if (this.hovered) { this.hovered = null; this.hoverBox.visible = false; this.events.onHover?.(0, null); }
      return;
    }
    const board = hit.object.userData.board as Board;
    const c = Math.floor(hit.point.x - BOARD_X[board] + SIZE / 2), r2 = Math.floor(hit.point.z + SIZE / 2);
    if (c < 0 || c >= SIZE || r2 < 0 || r2 >= SIZE) return;
    const cell = r2 * SIZE + c;
    if (!this.hovered || this.hovered.board !== board || this.hovered.cell !== cell) {
      this.hovered = { board, cell };
      this.events.onHover?.(board, cell);
      if (board === 1 && this.reticle.visible) sound('tick');
    }
    if (click) this.events.onClick?.(board, cell, e.button);
  }

  /** Where the hover frame is drawn (null hides it). */
  setHover(board: Board, cell: number | null, color = C.hover): void {
    if (cell === null) { this.hoverBox.visible = false; return; }
    this.hoverBox.visible = true;
    this.hoverBox.position.copy(cellPos(board, cell)).setY(0.3);
    (this.hoverBox.material as THREE.LineBasicMaterial).color.setHex(color);
  }

  private frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    // waves: the open sea rolls, the two waters are calmer
    const col = new THREE.Color();
    for (let i = 0; i < this.oceanBase.length; i++) {
      const o = this.oceanBase[i];
      const onBoard = o.board >= 0 && !this.harbour;
      const amp = onBoard ? 0.035 : 0.12;
      const y = Math.sin(o.x * 0.55 + t * 1.3) * amp + Math.cos(o.z * 0.7 + t * 0.9) * amp * 0.8 - 0.5;
      this.m4.makeTranslation(o.x, y, o.z);
      this.ocean.setMatrixAt(i, this.m4);
      if (onBoard) {
        const tint = this.tileTint.get(`${o.board}:${o.cell}`);
        const hov = this.hovered && this.hovered.board === o.board && this.hovered.cell === o.cell && this.hoverBox.visible;
        col.setHex(tint ?? (((rowOf(o.cell) + colOf(o.cell)) % 2) ? C.board : C.boardHi));
        if (hov) col.lerp(new THREE.Color(C.hover), 0.25);
        this.ocean.setColorAt(i, col);
      } else if (this.moonPath[i] > 0) {
        const glint = this.moonPath[i] * (0.55 + 0.45 * Math.sin(o.x * 1.7 + o.z * 2.3 + t * 2.6));
        col.setHex(C.sea).lerp(new THREE.Color(0xbfd2ff), glint * 0.5);
        this.ocean.setColorAt(i, col);
      } else if (i % 7 === 0 || o.board >= 0) {
        col.setHex(C.sea).lerp(new THREE.Color(C.seaHi), 0.5 + 0.5 * Math.sin(o.x * 0.3 + o.z * 0.2 + t * 0.8));
        this.ocean.setColorAt(i, col);
      }
    }
    this.ocean.instanceMatrix.needsUpdate = true;
    if (this.ocean.instanceColor) this.ocean.instanceColor.needsUpdate = true;

    // fog drifts; shot cells (and everything, once the battle is decided) clear
    for (let i = 0; i < this.fogCells.length; i++) {
      const f = this.fogCells[i];
      const gone = this.fogLifted || this.fogGone.has(f.cell);
      const s = gone ? 0 : f.s * (0.9 + 0.1 * Math.sin(t * 0.8 + f.ph));
      this.m4.compose(new THREE.Vector3(f.x + Math.sin(t * 0.3 + f.ph) * 0.12, 0.35 + Math.sin(t * 0.5 + f.ph) * 0.1, f.z), new THREE.Quaternion(), new THREE.Vector3(s * 1.1, s * 0.6, s * 1.1));
      this.fog.setMatrixAt(i, this.m4);
    }
    this.fog.instanceMatrix.needsUpdate = true;

    // ships bob; wrecks list and settle
    for (const board of [0, 1] as const) {
      for (const s of this.ships[board]) {
        if (!s) continue;
        const k = s.userData.k as number;
        if (s.userData.wreck) {
          s.position.y = Math.max(-0.32, s.position.y - dt * 0.2);
          s.rotation.x = Math.min(0.32, s.rotation.x + dt * 0.3);
        } else {
          s.position.y = (s.userData.base as number) + Math.sin(t * 1.4 + k * 1.7) * 0.04;
          s.rotation.x = Math.sin(t * 1.1 + k) * 0.03;
        }
      }
    }
    if (this.ghost) this.ghost.position.y = 0.33 + Math.sin(t * 4) * 0.04;

    // fires burn on hits; wrecks smoke
    for (const f of this.fires) {
      if (Math.random() < (f.strong ? 0.5 : 0.25)) {
        const p = cellPos(f.board, f.cell).setY(0.3);
        p.x += (Math.random() - 0.5) * 0.3; p.z += (Math.random() - 0.5) * 0.3;
        const smoke = Math.random() < 0.35;
        this.particles.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 0.2, smoke ? 0.9 : 1.4, (Math.random() - 0.5) * 0.2), smoke ? C.smoke : Math.random() < 0.5 ? C.hit : 0xffc04a, smoke ? 0.22 : 0.13, smoke ? 1.6 : 0.6, smoke ? 1.2 : -0.6);
      }
    }

    // cannonballs on their arcs
    for (const b of [...this.balls]) {
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      b.mesh.position.lerpVectors(b.from, b.to, u);
      b.mesh.position.y += Math.sin(u * Math.PI) * (2.5 + b.from.distanceTo(b.to) * 0.18);
      if (Math.random() < 0.6) this.particles.spawn(b.mesh.position, new THREE.Vector3(0, 0.2, 0), C.smoke, 0.12, 0.5);
      if (u >= 1) { this.balls.splice(this.balls.indexOf(b), 1); b.done(); }
    }

    this.particles.splashGravity(dt);
    this.particles.update(dt);
    if (this.harbour) {
      for (const s of this.sailing) {
        const x = ((s.x0 + t * s.speed + 30) % 60 + 60) % 60 - 30;
        s.g.position.set(x, 0.05 + Math.sin(t * 1.3 + s.z) * 0.06, s.z);
        s.g.rotation.x = Math.sin(t * 1.1 + s.z) * 0.04;
      }
      this.camGoal.pos.x = 9 + Math.sin(t * 0.07) * 1.6;
    }
    this.beam.rotation.y = t * 0.6;
    this.reticle.rotation.y = t * 1.2;
    this.reticle.scale.setScalar(1 + Math.sin(t * 6) * 0.06);
    for (const r of this.lastRings) {
      const k = (t * 1.3) % 1;
      r.scale.setScalar(0.8 + k * 0.6);
      (r.material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }
    for (const c of [...this.callouts]) {
      c.t += dt;
      c.s.position.y += dt * 0.9;
      c.s.material.opacity = Math.min(1, 3 * (1.6 - c.t));
      if (c.t > 1.6) { this.scene.remove(c.s); this.callouts.splice(this.callouts.indexOf(c), 1); }
    }

    // camera eases to its goal; impacts shake it
    this.camera.position.lerp(this.camGoal.pos, 1 - Math.pow(0.02, dt));
    this.camLook.lerp(this.camGoal.look, 1 - Math.pow(0.02, dt));
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * 0.25;
    this.camera.lookAt(this.camLook.x + (Math.random() - 0.5) * sh, this.camLook.y + (Math.random() - 0.5) * sh, this.camLook.z);
    const burning = this.fires.slice(-this.fireLights.length);
    this.fireLights.forEach((l, i) => {
      const ship = this.harbour ? this.sailing[i] : undefined;
      if (ship) { l.position.copy(ship.g.position).setY(1.4); l.intensity = 6; return; }
      const f = burning[i];
      if (!f) { l.intensity = 0; return; }
      l.position.copy(cellPos(f.board, f.cell)).setY(0.9);
      l.intensity = (f.strong ? 6 : 3) * (0.75 + 0.25 * Math.sin(t * 17 + i * 3) * Math.sin(t * 7.3 + i));
    });
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 120);
    this.composer.render();
  }

  isGhostOk(): boolean { return this.ghostOk; }
}

// ---------- sound (synthesised; nothing to download) ----------

let actx: AudioContext | null = null;
let muted = false;
export const setMuted = (m: boolean): void => { muted = m; };
export const isMuted = (): boolean => muted;

function noise(ctx: AudioContext, dur: number): AudioBufferSourceNode {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  return s;
}

export function sound(kind: 'boom' | 'splash' | 'blast' | 'bell' | 'tick'): void {
  if (muted) return;
  try {
    actx ??= new AudioContext();
    const ctx = actx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    if (kind === 'tick') {
      const o = ctx.createOscillator();
      o.frequency.value = 1500;
      o.type = 'square';
      gain.gain.setValueAtTime(0.02, now);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.04);
      o.connect(gain); o.start(now); o.stop(now + 0.05);
      return;
    }
    if (kind === 'bell') {
      const o = ctx.createOscillator();
      o.frequency.value = 880;
      o.type = 'triangle';
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      o.connect(gain); o.start(now); o.stop(now + 0.8);
      return;
    }
    const n = noise(ctx, kind === 'splash' ? 0.6 : 0.9);
    const f = ctx.createBiquadFilter();
    f.type = kind === 'splash' ? 'bandpass' : 'lowpass';
    f.frequency.value = kind === 'boom' ? 380 : kind === 'blast' ? 700 : 1400;
    gain.gain.value = kind === 'blast' ? 0.9 : kind === 'boom' ? 0.6 : 0.35;
    n.connect(f); f.connect(gain); n.start(now);
  } catch { /* no audio */ }
}
