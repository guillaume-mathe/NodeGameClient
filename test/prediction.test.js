import { describe, it, expect } from "vitest";
import { ActionBuffer } from "../src/prediction/actionBuffer.js";
import { PredictionManager } from "../src/prediction/PredictionManager.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockConnection(tickRateHz = 30) {
  const stateListeners = [];
  let clientSeq = 0;
  const sent = [];
  return {
    tickRateHz,
    rtt: 30,
    serverFrame: 0,
    state: null,
    _clientSeq: 0,
    onStateChange(cb) {
      stateListeners.push(cb);
      return () => {
        const idx = stateListeners.indexOf(cb);
        if (idx !== -1) stateListeners.splice(idx, 1);
      };
    },
    sendAction(action) {
      clientSeq++;
      this._clientSeq = clientSeq;
      sent.push({ ...action, clientSeq });
    },
    _emitState(state) {
      this.state = state;
      for (const cb of stateListeners) cb(state);
    },
    _sent: sent,
    _stateListeners: stateListeners,
  };
}

// ---------------------------------------------------------------------------
// ActionBuffer
// ---------------------------------------------------------------------------

describe("ActionBuffer", () => {
  it("push stores entries and count is correct", () => {
    const buf = new ActionBuffer(8);

    buf.push({ action: { type: "move" }, clientSeq: 1, targetFrame: 5 });
    buf.push({ action: { type: "move" }, clientSeq: 2, targetFrame: 6 });
    buf.push({ action: { type: "move" }, clientSeq: 3, targetFrame: 7 });

    expect(buf.count).toBe(3);
    expect(buf.capacity).toBe(8);
  });

  it("discardThrough removes entries with targetFrame <= frame", () => {
    const buf = new ActionBuffer(8);

    buf.push({ action: { type: "a" }, clientSeq: 1, targetFrame: 3 });
    buf.push({ action: { type: "b" }, clientSeq: 2, targetFrame: 5 });
    buf.push({ action: { type: "c" }, clientSeq: 3, targetFrame: 7 });

    buf.discardThrough(5);

    expect(buf.count).toBe(1);
    const remaining = buf.entries();
    expect(remaining[0].targetFrame).toBe(7);
  });

  it("entries returns remaining actions in insertion order", () => {
    const buf = new ActionBuffer(8);

    buf.push({ action: { type: "a" }, clientSeq: 1, targetFrame: 1 });
    buf.push({ action: { type: "b" }, clientSeq: 2, targetFrame: 2 });
    buf.push({ action: { type: "c" }, clientSeq: 3, targetFrame: 3 });

    const entries = buf.entries();
    expect(entries.length).toBe(3);
    expect(entries[0].action.type).toBe("a");
    expect(entries[1].action.type).toBe("b");
    expect(entries[2].action.type).toBe("c");
  });

  it("wraps at capacity, oldest entry dropped", () => {
    const buf = new ActionBuffer(3);

    buf.push({ action: { type: "a" }, clientSeq: 1, targetFrame: 1 });
    buf.push({ action: { type: "b" }, clientSeq: 2, targetFrame: 2 });
    buf.push({ action: { type: "c" }, clientSeq: 3, targetFrame: 3 });
    buf.push({ action: { type: "d" }, clientSeq: 4, targetFrame: 4 }); // drops "a"

    expect(buf.count).toBe(3);

    const entries = buf.entries();
    expect(entries[0].action.type).toBe("b");
    expect(entries[1].action.type).toBe("c");
    expect(entries[2].action.type).toBe("d");
  });

  it("clear resets the buffer", () => {
    const buf = new ActionBuffer(8);

    buf.push({ action: { type: "a" }, clientSeq: 1, targetFrame: 1 });
    buf.push({ action: { type: "b" }, clientSeq: 2, targetFrame: 2 });

    expect(buf.count).toBe(2);

    buf.clear();

    expect(buf.count).toBe(0);
    expect(buf.entries().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PredictionManager — construction
// ---------------------------------------------------------------------------

describe("PredictionManager — construction", () => {
  it("subscribes to connection onStateChange", () => {
    const conn = createMockConnection();
    const pm = new PredictionManager({
      connection: conn,
      predict: (s) => s,
    });

    expect(conn._stateListeners.length).toBe(1);

    pm.dispose();
  });

  it("predictedState is null initially", () => {
    const conn = createMockConnection();
    const pm = new PredictionManager({
      connection: conn,
      predict: (s) => s,
    });

    expect(pm.predictedState).toBeNull();

    pm.dispose();
  });
});

// ---------------------------------------------------------------------------
// PredictionManager — sendAction
// ---------------------------------------------------------------------------

describe("PredictionManager — sendAction", () => {
  it("forwards action to connection with targetFrame added", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
    });

    pm.sendAction({ type: "move", dx: 5 });

    expect(conn._sent.length).toBe(1);
    expect(conn._sent[0].type).toBe("move");
    expect(conn._sent[0].targetFrame).toBeGreaterThan(10);

    pm.dispose();
  });

  it("applies predict function to produce predictedState", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
    });

    pm.sendAction({ type: "move", dx: 5 });

    expect(pm.predictedState).not.toBeNull();
    expect(pm.predictedState.x).toBe(5);

    pm.dispose();
  });

  it("buffers action (pendingCount increments)", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
    });

    pm.sendAction({ type: "move", dx: 5 });
    pm.sendAction({ type: "move", dx: 3 });

    expect(pm.pendingCount).toBe(2);

    pm.dispose();
  });
});

