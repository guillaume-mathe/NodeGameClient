# PLAN.md — Browser Game Client Library

## Goal

An npm library (`node-game-client`) for browser-based multiplayer games that connects to `node-game-server`. The library owns networking, the game loop, state interpolation, input capture, and worker orchestration. The consuming game only implements:

1. **Input → Actions** — map raw inputs to action objects (`{ type, ... }`)
2. **State → Pixels** — render the current server state and interpolate between frames

The library is game-agnostic. No game-specific logic leaks in.

---

## Dependency Audit

Current `package.json` dependencies and their relevance to a **browser** library:

| Package | Keep? | Reason |
|---------|-------|--------|
| `ws` | **Drop** | Browser has native `WebSocket`. Only needed for Node.js environments (tests). |
| `rxjs` | **Drop** | Heavy for a game client. Simple EventEmitter/callback pattern is sufficient and avoids the 30KB+ bundle cost. We can use native `EventTarget` or a tiny typed emitter. |
| `piscina` | **Drop** | Node-only worker pool. Browser uses `Worker` / `OffscreenCanvas` APIs. |
| `xxhash-wasm` | **Drop** | Server uses this for deduplication. Client has no need to hash outgoing state. |
| `capnp-ts` | **Drop (for now)** | JSON-only codec for now. Binary codec support can be added later behind the same interface. |

New dependencies to consider:

| Package | Purpose | Phase |
|---------|---------|-------|
| `esbuild` (dev) | Bundle ESM source into a single distributable (ESM + IIFE). Fast, zero-config. | 6 |
| `vitest` (dev) | Test runner with native ESM support, browser mode, and mocking. | 1 |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Game (user code)                      │
│  inputMapper(inputState) → actions[]                    │
│  render(state, interp, canvas)                          │
└────────┬──────────────────────────────────┬─────────────┘
         │ actions                          │ state + interp
┌────────▼──────────────────────────────────▼─────────────┐
│                  GameClient (this library)               │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌───────┐  ┌────────────┐  │
│  │ Network │  │ GameLoop │  │ Input │  │ StateStore │  │
│  │         │  │          │  │       │  │            │  │
│  │ connect │  │ rAF loop │  │ kbd   │  │ snapshots  │  │
│  │ sync    │  │ fixed dt │  │ mouse │  │ deltas     │  │
│  │ actions │  │ interp α │  │ pad   │  │ interpol.  │  │
│  │ ack     │  │          │  │ touch │  │            │  │
│  └─────────┘  └──────────┘  └───────┘  └────────────┘  │
│                                                         │
│  ┌────────────────┐  ┌───────────────────────────────┐  │
│  │ Prediction     │  │ WorkerBridge (optional)       │  │
│  │                │  │                               │  │
│  │ local apply    │  │ OffscreenCanvas handoff       │  │
│  │ rollback       │  │ compute offload               │  │
│  │ reconcile      │  │ audio worker entry point      │  │
│  └────────────────┘  └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Phases

### Phase 1 — Network Client (browser port)

Port `examples/reference-client/GameClient.js` to browser-native `WebSocket`. This is the foundation everything else builds on.

**Files:** `src/net/Connection.js`, `src/net/protocol.js`

**Work items:**
- [ ] Replace `import WebSocket from "ws"` with native `WebSocket` (detect `ws` at import time for Node test environments via an adapter)
- [ ] Implement the sync handshake (`sync_request` → `sync_response` → `sync_result`)
- [ ] Snapshot reception → full state replace
- [ ] Delta reception → validate `baseFrame`, apply default delta logic (added/removed/updated players, non-protocol field merge, `_removedKeys`)
- [ ] Allow custom `applyDelta` callback (same as reference client)
- [ ] Action sending with auto-incrementing `clientSeq`
- [ ] Ack sending (auto + manual modes)
- [ ] Reconnection with configurable delay, max attempts, full state reset
- [ ] Typed event callbacks with unsubscribe pattern: `onStateChange`, `onGameEvent`, `onConnect`, `onDisconnect`, `onError`
- [ ] Clock offset calculation: `serverTimeMs - (clientNow - rtt / 2)`
- [ ] Use `performance.now()` instead of `Date.now()` for timing (monotonic, sub-ms precision)
- [ ] Unit tests against a mock WebSocket (no real server needed for unit tests)

**Public API sketch:**
```js
const conn = new Connection("ws://localhost:8080", {
  autoReconnect: true,
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5,
  autoAck: true,
  applyDelta: null, // use default
});

await conn.connect();
conn.sendAction({ type: "MOVE", x: 10, y: 20 });
conn.onStateChange(state => { ... });
conn.disconnect();
```

---

### Phase 2 — Game Loop

