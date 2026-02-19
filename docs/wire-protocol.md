# Wire Protocol

This document specifies the WebSocket message format between a `node-game-server` instance and its clients. It covers the JSON codec (`JSONEnvelopeCodec`); the binary Cap'n Proto codec uses the same logical structure but in a binary envelope.

All examples use JSON. Infrastructure messages (sync handshake, ack) are **always** raw JSON regardless of which codec is configured.

## Transport

- **Protocol**: WebSocket (`ws://` or `wss://`)
- **Encoding**: UTF-8 JSON (JSON codec) or binary (Cap'n Proto codec)
- **Framing**: Each WebSocket message is one complete protocol message
- **Compression**: The server enables `permessage-deflate` with a 512-byte threshold — messages smaller than 512 bytes are sent uncompressed, larger ones are deflated. Clients should accept the `permessage-deflate` extension during the WebSocket handshake.

## Connection Lifecycle

```
┌────────┐                           ┌────────┐
│ Client │                           │ Server │
└───┬────┘                           └───┬────┘
    │         TCP + WS handshake         │
    │◄──────────────────────────────────►│
    │                                    │
    │   1. sync_request  { t }           │
    │◄───────────────────────────────────│
    │                                    │
    │   2. sync_response { t, ct }       │
    │───────────────────────────────────►│
    │                                    │
    │   3. sync_result { rtt, playerId,  │
    │      serverFrame, serverTimeMs,    │
    │      tickRateHz }                  │
    │◄───────────────────────────────────│
    │                                    │
    │   4. snapshot (initial state)      │
    │◄───────────────────────────────────│
    │                                    │
    │   5. game_event CONNECT            │
    │◄───────────────────────────────────│  (broadcast to all clients)
    │                                    │
    │        ── normal play ──           │
    │   snapshots, deltas, game_events   │
    │◄───────────────────────────────────│
    │   actions, acks                    │
    │───────────────────────────────────►│
    │                                    │
    │   6. game_event DISCONNECT         │
    │◄───────────────────────────────────│  (broadcast to all clients)
    │         connection closed           │
    └────────────────────────────────────┘
```

**Key rules:**
- No game data (snapshots, deltas, game events) is sent until the sync handshake completes.
- The server assigns the `playerId` — clients cannot choose their own.
- If the client doesn't complete the handshake within `syncTimeoutMs` (default: 5 000 ms), the server closes the connection with code **4001**.

## Clock Synchronization Handshake

Three infrastructure messages exchanged before any game data flows.

### 1. `sync_request` (Server -> Client)

```json
{ "kind": "sync_request", "t": 1700000000000 }
```

| Field | Type   | Description              |
|-------|--------|--------------------------|
| `kind`| string | Always `"sync_request"`  |
| `t`   | number | Server timestamp (ms since epoch) |

### 2. `sync_response` (Client -> Server)

```json
{ "kind": "sync_response", "t": 1700000000000, "ct": 1700000000005 }
```

| Field | Type   | Description              |
|-------|--------|--------------------------|
| `kind`| string | Always `"sync_response"` |
| `t`   | number | Echoed server timestamp (must match exactly) |
| `ct`  | number | Client timestamp at time of reply (ms since epoch) |

### 3. `sync_result` (Server -> Client)

```json
{
  "kind": "sync_result",
  "rtt": 12,
  "playerId": "a1b2c3d4-...",
  "serverFrame": 450,
  "serverTimeMs": 1700000000012,
  "tickRateHz": 30
}
```

| Field         | Type   | Description |
|---------------|--------|-------------|
| `kind`        | string | Always `"sync_result"` |
| `rtt`         | number | Round-trip time in ms (`Date.now() - t`) |
| `playerId`    | string | Server-assigned unique player identity (UUID) |
| `serverFrame` | number | Current server frame at time of sync |
| `serverTimeMs`| number | Server timestamp at time of sync |
| `tickRateHz`  | number | Server tick rate (e.g. `30`) |

The client can compute its clock offset as: `serverTimeMs - (clientNow - rtt / 2)`.

## Server -> Client Messages

After the handshake, the server sends three kinds of game messages.

### `snapshot` — Full State

Sent as the first message after sync, then periodically every `snapshotInterval` frames (default: 20). Also sent at any time when the server determines a client has fallen too far behind or has no valid ack — so clients should always be prepared to receive a snapshot, not just at fixed intervals. Contains the complete authoritative state.

```json
{
  "kind": "snapshot",
  "frame": 60,
  "timeMs": 2000.0,
  "state": {
    "frame": 60,
    "timeMs": 2000.0,
    "players": [
      { "id": "a1b2c3d4", "x": 10, "y": 20 }
    ]
  }
}
```

| Field   | Type   | Description |
|---------|--------|-------------|
| `kind`  | string | Always `"snapshot"` |
| `frame` | number | Server frame number (uint32) |
| `timeMs`| number | Accumulated game time in ms |
| `state` | object | Complete game state — structure is game-specific |

**Client behavior:** Replace the entire local state with `msg.state`.

### `delta` — Incremental Update

Sent on non-snapshot frames. Contains only what changed since `baseFrame`.

```json
{
  "kind": "delta",
  "frame": 61,
  "baseFrame": 60,
  "timeMs": 2033.3,
  "added": [{ "id": "b2c3d4e5", "x": 0, "y": 0 }],
  "removed": ["c3d4e5f6"],
  "updated": [{ "id": "a1b2c3d4", "x": 15, "y": 25 }],
  "score": 42,
  "projectiles": [{ "id": "r1", "x": 100, "y": 50 }]
}
```

| Field       | Type     | Description |
|-------------|----------|-------------|
| `kind`      | string   | Always `"delta"` |
| `frame`     | number   | Target frame number (uint32) |
| `baseFrame` | number   | Frame this delta is relative to (uint32) |
| `timeMs`    | number   | Accumulated game time in ms |

The remaining fields depend on the game logic's `diff()` implementation. The default `diffState()` produces:

#### Player changes

| Field     | Type       | Description |
|-----------|------------|-------------|
| `added`   | object[]   | Players that are new since `baseFrame` |
| `removed` | string[]   | Player IDs that were removed since `baseFrame` |
| `updated` | object[]   | Players whose fields changed (full player object with `id`) |

#### Non-player state fields

Any other top-level state field that changed between `baseFrame` and `frame` is included directly in the delta message. Changes are detected via reference equality (`prev[key] !== next[key]`), which is safe because `tick()` must return new references for mutated data (immutability contract). The entire new value is sent — no deep diffing.

For example, if the game state has `score` and `projectiles` fields and both changed, they appear as top-level keys in the delta alongside `added`/`removed`/`updated`.

#### Removed state fields

If a top-level key existed in the previous state but is absent in the new state, the delta includes a `_removedKeys` array listing the removed key names:

```json
{
  "kind": "delta",
  "frame": 62,
  "baseFrame": 61,
  "timeMs": 2066.6,
  "added": [],
  "removed": [],
  "updated": [],
  "_removedKeys": ["powerUp"]
}
```

| Field          | Type     | Description |
|----------------|----------|-------------|
| `_removedKeys` | string[] | Top-level state keys that were removed (only present when non-empty) |

#### Reserved field names

Top-level state fields should **not** use any of the following names, as they collide with the delta protocol:

`kind`, `frame`, `baseFrame`, `timeMs`, `added`, `removed`, `updated`, `_removedKeys`

**Client behavior:**
1. Verify `msg.baseFrame === localState.frame`. If it doesn't match, **skip the delta** — the next snapshot will resync.
2. Apply the delta to produce the new state:
   - Remove players whose `id` is in `removed`
   - Append players in `added`
   - Merge fields from `updated` into matching players (by `id`)
   - Merge any other non-protocol keys from the delta into the state (these are changed game fields)
   - Delete any keys listed in `_removedKeys` from the state
3. Set `localState.frame = msg.frame` and `localState.timeMs = msg.timeMs`.

### `game_event` — Lifecycle / Meta Events

Discrete events for connection lifecycle and game-level signals. Broadcast to **all** connected clients (never skipped by backpressure).

```json
{
  "kind": "game_event",
  "type": "CONNECT",
  "playerId": "a1b2c3d4"
}
```

```json
{
  "kind": "game_event",
  "type": "DISCONNECT",
  "playerId": "a1b2c3d4"
}
```

| Field      | Type   | Description |
|------------|--------|-------------|
| `kind`     | string | Always `"game_event"` |
| `type`     | string | Event type (`CONNECT`, `DISCONNECT`, or custom) |
| `playerId` | string | Player associated with the event |

The default game event types are `CONNECT` and `DISCONNECT`. Game logic can extend this set via `gameEventTypes()` (e.g. adding `JOIN`, `GAME_START`).

**Client behavior:** Handle as application-level notifications. These do not replace or modify the game state directly — state changes caused by game events arrive via the next snapshot or delta.

## Client -> Server Messages

### Action — Gameplay Input

Actions are the primary way clients send gameplay input. They go through the codec for encoding/decoding.

```json
{
  "type": "MOVE",
  "clientSeq": 1,
  "x": 10,
  "y": 20
}
```

With optional frame targeting:

```json
{
  "type": "MOVE",
  "clientSeq": 2,
  "targetFrame": 42,
  "x": 15,
  "y": 25
}
```

| Field         | Type   | Required | Description |
|---------------|--------|----------|-------------|
| `type`        | string | yes      | Action type (game-specific, e.g. `"MOVE"`, `"FIRE"`) |
| `clientSeq`   | number | no       | Client-side monotonic sequence number |
| `targetFrame` | number | no       | Server frame the client intends this action for |
| `...`         | any    | no       | Additional game-specific payload fields |

**Important:**
- The `playerId` field, if present, is **ignored** — the server stamps the authoritative `playerId` from the connection.
- Clients **should not** send actions with a `type` matching a game event type (`CONNECT`, `DISCONNECT`, etc.) — those are server-managed. The server does not reject them, but routes them into the game-event pipeline instead of the normal action pipeline, which will produce unintended behavior.
- `targetFrame` enables frame-addressed input for rollback netcode. If the target frame is in the past but within the rollback window, the server will rollback and replay. If omitted, the action applies to the current frame.
- The server throttles actions per player per tick (`maxActionsPerPlayerPerTick`, default: 3) and globally (`maxActionsPerTick`, default: 2048).

### `ack` — Frame Acknowledgment

Infrastructure message (raw JSON, not codec-encoded). Reports the last frame the client has fully processed.

```json
{ "kind": "ack", "frame": 60 }
```

| Field   | Type   | Description |
|---------|--------|-------------|
| `kind`  | string | Always `"ack"` |
| `frame` | number | Last fully processed frame number (non-negative integer) |

**Server behavior:**
- Only advances `lastAckedFrame` forward (out-of-order acks are ignored).
- Used to tailor per-client updates: caught-up clients get shared deltas, behind clients get custom deltas from their acked state, and clients too far behind get full snapshots.

**Client behavior:**
- Send an ack after processing each snapshot or delta.
- The reference client does this automatically when `autoAck: true` (default).

## WebSocket Close Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 4001 | Sync timeout | Client did not complete the sync handshake within `syncTimeoutMs` |
| 4002 | Backpressure | Client's send buffer exceeded limits for too long (`maxDroppedFrames` consecutive skipped frames) |

## Message Flow Summary

```
Direction    Message          When                          Codec?
─────────    ───────          ────                          ──────
S → C        sync_request     On connection                 No (raw JSON)
C → S        sync_response    Reply to sync_request         No (raw JSON)
S → C        sync_result      After valid sync_response     No (raw JSON)
S → C        snapshot         After sync + every N frames   Yes
S → C        delta            Non-snapshot frames           Yes
S → C        game_event       On CONNECT/DISCONNECT/custom  Yes
C → S        action           Gameplay input                Yes
C → S        ack              After processing state        No (raw JSON)
```

## Reconnection

There is no session resumption. Each new WebSocket connection starts a fresh sync handshake, and the server assigns a **new `playerId`** every time. The previous player identity is not preserved — from the server's perspective, a reconnecting client is indistinguishable from a brand-new client.

Clients that implement auto-reconnect should:

1. Reset all local state (`playerId`, game state, `clientSeq`) before opening the new connection.
2. Expect a `DISCONNECT` game event for the old `playerId` (broadcast to other clients) followed by a `CONNECT` for the new one.
3. Re-derive any client-side state (e.g. which player "is me") from the new `playerId` in `sync_result`.

The reference client resets `clientSeq` to 0, clears `state` and `playerId`, and re-runs the full handshake on each reconnection attempt. See [`examples/reference-client/GameClient.js`](../examples/reference-client/GameClient.js).

## Implementing a Client

A minimal client implementation needs to:

1. **Open a WebSocket** to the server URL.
2. **Handle the sync handshake**: receive `sync_request`, reply with `sync_response` (echo `t`, add `ct`), receive `sync_result`.
3. **Receive the initial snapshot** and store it as the current state.
4. **Apply subsequent messages**:
   - `snapshot` -> replace state entirely (can arrive at any time, not just periodic intervals)
   - `delta` -> verify `baseFrame === localState.frame`, then apply player changes (`added`/`removed`/`updated`), merge changed non-protocol fields, delete keys listed in `_removedKeys`, update `frame`/`timeMs`. If `baseFrame` doesn't match, skip the delta and wait for the next snapshot.
   - `game_event` -> handle as notifications (always delivered, even during backpressure)
5. **Send acks** after processing each state update (frame number from the snapshot or the reconciled delta).
6. **Send actions** as JSON with a `type` field and monotonically increasing `clientSeq`.

See [`examples/reference-client/GameClient.js`](../examples/reference-client/GameClient.js) for a complete working implementation.
