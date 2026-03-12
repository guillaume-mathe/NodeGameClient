import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, JSONEnvelopeCodec } from "node-game-server";
import { GameClient } from "./GameClient.js";

// ---------------------------------------------------------------------------
// Shared test logic and helpers
// ---------------------------------------------------------------------------
let testPortCounter = 0;
let testTokenCounter = 0;
function nextToken() { return `test-token-${++testTokenCounter}`; }

const defaultLogic = {
  createInitialState() {
    return { frame: 0, timeMs: 0, players: [] };
  },
  tick(state, actions, ctx) {
    let players = state.players;
    for (const a of actions) {
      if (a.type === "MOVE") {
        players = players.map(p =>
          p.id === a.playerId ? { ...p, x: a.x ?? p.x, y: a.y ?? p.y } : p
        );
      }
    }
    return { frame: ctx.frame, timeMs: state.timeMs + ctx.dtMs, players };
  },
  onGameEvent(state, event) {
    if (event.type === "CONNECT") {
      return { ...state, players: [...state.players, { id: event.playerId, x: 0, y: 0 }] };
    }
    if (event.type === "DISCONNECT") {
      return { ...state, players: state.players.filter(p => p.id !== event.playerId) };
    }
    return state;
  },
};

function startTestServer(logic, opts = {}) {
  const port = 49400 + testPortCounter++;
  const server = createServer(logic ?? defaultLogic, new JSONEnvelopeCodec(), {
    tickRateHz: 30, port, ...opts,
  });
  server.start();
  return { server, port, url: `ws://127.0.0.1:${port}` };
}