A `requestAnimationFrame`-based loop with **fixed-timestep updates** and **variable-rate rendering**. The server is authoritative, so the client loop doesn't simulate — it polls input, sends actions, and renders the latest server state with interpolation.

**Files:** `src/loop/GameLoop.js`

**Work items:**
- [ ] `requestAnimationFrame` loop with accumulated time and fixed `dt` derived from server `tickRateHz`
- [ ] Each fixed step: poll input → call user's `inputMapper(inputState)` → send resulting actions
- [ ] Each render frame: compute interpolation alpha (`α = accumulator / fixedDt`) → call user's `render(state, α, ctx)`
- [ ] `start()`, `stop()`, `pause()`, `resume()` lifecycle
- [ ] Visibility API integration — pause loop when tab is hidden, resume when visible
- [ ] Expose timing stats: fps, frame time, server frame lag

**Public API sketch:**
```js
const loop = new GameLoop({
  connection,
  inputManager,
  tickRateHz: 30, // from sync_result, set automatically
  update(inputState, sendAction) {
    if (inputState.keys.has("ArrowRight")) {
      sendAction({ type: "MOVE", dx: 1 });
    }
  },
  render(state, alpha, timestamp) {
    // draw using state + alpha for interpolation
  },
});

loop.start();
```

---

### Phase 3 — Input System

Unified input capture across keyboard, mouse/pointer, gamepad, and touch. The library captures raw input state; the game maps it to actions.

**Files:** `src/input/InputManager.js`, `src/input/KeyboardDevice.js`, `src/input/PointerDevice.js`, `src/input/GamepadDevice.js`, `src/input/TouchDevice.js`

**Work items:**
- [ ] `InputManager` — aggregates all devices, exposes a single `InputState` snapshot each frame
- [ ] `KeyboardDevice` — tracks currently pressed keys as a `Set<string>`, plus `justPressed`/`justReleased` per frame
- [ ] `PointerDevice` — mouse/pointer position (relative to canvas), buttons, movement delta, pointer lock support
- [ ] `GamepadDevice` — polls `navigator.getGamepads()` each frame, exposes axes and buttons with configurable dead zones
- [ ] `TouchDevice` — active touches with positions, supports virtual joystick regions
- [ ] All devices can be enabled/disabled independently
- [ ] `dispose()` cleans up all event listeners

**InputState shape:**
```js
{
  keys: Set<string>,         // currently held keys
  justPressed: Set<string>,  // pressed this frame
  justReleased: Set<string>, // released this frame
  pointer: { x, y, dx, dy, buttons, locked },
  gamepads: [{ axes: [], buttons: [] }],
  touches: [{ id, x, y }],
}
```

---

### Phase 4 — State Store & Interpolation

Buffer recent server states to enable smooth rendering between server ticks.

**Files:** `src/state/StateStore.js`, `src/state/interpolation.js`

