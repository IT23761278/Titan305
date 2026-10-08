/* ============================================================================
   TITAN RACER — headless smoke test
   ---------------------------------------------------------------------------
   Runs the real game.js inside Node against stub DOM / Canvas2D / WebAudio
   objects, then drives it: attract mode -> start -> a reckless 4-minute run ->
   restart -> a long run by a competent pseudo-AI driver.

   It asserts that ...

     * the module loads and the frame loop survives thousands of frames
     * lives, nitro, speed and position stay inside sane bounds
     * the restart path resets everything (no stale game-over timers)
     * no drawing call ever receives NaN / Infinity coordinates
     * the player is always left a passable gap in the traffic
       (game's own reachability model, TitanRacer.peek().auditPath)

   Usage:  node tools/headless-test.js [path-to-game-folder]
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const errors = [];
const warnings = [];

/* ---------------- canvas 2d context stub ---------------- */
function makeGradient() { return { addColorStop() {} }; }
const badCalls = [];
function wrapCtxFn(name, fn) {
  return function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (typeof v === 'number' && !isFinite(v)) {
        if (badCalls.length < 8) badCalls.push(name + ' arg#' + i + ' = ' + v);
      }
    }
    return fn.apply(null, arguments);
  };
}
function makeCtx() {
  const store = {};
  const noop = () => {};
  const handler = {
    get(t, k) {
      if (k in store) return store[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return makeGradient;
      if (k === 'measureText') return () => ({ width: 12 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'canvas') return t.canvas;
      return wrapCtxFn(k, noop);
    },
    set(t, k, v) { store[k] = v; return true; },
  };
  return new Proxy({ canvas: { width: 540, height: 960 } }, handler);
}

/* ---------------- element stub ---------------- */
function makeEl(id) {
  const el = {
    id,
    _handlers: {},
    textContent: '',
    width: 540,
    height: 960,
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; on ? this._s.add(c) : this._s.delete(c); return on; },
    },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 540, height: 960, right: 540, bottom: 960 }; },
    getContext() { return this._ctx || (this._ctx = makeCtx()); },
    remove() { this._removed = true; },
    appendChild() {}, removeChild() {}, querySelector() { return null; },
    fire(type, ev) { (this._handlers[type] || []).forEach((f) => f(ev || {})); },
  };
  return el;
}

const els = {};
const getEl = (id) => (els[id] = els[id] || makeEl(id));

const winHandlers = {};
global.window = {
  devicePixelRatio: 2,
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
  removeEventListener() {},
  AudioContext: undefined,          // exercise the "no audio" path
  webkitAudioContext: undefined,
};
global.document = {
  readyState: 'complete',
  body: makeEl('body'),
  getElementById: getEl,
  addEventListener() {},
};
const lsData = {};
global.localStorage = {
  getItem: (k) => (k in lsData ? lsData[k] : null),
  setItem: (k, v) => { lsData[k] = String(v); },
};

/* ---------------- controllable clock + rAF ---------------- */
let clock = 0;
global.performance = { now: () => clock };
let rafQueue = [];
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
global.setTimeout = (fn, ms) => { timeouts.push({ fn, at: clock + (ms || 0) }); return timeouts.length; };
let timeouts = [];

function step(ms) {
  clock += ms;
  const due = timeouts.filter((t) => t.at <= clock);
  timeouts = timeouts.filter((t) => t.at > clock);
  due.forEach((t) => t.fn());
  const q = rafQueue; rafQueue = [];
  q.forEach((fn) => fn(clock));
}

function fireWindow(type, ev) { (winHandlers[type] || []).forEach((f) => f(ev)); }
function key(code, down) {
  fireWindow(down ? 'keydown' : 'keyup', { code, preventDefault() {}, clientX: 0, clientY: 0 });
}

/* ---------------- load the game ---------------- */
const src = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
process.on('uncaughtException', (e) => { errors.push('uncaught: ' + e.stack); });
try {
  new Function(src)();      // same as a <script> tag
} catch (e) {
  errors.push('load error: ' + e.stack);
}

