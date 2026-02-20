import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkerBridge } from "../src/worker/WorkerBridge.js";
import { createRenderWorker } from "../src/worker/renderWorkerEntry.js";
import { AudioBridge } from "../src/worker/AudioBridge.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockConnection() {
  const stateListeners = [];
  const gameEventListeners = [];
  return {
    onStateChange(cb) {
      stateListeners.push(cb);
      return () => {
        const idx = stateListeners.indexOf(cb);
        if (idx !== -1) stateListeners.splice(idx, 1);
      };
    },
    onGameEvent(cb) {
      gameEventListeners.push(cb);
      return () => {
        const idx = gameEventListeners.indexOf(cb);
        if (idx !== -1) gameEventListeners.splice(idx, 1);
      };
    },
    _emitState(state) {
      for (const cb of stateListeners) cb(state);
    },
    _emitGameEvent(event) {
      for (const cb of gameEventListeners) cb(event);
    },
    _stateListeners: stateListeners,
    _gameEventListeners: gameEventListeners,
  };
}

function createMockWorker() {
  const sent = [];
  const worker = {
    postMessage(msg, transfer) {
      sent.push({ msg, transfer });
    },
    terminate() {
      worker._terminated = true;
    },
    onmessage: null,
    _sent: sent,
    _terminated: false,
    _simulateMessage(data) {
      if (worker.onmessage) {
        worker.onmessage({ data });
      }
    },
  };
  return worker;
}

function createMockCanvas() {
  const offscreen = { _isOffscreen: true };
  return {
    transferControlToOffscreen() {
      return offscreen;
    },
    _offscreen: offscreen,
  };
}

function installMockAudioContext() {
  let instance = null;
  globalThis.AudioContext = class MockAudioContext {
    constructor() {
      this.state = "running";
      this._resumed = 0;
      this._suspended = 0;
      this._closed = false;
      instance = this;
    }
    resume() {
      this._resumed++;
      this.state = "running";
    }
    suspend() {
      this._suspended++;
      this.state = "suspended";
    }
    close() {
      this._closed = true;
      this.state = "closed";
    }
  };

  return {
    lastInstance() { return instance; },
    cleanup() { delete globalThis.AudioContext; },
  };
}

function createMockTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) listeners.delete(type);
    },
    fire(type) {
      const list = listeners.get(type);
      if (list) for (const fn of list) fn();
    },
    hasListeners(type) {
      const list = listeners.get(type);
      return list != null && list.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// WorkerBridge
// ---------------------------------------------------------------------------

describe("WorkerBridge", () => {
  it("isSupported() returns based on OffscreenCanvas availability", () => {
    const had = typeof globalThis.OffscreenCanvas !== "undefined";

    // Without OffscreenCanvas
    delete globalThis.OffscreenCanvas;
    expect(WorkerBridge.isSupported()).toBe(false);

    // With OffscreenCanvas
    globalThis.OffscreenCanvas = class {};
    expect(WorkerBridge.isSupported()).toBe(true);

    // Restore
    if (!had) {
      delete globalThis.OffscreenCanvas;
    }
  });

  it("start() transfers canvas to worker with init message", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    bridge.start();

    // First message should be init with offscreen canvas
    expect(worker._sent[0].msg.type).toBe("init");
    expect(worker._sent[0].msg.canvas).toBe(canvas._offscreen);
    expect(worker._sent[0].transfer).toEqual([canvas._offscreen]);

    bridge.dispose();
  });

  it("start() subscribes to connection state changes", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    expect(conn._stateListeners.length).toBe(0);

    bridge.start();

    expect(conn._stateListeners.length).toBe(1);

    bridge.dispose();
  });

  it("state changes forwarded to worker via postMessage", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    bridge.start();

    const state = { frame: 1, players: [] };
    conn._emitState(state);

    // init, start, then state
    const stateMsg = worker._sent.find((s) => s.msg.type === "state");
    expect(stateMsg).toBeDefined();
    expect(stateMsg.msg.state).toBe(state);

    bridge.dispose();
  });

  it("stop() sends stop command and unsubscribes", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    bridge.start();
    expect(bridge.started).toBe(true);
    expect(conn._stateListeners.length).toBe(1);

    bridge.stop();

    expect(bridge.started).toBe(false);
    expect(conn._stateListeners.length).toBe(0);

    const stopMsg = worker._sent.find((s) => s.msg.type === "stop");
    expect(stopMsg).toBeDefined();
  });

  it("resize() sends resize message to worker", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    bridge.resize(800, 600);

    expect(worker._sent[0].msg).toEqual({ type: "resize", width: 800, height: 600 });

    bridge.dispose();
  });

  it("dispose() terminates worker and cleans up", () => {
    const worker = createMockWorker();
    const canvas = createMockCanvas();
    const conn = createMockConnection();
    const bridge = new WorkerBridge({ worker, canvas, connection: conn });

    bridge.start();
    bridge.dispose();

    expect(worker._terminated).toBe(true);
    expect(conn._stateListeners.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createRenderWorker
// ---------------------------------------------------------------------------

describe("createRenderWorker", () => {
  let originalOnmessage;

  beforeEach(() => {
    originalOnmessage = globalThis.onmessage;
  });

  afterEach(() => {
    globalThis.onmessage = originalOnmessage;
  });

  it("sets up globalThis.onmessage handler", () => {
    createRenderWorker({});
    expect(typeof globalThis.onmessage).toBe("function");
  });

  it("dispatches init with canvas to onInit", () => {
    const calls = [];
    createRenderWorker({ onInit: (canvas) => calls.push(canvas) });

    const mockCanvas = { _isOffscreen: true };
    globalThis.onmessage({ data: { type: "init", canvas: mockCanvas } });

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(mockCanvas);
  });

  it("dispatches state to onState", () => {
    const calls = [];
    createRenderWorker({ onState: (state) => calls.push(state) });

    const state = { frame: 5, players: [] };
    globalThis.onmessage({ data: { type: "state", state } });

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(state);
  });

  it("unknown message types dispatched to onMessage", () => {
    const calls = [];
    createRenderWorker({ onMessage: (data) => calls.push(data) });

    const data = { type: "custom", payload: 42 };
    globalThis.onmessage({ data });

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(data);
  });
});

// ---------------------------------------------------------------------------
// AudioBridge
// ---------------------------------------------------------------------------

describe("AudioBridge", () => {
  let mockAudio;

  beforeEach(() => {
    mockAudio = installMockAudioContext();
  });

  afterEach(() => {
    mockAudio.cleanup();
  });

  it("start() creates AudioContext and subscribes to connection", () => {
    const conn = createMockConnection();
    const target = createMockTarget();
    const handler = {};
    const audio = new AudioBridge({ connection: conn, handler, target });

    audio.start();

    expect(mockAudio.lastInstance()).not.toBeNull();
    expect(conn._stateListeners.length).toBe(1);
    expect(conn._gameEventListeners.length).toBe(1);
    expect(audio.context).toBe(mockAudio.lastInstance());
    expect(audio.started).toBe(true);

    audio.dispose();
  });

  it("forwards state changes to handler with context", () => {
    const conn = createMockConnection();
    const target = createMockTarget();
    const calls = [];
    const handler = {
      onStateChange(state, ctx) { calls.push({ state, ctx }); },
    };
    const audio = new AudioBridge({ connection: conn, handler, target });

    audio.start();

    const state = { frame: 1 };
    conn._emitState(state);

    expect(calls.length).toBe(1);
    expect(calls[0].state).toBe(state);
    expect(calls[0].ctx).toBe(mockAudio.lastInstance());

    audio.dispose();
  });

  it("forwards game events to handler with context", () => {
    const conn = createMockConnection();
    const target = createMockTarget();
    const calls = [];
    const handler = {
      onGameEvent(event, ctx) { calls.push({ event, ctx }); },
    };
    const audio = new AudioBridge({ connection: conn, handler, target });

    audio.start();

    const event = { kind: "GAME_EVENT", type: "explosion" };
    conn._emitGameEvent(event);

    expect(calls.length).toBe(1);
    expect(calls[0].event).toBe(event);
    expect(calls[0].ctx).toBe(mockAudio.lastInstance());

    audio.dispose();
  });

  it("user gesture listeners resume suspended context", () => {
    const conn = createMockConnection();
    const target = createMockTarget();
    const handler = {};
    const audio = new AudioBridge({ connection: conn, handler, target });

    audio.start();

    const ctx = mockAudio.lastInstance();
    ctx.state = "suspended";

    target.fire("click");

    expect(ctx._resumed).toBe(1);
    expect(ctx.state).toBe("running");

    audio.dispose();
  });

  it("dispose() closes context and unsubscribes", () => {
    const conn = createMockConnection();
    const target = createMockTarget();
    const handler = {};
    const audio = new AudioBridge({ connection: conn, handler, target });

    audio.start();
    const ctx = mockAudio.lastInstance();

    audio.dispose();

    expect(ctx._closed).toBe(true);
    expect(conn._stateListeners.length).toBe(0);
    expect(conn._gameEventListeners.length).toBe(0);
    expect(audio.context).toBeNull();
    expect(target.hasListeners("click")).toBe(false);
    expect(target.hasListeners("keydown")).toBe(false);
    expect(target.hasListeners("touchstart")).toBe(false);
  });
});