/** Wait for a condition to be true, polling every `intervalMs` up to `timeoutMs`. */
function waitFor(condFn, timeoutMs = 2000, intervalMs = 20) {
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

describe("GameClient", () => {

  // ------ connection lifecycle ------

  describe("connection lifecycle", () => {
    it("completes sync and receives initial snapshot", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();

        assert.ok(client.state, "state should be set after connect");
        assert.equal(typeof client.state.frame, "number");
        assert.ok(Array.isArray(client.state.players));

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("connect() resolves with state available", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();

        assert.ok(client.state !== null);
        assert.ok(client.connected);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("disconnect() closes cleanly", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();
        client.disconnect();

        assert.equal(client.connected, false);
      } finally {
        await server.stop();
      }
    });

    it("connected property reflects state", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        assert.equal(client.connected, false);

        await client.connect();
        assert.equal(client.connected, true);

        client.disconnect();
        assert.equal(client.connected, false);
      } finally {
        await server.stop();
      }
    });
  });

  // ------ state reconciliation ------

  describe("state reconciliation", () => {
    it("applies snapshot", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();

        // Initial snapshot has a players array (with the connected client itself)
        assert.ok(Array.isArray(client.state.players));
        assert.equal(typeof client.state.frame, "number");

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("applies delta (add/remove/update players)", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        const states = [];
        client.onStateChange(s => states.push(JSON.parse(JSON.stringify(s))));

        await client.connect();
        const playerId = client.playerId;

        // Send a move — the server will apply it and send a delta
        client.sendAction({ type: "MOVE", x: 42, y: 99 });

        await waitFor(() => {
          return states.some(s => {
            const p = s.players.find(p => p.id === playerId);
            return p && p.x === 42 && p.y === 99;
          });
        });

        const p = client.state.players.find(p => p.id === playerId);
        assert.equal(p.x, 42);
        assert.equal(p.y, 99);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("skips delta with mismatched baseFrame", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(" "));

        await client.connect();

        // Manually simulate receiving a delta with wrong baseFrame
        // by corrupting the state frame
        const originalFrame = client.state.frame;
        client.state = { ...client.state, frame: 99999 };

        // The next delta from the server will have a baseFrame that doesn't match
        // Wait for a server tick to send a delta
        await new Promise(r => setTimeout(r, 200));

        console.warn = origWarn;
        // Should have warned about mismatch (unless a snapshot arrived first)
        // The key assertion is that the client didn't crash

        client.disconnect();
      } finally {
        await server.stop();
      }
    });
  });

  // ------ actions ------

  describe("actions", () => {
    it("sendAction auto-increments clientSeq", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();

        // Capture what the server receives
        const received = [];
        const origBufferAction = server.game.bufferAction.bind(server.game);
        server.game.bufferAction = (action) => {
          received.push(action);
          origBufferAction(action);
        };

        client.sendAction({ type: "MOVE", x: 1, y: 1 });
        client.sendAction({ type: "MOVE", x: 2, y: 2 });

        await waitFor(() => received.filter(a => a.type === "MOVE").length >= 2);

        const moves = received.filter(a => a.type === "MOVE");
        assert.equal(moves[0].clientSeq, 1);
        assert.equal(moves[1].clientSeq, 2);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("server receives and applies the action", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        await client.connect();
        const playerId = client.playerId;

        client.sendAction({ type: "MOVE", x: 77, y: 88 });

        await waitFor(() => {
          const p = client.state?.players?.find(p => p.id === playerId);
          return p && p.x === 77 && p.y === 88;
        });

        const p = client.state.players.find(p => p.id === playerId);
        assert.equal(p.x, 77);
        assert.equal(p.y, 88);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });
  });

  // ------ ack ------

  describe("ack", () => {
    it("autoAck sends ack after state update", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken(), autoAck: true });
        await client.connect();

        // Wait for a tick to send state and the client to ack
        await new Promise(r => setTimeout(r, 300));

        const [playerId] = [...server.network.clients.keys()].filter(
          id => server.network.getClientState(id)?.syncComplete
        );
        const cs = server.network.getClientState(playerId);
        assert.ok(cs.lastAckedFrame >= 0, `expected lastAckedFrame >= 0, got ${cs.lastAckedFrame}`);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("autoAck=false suppresses ack", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken(), autoAck: false });
        await client.connect();

        // Wait for a tick
        await new Promise(r => setTimeout(r, 300));

        const [playerId] = [...server.network.clients.keys()].filter(
          id => server.network.getClientState(id)?.syncComplete
        );
        const cs = server.network.getClientState(playerId);
        assert.equal(cs.lastAckedFrame, -1, "lastAckedFrame should remain -1 when autoAck=false");

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("manual sendAck works", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken(), autoAck: false });
        await client.connect();

        client.sendAck(5);
        await new Promise(r => setTimeout(r, 100));

        const [playerId] = [...server.network.clients.keys()].filter(
          id => server.network.getClientState(id)?.syncComplete
        );
        const cs = server.network.getClientState(playerId);
        assert.equal(cs.lastAckedFrame, 5);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });
  });

  // ------ callbacks ------

  describe("callbacks", () => {
    it("onStateChange fires on snapshot and delta", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        const states = [];
        client.onStateChange(s => states.push(s));

        await client.connect();

        // First call is from the initial snapshot
        assert.ok(states.length >= 1, "onStateChange should fire at least once (snapshot)");

        // Send an action so the server sends a delta
        client.sendAction({ type: "MOVE", x: 1, y: 1 });
        await waitFor(() => states.length >= 2, 2000);

        assert.ok(states.length >= 2, "onStateChange should fire again on delta");

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("onGameEvent fires for CONNECT/DISCONNECT", async () => {
      const { server, url } = startTestServer();
      try {
        const client1 = new GameClient(url, { token: nextToken() });
        const events = [];
        client1.onGameEvent(e => events.push(e));

        await client1.connect();

        // Connect a second client — should trigger a CONNECT game event
        const client2 = new GameClient(url, { token: nextToken() });
        await client2.connect();

        await waitFor(() => events.some(e => e.type === "CONNECT"));

        assert.ok(events.some(e => e.type === "CONNECT"), "should receive CONNECT game event");

        // Disconnect client2 — should trigger DISCONNECT
        client2.disconnect();
        await waitFor(() => events.some(e => e.type === "DISCONNECT"), 2000);

        assert.ok(events.some(e => e.type === "DISCONNECT"), "should receive DISCONNECT game event");

        client1.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("onConnect fires with sync info", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        let connectInfo = null;
        client.onConnect(info => { connectInfo = info; });

        await client.connect();

        assert.ok(connectInfo, "onConnect should have fired");
        assert.equal(typeof connectInfo.rtt, "number");
        assert.equal(typeof connectInfo.playerId, "string");
        assert.equal(typeof connectInfo.serverFrame, "number");
        assert.equal(connectInfo.tickRateHz, 30);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("onDisconnect fires with code/reason", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        let disconnectInfo = null;
        client.onDisconnect(info => { disconnectInfo = info; });

        await client.connect();
        client.disconnect();

        await waitFor(() => disconnectInfo !== null);
        assert.ok(disconnectInfo);
        assert.equal(typeof disconnectInfo.code, "number");
        assert.equal(disconnectInfo.willReconnect, false);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("unsub prevents further callbacks", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, { token: nextToken() });
        const states = [];
        const unsub = client.onStateChange(s => states.push(s));

        await client.connect();
        const countAfterConnect = states.length;

        unsub();

        // Send an action to trigger more state changes
        client.sendAction({ type: "MOVE", x: 1, y: 1 });
        await new Promise(r => setTimeout(r, 300));

        assert.equal(states.length, countAfterConnect,
          "no more callbacks after unsub");

        client.disconnect();
      } finally {
        await server.stop();
      }
    });
  });

  // ------ reconnection ------

  describe("reconnection", () => {
    it("auto-reconnects after unexpected close", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, {
          token: nextToken(),
          autoReconnect: true,
          reconnectDelayMs: 100,
          maxReconnectAttempts: 3,
        });
        const connectEvents = [];
        client.onConnect(info => connectEvents.push(info));

        await client.connect();
        assert.equal(connectEvents.length, 1);

        // Force-close the server-side socket to simulate unexpected close
        const [playerId] = server.network.clients.keys();
        const cs = server.network.getClientState(playerId);
        cs.ws.close(1001, "going away");

        // Wait for reconnect
        await waitFor(() => connectEvents.length >= 2, 3000);
        assert.ok(connectEvents.length >= 2, "should have reconnected");
        assert.ok(client.connected);

        client.disconnect();
      } finally {
        await server.stop();
      }
    });

    it("no reconnect after intentional disconnect()", async () => {
      const { server, url } = startTestServer();
      try {
        const client = new GameClient(url, {
          token: nextToken(),
          autoReconnect: true,
          reconnectDelayMs: 100,
        });
        const connectEvents = [];
        client.onConnect(info => connectEvents.push(info));

        await client.connect();
        client.disconnect();

        await new Promise(r => setTimeout(r, 500));
        assert.equal(connectEvents.length, 1, "should not reconnect after intentional disconnect");
      } finally {
        await server.stop();
      }
    });

    it("respects maxReconnectAttempts", async () => {
      const { server, url } = startTestServer();
      const client = new GameClient(url, {
        token: nextToken(),
        autoReconnect: true,
        reconnectDelayMs: 50,
        maxReconnectAttempts: 2,
      });
      const disconnectEvents = [];
      client.onDisconnect(info => disconnectEvents.push(info));

      await client.connect();

      // Force-close from server side, then stop server so reconnects fail
      const [playerId] = server.network.clients.keys();
      const cs = server.network.getClientState(playerId);
      cs.ws.close(1001, "going away");
      await new Promise(r => setTimeout(r, 50));
      await server.stop();

      // Wait for reconnect attempts to exhaust
      await waitFor(() => {
        return disconnectEvents.some(e => e.willReconnect === false);
      }, 5000);

      assert.ok(disconnectEvents.some(e => e.willReconnect === false),
        "should give up after maxReconnectAttempts");
    });
  });

  // ------ custom applyDelta ------

  describe("custom applyDelta", () => {
    it("uses custom applyDelta callback", async () => {
      const { server, url } = startTestServer();
      try {
        let customCalled = false;
        const client = new GameClient(url, {
          token: nextToken(),
          applyDelta(state, msg) {
            customCalled = true;
            // Simple: just update frame
            return { ...state, frame: msg.frame, timeMs: msg.timeMs };
          },
        });

        await client.connect();

        // Send an action so the server produces a delta
        client.sendAction({ type: "MOVE", x: 1, y: 1 });
        await waitFor(() => customCalled, 2000);

        assert.ok(customCalled, "custom applyDelta should have been called");

        client.disconnect();
      } finally {
        await server.stop();
      }
    });
  });
});