// ---------------------------------------------------------------------------
// PredictionManager — reconciliation
// ---------------------------------------------------------------------------

describe("PredictionManager — reconciliation", () => {
  it("discards acknowledged actions and re-applies remaining", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
    });

    // Send first action
    pm.sendAction({ type: "move", dx: 5 });
    const targetFrame1 = conn._sent[0].targetFrame;

    // Advance conn.state so second action gets a later targetFrame
    conn.state = { frame: targetFrame1, x: 2 };
    pm.sendAction({ type: "move", dx: 3 });
    const targetFrame2 = conn._sent[1].targetFrame;

    // Server advances to targetFrame1 — first action acknowledged
    conn._emitState({ frame: targetFrame1, x: 5 });

    // First action discarded, second re-applied on server state
    expect(pm.pendingCount).toBe(1);
    expect(pm.predictedState.x).toBe(8); // server x=5 + remaining dx=3

    pm.dispose();
  });

  it("predictedState equals serverState when no pending actions remain", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
    });

    pm.sendAction({ type: "move", dx: 5 });

    const targetFrame = conn._sent[0].targetFrame;

    // Server acknowledges the action
    const serverState = { frame: targetFrame, x: 5 };
    conn._emitState(serverState);

    expect(pm.pendingCount).toBe(0);
    expect(pm.predictedState).toBe(serverState);

    pm.dispose();
  });

  it("fires onMisprediction with serverState and previous predicted state", () => {
    const conn = createMockConnection(30);
    conn.state = { frame: 10, x: 0 };
    conn.rtt = 30;

    const mispredictions = [];
    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s, x: s.x + a.dx }),
      onMisprediction: (serverState, previousPredicted) => {
        mispredictions.push({ serverState, previousPredicted });
      },
    });

    pm.sendAction({ type: "move", dx: 5 });

    const previousPredicted = pm.predictedState;

    // Server state arrives (could differ from prediction)
    const serverState = { frame: 20, x: 3 };
    conn._emitState(serverState);

    expect(mispredictions.length).toBe(1);
    expect(mispredictions[0].serverState).toBe(serverState);
    expect(mispredictions[0].previousPredicted).toBe(previousPredicted);

    pm.dispose();
  });
});

// ---------------------------------------------------------------------------
// PredictionManager — dispose
// ---------------------------------------------------------------------------

