# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser real-time game client library for connecting to `node-game-server` instances. Provides WebSocket connection management, state interpolation, input handling, client-side prediction, and an optional Web Worker rendering pipeline. Pure JavaScript with ES modules, bundled with esbuild.

Part of a four-project game stack:
- **NodeGameServer** (sibling) — authoritative game server with tick-based simulation
- **NodeGameClient** (this repo) — browser client library
- **NodeGameInputManager** (sibling) — intent-based input abstraction (keyboard/gamepad → MOVE_X, MOVE_Y)
- **NodeGameECS** (sibling) — lightweight Entity Component System for game logic

Requires Node.js >= 22.

## Commands

### Run tests

```bash
npm test
```

Runs `vitest run` — all tests in `test/`.

### Build

```bash
npm run build
```

Produces ESM + IIFE bundles in `dist/` and TypeScript declarations. **Must rebuild after source changes** for the browser-game example to pick up updates (it serves from `dist/`).

### Run browser-game example

```bash
cd examples/browser-game && npm install && npm start
```

Starts the game server on `ws://localhost:8080` and HTTP server on `http://localhost:3000`.

### Run reference-client tests

```bash
cd examples/reference-client && npm install && npm test
```

Uses Node's built-in test runner (`node --test`). Requires `node-game-server` at sibling path.

## Architecture

### Wire Protocol (docs/wire-protocol.md)

WebSocket-based protocol. The server sends sync and game event messages as **JSON text frames**, but snapshots and deltas as **binary frames** (Buffer from JSONEnvelopeCodec). The client handles both via `ws.binaryType = "arraybuffer"` and TextDecoder.

- **Sync handshake:** `sync_request` → `sync_response` (with `token`) → `sync_result` (with `resumed` flag) — establishes playerId, calculates RTT/clock offset
- **State delivery:** `snapshot` (full state) and `delta` (incremental updates keyed by `baseFrame`)
- **Client messages:** `action` (with monotonic `clientSeq`), `ack` (frame acknowledgment), `logout` (intentional disconnect)
- **Game events:** CONNECT, DISCONNECT, SUSPEND, RESUME, and custom events
- **Session resume:** reconnect with same token to resume a suspended session (same playerId)
- **Close codes:** 4001 (sync timeout), 4002 (backpressure), 4003 (missing token), 4004 (auth failed), 4005 (duplicate connection)
- **connect() resolves** after both sync_result AND the first snapshot are received

### Protocol Reserved Keys

These field names are reserved by the wire protocol and must not be used in custom game state:
`kind`, `frame`, `baseFrame`, `timeMs`, `added`, `removed`, `updated`, `_removedKeys`, `entities`

### State Structure

**Plain-state mode:** Game state lives in `client.state` with `frame`, `timeMs`, and `players` (array with `id` field). Non-protocol fields from snapshots/deltas are merged directly into state.

**ECS mode:** Game state lives in `client.state` with `frame`, `timeMs`, and `entities` (array with `id` and `components` fields). Each entity has `{ id: number, components: { ComponentName: { ...fields } } }`.

`timeMs` is game elapsed time (starts at 0), **not** wall-clock time. The client auto-detects ECS vs plain-state format from the server messages.

### Source Modules

#### `src/net/Connection.js` — WebSocket Connection

Core networking class. Handles sync handshake, snapshot/delta reconciliation, action submission with auto-incrementing `clientSeq`, ack tracking, and optional auto-reconnection. Supports both plain-state and ECS wire formats.

- Constructor: `new Connection(url, { token, autoReconnect, reconnectDelayMs, maxReconnectAttempts, autoAck, applyDelta, world })`
- `connect()` → `Promise<void>` — resolves after sync + first snapshot
- `sendAction(action)` — sends with monotonic `clientSeq`
- `disconnect()` — sends `logout` message before closing (session destroy vs suspend)
- Observer methods: `onStateChange`, `onGameEvent`, `onConnect`, `onDisconnect`, `onError` — all return unsubscribe functions
- Properties: `state`, `playerId`, `resumed`, `rtt`, `clockOffset`, `tickRateHz`, `connected`, `world`
- **ECS mode:** Pass `world` (a `node-game-ecs` World instance) to enable ECS-aware reconciliation. Snapshots are applied via `world.applySnapshot()`, deltas via `world.applyDiff()`. Without `world`, ECS deltas are auto-detected and applied via `defaultApplyECSDelta`.
- **Delta resolution order:** `world` → custom `applyDelta` → auto-detect (ECS `entities` field → plain-state `defaultApplyDelta`)

#### `src/loop/GameLoop.js` — rAF Game Loop

Fixed-timestep updates decoupled from variable-rate rendering.

