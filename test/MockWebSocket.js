/**
 * Mock WebSocket that simulates the server side of the node-game-server
 * wire protocol. Used for unit-testing Connection without a real server.
 *
 * Implements the browser WebSocket API surface that Connection relies on:
 * - readyState, OPEN/CLOSED constants
 * - onopen, onclose, onmessage, onerror callbacks
 * - send(), close()
 *
 * After construction it auto-fires "open", then runs the sync handshake
 * (sync_request → sync_response → sync_result → initial snapshot).
 */

export const OPEN = 1;
export const CLOSED = 3;

export class MockWebSocket {
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  /**
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.playerId="mock-player-1"]
   * @param {number} [opts.tickRateHz=30]
   * @param {number} [opts.serverFrame=1]
   * @param {object} [opts.initialState] - custom initial snapshot state
   * @param {boolean} [opts.autoSync=true] - automatically run sync handshake
   * @param {boolean} [opts.resumed=false] - whether to report a resumed session
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.readyState = OPEN;

    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;

    /** Messages sent by the client (via send()) */
    this.sent = [];

    // Server-side config
    this._playerId = opts.playerId ?? "mock-player-1";
    this._tickRateHz = opts.tickRateHz ?? 30;
    this._serverFrame = opts.serverFrame ?? 1;
    this._initialState = opts.initialState ?? null;
    this._autoSync = opts.autoSync ?? true;
    this._resumed = opts.resumed ?? false;
    this._closed = false;

    // Schedule open + sync handshake on next microtask
    queueMicrotask(() => this._boot());
  }

  /** Simulate receiving a message from the server. */
  serverSend(data) {
    if (this._closed) return;
    const event = { data: typeof data === "string" ? data : JSON.stringify(data) };
    this.onmessage?.(event);
  }

  /** Simulate the server closing the connection. */
  serverClose(code = 1000, reason = "") {
    if (this._closed) return;
    this._closed = true;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Simulate an error on the connection. */
  serverError(message = "mock error") {
    this.onerror?.({ message });
  }

  // -- Browser WebSocket API surface --

  send(data) {
    if (this._closed || this.readyState !== OPEN) return;
    this.sent.push(data);

    // Parse to check for sync_response during handshake
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
    // Fire onclose asynchronously like a real WebSocket
    queueMicrotask(() => {
      this.onclose?.({ code, reason });
    });
  }

  // -- Internal --

  _boot() {
    if (this._closed) return;
    this.onopen?.({});
    if (this._autoSync) {
      this._runSyncHandshake();
    }
  }

  async _runSyncHandshake() {
    const serverTime = Date.now();

    // Set up promise BEFORE sending sync_request, because the client's
    // sync_response comes back synchronously within the same call stack.
    const syncResponsePromise = new Promise((resolve) => {
      this._pendingSyncResolve = resolve;
    });

    // 1. Send sync_request
    this.serverSend({ kind: "sync_request", t: serverTime });

    // 2. Wait for sync_response from client
    const syncResponse = await syncResponsePromise;

    const rtt = Date.now() - serverTime;

    // 3. Send sync_result
    this.serverSend({
      kind: "sync_result",
      rtt,
      playerId: this._playerId,
      serverFrame: this._serverFrame,
      serverTimeMs: Date.now(),
      tickRateHz: this._tickRateHz,
      resumed: this._resumed,
    });

    // 4. Send initial snapshot
    const state = this._initialState ?? {
      frame: this._serverFrame,
      timeMs: 0,
      players: [{ id: this._playerId, x: 0, y: 0 }],
    };
    this.serverSend({ kind: "snapshot", frame: state.frame, timeMs: state.timeMs, state });
  }
}

/**
 * Install MockWebSocket as the global WebSocket for the duration of a test.
 * Returns a helper to access the most recent MockWebSocket instance.
 *
 * @param {object} [mockOpts] - Options forwarded to MockWebSocket constructor
 * @returns {{ lastInstance: () => MockWebSocket, cleanup: () => void }}
 */
export function installMockWebSocket(mockOpts = {}) {
  const instances = [];
  const OriginalWebSocket = globalThis.WebSocket;

  globalThis.WebSocket = class extends MockWebSocket {
    constructor(url) {
      super(url, mockOpts);
      instances.push(this);
    }
  };
  // Copy static constants
  globalThis.WebSocket.OPEN = OPEN;
  globalThis.WebSocket.CLOSED = CLOSED;

  return {
    lastInstance: () => instances[instances.length - 1],
    allInstances: () => [...instances],
    cleanup: () => {
      globalThis.WebSocket = OriginalWebSocket;
    },
  };
}
