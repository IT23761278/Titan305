# 🏁 Titan Racer

An endless arcade **highway racer** that runs in the browser — vanilla JavaScript, Canvas 2D, **zero dependencies, zero build step**. Open `index.html` and drive.

**[▶ Play it here](https://it23761278.github.io/Titan305/)** — or just open `index.html` locally.

![portrait 9:16 arcade racer](https://img.shields.io/badge/platform-desktop%20%2B%20mobile-4d7cff)

---

## The game

You are on an endless highway that never stops changing. Weave through traffic that
drives at its own pace, chain overtakes to build a combo multiplier, and burn **nitro**
to squeeze past the gaps. The world rolls from bright day, through a sunset, into
night, and back around again — every 1400 metres.

You get **3 lives**. Three crashes and the race is over.

### Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Steer | `←` `→` or `A` `D` | **drag anywhere** on the road, or the ◀ ▶ pads |
| Nitro boost | `Space` (hold) | **NITRO** button (hold) |
| Brake | `↓` or `S` | **BRAKE** button |
| Pause | `P` / `Esc` | ⏸ button (top) |
| Mute | `M` | 🔊 button (top) |

> Steering by dragging is the smoothest option on a phone — the pads are there if you
> prefer buttons.

### Scoring

| Action | Points |
| --- | --- |
| Distance | 1 per metre |
| Overtake | `20 × combo` (combo builds up to ×9) |
| Near miss | `40 × combo` |

The combo decays 3.4 s after your last overtake, and a crash resets it. Nitro refills
when you stop boosting. Your best score is kept in `localStorage`.

---

## Features

- **3 rolling environments** — day / sunset / night that cross-fade into each other
- **Procedural curved highway** — smooth multi-sine road bends that push your car wide
- **Live traffic** — sedans, sport cars and slow trucks, with lane changes of their own
- **Nitro with exhaust flames**, headlight cones at night, speed lines at top speed
- **Particles everywhere** — tyre smoke, dust when you dip onto the grass, crash
  fireballs, tyre marks left on the tarmac
- **Arcade audio built from scratch** with the Web Audio API — a two-oscillator engine
  whose pitch follows your speed, filtered road noise, whooshes, coin blips and crashes
  (no audio files)
- **Fair-by-construction traffic** — spawns are rejected if they would ever close every
  lane, and a reachability solver checks that a gap is still drivable; cars that block
  the road merge out of the way (see `corridorOk`, `auditPath`, `repairCorridor`)
- **Fully responsive 9:16 portrait stage** — fits any screen, mouse, touch or keyboard
- Pause / mute, countdown start, live HUD, and an end-of-race stats screen with a
  stored personal best

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup: canvas, menus, HUD buttons, touch controls |
| `style.css` | Layout, the 9:16 stage, overlays and panels |
| `game.js` | The whole game, in nine clearly-labelled sections |
| `tools/headless-test.js` | Node smoke test / traffic-fairness audit (dev only) |

## Running it

```bash
# simplest
open index.html            # or just double-click it

# or serve it
python3 -m http.server 8000
# -> http://localhost:8000
```

## Tests

There is no browser automation here, so `game.js` is exercised headlessly instead: the
test stubs `document`, Canvas 2D, Web Audio and `requestAnimationFrame`, runs the real
game loop, drives it with a pseudo-AI driver, and audits that

- nothing throws across ~30 000 simulated frames,
- lives / nitro / speed / position stay in range,
- restarting really resets state,
- no draw call ever receives `NaN` or `Infinity`,
- and **a passable gap always exists** in the traffic ahead.

```bash
node tools/headless-test.js
```

## Tech notes

- Single `game.js` IIFE, no modules, no bundler, no external JS.
- Fixed 60 Hz physics step decoupled from rendering (`while (acc >= STEP)`).
- Logical 540 × 960 canvas scaled to the device pixel ratio, so it is crisp on retina
  screens and cheap on phones.
- `window.TitanRacer` is exposed for debugging — e.g. `TitanRacer.player.speed`,
  `TitanRacer.peek()`, `TitanRacer.start()`.
- Only external request is the Orbitron webfont; the game falls back to the system
  font stack offline.

## License

MIT — do whatever you like with it.
