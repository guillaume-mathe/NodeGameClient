# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js real-time game client networking library for connecting to `node-game-server` instances. Implements the wire protocol for WebSocket communication, state synchronization, action submission, and reconnection. Pure JavaScript with ES modules, no build step.

Requires Node.js >= 22.

## Commands

### Run tests (reference client)

```bash
cd examples/reference-client && npm install && npm test
```

This runs `node --test reference-client.test.js` using Node's built-in test runner. Tests require the `node-game-server` package, which is resolved via `file:../../` (expects the server project at sibling path or root).

### Install dependencies

```bash
npm install
```

## Architecture

### Wire Protocol (docs/wire-protocol.md)

WebSocket-based protocol with:
- **Sync handshake:** `sync_request` → `sync_response` → `sync_result` (establishes playerId, calculates RTT/clock offset)
- **State delivery:** `snapshot` (full state) and `delta` (incremental updates keyed by `baseFrame`)
- **Client messages:** `action` (with monotonic `clientSeq`) and `ack` (frame acknowledgment)
- **Game events:** CONNECT, DISCONNECT, and custom events
- **Close codes:** 4001 (sync timeout), 4002 (backpressure)

### GameClient (examples/reference-client/GameClient.js)

The reference client implementation. Key patterns:

- **Observer pattern with unsubscribe:** `onStateChange`, `onGameEvent`, `onConnect`, `onDisconnect`, `onError` all return unsubscribe functions
- **Private methods prefixed with `_`:** e.g., `_fire`, `_subscribe`, `_sendAckRaw`
- **Guard clauses on WebSocket state** before sending messages
- **State immutability:** new state objects created via spread operator on each update
- **`Promise.withResolvers()`** for the async `connect()` method
- **Auto-reconnect** with configurable delay and max attempts; `clientSeq` resets on reconnect

### Protocol Reserved Keys

These field names are reserved by the wire protocol and must not be used in custom game state:
`kind`, `frame`, `baseFrame`, `timeMs`, `added`, `removed`, `updated`, `_removedKeys`

### State Structure

Game state lives in `client.state` with `frame`, `timeMs`, and `players` (array with `id` field). Non-protocol fields from snapshots/deltas are merged directly into state.

## Conventions

- ES modules (`"type": "module"`)
- JSDoc for public API documentation
- camelCase for methods/variables, CONSTANT_CASE for module-level Sets
- Tests use `node:test` with dynamic ports (49400+) and a `waitFor()` polling helper
- Listener errors are silently swallowed in `_fire`