**Work items:**
- [ ] Ring buffer of the last N states (default: `tickRateHz` worth — 1 second)
- [ ] On each `onStateChange`, push the new state into the buffer with its `timeMs`
- [ ] `getInterpolatedState(renderTimeMs)` — find the two bracketing states and return `{ prev, next, alpha }` for the game to interpolate between
- [ ] Render time = estimated server time - interpolation delay (e.g., 2-3 ticks behind to absorb jitter)
- [ ] Estimated server time = `performance.now() + clockOffset`
- [ ] Expose `serverTimeMsEstimate` for the game to use
- [ ] Handle state gaps gracefully (snapshot after missed deltas — snap, don't interpolate)
- [ ] Provide helper: `lerpEntity(prev, next, alpha, fields)` — linear interpolation over specified numeric fields

---

### Phase 5 — Client-Side Prediction

Optimistic local application of actions so the player sees immediate feedback, with server reconciliation when authoritative state arrives. The server already supports `targetFrame` on actions for rollback netcode.

**Files:** `src/prediction/PredictionManager.js`, `src/prediction/actionBuffer.js`

**Work items:**
- [ ] **Action buffer** — ring buffer of unacknowledged actions, each tagged with `clientSeq` and `targetFrame`
- [ ] **Local apply** — when the game sends an action, immediately apply it to a local predicted state using a game-supplied `predict(state, action)` function
- [ ] **Server reconciliation** — when a server snapshot/delta arrives:
  1. Accept the server state as ground truth
  2. Discard all buffered actions with `targetFrame <= server.frame` (server has already processed them)
  3. Re-apply remaining unacknowledged actions on top of the server state to produce the new predicted state
- [ ] **Misprediction detection** — expose a callback `onMisprediction(serverState, predictedState)` so the game can decide how to handle visual corrections (snap vs. smooth blend)
- [ ] **Opt-in design** — prediction is disabled by default. Enabled by providing the `predict` function. When disabled, the library behaves as a pure server-authoritative client (render server state only).
- [ ] **Integration with StateStore** — predicted state feeds into interpolation; server state is still buffered for rollback
- [ ] **`targetFrame` calculation** — estimate the server frame that will process this action: `serverFrame + Math.round(rtt / 2 / frameDurationMs)`

**Public API sketch:**
```js
const client = new GameClient({
  connection,
  predict(state, action) {
    // Game-specific: apply action optimistically
    if (action.type === "MOVE") {
      const me = state.players.find(p => p.id === myId);
      return { ...state, players: state.players.map(p =>
        p.id === myId ? { ...p, x: p.x + action.dx } : p
      )};
    }
    return state;
  },
  onMisprediction(serverState, predictedState) {
    // Optional: smooth correction instead of snap
  },
});
```

---

### Phase 6 — Worker Bridge (optional module)

Offload rendering or computation to Web Workers. This is opt-in — games that don't need it ignore this module entirely.

**Files:** `src/worker/WorkerBridge.js`, `src/worker/render-worker-entry.js`, `src/worker/AudioBridge.js`

**Work items:**
- [ ] `WorkerBridge` — manages a single Web Worker for rendering via `OffscreenCanvas`
- [ ] Main thread transfers canvas control via `canvas.transferControlToOffscreen()`
- [ ] Message protocol between main thread and render worker: state updates, input state, lifecycle commands (start/stop/resize)
- [ ] Structured cloning for state transfer; consider `SharedArrayBuffer` for high-frequency data (input axes, positions) if `crossOriginIsolated` is available
- [ ] Fallback: if `OffscreenCanvas` is unsupported, render on main thread (no worker)
- [ ] Optional compute worker: game provides a module, library manages posting work and collecting results
- [ ] **AudioBridge** — threaded entry point for game audio:
  - Library creates an `AudioContext` and manages it in a worker (or AudioWorklet)
  - Forwards game events and state changes to the audio worker
  - Game provides the audio handler: `onGameEvent(event, audioCtx)`, `onStateChange(state, audioCtx)` — deciding *what* to play
  - Library handles *when* and *where* (scheduling, thread management, context resume on user gesture)
  - Pluggable: game passes an audio module/config, library wires it up. No audio code in the library itself beyond the bridge.

---

### Phase 7 — Build, Package & Distribute

Make it consumable as an npm package for browser bundlers and via CDN.

**Files:** `build.js` or `esbuild.config.js`, updated `package.json`

**Work items:**
- [ ] Bundle with esbuild: ESM output (`dist/node-game-client.js`) + IIFE output (`dist/node-game-client.iife.js`)
- [ ] Tree-shakeable: each module importable independently (`import { Connection } from "node-game-client"`)
- [ ] `package.json` fields: `exports`, `module`, `browser`, `types` (JSDoc-generated `.d.ts` via `tsc --declaration --emitDeclarationOnly`)
- [ ] No Node.js APIs in the main bundle — `ws` only in a test adapter
- [ ] Source maps included
- [ ] Minified production build

---

### Phase 8 — Example Game

A minimal playable example that proves the library works end-to-end. Not part of the library itself.

**Files:** `examples/browser-game/`

**Work items:**
- [ ] Simple 2D game (e.g., moving colored squares on a shared canvas)
- [ ] Shows: connect, capture WASD input, send MOVE actions, render players with interpolation
- [ ] Runs against a local `node-game-server` instance using the logic from `examples/reference-client/example-server.js`
- [ ] Serves via a static HTML file (no framework)

---

## Execution Order

Phases 1-4 are the sequential core — each builds on the previous. Phase 5 (Prediction) builds on Phases 1 + 4. Phase 6 (Workers/Audio) is independent and can be deferred. Phase 7 (Build) can begin incrementally after Phase 1. Phase 8 comes last as integration validation.

```
Phase 1 (Network) ──► Phase 2 (Loop) ──► Phase 3 (Input) ──► Phase 4 (State/Interp)
       │                                                              │
       │                                                    Phase 5 (Prediction)
       │                                                              │
       └──► Phase 7 (Build) ◄────────────────────────────────────────┘
                                                                      │
                                    Phase 6 (Workers/Audio) ──────────┘
                                                                      │
                                                          Phase 8 (Example)
```

---

## Decisions

1. **Binary codec** — JSON-only for now. The codec interface can be added later without breaking changes.
2. **Client-side prediction** — Yes, included as Phase 5. Opt-in via a game-supplied `predict(state, action)` function. Disabled by default.
3. **Audio** — The library provides a threaded `AudioBridge` (Phase 6) that forwards game events/state to a game-supplied audio handler. The game decides what plays; the library handles threading and `AudioContext` lifecycle.
