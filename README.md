# node-game-client

Browser client library for connecting to [node-game-server](https://github.com/) instances. Provides WebSocket connection management, state interpolation, input handling, client-side prediction, and an optional Web Worker rendering pipeline.

Pure JavaScript with ES modules, bundled with esbuild. Part of the node-game stack:

- **NodeGameServer** -- authoritative game server with tick-based simulation
- **NodeGameClient** (this repo) -- browser client library
- **NodeGameInputManager** -- intent-based input abstraction (keyboard/gamepad)
- **NodeGameECS** -- lightweight Entity Component System

## Install

```bash
npm install node-game-client
```

Requires Node.js >= 22 for building. The bundled output targets ES2022 browsers.

## Quick Start

```js
import { Connection, GameLoop, StateStore, lerpEntity } from "node-game-client";

const connection = new Connection("ws://localhost:8080", {
  token: crypto.randomUUID(),
});

await connection.connect();

const stateStore = new StateStore({ connection });

const loop = new GameLoop({
  connection,
  update(sendAction) {
    // Called at server tick rate (e.g. 30 Hz)
    sendAction({ type: "MOVE", dx: 1, dy: 0 });
  },
  render(state, alpha, timestamp) {
    // Called every rAF frame
    const interp = stateStore.getInterpolatedState();
    if (!interp) return;
    const { prev, next, alpha: t } = interp;
    // Interpolate players between prev and next states
    for (const np of next.players ?? []) {
      const pp = prev.players?.find((p) => p.id === np.id) ?? np;
      const player = lerpEntity(pp, np, t, ["x", "y"]);
      // draw player...
    }
  },
});

loop.start();
```

See [`examples/browser-game/`](examples/browser-game/) for a complete working example with canvas rendering and IntentManager input.

## API

### Connection

Core networking class. Handles the sync handshake, snapshot/delta reconciliation, action submission, ack tracking, and optional auto-reconnection.

```js
const conn = new Connection(url, {
  token,                  // Required -- session token
  autoReconnect: false,   // Reconnect on drop
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5,
  autoAck: true,          // Auto-ack after each state update
  applyDelta: null,       // Custom delta function
  world: null,            // ECS World for ECS-aware reconciliation
});

await conn.connect();             // Resolves after sync + first snapshot
conn.sendAction({ type: "MOVE" });
conn.disconnect();                // Sends logout, closes cleanly
```

**Properties:** `state`, `playerId`, `resumed`, `rtt`, `clockOffset`, `serverFrame`, `tickRateHz`, `connected`, `world`

**Observers** (return unsubscribe functions): `onStateChange(cb)`, `onGameEvent(cb)`, `onConnect(cb)`, `onDisconnect(cb)`, `onError(cb)`

Supports both plain-state and ECS wire formats. Pass a `world` (from `node-game-ecs`) to enable ECS-aware reconciliation via `world.applySnapshot()` and `world.applyDiff()`.

### GameLoop

Fixed-timestep updates decoupled from variable-rate rendering via `requestAnimationFrame`.

```js
const loop = new GameLoop({
  connection,
  update(sendAction) { /* fixed tick rate */ },
  render(state, alpha, timestamp) { /* every rAF frame */ },
  tickRateHz, // Optional, defaults to connection.tickRateHz
});

loop.start();
loop.stop();
loop.pause();
loop.resume();
loop.fps; // EMA-smoothed frames per second
```

### StateStore

Ring buffer of recent server states for smooth interpolation between ticks.

```js
const store = new StateStore({
  connection,
  capacity,              // Default: tickRateHz frames
  interpolationDelayMs,  // Default: 3 * (1000 / tickRateHz)
});

const { prev, next, alpha } = store.getInterpolatedState();
store.serverTimeMsEstimate; // Estimated current game time
store.renderTimeMs;         // serverTimeMsEstimate - interpolationDelayMs
store.dispose();
```

### Interpolation

```js
import { lerpEntity, lerpComponents } from "node-game-client";

// Plain-state: interpolate flat entity fields
const player = lerpEntity(prev, next, alpha, ["x", "y"]);

// ECS: interpolate within named components
const entity = lerpComponents(prev, next, alpha, {
  Position: ["x", "y"],
});
```

### PredictionManager

Client-side prediction with server reconciliation. Supports both plain-state and ECS modes.

```js
const prediction = new PredictionManager({
  connection,
  predict(state, action) {
    // Return new predicted state (plain mode)
    return { ...state, x: state.x + action.dx };
  },
  onMisprediction(serverState, predictedState) { /* optional */ },
  capacity: 64,
  world: null, // ECS World for ECS mode
});

prediction.sendAction({ type: "MOVE", dx: 1 });
prediction.predictedState; // Current predicted state
prediction.pendingCount;   // Unacked action count
prediction.dispose();
```

In ECS mode, pass a `world` and `predict(world, action)` mutates the World in place. On reconciliation, the World is restored to server state and pending actions are re-applied.

### InputManager

Aggregates keyboard, pointer, gamepad, and touch into a unified `poll()` result.

```js
const input = new InputManager({
  target: canvas,
  keyboard: true,
  pointer: true,
  gamepad: false,
  touch: false,
  gamepadDeadZone: 0.1,
});

const { keys, justPressed, justReleased, pointer, gamepads, touches } = input.poll();
input.dispose();
```

### WorkerBridge + createRenderWorker

Off-main-thread rendering via OffscreenCanvas.

```js
// Main thread
const bridge = new WorkerBridge({ worker, canvas, connection });
bridge.start();

// Worker
import { createRenderWorker } from "node-game-client";
createRenderWorker({
  onInit(canvas) { /* set up GL/2D context */ },
  onState(state) { /* render frame */ },
  onResize(w, h) { /* handle resize */ },
});
```

### AudioBridge

Manages AudioContext lifecycle with auto-resume on user interaction.

```js
const audio = new AudioBridge({
  connection,
  handler: {
    onStateChange(state, ctx) { /* play sounds based on state */ },
    onGameEvent(event, ctx) { /* play event sounds */ },
  },
});
audio.start();
```

## Build

```bash
npm run build
```

Produces ESM (`dist/node-game-client.js`) and IIFE (`dist/node-game-client.iife.js`) bundles with source maps, plus TypeScript declarations in `dist/types/`.

## Test

```bash
npm test
```

Runs vitest with all tests in `test/`.

## Wire Protocol

See [docs/wire-protocol.md](docs/wire-protocol.md) for the complete WebSocket protocol specification including the sync handshake, snapshot/delta formats (plain-state and ECS), game events, session resume, and close codes.

## Examples

- **[`examples/browser-game/`](examples/browser-game/)** -- Full browser game with canvas rendering, interpolated movement, and IntentManager input. Run with `cd examples/browser-game && npm install && npm start`.
- **[`examples/reference-client/`](examples/reference-client/)** -- Node.js reference client using the `ws` package, with integration tests.

## License

See [LICENSE](LICENSE).
