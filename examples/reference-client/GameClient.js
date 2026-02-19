import WebSocket from "ws";

/** Keys that are part of the delta envelope/protocol, not game state fields. */
const DELTA_PROTOCOL_KEYS = new Set([
  "kind", "frame", "baseFrame", "timeMs",
  "added", "removed", "updated", "_removedKeys",
]);

/**
 * Default delta applier — handles the standard diffState format:
 * player changes ({ added, removed, updated } keyed on players[].id)
 * plus any changed non-player top-level state fields.
 */
function defaultApplyDelta(state, msg) {
  let players = state.players;
  if (msg.removed?.length) {
    const gone = new Set(msg.removed);
    players = players.filter(p => !gone.has(p.id));
  }
  if (msg.added?.length) players = players.concat(msg.added);
  if (msg.updated?.length) {
    const updates = new Map(msg.updated.map(p => [p.id, p]));
    players = players.map(p => updates.has(p.id) ? { ...p, ...updates.get(p.id) } : p);
  }

  const result = { ...state, frame: msg.frame, timeMs: msg.timeMs, players };

  // Merge changed non-player state fields
  for (const key of Object.keys(msg)) {
    if (!DELTA_PROTOCOL_KEYS.has(key)) {
      result[key] = msg[key];
    }
  }

  // Remove keys that were deleted from server state
  if (msg._removedKeys?.length) {
    for (const key of msg._removedKeys) {
      delete result[key];
    }
  }

  return result;
}

/**
 * Reference game client for node-game-server.
 *
 * Handles the sync handshake, snapshot/delta reconciliation, action submission
 * with auto-incrementing clientSeq, ack tracking, and optional reconnection.
 */
export class GameClient {
  /**
   * @param {string} url  WebSocket URL (e.g. "ws://localhost:8080")
   * @param {object} [opts]
   * @param {boolean} [opts.autoReconnect=false]
   * @param {number}  [opts.reconnectDelayMs=1000]
   * @param {number}  [opts.maxReconnectAttempts=5]
   * @param {boolean} [opts.autoAck=true]
   * @param {((state: object, msg: object) => object)|null} [opts.applyDelta=null]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.autoReconnect = opts.autoReconnect ?? false;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.autoAck = opts.autoAck ?? true;
    this._applyDelta = opts.applyDelta ?? defaultApplyDelta;

    /** @type {object|null} */
    this.state = null;
    /** @type {string|null} */
    this.playerId = null;
    this.rtt = 0;
    this.clockOffset = 0;
    this.serverFrame = 0;
    this.tickRateHz = 0;
    this.connected = false;

    this._clientSeq = 0;
    this._ws = null;
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;

    // Callback lists
    this._onStateChange = [];
    this._onGameEvent = [];
    this._onConnect = [];
    this._onDisconnect = [];
    this._onError = [];
  }

  /**
   * Connect to the server. Resolves after the sync handshake completes
   * and the initial snapshot is received.
   * @returns {Promise<void>}
   */
  connect() {
    const { promise, resolve, reject } = Promise.withResolvers();

    this._intentionalClose = false;
    this._clientSeq = 0;
    this.state = null;
    this.playerId = null;
    this.connected = false;

    const ws = new WebSocket(this.url);
    this._ws = ws;

    let settled = false;

    ws.on("error", (err) => {
      this._fire(this._onError, err);
      if (!settled) { settled = true; reject(err); }
    });

    ws.on("close", (code, reason) => {
      this.connected = false;
      const reasonStr = typeof reason === "string" ? reason : reason?.toString("utf8") ?? "";
      const willReconnect = !this._intentionalClose && this.autoReconnect
        && this._reconnectAttempts < this.maxReconnectAttempts;

      this._fire(this._onDisconnect, { code, reason: reasonStr, willReconnect });

      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket closed before sync (code ${code})`));
      }

      if (willReconnect) {
        this._scheduleReconnect();
      }
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      } catch {
        return; // ignore non-JSON
      }

      if (msg.kind === "sync_request") {
        ws.send(JSON.stringify({ kind: "sync_response", t: msg.t, ct: Date.now() }));
        return;
      }

      if (msg.kind === "sync_result") {
        this.rtt = msg.rtt;
        this.playerId = msg.playerId;
        this.serverFrame = msg.serverFrame;
        this.tickRateHz = msg.tickRateHz;
        this.clockOffset = msg.serverTimeMs - (Date.now() - this.rtt / 2);
        this.connected = true;
        this._reconnectAttempts = 0;
        this._fire(this._onConnect, {
          rtt: this.rtt,
          playerId: this.playerId,
          serverFrame: this.serverFrame,
          tickRateHz: this.tickRateHz,
        });
        // Don't resolve yet — wait for initial snapshot
        return;
      }

      if (msg.kind === "snapshot") {
        this.state = msg.state;
        this._fire(this._onStateChange, this.state);
        if (this.autoAck) {
          this._sendAckRaw(msg.state.frame);
        }
        if (!settled) { settled = true; resolve(); }
        return;
      }

      if (msg.kind === "delta") {
        if (this.state && msg.baseFrame === this.state.frame) {
          this.state = this._applyDelta(this.state, msg);
          this._fire(this._onStateChange, this.state);
          if (this.autoAck) {
            this._sendAckRaw(this.state.frame);
          }
        } else {
          // baseFrame mismatch — skip delta
          console.warn(
            `GameClient: delta baseFrame ${msg.baseFrame} does not match state.frame ${this.state?.frame}, skipping`
          );
        }
        return;
      }

      if (msg.kind === "game_event") {
        this._fire(this._onGameEvent, msg);
        return;
      }
    });

    return promise;
  }

  /**
   * Send a game action to the server. Automatically increments clientSeq.
   * @param {object} action — must have a `type` field; may include `targetFrame`
   */
  sendAction(action) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const seq = ++this._clientSeq;
    const msg = { ...action, clientSeq: seq };
    this._ws.send(JSON.stringify(msg));
  }

  /**
   * Manually send an ack for a specific frame (use when autoAck=false).
   * @param {number} frame
   */
  sendAck(frame) {
    this._sendAckRaw(frame);
  }

  /** @private */
  _sendAckRaw(frame) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ kind: "ack", frame }));
    }
  }

  /**
   * Intentional disconnect — no reconnection.
   */
  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.connected = false;
  }

  // ---- Callback registration (returns unsubscribe function) ----

  onStateChange(cb) { return this._subscribe(this._onStateChange, cb); }
  onGameEvent(cb)   { return this._subscribe(this._onGameEvent, cb); }
  onConnect(cb)     { return this._subscribe(this._onConnect, cb); }
  onDisconnect(cb)  { return this._subscribe(this._onDisconnect, cb); }
  onError(cb)       { return this._subscribe(this._onError, cb); }

  // ---- Internal helpers ----

  /** @private */
  _subscribe(list, cb) {
    list.push(cb);
    return () => {
      const idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /** @private */
  _fire(list, arg) {
    for (const cb of list) {
      try { cb(arg); } catch { /* swallow listener errors */ }
    }
  }

  /** @private */
  _scheduleReconnect() {
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {
        // reconnect failed — onError/onDisconnect will fire from the new attempt
      });
    }, this.reconnectDelayMs);
  }
}
