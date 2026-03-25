import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Connection } from "../src/net/Connection.js";
import { installMockWebSocket, OPEN, CLOSED } from "./MockWebSocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a condition to be true, polling every `intervalMs`. */
function waitFor(condFn, timeoutMs = 1000, intervalMs = 5) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condFn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Connection", () => {
  let mock;

  beforeEach(() => {
    mock = installMockWebSocket();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // ------ connection lifecycle ------

  describe("connection lifecycle", () => {
    it("completes sync and receives initial snapshot", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(client.state).toBeTruthy();
      expect(typeof client.state.frame).toBe("number");
      expect(Array.isArray(client.state.players)).toBe(true);

      client.disconnect();
    });

    it("connect() resolves with state available", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(client.state).not.toBeNull();
      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it("disconnect() closes cleanly", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();
      client.disconnect();

      expect(client.connected).toBe(false);
    });

    it("connected property reflects state", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      expect(client.connected).toBe(false);

      await client.connect();
      expect(client.connected).toBe(true);

      client.disconnect();
      expect(client.connected).toBe(false);
    });

    it("sends token in sync_response", async () => {
      const client = new Connection("ws://mock", { token: "my-secret-token" });
      await client.connect();

      const ws = mock.lastInstance();
      const syncResponse = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .find(m => m && m.kind === "sync_response");

      expect(syncResponse).toBeTruthy();
      expect(syncResponse.token).toBe("my-secret-token");

      client.disconnect();
    });

    it("sends logout before closing on disconnect()", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      const ws = mock.lastInstance();
      client.disconnect();

      const logout = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .find(m => m && m.kind === "logout");

      expect(logout).toBeTruthy();
    });

    it("exposes resumed=false for new sessions", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(client.resumed).toBe(false);

      client.disconnect();
    });

    it("exposes resumed=true for resumed sessions", async () => {
      mock.cleanup();
      mock = installMockWebSocket({ resumed: true });

      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(client.resumed).toBe(true);

      client.disconnect();
    });
  });

  // ------ state reconciliation ------

  describe("state reconciliation", () => {
    it("applies snapshot", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(Array.isArray(client.state.players)).toBe(true);
      expect(typeof client.state.frame).toBe("number");

      client.disconnect();
    });

    it("applies delta (add/remove/update players)", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      const ws = mock.lastInstance();

      // Send a delta that adds a player, updates existing, and removes none
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        added: [{ id: "new-player", x: 50, y: 50 }],
        removed: [],
        updated: [{ id: "mock-player-1", x: 42, y: 99 }],
      });

      await waitFor(() => client.state.frame === 2);

      expect(client.state.players).toHaveLength(2);
      const updated = client.state.players.find(p => p.id === "mock-player-1");
      expect(updated.x).toBe(42);
      expect(updated.y).toBe(99);
      const added = client.state.players.find(p => p.id === "new-player");
      expect(added.x).toBe(50);

      // Now send a delta that removes the new player
      ws.serverSend({
        kind: "delta",
        frame: 3,
        baseFrame: 2,
        timeMs: 66.6,
        added: [],
        removed: ["new-player"],
        updated: [],
      });

      await waitFor(() => client.state.frame === 3);
      expect(client.state.players).toHaveLength(1);
      expect(client.state.players[0].id).toBe("mock-player-1");

      client.disconnect();
    });

    it("skips delta with mismatched baseFrame", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await client.connect();
      const ws = mock.lastInstance();
      const originalFrame = client.state.frame;

      // Send delta with wrong baseFrame
      ws.serverSend({
        kind: "delta",
        frame: 99,
        baseFrame: 999, // doesn't match state.frame (1)
        timeMs: 100,
        added: [],
        removed: [],
        updated: [],
      });

      // Give it time to process
      await new Promise(r => setTimeout(r, 50));

      // Frame should NOT have changed
      expect(client.state.frame).toBe(originalFrame);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      client.disconnect();
    });
  });

  // ------ actions ------

  describe("actions", () => {
    it("sendAction auto-increments clientSeq", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      client.sendAction({ type: "MOVE", x: 1, y: 1 });
      client.sendAction({ type: "MOVE", x: 2, y: 2 });

      const ws = mock.lastInstance();
      const actions = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(m => m && m.type === "MOVE");

      expect(actions).toHaveLength(2);
      expect(actions[0].clientSeq).toBe(1);
      expect(actions[1].clientSeq).toBe(2);

      client.disconnect();
    });

    it("action message includes type and payload", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      client.sendAction({ type: "FIRE", x: 10, y: 20 });

      const ws = mock.lastInstance();
      const actions = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(m => m && m.type === "FIRE");

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("FIRE");
      expect(actions[0].x).toBe(10);
      expect(actions[0].y).toBe(20);
      expect(actions[0].clientSeq).toBe(1);

      client.disconnect();
    });
  });

  // ------ ack ------

  describe("ack", () => {
    it("autoAck sends ack after snapshot", async () => {
      const client = new Connection("ws://mock", { token: "t1", autoAck: true });
      await client.connect();

      const ws = mock.lastInstance();
      const acks = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(m => m && m.kind === "ack");

      expect(acks.length).toBeGreaterThanOrEqual(1);
      expect(acks[0].frame).toBe(1); // initial snapshot frame

      client.disconnect();
    });

    it("autoAck=false suppresses ack", async () => {
      const client = new Connection("ws://mock", { token: "t1", autoAck: false });
      await client.connect();

      const ws = mock.lastInstance();
      const acks = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(m => m && m.kind === "ack");

      expect(acks).toHaveLength(0);

      client.disconnect();
    });

    it("manual sendAck works", async () => {
      const client = new Connection("ws://mock", { token: "t1", autoAck: false });
      await client.connect();

      client.sendAck(5);

      const ws = mock.lastInstance();
      const acks = ws.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(m => m && m.kind === "ack");

      expect(acks).toHaveLength(1);
      expect(acks[0].frame).toBe(5);

      client.disconnect();
    });
  });

  // ------ callbacks ------

  describe("callbacks", () => {
    it("onStateChange fires on snapshot and delta", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      const states = [];
      client.onStateChange(s => states.push(s));

      await client.connect();

      // First call from initial snapshot
      expect(states.length).toBeGreaterThanOrEqual(1);

      // Send a delta
      const ws = mock.lastInstance();
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        added: [],
        removed: [],
        updated: [{ id: "mock-player-1", x: 5, y: 5 }],
      });

      await waitFor(() => states.length >= 2);
      expect(states.length).toBeGreaterThanOrEqual(2);

      client.disconnect();
    });

    it("onGameEvent fires for game events", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      const events = [];
      client.onGameEvent(e => events.push(e));

      await client.connect();

      const ws = mock.lastInstance();
      ws.serverSend({
        kind: "game_event",
        type: "CONNECT",
        playerId: "other-player",
      });

      await waitFor(() => events.length >= 1);
      expect(events[0].type).toBe("CONNECT");
      expect(events[0].playerId).toBe("other-player");

      client.disconnect();
    });

    it("onConnect fires with sync info including resumed", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      let connectInfo = null;
      client.onConnect(info => { connectInfo = info; });

      await client.connect();

      expect(connectInfo).toBeTruthy();
      expect(typeof connectInfo.rtt).toBe("number");
      expect(typeof connectInfo.playerId).toBe("string");
      expect(typeof connectInfo.serverFrame).toBe("number");
      expect(connectInfo.tickRateHz).toBe(30);
      expect(connectInfo.resumed).toBe(false);

      client.disconnect();
    });

    it("onDisconnect fires with code and willReconnect", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      let disconnectInfo = null;
      client.onDisconnect(info => { disconnectInfo = info; });

      await client.connect();
      client.disconnect();

      await waitFor(() => disconnectInfo !== null);
      expect(disconnectInfo).toBeTruthy();
      expect(typeof disconnectInfo.code).toBe("number");
      expect(disconnectInfo.willReconnect).toBe(false);
    });

    it("unsubscribe prevents further callbacks", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      const states = [];
      const unsub = client.onStateChange(s => states.push(s));

      await client.connect();
      const countAfterConnect = states.length;

      unsub();

      // Send a delta — should NOT trigger callback
      const ws = mock.lastInstance();
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        added: [],
        removed: [],
        updated: [],
      });

      await new Promise(r => setTimeout(r, 50));
      expect(states.length).toBe(countAfterConnect);

      client.disconnect();
    });
  });

  // ------ reconnection ------

  describe("reconnection", () => {
    it("auto-reconnects after unexpected close", async () => {
      const client = new Connection("ws://mock", {
        token: "t1",
        autoReconnect: true,
        reconnectDelayMs: 50,
        maxReconnectAttempts: 3,
      });
      const connectEvents = [];
      client.onConnect(info => connectEvents.push(info));

      await client.connect();
      expect(connectEvents).toHaveLength(1);

      // Simulate server closing connection
      const ws = mock.lastInstance();
      ws.serverClose(1001, "going away");

      // Wait for reconnect (new MockWebSocket instance is created)
      await waitFor(() => connectEvents.length >= 2, 3000);
      expect(connectEvents.length).toBeGreaterThanOrEqual(2);
      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it("no reconnect after intentional disconnect()", async () => {
      const client = new Connection("ws://mock", {
        token: "t1",
        autoReconnect: true,
        reconnectDelayMs: 50,
      });
      const connectEvents = [];
      client.onConnect(info => connectEvents.push(info));

      await client.connect();
      client.disconnect();

      await new Promise(r => setTimeout(r, 200));
      expect(connectEvents).toHaveLength(1);
    });

    it("respects maxReconnectAttempts", async () => {
      // First connection succeeds (normal mock), then we make subsequent ones fail
      mock.cleanup();
      const instances = [];
      let connectionCount = 0;
      const OriginalWebSocket = globalThis.WebSocket;

      globalThis.WebSocket = class FailAfterFirstWebSocket {
        static OPEN = OPEN;
        static CLOSED = CLOSED;

        constructor(url) {
          this.url = url;
          this.readyState = OPEN;
          this.onopen = null;
          this.onclose = null;
          this.onmessage = null;
          this.onerror = null;
          this.sent = [];
          this._closed = false;
          connectionCount++;
          const connNum = connectionCount;
          instances.push(this);

          queueMicrotask(() => {
            if (this._closed) return;
            if (connNum === 1) {
              // First connection: successful sync
              this.onopen?.({});
              this._runSync();
            } else {
              // Subsequent connections: fail immediately
              this.onopen?.({});
              queueMicrotask(() => {
                if (!this._closed) {
                  this._closed = true;
                  this.readyState = CLOSED;
                  this.onclose?.({ code: 1006, reason: "connection failed" });
                }
              });
            }
          });
        }

        send(data) {
          if (this._closed) return;
          this.sent.push(data);
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          if (msg.kind === "sync_response" && this._pendingSyncResolve) {
            this._pendingSyncResolve(msg);
            this._pendingSyncResolve = null;
          }
        }

        close(code = 1000, reason = "") {
          if (this._closed) return;
          this._closed = true;
          this.readyState = CLOSED;
          queueMicrotask(() => {
            this.onclose?.({ code, reason });
          });
        }

        async _runSync() {
          const serverTime = Date.now();
          const p = new Promise(resolve => { this._pendingSyncResolve = resolve; });
          this.onmessage?.({ data: JSON.stringify({ kind: "sync_request", t: serverTime }) });
          await p;
          this.onmessage?.({ data: JSON.stringify({
            kind: "sync_result", rtt: 1, playerId: "mock-player-1",
            serverFrame: 1, serverTimeMs: Date.now(), tickRateHz: 30,
          })});
          const state = { frame: 1, timeMs: 0, players: [{ id: "mock-player-1", x: 0, y: 0 }] };
          this.onmessage?.({ data: JSON.stringify({ kind: "snapshot", frame: 1, timeMs: 0, state }) });
        }
      };

      const client = new Connection("ws://mock", {
        token: "t1",
        autoReconnect: true,
        reconnectDelayMs: 30,
        maxReconnectAttempts: 2,
      });
      const disconnectEvents = [];
      client.onDisconnect(info => disconnectEvents.push(info));

      await client.connect();

      // Simulate server closing
      const ws = instances[0];
      ws._closed = true;
      ws.readyState = CLOSED;
      ws.onclose?.({ code: 1001, reason: "going away" });

      // Wait for reconnect attempts to exhaust
      await waitFor(
        () => disconnectEvents.some(e => e.willReconnect === false),
        3000,
      );

      expect(disconnectEvents.some(e => e.willReconnect === false)).toBe(true);

      globalThis.WebSocket = OriginalWebSocket;
      client.disconnect();
    });
  });

  // ------ custom applyDelta ------

  describe("custom applyDelta", () => {
    it("uses custom applyDelta callback", async () => {
      let customCalled = false;
      const client = new Connection("ws://mock", {
        token: "t1",
        applyDelta(state, msg) {
          customCalled = true;
          return { ...state, frame: msg.frame, timeMs: msg.timeMs };
        },
      });

      await client.connect();

      const ws = mock.lastInstance();
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        added: [],
        removed: [],
        updated: [],
      });

      await waitFor(() => customCalled);
      expect(customCalled).toBe(true);

      client.disconnect();
    });
  });

  // ------ ECS mode ------

  describe("ECS mode (auto-detect)", () => {
    beforeEach(() => {
      mock.cleanup();
      mock = installMockWebSocket({ ecs: true });
    });

    it("applies ECS snapshot with entities array", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      expect(client.state).toBeTruthy();
      expect(Array.isArray(client.state.entities)).toBe(true);
      expect(client.state.entities[0].components.Player.id).toBe("mock-player-1");

      client.disconnect();
    });

    it("applies ECS delta (add/update/remove ops)", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      const ws = mock.lastInstance();

      // Delta: add a new entity, update existing
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        entities: [
          { id: 2, op: "add", components: { Position: { x: 50, y: 60 }, Player: { id: "player-2" } } },
          { id: 1, op: "update", components: { Position: { x: 10, y: 20 } } },
        ],
      });

      await waitFor(() => client.state.frame === 2);

      expect(client.state.entities).toHaveLength(2);

      const e1 = client.state.entities.find(e => e.id === 1);
      expect(e1.components.Position.x).toBe(10);
      expect(e1.components.Position.y).toBe(20);

      const e2 = client.state.entities.find(e => e.id === 2);
      expect(e2.components.Player.id).toBe("player-2");

      // Delta: remove entity 2
      ws.serverSend({
        kind: "delta",
        frame: 3,
        baseFrame: 2,
        timeMs: 66.6,
        entities: [
          { id: 2, op: "remove" },
        ],
      });

      await waitFor(() => client.state.frame === 3);
      expect(client.state.entities).toHaveLength(1);
      expect(client.state.entities[0].id).toBe(1);

      client.disconnect();
    });

    it("handles ECS delta with component removal", async () => {
      const client = new Connection("ws://mock", { token: "t1" });
      await client.connect();

      const ws = mock.lastInstance();

      // Add a component, then remove it
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        entities: [
          { id: 1, op: "update", components: { Velocity: { vx: 1, vy: 0 } } },
        ],
      });

      await waitFor(() => client.state.frame === 2);
      expect(client.state.entities[0].components.Velocity).toBeTruthy();

      ws.serverSend({
        kind: "delta",
        frame: 3,
        baseFrame: 2,
        timeMs: 66.6,
        entities: [
          { id: 1, op: "update", removed: ["Velocity"] },
        ],
      });

      await waitFor(() => client.state.frame === 3);
      expect(client.state.entities[0].components.Velocity).toBeUndefined();

      client.disconnect();
    });
  });

  describe("ECS mode (world option)", () => {
    function createMockWorld() {
      let entities = [];
      return {
        _entities: entities,
        applySnapshot(data) {
          entities = data.entities
            ? data.entities.map(e => ({ id: e.id, components: { ...e.components } }))
            : [];
          this._entities = entities;
        },
        applyDiff(diff) {
          for (const entry of diff.entities) {
            switch (entry.op) {
              case "add":
                entities.push({ id: entry.id, components: { ...entry.components } });
                break;
              case "update": {
                const existing = entities.find(e => e.id === entry.id);
                if (existing && entry.components) {
                  for (const [name, data] of Object.entries(entry.components)) {
                    existing.components[name] = { ...existing.components[name], ...data };
                  }
                }
                if (existing && entry.removed) {
                  for (const name of entry.removed) delete existing.components[name];
                }
                break;
              }
              case "remove":
                this._entities = entities = entities.filter(e => e.id !== entry.id);
                break;
            }
          }
        },
        serialize() {
          return { entities: entities.map(e => ({ id: e.id, components: { ...e.components } })) };
        },
      };
    }

    beforeEach(() => {
      mock.cleanup();
      mock = installMockWebSocket({ ecs: true });
    });

    it("applies snapshot to world", async () => {
      const world = createMockWorld();
      const client = new Connection("ws://mock", { token: "t1", world });
      await client.connect();

      expect(client.world).toBe(world);
      expect(world._entities).toHaveLength(1);
      expect(world._entities[0].components.Player.id).toBe("mock-player-1");

      client.disconnect();
    });

    it("applies delta via world.applyDiff()", async () => {
      const world = createMockWorld();
      const client = new Connection("ws://mock", { token: "t1", world });
      await client.connect();

      const ws = mock.lastInstance();
      ws.serverSend({
        kind: "delta",
        frame: 2,
        baseFrame: 1,
        timeMs: 33.3,
        entities: [
          { id: 2, op: "add", components: { Position: { x: 50, y: 60 } } },
          { id: 1, op: "update", components: { Position: { x: 10, y: 20 } } },
        ],
      });

      await waitFor(() => client.state.frame === 2);

      // Both world and state should reflect the changes
      expect(world._entities).toHaveLength(2);
      expect(client.state.entities).toHaveLength(2);

      client.disconnect();
    });
  });
});