describe("PredictionManager — dispose", () => {
  it("unsubscribes from connection and clears state", () => {
    const conn = createMockConnection();
    const pm = new PredictionManager({
      connection: conn,
      predict: (s, a) => ({ ...s }),
    });

    expect(conn._stateListeners.length).toBe(1);

    conn.state = { frame: 1, x: 0 };
    pm.sendAction({ type: "move", dx: 1 });
    expect(pm.predictedState).not.toBeNull();

    pm.dispose();

    expect(conn._stateListeners.length).toBe(0);
    expect(pm.predictedState).toBeNull();
    expect(pm.pendingCount).toBe(0);

    // Further state emissions should not affect the manager
    conn._emitState({ frame: 2, x: 10 });
    expect(pm.predictedState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mock ECS World for prediction tests
// ---------------------------------------------------------------------------

function createMockWorld(initialEntities = []) {
  const entities = initialEntities.map(e => ({
    id: e.id,
    components: Object.fromEntries(
      Object.entries(e.components).map(([k, v]) => [k, { ...v }])
    ),
  }));

  return {
    _entities: entities,
    _snapshotCalls: 0,
    _applySnapshotCalls: 0,

    applySnapshot(data) {
      this._applySnapshotCalls++;
      entities.length = 0;
      for (const e of data.entities) {
        entities.push({
          id: e.id,
          components: Object.fromEntries(
            Object.entries(e.components).map(([k, v]) => [k, { ...v }])
          ),
        });
      }
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
            break;
          }
          case "remove":
            const idx = entities.findIndex(e => e.id === entry.id);
            if (idx !== -1) entities.splice(idx, 1);
            break;
        }
      }
      this._entities = entities;
    },

    serialize() {
      this._snapshotCalls++;
      return {
        entities: entities.map(e => ({
          id: e.id,
          components: Object.fromEntries(
            Object.entries(e.components).map(([k, v]) => [k, { ...v }])
          ),
        })),
      };
    },

    snapshot() {
      return this.serialize();
    },
  };
}

// ---------------------------------------------------------------------------
// PredictionManager — ECS mode
// ---------------------------------------------------------------------------

describe("PredictionManager — ECS mode", () => {
  it("exposes world via getter", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld();
    const pm = new PredictionManager({
      connection: conn,
      predict: () => {},
      world,
    });

    expect(pm.world).toBe(world);

    pm.dispose();
  });

  it("applies predict function to world on sendAction", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld([
      { id: 1, components: { Position: { x: 0, y: 0 } } },
    ]);
    conn.state = { frame: 10, timeMs: 333, entities: world.serialize().entities };

    const pm = new PredictionManager({
      connection: conn,
      predict: (w, action) => {
        const e = w._entities.find(e => e.id === 1);
        if (e) {
          e.components.Position.x += action.dx;
          e.components.Position.y += action.dy;
        }
      },
      world,
    });

    pm.sendAction({ type: "move", dx: 5, dy: 10 });

    // World should be mutated
    expect(world._entities[0].components.Position.x).toBe(5);
    expect(world._entities[0].components.Position.y).toBe(10);

    // predictedState should reflect the world
    const predicted = pm.predictedState;
    expect(predicted).not.toBeNull();
    expect(predicted.entities[0].components.Position.x).toBe(5);

    pm.dispose();
  });

  it("reconciles by restoring world to server state and re-applying pending", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld([
      { id: 1, components: { Position: { x: 0, y: 0 } } },
    ]);
    conn.state = { frame: 10, timeMs: 333, entities: world.serialize().entities };

    const pm = new PredictionManager({
      connection: conn,
      predict: (w, action) => {
        const e = w._entities.find(e => e.id === 1);
        if (e) e.components.Position.x += action.dx;
      },
      world,
    });

    // Send two actions
    pm.sendAction({ type: "move", dx: 5 });
    const tf1 = conn._sent[0].targetFrame;
    conn.state = { frame: tf1, timeMs: 500, entities: world.serialize().entities };
    pm.sendAction({ type: "move", dx: 3 });

    // Server acknowledges first action at frame tf1 with its own position
    conn._emitState({
      frame: tf1,
      timeMs: 500,
      entities: [{ id: 1, components: { Position: { x: 7 } } }],
    });

    // World should be restored to server state, then second action re-applied
    expect(pm.pendingCount).toBe(1);
    expect(world._entities[0].components.Position.x).toBe(10); // 7 + 3

    pm.dispose();
  });

  it("predictedState equals server state when no pending actions", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld([
      { id: 1, components: { Position: { x: 0, y: 0 } } },
    ]);
    conn.state = { frame: 10, timeMs: 333, entities: world.serialize().entities };

    const pm = new PredictionManager({
      connection: conn,
      predict: (w, action) => {
        const e = w._entities.find(e => e.id === 1);
        if (e) e.components.Position.x += action.dx;
      },
      world,
    });

    pm.sendAction({ type: "move", dx: 5 });
    const tf = conn._sent[0].targetFrame;

    // Server acknowledges
    conn._emitState({
      frame: tf,
      timeMs: 500,
      entities: [{ id: 1, components: { Position: { x: 5, y: 0 } } }],
    });

    expect(pm.pendingCount).toBe(0);
    expect(pm.predictedState.entities[0].components.Position.x).toBe(5);

    pm.dispose();
  });

  it("fires onMisprediction in ECS mode", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld([
      { id: 1, components: { Position: { x: 0, y: 0 } } },
    ]);
    conn.state = { frame: 10, timeMs: 333, entities: world.serialize().entities };

    const mispredictions = [];
    const pm = new PredictionManager({
      connection: conn,
      predict: (w, action) => {
        const e = w._entities.find(e => e.id === 1);
        if (e) e.components.Position.x += action.dx;
      },
      onMisprediction: (server, prev) => mispredictions.push({ server, prev }),
      world,
    });

    pm.sendAction({ type: "move", dx: 5 });

    conn._emitState({
      frame: 20,
      timeMs: 666,
      entities: [{ id: 1, components: { Position: { x: 3, y: 0 } } }],
    });

    expect(mispredictions).toHaveLength(1);
    // previousPredicted should have the old world state (x=5)
    expect(mispredictions[0].prev.entities[0].components.Position.x).toBe(5);

    pm.dispose();
  });

  it("calls world.applySnapshot on each reconciliation", () => {
    const conn = createMockConnection(30);
    const world = createMockWorld([
      { id: 1, components: { Position: { x: 0, y: 0 } } },
    ]);
    conn.state = { frame: 10, timeMs: 333, entities: world.serialize().entities };

    const pm = new PredictionManager({
      connection: conn,
      predict: () => {},
      world,
    });

    const before = world._applySnapshotCalls;

    conn._emitState({
      frame: 11,
      timeMs: 366,
      entities: [{ id: 1, components: { Position: { x: 10, y: 10 } } }],
    });

    expect(world._applySnapshotCalls).toBe(before + 1);

    pm.dispose();
  });
});
