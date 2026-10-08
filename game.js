/* ============================================================================
   TITAN RACER — an endless arcade highway racer
   Vanilla JavaScript + Canvas 2D. No dependencies, no build step.
   ---------------------------------------------------------------------------
   Sections:
     1. constants + math helpers
     2. themes (day / sunset / night)
     3. audio engine (Web Audio API)
     4. input (keyboard / pointer / touch)
     5. world generation (road curves, trees)
     6. entities (player, traffic, particles, popups)
     7. update loop
     8. renderer
     9. game flow + UI wiring
   ========================================================================== */
(function () {
  'use strict';

  /* ========================================================== 1. CONSTANTS */

  const VW = 540;                 // logical (design) canvas width
  const VH = 960;                 // logical (design) canvas height
  const PLAYER_Y = VH - 170;      // screen y of the player's car
  const PX_PER_M = 12;            // world px per in-game "meter"
  const ROAD_W = 336;
  const ROAD_HALF = ROAD_W / 2;
  const LANE_W = ROAD_W / 3;
  const LANE_X = [-LANE_W, 0, LANE_W];      // lane centres (offset from road centre)
  const DIV_X = [-LANE_W / 2, LANE_W / 2];  // dashed lane dividers

  const MAX_SPEED = 620;          // px/s, default top speed
  const NITRO_MULT = 1.42;        // nitro speed multiplier
  const KMH = 0.30;               // px/s -> km/h for the HUD

  const START_LIVES = 3;
  const THEME_LEN = 1400;         // meters per environment
  const THEME_FADE = 260;         // meters of cross-fade between environments

  const STORE = {
    best: 'titanracer.best',
    sound: 'titanracer.quiet',
  };

  /* math helpers ---------------------------------------------------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const approach = (v, target, delta) => (v < target ? Math.min(v + delta, target) : Math.max(v - delta, target));

  // stable pseudo-random in [0,1) from an integer seed
  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  /** Accepts '#rgb', '#rrggbb' or 'rgb(r,g,b)' and returns [r,g,b]. */
  function toRgb(color) {
    if (color[0] === '#') {
      const h = color.slice(1);
      const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const n = parseInt(s, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = color.match(/-?\d+(\.\d+)?/g) || [0, 0, 0];
    return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])];
  }
  function mixHex(a, b, t) {
    const A = toRgb(a), B = toRgb(b);
    const r = Math.round(lerp(A[0], B[0], t));
    const g = Math.round(lerp(A[1], B[1], t));
    const bl = Math.round(lerp(A[2], B[2], t));
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function shade(hex, t) { // t>0 lighter, t<0 darker
    return t >= 0 ? mixHex(hex, '#ffffff', t) : mixHex(hex, '#000000', -t);
  }

  /* ============================================================ 2. THEMES */

  const THEMES = [
    { // 0 — bright day
      name: 'DAY',
      grass: '#3f9d52', grass2: '#36904a', bush: '#2c7a3c',
      road: '#4b4e5a', edge: '#eef1f7',
      rumbleA: '#e04646', rumbleB: '#f7f9fd',
      leaf: '#2f7d3a', leaf2: '#266b31', trunk: '#6b4a2f',
      night: 0, tint: 'rgba(255,255,255,0)',
    },
    { // 1 — sunset / autumn
      name: 'SUNSET',
      grass: '#b07a3c', grass2: '#a06c34', bush: '#8a5c2c',
      road: '#4a4450', edge: '#f3e6d2',
      rumbleA: '#d8492f', rumbleB: '#f6e9d8',
      leaf: '#d08434', leaf2: '#b56a26', trunk: '#5d4027',
      night: 0.16, tint: 'rgba(255,120,40,0.16)',
    },
    { // 2 — night
      name: 'NIGHT',
      grass: '#16301f', grass2: '#122818', bush: '#102417',
      road: '#23252e', edge: '#cfd6e6',
      rumbleA: '#b03333', rumbleB: '#c9ced8',
      leaf: '#12401f', leaf2: '#0e3319', trunk: '#3a2a1c',
      night: 0.66, tint: 'rgba(10,16,48,0.32)',
    },
  ];

  function themeAt(meters) {
    const i = Math.floor(meters / THEME_LEN) % THEMES.length;
    const j = (i + 1) % THEMES.length;
    const into = meters - Math.floor(meters / THEME_LEN) * THEME_LEN;
    const t = into > THEME_LEN - THEME_FADE ? (into - (THEME_LEN - THEME_FADE)) / THEME_FADE : 0;
    const A = THEMES[i], B = THEMES[j];
    if (t <= 0) return mixTheme(A, A, 0, A.name);
    return mixTheme(A, B, t * t * (3 - 2 * t), A.name + ' \u2192 ' + B.name);
  }
  function mixTheme(A, B, t, name) {
    const keys = ['grass', 'grass2', 'bush', 'road', 'edge', 'rumbleA', 'rumbleB', 'leaf', 'leaf2', 'trunk'];
    const o = { name: name };
    keys.forEach((k) => { o[k] = mixHex(A[k], B[k], t); });
    o.night = lerp(A.night, B.night, t);
    o.tintA = A.tint; o.tintB = B.tint; o.tintT = t;
    return o;
  }

  /* ============================================================ 3. AUDIO */

  const Sound = {
    ctx: null, master: null, engine: null, quiet: false, ready: false,

    init() {
      if (this.ready) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        const ctx = new AC();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.quiet ? 0 : 0.7;
        this.master.connect(ctx.destination);

        // --- engine: two detuned saws through a low-pass filter
        const eg = ctx.createGain(); eg.gain.value = 0;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 3;
        const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
        const o2 = ctx.createOscillator(); o2.type = 'square';
        o1.frequency.value = 70; o2.frequency.value = 105;
        o1.connect(lp); o2.connect(lp); lp.connect(eg); eg.connect(this.master);
        o1.start(); o2.start();

        // --- road / wind noise
        const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
        const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1100; nf.Q.value = 0.6;
        const ng = ctx.createGain(); ng.gain.value = 0;
        noise.connect(nf); nf.connect(ng); ng.connect(this.master);
        noise.start();

        this.engine = { o1, o2, lp, eg, nf, ng };
        this.ready = true;
      } catch (e) { /* audio is optional */ }
    },

    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },

    setQuiet(q) {
      this.quiet = q;
      if (this.master) this.master.gain.value = q ? 0 : 0.7;
    },

    // ratio: 0..1 of top speed
    engineTone(ratio, boosting, active) {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      const r = clamp(ratio, 0, 1.3);
      const base = 52 + r * 128 + (boosting ? 26 : 0);
      this.engine.o1.frequency.setTargetAtTime(base, t, 0.06);
      this.engine.o2.frequency.setTargetAtTime(base * 1.503, t, 0.06);
      this.engine.lp.frequency.setTargetAtTime(500 + r * 1500 + (boosting ? 700 : 0), t, 0.1);
      this.engine.eg.gain.setTargetAtTime(active ? 0.055 + r * 0.075 : 0, t, 0.12);
      this.engine.nf.frequency.setTargetAtTime(700 + r * 1500, t, 0.15);
      this.engine.ng.gain.setTargetAtTime(active ? 0.006 + r * 0.05 : 0, t, 0.15);
    },

    blip(freq, dur, type, vol) {
      if (!this.ready || this.quiet) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(); o.type = type || 'square'; o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol == null ? 0.16 : vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + (dur || 0.12) + 0.02);
    },

    noiseBurst(dur, freq, q, vol, sweepTo) {
      if (!this.ready || this.quiet) return;
      const t = this.ctx.currentTime;
      const len = Math.ceil(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      const g = this.ctx.createGain(); g.gain.value = vol == null ? 0.3 : vol;
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t);
    },

    crash() {
      this.noiseBurst(0.65, 320, 0.7, 0.55, 90);
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.6);
    },

    whoosh() { this.noiseBurst(0.3, 300, 0.8, 0.22, 2200); },
    scrape() { this.noiseBurst(0.18, 2600, 1.4, 0.12, 900); },
    coin() { this.blip(880, 0.1, 'square', 0.12); setTimeout(() => this.blip(1320, 0.12, 'square', 0.1), 70); },
  };

  /* ============================================================ 4. INPUT */

  const Input = {
    left: false, right: false, brake: false, nitro: false,
    steerDrag: 0,           // -1..1 from pointer drag steering
    dragPointer: null,
    brakePointer: null,
    nitroPointer: null,

    init() {
      const keys = {
        ArrowLeft: 'left', KeyA: 'left',
        ArrowRight: 'right', KeyD: 'right',
        ArrowDown: 'brake', KeyS: 'brake',
        Space: 'nitro', ShiftLeft: 'nitro', KeyK: 'nitro',
      };
      window.addEventListener('keydown', (e) => {
        const k = keys[e.code];
        if (k) { Input[k] = true; e.preventDefault(); }
        if (e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); Game.togglePause(); }
        if (e.code === 'KeyM') { e.preventDefault(); UI.toggleSound(); }
        if (e.code === 'Enter' && (Game.mode === 'menu' || Game.mode === 'over')) Game.start();
        Sound.init(); Sound.resume();
      });
      window.addEventListener('keyup', (e) => {
        const k = keys[e.code];
        if (k) { Input[k] = false; e.preventDefault(); }
      });
      window.addEventListener('blur', () => {
        Input.left = Input.right = Input.brake = Input.nitro = false;
        Input.steerDrag = 0; Input.dragPointer = null;
      });

      // ---- canvas drag steering (desktop mouse + touch) ----
      const cv = document.getElementById('game');
      const dragStart = (e) => {
        if (Game.mode !== 'playing') return;
        Input.dragPointer = e.pointerId;
        Input._dragX0 = e.clientX;
        Input._dragRect = cv.getBoundingClientRect();
        Sound.init(); Sound.resume();
      };
      const dragMove = (e) => {
        if (Input.dragPointer !== e.pointerId || !Input._dragRect) return;
        const scale = Input._dragRect.width || 1;
        const dx = (e.clientX - Input._dragX0) / (scale * 0.16);
        Input.steerDrag = clamp(dx, -1, 1);
        e.preventDefault();
      };
      const dragEnd = (e) => {
        if (Input.dragPointer !== e.pointerId) return;
        Input.dragPointer = null;
        Input.steerDrag = 0;
      };
      cv.addEventListener('pointerdown', dragStart);
      cv.addEventListener('pointermove', dragMove);
      window.addEventListener('pointerup', dragEnd);
      window.addEventListener('pointercancel', dragEnd);

      // ---- on-screen touch buttons ----
      const bind = (el, on, off) => {
        if (!el) return;
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          el.classList.add('down'); Sound.init(); Sound.resume(); on();
        });
        const up = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('down'); off(); };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
      };
      bind(document.getElementById('btnNitro'), () => { Input.nitro = true; }, () => { Input.nitro = false; });
      bind(document.getElementById('btnBrake'), () => { Input.brake = true; }, () => { Input.brake = false; });
      bind(document.getElementById('btnLeft'), () => { Input.left = true; }, () => { Input.left = false; });
      bind(document.getElementById('btnRight'), () => { Input.right = true; }, () => { Input.right = false; });
    },

    steer() {
      let s = 0;
      if (Input.left) s -= 1;
      if (Input.right) s += 1;
      if (s === 0) s = Input.steerDrag;
      return clamp(s, -1, 1);
    },
  };

  /* ================================================= 5. ROAD + SCENERY */

  /** Lateral offset of the road centre for a given world y (smooth curves). */
  function roadCenter(y) {
    return (
      46 * Math.sin(y * 0.00072) +
      22 * Math.sin(y * 0.00165 + 2.1) +
      9 * Math.sin(y * 0.00340 + 0.7)
    );
  }
  /** d(center)/d(worldY) — used to push the car out of fast corners. */
  function roadSlope(y) {
    return (
      46 * 0.00072 * Math.cos(y * 0.00072) +
      22 * 0.00165 * Math.cos(y * 0.00165 + 2.1) +
      9 * 0.00340 * Math.cos(y * 0.00340 + 0.7)
    );
  }

  const TRAFFIC_PAINT = ['#c9342f', '#2f6fc9', '#e0a12a', '#7a4fc9', '#2fae6a', '#d9dbe3', '#e0642f', '#1f2f4a', '#c93f8f', '#3aa9b8'];
  const CAR_TYPES = [
    { id: 'sedan', w: 54, h: 100, spd: [0.34, 0.50], weight: 5 },
    { id: 'truck', w: 68, h: 168, spd: [0.26, 0.38], weight: 3 },
    { id: 'sport', w: 52, h: 96, spd: [0.50, 0.66], weight: 2 },
  ];

  /* ========================================================== 6. ENTITIES */

  const player = {
    px: 0, worldY: 0, speed: 0, vx: 0, tilt: 0,
    nitro: 100, nitroCool: 0, boosting: false,
    lives: START_LIVES, invuln: 0, offroad: false,
    combo: 1, comboT: 0, topSpeed: 0, distance: 0, wreckT: 0,
    w: 52, h: 96,
  };

  let traffic = [];
  let trees = [];
  let particles = [];
  let popups = [];
  let marks = [];
  let nextTreeY = 0;
  let spawnTimer = 0;
  let repairT = 0;
  let camY = 0;
  let shakeT = 0, shakeMag = 0;
  let flashT = 0, flashColor = '255,255,255';
  let countdown = 0;
  let roadRows = [];      // per-frame road sampling cache

  const Game = {
    mode: 'menu',           // menu | playing | paused | over
    time: 0,
    overtakes: 0,
    bonus: 0,
    score: 0,
    best: 0,
    theme: THEMES[0],
    muted: false,

    init() {
      this.best = parseInt(localStorage.getItem(STORE.best) || '0', 10) || 0;
      this.muted = localStorage.getItem(STORE.sound) === '1';
      UI.refreshBest();
      UI.refreshSound();
    },

    reset() {
      player.px = 0; player.worldY = 0; player.speed = 0; player.vx = 0; player.tilt = 0;
      player.nitro = 100; player.nitroCool = 0; player.boosting = false;
      player.lives = START_LIVES; player.invuln = 2; player.offroad = false;
      player.combo = 1; player.comboT = 0; player.topSpeed = 0; player.distance = 0;
      player.wreckT = 0;

      traffic = []; trees = []; particles = []; popups = []; marks = [];
      camY = 0; nextTreeY = 900; spawnTimer = 1.2; repairT = 0.25;
      shakeT = 0; shakeMag = 0; flashT = 0;

      this.time = 0; this.overtakes = 0; this.bonus = 0; this.score = 0;
      this.theme = themeAt(0);
      countdown = 3.2;
    },

    start() {
      Sound.init(); Sound.resume();
      this.reset();
      this.mode = 'playing';
      UI.showOverlay(null);
      Input.steerDrag = 0;
    },

    toMenu() {
      this.mode = 'menu';
      this.reset();
      UI.refreshBest();
      UI.showOverlay('menu');
    },

    togglePause() {
      if (this.mode === 'playing') { this.mode = 'paused'; UI.showOverlay('pause'); }
      else if (this.mode === 'paused') { this.mode = 'playing'; UI.showOverlay(null); }
    },

    gameOver() {
      this.mode = 'over';
      Sound.engineTone(0, false, false);
      const final = Math.floor(this.score);
      const isBest = final > this.best;
      if (isBest) { this.best = final; localStorage.setItem(STORE.best, String(final)); }
      UI.showGameOver(isBest);
    },
  };

  /* =========================================================== 7. UPDATE */

  function difficulty() {
    // 0 at the start line, grows with distance (soft-capped)
    return clamp(1 - Math.exp(-player.distance / 1800), 0, 1);
  }

  function speedCap() {
    let cap = MAX_SPEED * (0.995 + difficulty() * 0.11);
    if (player.boosting) cap *= NITRO_MULT;
    if (player.offroad) cap *= 0.56;
    return cap;
  }

  function updatePlayer(dt) {
    const canDrive = countdown <= 2.2;   // "1" is on screen

    // ---- throttle / brake -------------------------------------------------
    const cap = speedCap();
    if (canDrive) {
      const accelerating = !Input.brake;
      const rate = accelerating ? 240 + (cap - player.speed) * 0.9 : 900;
      player.speed = approach(player.speed, accelerating ? cap : 0, Math.max(60, rate) * dt);
    } else {
      player.speed = approach(player.speed, 0, 700 * dt);
    }
    player.speed = clamp(player.speed, 0, 1100);

    // ---- nitro ------------------------------------------------------------
    const wantBoost = Input.nitro && !Input.brake && player.nitro > 2 && canDrive && player.speed > 120;
    player.boosting = wantBoost;
    if (wantBoost) {
      player.nitro = Math.max(0, player.nitro - 30 * dt);
      player.nitroCool = 0.7;
      for (let i = 0; i < 3; i++) spawnParticle(exhaust());
    } else {
      player.nitroCool = Math.max(0, player.nitroCool - dt);
      if (player.nitroCool <= 0) player.nitro = Math.min(100, player.nitro + 11 * dt);
    }

    // ---- steering ---------------------------------------------------------
    const steer = canDrive ? Input.steer() : 0;
    const grip = player.offroad ? 0.62 : 1;
    const steerMax = 430 * grip * (0.72 + 0.28 * clamp(player.speed / MAX_SPEED, 0, 1.2));
    player.vx = approach(player.vx, steer * steerMax, (player.offroad ? 1500 : 2400) * dt);
    player.px += player.vx * dt;

    // corners push the car outwards
    const push = roadSlope(player.worldY) * player.speed * 0.55;
    player.px -= push * dt;

    // keep the car inside the visible world
    const limit = VW / 2 - 12;
    player.px = clamp(player.px, -limit, limit);

    // ---- forward motion ---------------------------------------------------
    player.worldY += player.speed * dt;
    const before = player.distance;
    player.distance = player.worldY / PX_PER_M;
    Game.score += Math.max(0, player.distance - before) * 1.0;
    player.topSpeed = Math.max(player.topSpeed, player.speed);

    // ---- surface ----------------------------------------------------------
    const wasOff = player.offroad;
    player.offroad = Math.abs(player.px) > ROAD_HALF - 16;
    if (player.offroad && player.speed > 150) {
      shakeT = Math.max(shakeT, 0.12); shakeMag = Math.max(shakeMag, 1.6 + player.speed / 700);
      if (Math.random() < dt * 40) spawnParticle(dust());
      if (wasOff === false) Sound.scrape();
    }
    if (!player.offroad && wasOff) Sound.blip(300, 0.06, 'sine', 0.05);

    // ---- attitude ---------------------------------------------------------
    player.tilt = lerp(player.tilt, -steer * 0.075 + clamp(player.vx / 4200, -0.05, 0.05), 1 - Math.pow(0.001, dt));

    // ---- exhaust puffs ----------------------------------------------------
    if (player.speed > 60 && Math.random() < dt * (player.boosting ? 60 : 22)) spawnParticle(exhaust());
    if (Input.brake && player.speed > 260 && Math.random() < dt * 36) spawnParticle(smoke());

    // ---- combo / invulnerability timers ----------------------------------
    if (player.comboT > 0) {
      player.comboT -= dt;
      if (player.comboT <= 0) player.combo = 1;
    }
    if (player.invuln > 0) player.invuln -= dt;

    // ---- trees ------------------------------------------------------------
    for (const t of trees) {
      if (Math.abs(player.worldY - t.worldY) < t.h * 0.4 + 26 && Math.abs(player.px - t.x) < t.w * 0.4 + 20) {
        if (player.speed > 40) crash('You clipped a roadside tree');
        break;
      }
    }
  }

  /** Advance every traffic car and cull the ones behind the camera. */
  function moveTraffic(dt) {
    for (const c of traffic) {
      c.worldY += c.speed * dt;
      // occasional lane change
      if (c.laneTimer > 0) {
        c.laneTimer -= dt;
        if (c.laneTimer <= 0 && c.type !== 'truck' && Math.abs(player.worldY - c.worldY) > 340) {
          const dir = Math.random() < 0.5 ? -1 : 1;
          const nl = clamp(c.lane + dir, 0, 2);
          if (nl !== c.lane && !laneBlocked(nl, c.worldY, 300) && corridorOk(c.worldY, nl, c)) {
            c.lane = nl; c.laneTimer = rnd(3, 9);
          } else c.laneTimer = 1.5;
        }
      }
      c.x = lerp(c.x, LANE_X[c.lane], 1 - Math.pow(0.02, dt));
      c.sway = Math.sin(Game.time * 2 + c.seed * 10) * 1.2;
    }
    traffic = traffic.filter((c) => c.worldY > camY - 500);
  }

  /** Idle "attract mode" traffic used behind the main menu. */
  function updateMenuTraffic(dt) {
    moveTraffic(dt);
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = rnd(0.5, 1.3);
      if (traffic.length < 7) {
        const lane = rndInt(0, 2);
        const type = pick(CAR_TYPES);
        if (!laneBlocked(lane, camY + PLAYER_Y + 1200, 340)) {
          traffic.push({
            worldY: camY + PLAYER_Y + rnd(900, 1700),
            lane: lane, x: LANE_X[lane],
            speed: rnd(type.spd[0], type.spd[1]) * MAX_SPEED * 0.85,
            w: type.w, h: type.h, type: type.id,
            color: pick(TRAFFIC_PAINT), seed: Math.random() * 999,
            laneTimer: rnd(2, 8), sway: 0, passed: true, missed: true,
          });
        }
      }
    }
  }

  /**
   * Reachability check: sweeping forward from the player, can a car still
   * weave through what's ahead? Returns the y of the first impassable wall,
   * or null when a path exists. Roughly models the player's steering speed.
   */
  function auditPath(startAhead, steps, stepLen) {
    const STEP = stepLen || 50;
    const STEPS = steps || 18;
    const reach = 430 * (STEP / Math.max(player.speed, 420)) + 9;
    let ranges = [[player.px - 70, player.px + 70]];
    for (let i = 1; i <= STEPS; i++) {
      const y = player.worldY + startAhead + i * STEP;
      const next = [];
      for (const r of ranges) {
        const lo = Math.max(-158, r[0] - reach);
        const hi = Math.min(158, r[1] + reach);
        if (hi >= lo) next.push([lo, hi]);
      }
      for (const c of traffic) {
        if (Math.abs(c.worldY - y) > (c.h + player.h) * 0.5) continue;
        const cx = roadCenter(c.worldY) + c.x + (c.sway || 0);
        const bl = cx - (c.w + player.w) * 0.5 - 4;
        const br = cx + (c.w + player.w) * 0.5 + 4;
        for (let k = next.length - 1; k >= 0; k--) {
          const r = next[k];
          if (br <= r[0] || bl >= r[1]) continue;
          next.splice(k, 1);
          if (bl > r[0]) next.push([r[0], bl]);
          if (br < r[1]) next.push([br, r[1]]);
        }
      }
      if (!next.length) return y;
      ranges = next;
    }
    return null;
  }

  /**
   * Traffic is allowed to drift into configurations that block the road; when
   * that happens a car further up the highway politely merges out of the way
   * (or eases off) so the player is never handed an impossible gap.
   */
  function repairCorridor() {
    if (Game.mode !== 'playing') return;
    const wall = auditPath(560, 16, 55);
    if (wall == null) return;
    let car = null, bestD = 1e9;
    for (const c of traffic) {
      if (c.worldY - player.worldY < 430) continue;     // too close: player's problem
      const d = Math.abs(c.worldY - wall);
      if (d < bestD) { bestD = d; car = c; }
    }
    if (!car) return;
    const lanes = [car.lane - 1, car.lane + 1].filter((l) => l >= 0 && l <= 2);
    for (const nl of lanes) {
      if (laneBlocked(nl, car.worldY, 300)) continue;
      if (!corridorOk(car.worldY, nl, car)) continue;
      car.lane = nl;
      car.laneTimer = rnd(4, 10);
      return;
    }
    // nowhere to merge: drop back so the gap opens up ahead of the player
    car.speed *= 0.7;
  }

  function updateTraffic(dt) {
    const diff = difficulty();
    moveTraffic(dt);

    repairT -= dt;
    if (repairT <= 0) { repairT = 0.25; repairCorridor(); }

    // spawn
    spawnTimer -= dt;
    if (spawnTimer <= 0 && countdown <= 1.4) {
      spawnTimer = lerp(1.35, 0.60, diff) * rnd(0.8, 1.25);
      const ahead = traffic.filter((c) => c.worldY > camY + 200 && c.worldY < camY + 1600);
      const maxAhead = Math.round(lerp(3, 7, diff));
      if (ahead.length < maxAhead) spawnTraffic(diff);
    }

    // ---- collisions / overtakes ------------------------------------------
    // lateral test happens in *screen* space so it always matches what the
    // player sees, even where the road bends.
    for (let i = traffic.length - 1; i >= 0; i--) {
      const c = traffic[i];
      c.screenX = roadCenter(c.worldY) + c.x + c.sway;
      const dy = player.worldY - c.worldY;
      const half = (c.h + player.h) * 0.5;
      const lat = Math.abs(player.px - c.screenX);
      const latLimit = (c.w + player.w) * 0.5 - 6;

      if (Math.abs(dy) < half && lat < latLimit) {
        if (player.invuln <= 0 && player.speed > 60) {
          smash(c);
          traffic.splice(i, 1);
          continue;
        }
      } else if (Math.abs(dy) < half + 30 && lat < latLimit + 16) {
        // near miss (only once per car)
        if (!c.missed) {
          c.missed = true;
          const gained = 40 * player.combo;
          Game.bonus += gained; Game.score += gained;
          popup('NEAR MISS +' + gained, c.screenX, c.worldY, '#8ff0ff');
          Sound.whoosh();
        }
      }
      // passed the car?
      if (!c.passed && player.worldY > c.worldY + c.h * 0.5) {
        c.passed = true;
        Game.overtakes++;
        player.combo = Math.min(9, player.combo + 1);
        player.comboT = 3.4;
        const gained = 20 * player.combo;
        Game.bonus += gained; Game.score += gained;
        popup('OVERTAKE \u00d7' + player.combo + '  +' + gained, c.screenX, c.worldY, '#ffe066');
        Sound.coin();
      }
    }
  }

  function laneBlocked(lane, y, margin) {
    return traffic.some((c) => c.lane === lane && Math.abs(c.worldY - y) < margin);
  }

  /**
   * Fairness rule. Traffic is only allowed to form if the player, sitting
   * anywhere behind it, can always find a way through: pretending the new car
   * sits in `lane` at `y`, every road band around that spot must still contain
   * a free lateral gap wider than the player's car.
   */
  function corridorOk(y, lane, exclude) {
    const ghost = { worldY: y, x: LANE_X[lane], w: 62, h: 130, sway: 0 };
    const list = exclude ? traffic.filter((c) => c !== exclude).concat([ghost]) : traffic.concat([ghost]);
    const GAP_NEEDED = 78;
    for (let shift = -420; shift <= 420; shift += 140) {
      const cy = y + shift;
      const spans = [];
      for (const c of list) {
        if (Math.abs(c.worldY - cy) > 300 + c.h * 0.5) continue;
        const cx = roadCenter(c.worldY) + c.x + (c.sway || 0);
        spans.push([cx - c.w / 2 - 8, cx + c.w / 2 + 8]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let widest = 0;
      let cursor = -ROAD_HALF + 4;
      for (const s of spans) {
        if (s[0] > cursor) widest = Math.max(widest, s[0] - cursor);
        cursor = Math.max(cursor, s[1]);
      }
      widest = Math.max(widest, ROAD_HALF - 4 - cursor);
      if (widest < GAP_NEEDED) return false;
    }
    return true;
  }

  function spawnTraffic(diff) {
    // weighted type choice — more trucks and sports cars later
    const weights = CAR_TYPES.map((t) => t.weight + (t.id === 'truck' ? diff : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, type = CAR_TYPES[0];
    for (let i = 0; i < CAR_TYPES.length; i++) { r -= weights[i]; if (r <= 0) { type = CAR_TYPES[i]; break; } }

    const spawnY = camY + PLAYER_Y + rnd(950, 1500);
    for (let attempt = 0; attempt < 14; attempt++) {
      const lane = rndInt(0, 2);
      if (laneBlocked(lane, spawnY, 300)) continue;
      if (!corridorOk(spawnY, lane)) continue;
      traffic.push({
        worldY: spawnY,
        lane: lane,
        x: LANE_X[lane],
        speed: rnd(type.spd[0], type.spd[1]) * MAX_SPEED * (0.9 + diff * 0.22),
        w: type.w, h: type.h, type: type.id,
        color: pick(TRAFFIC_PAINT),
        seed: Math.random() * 999,
        laneTimer: rnd(2, 8),
        sway: 0, passed: false, missed: false,
      });
      return;
    }
  }

  function updateTrees() {
    const farY = camY + PLAYER_Y + 120;
    while (nextTreeY < farY) {
      const n = nextTreeY;
      for (let side = -1; side <= 1; side += 2) {
        if (hash(n + (side > 0 ? 7 : 3)) > 0.62) continue;
        const off = side * (ROAD_HALF + 52 + hash(n + side * 11) * 210);
        trees.push({
          worldY: n + hash(n + side * 5) * 120,
          x: off,
          w: 34 + hash(n + side * 13) * 26,
          h: 30 + hash(n + side * 17) * 34,
          kind: hash(n + side * 19) > 0.72 ? 'bush' : 'tree',
        });
      }
      nextTreeY += 170;
    }
    trees = trees.filter((t) => t.worldY > camY - 420);
  }

  function spawnParticle(p) { if (particles.length < 320) particles.push(p); }

  function exhaust() {
    const bx = player.px, by = player.worldY;
    return {
      x: bx + rnd(-9, 9), y: by - player.h * 0.5, vx: rnd(-18, 18), vy: rnd(-30, -6) - (player.boosting ? 160 : 0),
      life: rnd(0.25, 0.6), max: 0.6, size: rnd(3, 7),
      color: player.boosting ? '120,200,255' : '190,190,200', add: player.boosting,
    };
  }
  function dust() {
    return {
      x: player.px + rnd(-26, 26), y: player.worldY - rnd(0, 40), vx: rnd(-60, 60), vy: rnd(-40, 40),
      life: rnd(0.3, 0.8), max: 0.8, size: rnd(6, 16), color: '196,178,130', add: false,
    };
  }
  function smoke() {
    return {
      x: player.px + rnd(-20, 20), y: player.worldY - player.h * 0.45, vx: rnd(-70, 70), vy: rnd(-90, -20),
      life: rnd(0.4, 0.9), max: 0.9, size: rnd(8, 18), color: '120,120,128', add: false,
    };
  }
  function boom(x, y) {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(60, 460);
      spawnParticle({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8,
        life: rnd(0.3, 1.1), max: 1.1, size: rnd(4, 14),
        color: pick(['255,190,80', '255,120,40', '255,80,40', '255,240,190']), add: true,
      });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(20, 130);
      spawnParticle({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8,
        life: rnd(0.6, 1.6), max: 1.6, size: rnd(10, 26), color: '70,70,76', add: false,
      });
    }
  }

  function updateParticles(dt) {
    const dv = player.speed;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.y -= dv * dt * 0.35;              // slipstream drags particles backwards
      p.vx *= 1 - 1.6 * dt;
      p.vy *= 1 - 1.6 * dt;
      p.size += (p.add ? 6 : 22) * dt;
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const q = popups[i];
      q.life -= dt; q.y += 40 * dt;
      if (q.life <= 0) popups.splice(i, 1);
    }
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      m.life -= dt;
      if (m.life <= 0) marks.splice(i, 1);
    }
    if (shakeT > 0) { shakeT -= dt; if (shakeT <= 0) shakeMag = 0; }
    if (flashT > 0) flashT -= dt;
  }

  function popup(text, x, worldY, color) {
    if (popups.length > 14) popups.shift();
    popups.push({ text: text, x: x, y: worldY, life: 0.95, max: 0.95, color: color || '#fff' });
  }

  function crash(reason) {
    if (Game.mode !== 'playing' || player.lives <= 0) return;
    if (player.invuln > 0) return;          // still blinking from the last crash
    player.lives = Math.max(0, player.lives - 1);
    player.combo = 1; player.comboT = 0;
    player.invuln = 2.4;
    player.speed *= 0.22;
    player.vx = rnd(-160, 160);
    shakeT = 0.55; shakeMag = 15;
    flashT = 0.35; flashColor = '255,120,60';
    boom(player.px, player.worldY);
    Sound.crash();
    popup(player.lives > 0 ? reason : 'WRECKED!', player.px, player.worldY, '#ff7a5c');
    for (let i = 0; i < 16; i++) marks.push({ x: player.px + rnd(-30, 30), y: player.worldY, w: rnd(4, 10), h: rnd(20, 50), life: rnd(3, 9) });
    // out of lives: let the explosion play out, then end the race in-loop
    if (player.lives <= 0) player.wreckT = 0.8;
  }

  function smash(car) {
    crash('CRASH!');
    boom(car.x + car.sway, car.worldY);
    Sound.noiseBurst(0.4, 700, 0.8, 0.35, 120);
  }

  function update(dt) {
    Game.time += dt;
    if (player.wreckT > 0) {
      player.wreckT -= dt;
      if (player.wreckT <= 0) { Game.gameOver(); return; }
    }
    if (countdown > 0) {
      const prev = Math.ceil(countdown - 0.2);
      countdown -= dt;
      const now = Math.ceil(countdown - 0.2);
      if (now !== prev && now >= 0 && now <= 3) Sound.blip(now === 0 ? 900 : 520, 0.16, 'square', 0.2);
    }
    camY = player.worldY;
    Game.theme = themeAt(player.distance);

    updatePlayer(dt);
    updateTraffic(dt);
    updateTrees();
    updateParticles(dt);

    // engine audio
    const ratio = player.speed / MAX_SPEED;
    Sound.engineTone(ratio, player.boosting, Game.mode === 'playing');
  }

  /* =========================================================== 8. RENDER */

  const cv = document.getElementById('game');
  const ctx = cv.getContext('2d');
  let dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(VW * dpr);
    cv.height = Math.round(VH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  function rr(x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /** world y -> screen y */
  const sy = (wy) => PLAYER_Y - (wy - camY);

  function drawGround(th) {
    // grass base
    ctx.fillStyle = th.grass;
    ctx.fillRect(0, 0, VW, VH);

    // scrolling texture bands
    const bandH = 90;
    const start = Math.floor((camY - 200) / bandH) * bandH;
    for (let wy = start; wy < camY + PLAYER_Y + 120; wy += bandH) {
      const y = sy(wy);
      if (y > VH || y + bandH < 0) continue;
      const i = Math.floor(wy / bandH);
      ctx.fillStyle = th.grass2;
      if (i % 2 === 0) ctx.fillRect(0, y, VW, bandH);
      // speckles / patches
      for (let k = 0; k < 4; k++) {
        const rx = hash(i * 31 + k) * VW;
        const ry = y + hash(i * 17 + k) * bandH;
        const rw = 40 + hash(i * 7 + k) * 130;
        ctx.beginPath();
        ctx.ellipse(rx, ry, rw, rw * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function buildRoadRows() {
    roadRows.length = 0;
    for (let y = 0; y <= VH; y += 4) {
      const wy = camY + PLAYER_Y - y;
      roadRows.push({ y: y, wy: wy, c: roadCenter(wy) + VW / 2 });
    }
  }

  function drawRoad(th) {
    const rows = roadRows;
    // asphalt
    ctx.beginPath();
    ctx.moveTo(rows[0].c - ROAD_HALF, rows[0].y);
    for (let i = 1; i < rows.length; i++) ctx.lineTo(rows[i].c - ROAD_HALF, rows[i].y);
    for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(rows[i].c + ROAD_HALF, rows[i].y);
    ctx.closePath();
    ctx.fillStyle = th.road;
    ctx.fill();

    // subtle asphalt sheen
    ctx.save();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, VW, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.05)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
    ctx.restore();

    // rumble strips (alternating blocks along both edges)
    const blockH = 44;
    const wStart = Math.floor((camY - 200) / blockH) * blockH;
    for (let wy = wStart; wy < camY + PLAYER_Y + 60; wy += blockH) {
      const yA = sy(wy), yB = sy(wy + blockH);
      if (yB > VH || yA < 0) continue;
      const idx = Math.round(wy / blockH);
      ctx.fillStyle = idx % 2 === 0 ? th.rumbleA : th.rumbleB;
      for (const side of [-1, 1]) {
        const cA = roadCenter(wy) + VW / 2, cB = roadCenter(wy + blockH) + VW / 2;
        const xA = cA + side * ROAD_HALF, xB = cB + side * ROAD_HALF;
        ctx.beginPath();
        ctx.moveTo(xA + side * -4, yA);
        ctx.lineTo(xB + side * -4, yB);
        ctx.lineTo(xB + side * 14, yB);
        ctx.lineTo(xA + side * 14, yA);
        ctx.closePath();
        ctx.fill();
      }
    }

    // lane dashes
    const dashLen = 62, dashGap = 62, dashW = 8;
    const period = dashLen + dashGap;
    const dStart = Math.floor((camY - 200) / period) * period;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    for (let wy = dStart; wy < camY + PLAYER_Y + 80; wy += period) {
      const yA = sy(wy), yB = sy(wy + dashLen);
      if (yB > VH || yA < 0) continue;
      for (const dx of DIV_X) {
        const cA = roadCenter(wy) + VW / 2 + dx, cB = roadCenter(wy + dashLen) + VW / 2 + dx;
        ctx.beginPath();
        ctx.moveTo(cA - dashW / 2, yA);
        ctx.lineTo(cB - dashW / 2, yB);
        ctx.lineTo(cB + dashW / 2, yB);
        ctx.lineTo(cA + dashW / 2, yA);
        ctx.closePath();
        ctx.fill();
      }
    }

    // solid edge lines
    ctx.beginPath();
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i].c - ROAD_HALF + 22;
      i === 0 ? ctx.moveTo(x, rows[i].y) : ctx.lineTo(x, rows[i].y);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const x = rows[i].c - ROAD_HALF + 27;
      ctx.lineTo(x, rows[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = th.edge;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i].c + ROAD_HALF - 22;
      i === 0 ? ctx.moveTo(x, rows[i].y) : ctx.lineTo(x, rows[i].y);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const x = rows[i].c + ROAD_HALF - 27;
      ctx.lineTo(x, rows[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = th.edge;
    ctx.fill();
  }

  function drawTrees(th) {
    const list = trees.slice().sort((a, b) => b.worldY - a.worldY);
    for (const t of list) {
      const y = sy(t.worldY);
      if (y < -120 || y > VH + 60) continue;
      const x = roadCenter(t.worldY) + VW / 2 + t.x;
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(x + t.w * 0.22, y + t.h * 0.2, t.w * 0.62, t.h * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      if (t.kind === 'bush') {
        ctx.fillStyle = th.bush;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(x + (k - 1) * t.w * 0.32, y - k * 3, t.w * 0.44, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = th.trunk;
        ctx.beginPath();
        ctx.arc(x, y + t.h * 0.1, t.w * 0.14, 0, Math.PI * 2);
        ctx.fill();
        const grd = ctx.createRadialGradient(x - t.w * 0.25, y - t.h * 0.3, t.w * 0.15, x, y - t.h * 0.15, t.w * 0.85);
        grd.addColorStop(0, shade(th.leaf, 0.18));
        grd.addColorStop(1, th.leaf2);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y - t.h * 0.1, t.w * 0.62, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = th.leaf;
        ctx.beginPath();
        ctx.arc(x - t.w * 0.12, y - t.h * 0.22, t.w * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ---- vehicles --------------------------------------------------------- */

  function drawWheels(w, h, tilt, steerAngle) {
    ctx.save();
    ctx.fillStyle = '#15161a';
    const wheelW = w * 0.17, wheelH = h * 0.22;
    const positions = [
      [-w / 2 - wheelW * 0.22, -h * 0.28, 1], [w / 2 + wheelW * 0.22, -h * 0.28, 1],
      [-w / 2 - wheelW * 0.22, h * 0.30, 0], [w / 2 + wheelW * 0.22, h * 0.30, 0],
    ];
    for (const [x, y, front] of positions) {
      ctx.save();
      ctx.translate(x, y);
      if (front) ctx.rotate((steerAngle || 0) * 0.5);
      rr(-wheelW / 2, -wheelH / 2, wheelW, wheelH, 3);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawCarBody(w, h, color, opts) {
    opts = opts || {};
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(3, 6, w * 0.62, h * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();

    // body
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, shade(color, -0.34));
    g.addColorStop(0.32, color);
    g.addColorStop(0.55, shade(color, 0.22));
    g.addColorStop(1, shade(color, -0.42));
    ctx.fillStyle = g;
    rr(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.24);
    ctx.fill();

    // dark outline
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (opts.truck) {
      // cargo box + cab
      ctx.fillStyle = shade(color, -0.15);
      rr(-w / 2 + 3, -h / 2 + 6, w - 6, h * 0.62, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 3;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 8, -h / 2 + 6 + (h * 0.62 * i) / 4);
        ctx.lineTo(w / 2 - 8, -h / 2 + 6 + (h * 0.62 * i) / 4);
        ctx.stroke();
      }
      ctx.fillStyle = shade(color, 0.12);
      rr(-w / 2 + 3, h * 0.16, w - 6, h * 0.30, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(18,24,34,0.92)';
      rr(-w / 2 + 8, h * 0.20, w - 16, h * 0.13, 4);
      ctx.fill();
    } else {
      // cabin glass
      ctx.fillStyle = 'rgba(16,22,34,0.92)';
      rr(-w * 0.38, -h * 0.22, w * 0.76, h * 0.20, 5);
      ctx.fill();
      rr(-w * 0.34, h * 0.06, w * 0.68, h * 0.15, 5);
      ctx.fill();
      // roof
      ctx.fillStyle = shade(color, 0.10);
      rr(-w * 0.36, -h * 0.05, w * 0.72, h * 0.14, 5);
      ctx.fill();
      // windscreen reflection
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      rr(-w * 0.34, -h * 0.21, w * 0.30, h * 0.18, 4);
      ctx.fill();
      // centre stripe
      if (opts.stripe) {
        ctx.fillStyle = opts.stripe;
        rr(-w * 0.07, -h * 0.44, w * 0.14, h * 0.88, 3);
        ctx.fill();
      }
      // spoiler
      if (opts.spoiler) {
        ctx.fillStyle = shade(color, -0.5);
        rr(-w * 0.52, h * 0.36, w * 1.04, h * 0.10, 4);
        ctx.fill();
      }
    }
  }

  function drawLights(w, h, opts) {
    const night = opts.night || 0;
    // headlights
    if (opts.headlights) {
      const a = 0.35 + night * 0.65;
      ctx.fillStyle = 'rgba(255,245,205,' + a.toFixed(2) + ')';
      rr(-w * 0.40, -h / 2 + 3, w * 0.24, h * 0.045, 2); ctx.fill();
      rr(w * 0.16, -h / 2 + 3, w * 0.24, h * 0.045, 2); ctx.fill();
    }
    // tail lights
    if (opts.taillights !== false) {
      ctx.fillStyle = opts.braking ? 'rgba(255,60,50,0.98)' : 'rgba(210,40,40,0.85)';
      rr(-w * 0.42, h / 2 - h * 0.055, w * 0.26, h * 0.035, 2); ctx.fill();
      rr(w * 0.16, h / 2 - h * 0.055, w * 0.26, h * 0.035, 2); ctx.fill();
    }
  }

  function drawPlayer(th) {
    const x = player.px + VW / 2;
    const y = PLAYER_Y;
    const blink = player.invuln > 0 && Math.floor(player.invuln * 12) % 2 === 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(player.tilt);

    // nitro / offroad glow
    if (player.boosting) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, player.h * 0.55, 4, 0, player.h * 0.6, 74);
      g.addColorStop(0, 'rgba(120,215,255,0.55)');
      g.addColorStop(1, 'rgba(60,140,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, player.h * 0.6, 44, 74, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // flames
      for (let i = -1; i <= 1; i += 2) {
        ctx.fillStyle = 'rgba(150,225,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(i * 14 - 5, player.h * 0.5);
        ctx.lineTo(i * 14 + 5, player.h * 0.5);
        ctx.lineTo(i * 14, player.h * 0.5 + rnd(22, 46));
        ctx.closePath();
        ctx.fill();
      }
    }

    if (blink) ctx.globalAlpha = 0.35;
    drawWheels(player.w, player.h, player.tilt, Input.steer() * 0.9);
    drawCarBody(player.w, player.h, '#e8262d', { stripe: '#ffffff', spoiler: true });
    drawLights(player.w, player.h, { headlights: true, night: th.night, taillights: true, braking: Input.brake });
    ctx.globalAlpha = 1;
    // cockpit driver hint
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    rr(-player.w * 0.30, -player.h * 0.20, player.w * 0.60, player.h * 0.16, 4);
    ctx.fill();
    ctx.restore();

    // headlight beam on the road at night
    if (th.night > 0.25) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(x, y);
      beam(th.night * 0.9, -player.h * 0.5, player.w);
      ctx.restore();
    }
  }

  /** additive headlight cone pointing "forward" (up the screen) */
  function beam(strength, frontY, w) {
    const len = 420 + strength * 260;
    const g = ctx.createLinearGradient(0, frontY, 0, frontY - len);
    g.addColorStop(0, 'rgba(255,240,200,' + (0.30 * strength).toFixed(3) + ')');
    g.addColorStop(0.45, 'rgba(255,238,190,' + (0.13 * strength).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,235,180,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-w * 0.42, frontY);
    ctx.lineTo(w * 0.42, frontY);
    ctx.lineTo(w * 2.1, frontY - len);
    ctx.lineTo(-w * 2.1, frontY - len);
    ctx.closePath();
    ctx.fill();
  }

  function drawTrafficCar(c, th) {
    const x = (c.screenX == null ? roadCenter(c.worldY) + c.x + c.sway : c.screenX) + VW / 2;
    const y = sy(c.worldY);
    if (y < -260 || y > VH + 200) return;
    ctx.save();
    ctx.translate(x, y);
    const tilt = clamp(roadSlope(c.worldY) * 0.6, -0.12, 0.12);
    ctx.rotate(tilt);
    drawWheels(c.w, c.h, 0, 0);
    drawCarBody(c.w, c.h, c.color, { truck: c.type === 'truck', spoiler: c.type === 'sport', stripe: c.type === 'sport' ? 'rgba(255,255,255,0.75)' : null });
    drawLights(c.w, c.h, { headlights: true, night: th.night, taillights: true });
    ctx.restore();
    if (th.night > 0.25) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(x, y);
      beam(th.night * 0.75, -c.h * 0.5, c.w);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const y = sy(p.y);
      if (y < -60 || y > VH + 60) continue;
      const a = clamp(p.life / p.max, 0, 1);
      ctx.save();
      if (p.add) ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(' + p.color + ',' + (a * (p.add ? 0.85 : 0.5)).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x + VW / 2, y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawMarks() {
    for (const m of marks) {
      const y = sy(m.y);
      if (y < -60 || y > VH + 60) continue;
      ctx.save();
      ctx.globalAlpha = clamp(m.life / 6, 0, 0.5);
      ctx.fillStyle = '#0c0c10';
      rr(m.x + VW / 2 - m.w / 2, y - m.h / 2, m.w, m.h, 3);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPopups() {
    ctx.textAlign = 'center';
    for (const q of popups) {
      const y = sy(q.y);
      if (y < -40 || y > VH + 40) continue;
      const t = 1 - q.life / q.max;
      const scale = t < 0.18 ? 0.6 + (t / 0.18) * 0.55 : 1.15 - t * 0.18;
      ctx.save();
      ctx.globalAlpha = q.life > 0.35 ? 1 : q.life / 0.35;
      ctx.translate(q.x + VW / 2, y);
      ctx.scale(scale, scale);
      ctx.font = '900 24px Orbitron, "Segoe UI", ui-monospace, monospace';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(q.text, 0, 0);
      ctx.fillStyle = q.color;
      ctx.fillText(q.text, 0, 0);
      ctx.restore();
    }
  }

  /* ---- HUD -------------------------------------------------------------- */

  function drawHud(th) {
    const kmh = Math.round(player.speed * KMH);
    const ratio = clamp(player.speed / (MAX_SPEED * NITRO_MULT), 0, 1);

    // distance / score
    ctx.textAlign = 'left';
    ctx.font = '900 44px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(Math.floor(player.distance) + ' m', 30, 62);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(Math.floor(player.distance) + ' m', 28, 60);

    ctx.font = '700 20px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText('SCORE ' + Math.floor(Game.score), 28, 90);
    ctx.font = '600 15px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(140,240,255,0.85)';
    ctx.fillText(th.name, 28, 112);
    if (player.combo > 1) {
      const pulse = 1 + Math.sin(Game.time * 12) * 0.04;
      ctx.save();
      ctx.translate(28, 142);
      ctx.scale(pulse, pulse);
      ctx.font = '900 22px Orbitron, "Segoe UI", ui-monospace, monospace';
      ctx.fillStyle = '#ffd54a';
      ctx.fillText('COMBO \u00d7' + player.combo, 0, 0);
      ctx.restore();
    }

    // lives
    ctx.textAlign = 'right';
    for (let i = 0; i < START_LIVES; i++) {
      const alive = i < player.lives;
      const x = VW - 34 - i * 40, y = 46;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = alive ? '#e8262d' : 'rgba(255,255,255,0.16)';
      rr(-11, -17, 22, 34, 6); ctx.fill();
      ctx.fillStyle = alive ? 'rgba(20,26,38,0.85)' : 'rgba(255,255,255,0.10)';
      rr(-7, -9, 14, 9, 3); ctx.fill();
      rr(-7, 3, 14, 7, 3); ctx.fill();
      ctx.restore();
    }

    // ---- nitro bar (lower left, kept above the touch buttons) ----
    const bw = 176, bh = 16, bx = 26, by = VH - 232;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    rr(bx - 3, by - 3, bw + 6, bh + 6, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    rr(bx, by, bw, bh, 9); ctx.fill();
    const ng = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    ng.addColorStop(0, '#2fd0ff');
    ng.addColorStop(1, '#7c5cff');
    ctx.fillStyle = ng;
    rr(bx, by, Math.max(6, bw * (player.nitro / 100)), bh, 9); ctx.fill();
    ctx.font = '700 14px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('NITRO', bx, by - 10);

    // ---- speed readout (lower right, above the touch buttons) ----
    const cx = VW - 86, cy = VH - 232, R = 52;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(0, 0, R, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();
    ctx.strokeStyle = player.boosting ? '#7ce7ff' : ratio > 0.75 ? '#ffb03a' : '#8ef0c0';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, 0, R, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * ratio);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '900 34px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.fillText(String(kmh), 0, 10);
    ctx.font = '600 13px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('KM/H', 0, 30);
    ctx.restore();

    // ---- speed lines when fast / boosting ----
    if (ratio > 0.72 || player.boosting) {
      const intensity = (ratio - 0.65) / 0.35;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.10 * intensity).toFixed(3) + ')';
      ctx.lineWidth = 2;
      for (let i = 0; i < 26; i++) {
        const x = hash(i * 3.7 + Math.floor(Game.time * 22)) * VW;
        const y = hash(i * 9.1 + Math.floor(Game.time * 30)) * VH;
        const len = 60 + hash(i * 5.3) * 140;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + len);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawCountdown() {
    if (countdown <= 0) return;
    const n = Math.ceil(countdown - 0.2);
    const label = n <= 0 ? 'GO!' : String(Math.min(3, n));
    const frac = 1 - (countdown - Math.floor(countdown));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.translate(VW / 2, VH * 0.42);
    const scale = 1 + (1 - frac) * 0.35;
    ctx.scale(scale, scale);
    ctx.globalAlpha = clamp(frac * 2, 0, 1);
    ctx.font = '900 ' + (label === 'GO!' ? 96 : 118) + 'px Orbitron, "Segoe UI", ui-monospace, monospace';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(label, 0, 0);
    const g = ctx.createLinearGradient(0, -70, 0, 20);
    g.addColorStop(0, label === 'GO!' ? '#9dffb0' : '#ffffff');
    g.addColorStop(1, label === 'GO!' ? '#22c55e' : '#ffd54a');
    ctx.fillStyle = g;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  function drawVignette(th) {
    // environment tint + night fall-off
    if (th.night > 0.02) {
      ctx.fillStyle = 'rgba(6,10,26,' + (th.night * 0.55).toFixed(3) + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
    const g = ctx.createRadialGradient(VW / 2, VH * 0.5, VH * 0.32, VW / 2, VH * 0.5, VH * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
    if (flashT > 0) {
      ctx.fillStyle = 'rgba(' + flashColor + ',' + (flashT * 1.1).toFixed(3) + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
  }

  function render() {
    const th = Game.theme;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VW, VH);

    ctx.save();
    if (shakeT > 0) {
      const m = shakeMag * (shakeT / 0.55);
      ctx.translate(rnd(-m, m), rnd(-m, m));
    }

    buildRoadRows();
    // night darkening is layered on *after* the scenery so headlights pop
    drawGround(th);
    drawRoad(th);
    drawTrees(th);
    if (th.night > 0.02) {
      ctx.fillStyle = 'rgba(6,10,26,' + (th.night * 0.5).toFixed(3) + ')';
      ctx.fillRect(-40, -40, VW + 80, VH + 80);
    }
    drawMarks();

    const list = traffic.slice().sort((a, b) => b.worldY - a.worldY);
    for (const c of list) if (c.worldY > player.worldY) drawTrafficCar(c, th);
    drawPlayer(th);           // the hero car also drives the attract-mode demo
    for (const c of list) if (c.worldY <= player.worldY) drawTrafficCar(c, th);

    drawParticles();
    ctx.restore();

    drawPopups();
    drawVignette(th);
    if (Game.mode !== 'menu') drawHud(th);
    drawCountdown();
  }

  /* ======================================================== 9. GAME FLOW */

  const UI = {
    overlays: {},

    init() {
      this.overlays.menu = document.getElementById('menu');
      this.overlays.pause = document.getElementById('pause');
      this.overlays.over = document.getElementById('over');

      document.getElementById('btnStart').addEventListener('click', () => Game.start());
      document.getElementById('btnResume').addEventListener('click', () => Game.togglePause());
      document.getElementById('btnRestart').addEventListener('click', () => Game.start());
      document.getElementById('btnQuit').addEventListener('click', () => Game.toMenu());
      document.getElementById('btnAgain').addEventListener('click', () => Game.start());
      document.getElementById('btnMenu').addEventListener('click', () => Game.toMenu());
      document.getElementById('btnPause').addEventListener('click', () => Game.togglePause());
      document.getElementById('btnSound').addEventListener('click', () => this.toggleSound());
      document.getElementById('soundToggle').addEventListener('click', () => this.toggleSound());
      this.updateMuteButtons();
    },

    showOverlay(which) {
      for (const k of Object.keys(this.overlays)) {
        this.overlays[k].classList.toggle('hidden', k !== which);
      }
      document.body.classList.toggle('in-game', !!which === false || which === null);
      document.getElementById('touch').classList.toggle('show', Game.mode === 'playing');
    },

    refreshBest() {
      const el = document.getElementById('bestLabel');
      if (el) el.textContent = Game.best > 0 ? 'BEST ' + Game.best : 'NO RECORDS YET';
    },

    refreshSound() { this.updateMuteButtons(); },

    updateMuteButtons() {
      const on = !Game.muted;
      const b = document.getElementById('btnSound');
      if (b) { b.textContent = on ? '\uD83D\uDD0A' : '\uD83D\uDD07'; b.classList.toggle('muted', !on); }
      const s = document.getElementById('soundToggle');
      if (s) s.textContent = on ? '\uD83D\uDD0A Sound on' : '\uD83D\uDD07 Sound off';
    },

    toggleSound() {
      Game.muted = !Game.muted;
      localStorage.setItem(STORE.sound, Game.muted ? '1' : '0');
      Sound.init();
      Sound.setQuiet(Game.muted);
      this.updateMuteButtons();
    },

    showGameOver(isBest) {
      document.getElementById('statDistance').textContent = Math.floor(player.distance) + ' m';
      document.getElementById('statScore').textContent = Math.floor(Game.score).toLocaleString();
      document.getElementById('statTop').textContent = Math.round(player.topSpeed * KMH) + ' km/h';
      document.getElementById('statOvertakes').textContent = String(Game.overtakes);
      document.getElementById('statBonus').textContent = Math.floor(Game.bonus).toLocaleString();
      document.getElementById('bestBig').textContent = 'BEST ' + Math.floor(Game.best).toLocaleString();
      document.getElementById('newRecord').classList.toggle('hidden', !isBest);
      this.showOverlay('over');
    },
  };

  /* ---- main loop -------------------------------------------------------- */

  let last = performance.now();
  let acc = 0;
  const STEP = 1 / 60;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    acc += dt;

    if (Game.mode === 'playing') {
      while (acc >= STEP) { update(STEP); acc -= STEP; if (Game.mode !== 'playing') break; }
    } else {
      acc = 0;
      Game.time += dt * 0.4;
      updateParticles(dt);
      if (Game.mode === 'menu') {
        // attract mode: the world scrolls by on its own
        camY += 300 * dt;
        player.worldY = camY;
        player.px = Math.sin(Game.time * 0.8) * 42;
        player.speed = 300;
        Game.theme = themeAt(camY / PX_PER_M);
        updateTrees();
        updateMenuTraffic(dt);
        if (Math.random() < dt * 8) spawnParticle(exhaust());
      }
      Sound.engineTone(0.25, false, Game.mode === 'paused');
    }
    render();
    requestAnimationFrame(frame);
  }

  /* ---- boot ------------------------------------------------------------- */

  function boot() {
    resize();
    window.addEventListener('resize', resize);
    Input.init();
    UI.init();
    Game.init();
    Sound.init();
    Sound.setQuiet(Game.muted);
    Game.reset();
    Game.mode = 'menu';
    UI.showOverlay('menu');
    requestAnimationFrame(frame);
  }

  // debug / automation handle (also handy from the browser console)
  window.TitanRacer = {
    Game, player, UI, Input, Sound,
    start: () => Game.start(),
    peek: () => ({ traffic, trees, particles, popups, marks, roadCenter, roadSlope, LANE_X, ROAD_HALF, MAX_SPEED, auditPath }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
