import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GameLoop } from "../src/loop/GameLoop.js";
import { Connection } from "../src/net/Connection.js";
import { installMockWebSocket } from "./MockWebSocket.js";

// ---------------------------------------------------------------------------
// rAF helpers
// ---------------------------------------------------------------------------

let rafCallbacks;
let nextRafId;
let cancelledIds;
let origRAF;
let origCAF;

function installMockRAF() {
  rafCallbacks = [];
  nextRafId = 1;
  cancelledIds = new Set();

  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = (cb) => {
    const id = nextRafId++;
    rafCallbacks.push({ id, cb });
    return id;
  };

  globalThis.cancelAnimationFrame = (id) => {
    cancelledIds.add(id);
  };
}

function cleanupMockRAF() {
  if (origRAF !== undefined) globalThis.requestAnimationFrame = origRAF;
  else delete globalThis.requestAnimationFrame;
  if (origCAF !== undefined) globalThis.cancelAnimationFrame = origCAF;
  else delete globalThis.cancelAnimationFrame;
}

/** Invoke the most recent rAF callback with a given timestamp. */
function stepFrame(timestamp) {
  // Find the latest non-cancelled callback
  let entry;
  while (rafCallbacks.length > 0) {
    entry = rafCallbacks.pop();
    if (!cancelledIds.has(entry.id)) break;
    entry = null;
  }
  if (entry) entry.cb(timestamp);
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

let visibilityListeners;
let mockVisibilityState;

function installMockVisibility() {
  visibilityListeners = [];
  mockVisibilityState = "visible";

  if (typeof globalThis.document === "undefined") {
    globalThis.document = {};
  }

  globalThis.document.addEventListener = (type, handler) => {
    if (type === "visibilitychange") visibilityListeners.push(handler);
  };
  globalThis.document.removeEventListener = (type, handler) => {
    if (type === "visibilitychange") {
      visibilityListeners = visibilityListeners.filter((h) => h !== handler);
    }
  };

  Object.defineProperty(globalThis.document, "visibilityState", {
    get: () => mockVisibilityState,
    configurable: true,
  });
}

function setVisibility(state) {
  mockVisibilityState = state;
  for (const handler of [...visibilityListeners]) handler();
}

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

async function createConnectedConnection(mock) {
  const conn = new Connection("ws://mock", { token: "test-token" });
  await conn.connect();
  return conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameLoop", () => {
  let mock;

  beforeEach(() => {
    installMockVisibility();
    installMockRAF();
    mock = installMockWebSocket();
  });

  afterEach(() => {
    mock.cleanup();
    cleanupMockRAF();
  });

  // ------ lifecycle ------

  describe("lifecycle", () => {
    it("start() begins requesting frames and sets running to true", async () => {
      const conn = await createConnectedConnection(mock);
      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: () => {},
      });

      expect(loop.running).toBe(false);
      loop.start();
      expect(loop.running).toBe(true);
      expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

      loop.stop();
      conn.disconnect();
    });

    it("stop() cancels the loop and sets running to false", async () => {
      const conn = await createConnectedConnection(mock);
      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: () => {},
      });

      loop.start();
      expect(loop.running).toBe(true);

      loop.stop();
      expect(loop.running).toBe(false);
      expect(cancelledIds.size).toBeGreaterThanOrEqual(1);

      conn.disconnect();
    });

    it("start() is a no-op when already running", async () => {
      const conn = await createConnectedConnection(mock);
      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: () => {},
      });

      loop.start();
      const firstRafCount = rafCallbacks.length;
      loop.start(); // should be no-op
      expect(rafCallbacks.length).toBe(firstRafCount);

      loop.stop();
      conn.disconnect();
    });
  });

  // ------ fixed timestep ------

  describe("fixed timestep", () => {
    it("calls update correct number of times for accumulated time", async () => {
      const conn = await createConnectedConnection(mock);
      let updateCount = 0;

      // tickRateHz=10 → fixedDt=100ms
      const loop = new GameLoop({
        connection: conn,
        update: () => { updateCount++; },
        render: () => {},
        tickRateHz: 10,
      });

      loop.start();

      // First frame initializes prevTime
      stepFrame(0);
      expect(updateCount).toBe(0);

      // Advance 250ms → should trigger 2 update ticks (250/100 = 2 full ticks, 50ms leftover)
      stepFrame(250);
      expect(updateCount).toBe(2);

      loop.stop();
      conn.disconnect();
    });

    it("update receives a working sendAction function", async () => {
      const conn = await createConnectedConnection(mock);
      let receivedSendAction = null;

      const loop = new GameLoop({
        connection: conn,
        update: (sendAction) => { receivedSendAction = sendAction; },
        render: () => {},
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(100);

      expect(typeof receivedSendAction).toBe("function");

      // Calling sendAction should forward to connection
      const ws = mock.lastInstance();
      const sentBefore = ws.sent.length;
      receivedSendAction({ type: "MOVE", x: 1 });
      expect(ws.sent.length).toBe(sentBefore + 1);

      const lastMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(lastMsg.type).toBe("MOVE");
      expect(lastMsg.clientSeq).toBe(1);

      loop.stop();
      conn.disconnect();
    });

    it("caps large dt to prevent spiral of death", async () => {
      const conn = await createConnectedConnection(mock);
      let updateCount = 0;

      // tickRateHz=10 → fixedDt=100ms, maxDt=400ms
      const loop = new GameLoop({
        connection: conn,
        update: () => { updateCount++; },
        render: () => {},
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);

      // Advance 5000ms (way beyond maxDt=400ms) → should cap at 4 ticks
      stepFrame(5000);
      expect(updateCount).toBe(4);

      loop.stop();
      conn.disconnect();
    });
  });

  // ------ render ------

  describe("render", () => {
    it("calls render once per frame with (state, alpha, timestamp)", async () => {
      const conn = await createConnectedConnection(mock);
      const renderCalls = [];

      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: (state, alpha, timestamp) => {
          renderCalls.push({ state, alpha, timestamp });
        },
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);   // init frame, no render
      stepFrame(150);  // 1 tick (100ms), 50ms leftover → alpha=0.5

      expect(renderCalls).toHaveLength(1);
      expect(renderCalls[0].state).toBe(conn.state);
      expect(renderCalls[0].timestamp).toBe(150);

      loop.stop();
      conn.disconnect();
    });

    it("alpha is between 0 and 1", async () => {
      const conn = await createConnectedConnection(mock);
      const alphas = [];

      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: (_state, alpha) => { alphas.push(alpha); },
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(50);   // 50ms → 0 ticks, alpha = 50/100 = 0.5
      stepFrame(110);  // 60ms → 1 tick (accumulator: 50+60=110, after tick: 10ms), alpha = 10/100 = 0.1
      stepFrame(175);  // 65ms → 0 ticks (accumulator: 10+65=75), alpha = 75/100 = 0.75

      for (const a of alphas) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }

      loop.stop();
      conn.disconnect();
    });
  });

  // ------ pause / resume ------

  describe("pause / resume", () => {
    it("pause() suppresses update and render calls", async () => {
      const conn = await createConnectedConnection(mock);
      let updateCount = 0;
      let renderCount = 0;

      const loop = new GameLoop({
        connection: conn,
        update: () => { updateCount++; },
        render: () => { renderCount++; },
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(100);
      expect(updateCount).toBe(1);
      expect(renderCount).toBe(1);

      loop.pause();
      expect(loop.paused).toBe(true);

      stepFrame(200);
      stepFrame(300);
      // No additional calls while paused
      expect(updateCount).toBe(1);
      expect(renderCount).toBe(1);

      loop.stop();
      conn.disconnect();
    });

    it("resume() resets accumulator to avoid catch-up burst", async () => {
      const conn = await createConnectedConnection(mock);
      let updateCount = 0;

      const loop = new GameLoop({
        connection: conn,
        update: () => { updateCount++; },
        render: () => {},
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(100);
      expect(updateCount).toBe(1);

      loop.pause();
      stepFrame(200);
      stepFrame(5000); // large gap while paused

      loop.resume();
      expect(loop.paused).toBe(false);

      // First frame after resume just reinitializes prevTime
      stepFrame(5100);
      expect(updateCount).toBe(1); // no catch-up burst

      // Normal tick resumes
      stepFrame(5200);
      expect(updateCount).toBe(2);

      loop.stop();
      conn.disconnect();
    });
  });

  // ------ visibility ------

  describe("visibility", () => {
    it("auto-pauses when tab is hidden", async () => {
      const conn = await createConnectedConnection(mock);
      let renderCount = 0;

      const loop = new GameLoop({
        connection: conn,
        update: () => {},
        render: () => { renderCount++; },
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(100);
      expect(renderCount).toBe(1);

      setVisibility("hidden");
      expect(loop.paused).toBe(true);

      stepFrame(200);
      expect(renderCount).toBe(1); // no render while hidden

      loop.stop();
      conn.disconnect();
    });

    it("auto-resumes when tab becomes visible, no catch-up", async () => {
      const conn = await createConnectedConnection(mock);
      let updateCount = 0;

      const loop = new GameLoop({
        connection: conn,
        update: () => { updateCount++; },
        render: () => {},
        tickRateHz: 10,
      });

      loop.start();
      stepFrame(0);
      stepFrame(100);
      expect(updateCount).toBe(1);

      setVisibility("hidden");
      stepFrame(5000); // big gap while hidden

      setVisibility("visible");
      expect(loop.paused).toBe(false);

      // First frame after resume reinitializes prevTime
      stepFrame(5100);
      expect(updateCount).toBe(1); // no catch-up

      // Normal tick resumes
      stepFrame(5200);
      expect(updateCount).toBe(2);

      loop.stop();
      conn.disconnect();
    });
  });
});
