import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lerpEntity } from "../src/state/interpolation.js";
import { StateStore } from "../src/state/StateStore.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockConnection(tickRateHz = 30, clockOffset = 0) {
  const listeners = [];
  return {
    tickRateHz,
    clockOffset,
    onStateChange(cb) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    _emit(state) {
      for (const cb of listeners) cb(state);
    },
    _listeners: listeners,
  };
}

function makeState(frame, timeMs, players = []) {
  return { frame, timeMs, players };
}

// ---------------------------------------------------------------------------
// lerpEntity
// ---------------------------------------------------------------------------

describe("lerpEntity", () => {
  it("interpolates specified numeric fields at alpha=0.5", () => {
    const prev = { x: 0, y: 10, name: "a" };
    const next = { x: 100, y: 20, name: "b" };

    const result = lerpEntity(prev, next, 0.5, ["x", "y"]);

    expect(result.x).toBe(50);
    expect(result.y).toBe(15);
    expect(result.name).toBe("b"); // non-interpolated from next
  });

  it("alpha=0 returns prev values for interpolated fields", () => {
    const prev = { x: 10, y: 20 };
    const next = { x: 100, y: 200 };

    const result = lerpEntity(prev, next, 0, ["x", "y"]);

    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
  });

  it("handles missing/non-numeric fields gracefully (falls back to next)", () => {
    const prev = { x: 10, label: "old" };
    const next = { x: 100, label: "new", z: 50 };

    const result = lerpEntity(prev, next, 0.5, ["x", "label", "z", "missing"]);

    expect(result.x).toBe(55);
    expect(result.label).toBe("new"); // string, not interpolated
    expect(result.z).toBe(50);        // prev.z is undefined, falls back to next
  });
});

// ---------------------------------------------------------------------------
// StateStore — construction
// ---------------------------------------------------------------------------

describe("StateStore — construction", () => {
  it("uses tickRateHz as default capacity", () => {
    const conn = createMockConnection(20);
    const store = new StateStore({ connection: conn });

    expect(store.capacity).toBe(20);

    store.dispose();
  });

  it("uses 3 ticks as default interpolation delay", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    expect(store.interpolationDelayMs).toBe(3 * (1000 / 30));

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// StateStore — ring buffer
// ---------------------------------------------------------------------------

describe("StateStore — ring buffer", () => {
  it("buffers incoming states from onStateChange", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 133));
    conn._emit(makeState(3, 166));

    expect(store.count).toBe(3);

    store.dispose();
  });

  it("wraps when buffer reaches capacity (oldest overwritten)", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn, capacity: 3 });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 133));
    conn._emit(makeState(3, 166));
    conn._emit(makeState(4, 200)); // overwrites frame 1

    expect(store.count).toBe(3);

    // Verify oldest is frame 2, newest is frame 4
    const result = store.getInterpolatedState(133);
    expect(result.prev.frame).toBe(2);

    store.dispose();
  });

  it("clears buffer on frame gap (snapshot after missed deltas)", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 133));
    conn._emit(makeState(3, 166));

    expect(store.count).toBe(3);

    // Frame gap — jump from 3 to 10
    conn._emit(makeState(10, 400));

    expect(store.count).toBe(1);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// StateStore — getInterpolatedState
// ---------------------------------------------------------------------------

describe("StateStore — getInterpolatedState", () => {
  it("returns null when buffer is empty", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    expect(store.getInterpolatedState(100)).toBeNull();

    store.dispose();
  });

  it("snaps to single state when only one buffered", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));

    const result = store.getInterpolatedState(100);
    expect(result).not.toBeNull();
    expect(result.prev.frame).toBe(1);
    expect(result.next.frame).toBe(1);
    expect(result.alpha).toBe(0);

    store.dispose();
  });

  it("returns correct bracket and alpha between two states", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 200));

    const result = store.getInterpolatedState(150);

    expect(result.prev.frame).toBe(1);
    expect(result.next.frame).toBe(2);
    expect(result.alpha).toBeCloseTo(0.5);

    store.dispose();
  });

  it("snaps to earliest when renderTimeMs is before range", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 200));

    const result = store.getInterpolatedState(50);

    expect(result.prev.frame).toBe(1);
    expect(result.next.frame).toBe(1);
    expect(result.alpha).toBe(0);

    store.dispose();
  });

  it("snaps to latest when renderTimeMs is after range", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 200));

    const result = store.getInterpolatedState(300);

    expect(result.prev.frame).toBe(2);
    expect(result.next.frame).toBe(2);
    expect(result.alpha).toBe(0);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// StateStore — dispose
// ---------------------------------------------------------------------------

describe("StateStore — dispose", () => {
  it("unsubscribes from connection and clears buffer", () => {
    const conn = createMockConnection(30);
    const store = new StateStore({ connection: conn });

    conn._emit(makeState(1, 100));
    conn._emit(makeState(2, 133));
    expect(store.count).toBe(2);
    expect(conn._listeners.length).toBe(1);

    store.dispose();

    expect(store.count).toBe(0);
    expect(conn._listeners.length).toBe(0);

    // Further emissions should not affect the store
    conn._emit(makeState(3, 166));
    expect(store.count).toBe(0);
  });
});