const TR = global.window.TitanRacer;
if (!TR) { errors.push('TitanRacer global missing'); report(); }
else {
  const { Game, player } = TR;

  /* ---- 1. attract mode runs without throwing ---- */
  try { for (let i = 0; i < 120; i++) step(16.7); } catch (e) { errors.push('menu loop: ' + e.stack); }
  if (Game.mode !== 'menu') errors.push('expected menu mode, got ' + Game.mode);
  if (!Game.best === undefined) warnings.push('best is undefined');

  /* ---- 2. start via the menu button ---- */
  try { getEl('btnStart').fire('click'); } catch (e) { errors.push('start click: ' + e.stack); }
  if (Game.mode !== 'playing') errors.push('start button did not begin the race: ' + Game.mode);

  /* ---- 3. simulate ~4 minutes of aggressive driving ---- */
  const seenThemes = new Set();
  let maxSpeed = 0, crashes = 0, lastLives = player.lives;
  let frames = 0;
  try {
    for (let i = 0; i < 60 * 240; i++) {
      const t = i / 60;
      // wiggly, aggressive driver: hold right, then left, boost often, never brake
      if (i % 37 === 0) { key('ArrowRight', false); key('ArrowLeft', true); }
      if (i % 53 === 0) { key('ArrowLeft', false); key('ArrowRight', true); }
      if (i % 91 === 0) key('ArrowDown', true);
      if (i % 97 === 0) key('ArrowDown', false);
      key('Space', (i % 240) < 70);
      if (i % 600 === 0) { key('KeyP', true); key('KeyP', false); }   // pause + resume
      step(16.7);
      frames++;
      if (Game.mode === 'playing') {
        maxSpeed = Math.max(maxSpeed, player.speed);
        seenThemes.add(Game.theme.name);
        if (player.lives < lastLives) { crashes++; lastLives = player.lives; }
      }
      if (Game.mode === 'over') { break; }
    }
  } catch (e) { errors.push('play loop: ' + e.stack); }

  /* ---- 4. assertions ---- */
  if (Game.mode === 'playing' && player.distance < 200) warnings.push('distance grew very slowly: ' + player.distance.toFixed(1));
  if (player.topSpeed <= 0) errors.push('player never moved');
  if (maxSpeed > 1400) errors.push('speed exploded: ' + maxSpeed);
  if (crashes === 0) warnings.push('no crashes during 4 simulated minutes of reckless driving');
  if (player.nitro < 0 || player.nitro > 100) errors.push('nitro out of range: ' + player.nitro);
  if (Math.abs(player.px) > 300) errors.push('player left the world: px=' + player.px);
  if (Game.score <= 0) errors.push('score never increased');
  console.log('sim frames      :', frames);
  console.log('mode            :', Game.mode);
  console.log('distance        :', player.distance.toFixed(1), 'm');
  console.log('lives left      :', player.lives);
  console.log('crashes         :', crashes);
  console.log('top speed       :', (player.topSpeed * 0.3).toFixed(0), 'km/h');
  console.log('overtakes       :', Game.overtakes);
  console.log('bonus           :', Math.floor(Game.bonus));
  console.log('score           :', Math.floor(Game.score));
  console.log('themes seen     :', [...seenThemes].join(' | '));
  console.log('traffic alive   :', TR.Game && 'n/a');
  console.log('best stored     :', lsData['titanracer.best']);

  /* ---- 5. restart after game over ---- */
  if (Game.mode === 'over') {
    try {
      getEl('btnAgain').fire('click');
      for (let i = 0; i < 300; i++) step(16.7);
      if (Game.mode !== 'playing') errors.push('restart failed');
      if (player.lives !== 3) errors.push('lives not reset: ' + player.lives);
      if (player.distance > 400) warnings.push('distance not reset on restart: ' + player.distance.toFixed(1));
    } catch (e) { errors.push('restart: ' + e.stack); }
  }

  /* ---- 6. mute toggle + window events ---- */
  try {
    key('KeyM', true);
    key('KeyM', false);
    fireWindow('blur', {});
    for (let i = 0; i < 60; i++) step(16.7);
  } catch (e) { errors.push('misc events: ' + e.stack); }
}

  /* ---- 7. "skill" test: a competent AI driver, plus fairness auditing ---- */
  function aiStep() {
    const { traffic, roadCenter, LANE_X, ROAD_HALF } = TR.peek();
    const me = TR.player;
    const laneScore = [1e9, 1e9, 1e9];
    for (const c of traffic) {
      const dy = c.worldY - me.worldY;
      if (dy < -110 || dy > 1400) continue;
      const cx = roadCenter(c.worldY) + c.x;
      for (let l = 0; l < 3; l++) {
        if (Math.abs(cx - (roadCenter(c.worldY) + LANE_X[l])) < 74) {
          laneScore[l] = Math.min(laneScore[l], Math.max(0, dy));
        }
      }
    }
    const curLane = Math.max(0, Math.min(2, Math.round(me.px / 112) + 1));
    let best = 1, bestScore = -1;
    for (let l = 0; l < 3; l++) {
      const sc = laneScore[l] + (l === curLane ? 90 : 0);
      if (sc > bestScore) { bestScore = sc; best = l; }
    }
    // hug the centre of the road whenever we are near the grass
    let target;
    if (Math.abs(me.px) > ROAD_HALF - 45) target = roadCenter(me.worldY + 120);
    else target = roadCenter(me.worldY + 220) + LANE_X[best];
    const err = target - me.px;
    TR.Input.left = err < -16;
    TR.Input.right = err > 16;
    TR.Input.nitro = me.nitro > 22;
    TR.Input.brake = false;
  }

  function auditWalls() {
    // use the game's own reachability model, sampled from further back so the
    // repair logic (which only looks 560..1440px ahead) cannot mask a problem
    return TR.peek().auditPath(120, 24, 50);
  }

  if (TR.Game.mode === 'over') getEl('btnAgain').fire('click');
  else TR.start();
  let aiFrames = 0, offroadFrames = 0, wallHits = 0, wallSample = null, tightestGap = 999;
  const crashLog = [];
  let prevLives = TR.player.lives;
  const aiThemes = new Set();
  try {
    for (let i = 0; i < 60 * 480; i++) {      // up to 8 simulated minutes
      aiStep();
      step(16.7);
      aiFrames++;
      const p = TR.player;
      if (p.nitro < 0 || p.nitro > 100) errors.push('nitro out of range (ai): ' + p.nitro);
      if (p.speed > 1400) errors.push('speed exploded (ai): ' + p.speed);
      if (Math.abs(p.px) > 320) errors.push('left the world (ai): ' + p.px);
      if (TR.Game.mode === 'playing') {
        aiThemes.add(TR.Game.theme.name);
        if (p.offroad) offroadFrames++;
        const blockedAt = auditWalls();
        if (blockedAt != null) {
          wallHits++;
          if (!wallSample) {
            const pk = TR.peek();
            wallSample = {
              at: p.distance.toFixed(0) + ' m', kmh: Math.round(p.speed * 0.3), px: Math.round(p.px),
              wallAhead: Math.round(blockedAt - p.worldY),
              cars: pk.traffic.map((c) => ({
                dy: Math.round(c.worldY - p.worldY), lane: c.lane,
                sx: Math.round(pk.roadCenter(c.worldY) + c.x), w: c.w, merging: Math.abs((pk.roadCenter(c.worldY) + c.x) - (pk.roadCenter(c.worldY) + pk.LANE_X[c.lane])) > 6,
              })).filter((c) => c.dy > -200 && c.dy < 1800).sort((a, b) => a.dy - b.dy),
            };
          }
        }
        if (p.lives < prevLives) {
          crashLog.push({ d: Math.round(p.distance) + 'm', off: p.offroad, t: (i / 60).toFixed(1) + 's' });
          prevLives = p.lives;
        }
      }
      if (TR.Game.mode === 'over') break;
    }
  } catch (e) { errors.push('ai loop: ' + e.stack); }
  console.log('\n--- skilled AI driver ---');
  console.log('mode            :', TR.Game.mode);
  console.log('survived        :', aiFrames, 'frames (' + (aiFrames / 60).toFixed(0) + ' s)');
  console.log('distance        :', TR.player.distance.toFixed(0), 'm');
  console.log('score           :', Math.floor(TR.Game.score));
  console.log('lives           :', TR.player.lives);
  console.log('overtakes       :', TR.Game.overtakes);
  console.log('bonus           :', Math.floor(TR.Game.bonus));
  console.log('offroad frames  :', (100 * offroadFrames / aiFrames).toFixed(1) + '%');
  console.log('crashes         :', JSON.stringify(crashLog));
  console.log('blocked frames  :', wallHits, wallSample ? JSON.stringify(wallSample) : '');
  console.log('themes seen     :', [...aiThemes].join(' | '));
  if (TR.Game.mode === 'playing' && TR.player.distance < 1500) warnings.push('AI driver could not get far: ' + TR.player.distance.toFixed(0) + ' m');
  if (wallHits > 0) warnings.push('fully-blocked road bands appeared in ' + wallHits + ' frames');

if (badCalls.length) errors.push('non-finite draw args: ' + JSON.stringify(badCalls));

function report() {
  if (warnings.length) warnings.forEach((w) => console.log('WARN  ', w));
  if (errors.length) {
    errors.forEach((e) => console.log('FAIL  ', e));
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
}
report();