- Constructor: `new GameLoop({ connection, update, render, tickRateHz })`
- `update(sendAction)` called at server tick rate (e.g. 30Hz)
- `render(state, alpha, timestamp)` called every rAF frame
- Methods: `start()`, `stop()`, `pause()`, `resume()`
- EMA-smoothed `fps` getter

#### `src/state/StateStore.js` — Interpolation Buffer

Ring buffer of recent server states for smooth rendering between ticks.

- Constructor: `new StateStore({ connection, capacity, interpolationDelayMs })`
- Default capacity: `tickRateHz` frames; default delay: `3 * (1000 / tickRateHz)`
- `getInterpolatedState(renderTimeMs?)` → `{ prev, next, alpha }` — finds bracketing states and computes interpolation factor
- `serverTimeMsEstimate` — estimated current game time derived from last received state's `timeMs` + elapsed `performance.now()` (same time base as `state.timeMs`)
- `renderTimeMs` = `serverTimeMsEstimate - interpolationDelayMs`

#### `src/state/interpolation.js` — Lerp Utilities

- `lerpEntity(prev, next, alpha, fields)` — interpolates specified numeric fields on flat entity objects, takes non-numeric fields from `next`.
- `lerpComponents(prev, next, alpha, componentFields)` — ECS-aware interpolation. Interpolates specified fields within named components of ECS entities. `componentFields` is `{ Position: ["x", "y"] }`. Components not listed snap to `next`.

#### `src/input/InputManager.js` — Input Aggregator

Aggregates keyboard, pointer, gamepad, and touch devices into a unified `poll()` result.

- Constructor: `new InputManager({ target, keyboard, pointer, gamepad, touch, gamepadDeadZone })`
- `poll()` → `{ keys, justPressed, justReleased, pointer, gamepads, touches }`
- `dispose()` — detach all devices

Individual devices: `KeyboardDevice`, `PointerDevice`, `GamepadDevice`, `TouchDevice` — each with `poll()`, `attach(target)`, `detach()`, `enabled`.

#### `src/prediction/PredictionManager.js` — Client-Side Prediction

Predicts state locally and reconciles with server authoritative state. Supports both plain-state and ECS modes.

- Constructor: `new PredictionManager({ connection, predict, onMisprediction, capacity, world })`
- **Plain mode:** `predict(state, action) → newState` callback applies action to a plain state object.
- **ECS mode:** Pass `world` (a `node-game-ecs` World instance). `predict(world, action)` mutates the World in place. On reconciliation, the World is restored to server authoritative state via `world.applySnapshot()` and pending actions are re-applied via `predict()`.
- `sendAction(action)` — sends with prediction and frame targeting
- `predictedState` getter (ECS mode: serialized World with frame/timeMs), `pendingCount` getter, `world` getter

#### `src/prediction/actionBuffer.js` — Action Ring Buffer

`ActionBuffer(capacity)` — stores unacked actions with `push`, `discardThrough(frame)`, `entries()`, `clear()`.

#### `src/worker/WorkerBridge.js` — OffscreenCanvas Worker

Transfers canvas to a Web Worker for off-main-thread rendering.

- `WorkerBridge.isSupported()` — checks OffscreenCanvas availability
- Methods: `start()`, `stop()`, `resize(w, h)`, `postMessage()`, `onMessage()`, `dispose()`

#### `src/worker/renderWorkerEntry.js` — Worker Entry

`createRenderWorker(handlers)` — message dispatcher for the worker side. Handlers: `onInit(canvas)`, `onState(state)`, `onStart()`, `onStop()`, `onResize(w, h)`, `onMessage(data)`.

#### `src/worker/AudioBridge.js` — AudioContext Manager

Manages AudioContext lifecycle with auto-resume on user interaction.

- Constructor: `new AudioBridge({ connection, handler, resumeEvents, target })`
- Handler has `onStateChange?(state, ctx)` and `onGameEvent?(event, ctx)`
- Methods: `start()`, `stop()`, `dispose()`

### Examples

#### `examples/reference-client/`

Node.js reference client using the `ws` package. Standalone `GameClient.js` mirrors the browser Connection class. Integration tests with `node --test`.

#### `examples/browser-game/`

Full browser game with canvas rendering, interpolated movement, and IntentManager input. Server uses NodeGameECS (`World`, `defineComponent`) with `Player` and `Position` components. The `toState()` helper queries ECS entities and builds the plain `{ frame, timeMs, players }` wire format. HTTP server serves client bundles from `dist/` directories of sibling projects.

## Conventions

- ES modules (`"type": "module"`)
- JSDoc for public API documentation
- camelCase for methods/variables, CONSTANT_CASE for module-level Sets/constants
- Private methods prefixed with `_`
- Observer pattern: subscription methods return unsubscribe functions
- Listener errors silently swallowed in `_fire`
- Tests use vitest with MockWebSocket helper
- Guard clauses on `ws.readyState` before sending messages
- State immutability: new state objects created via spread operator on each update
