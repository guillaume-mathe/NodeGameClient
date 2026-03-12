import {
  defaultApplyDelta,
  SYNC_REQUEST, SYNC_RESPONSE, SYNC_RESULT,
  SNAPSHOT, DELTA, GAME_EVENT, ACK, LOGOUT,
} from "./protocol.js";

/**
 * Browser-native game client connection for node-game-server.
 *
 * Handles the sync handshake, snapshot/delta reconciliation, action submission
 * with auto-incrementing clientSeq, ack tracking, and optional reconnection.
 *
 * Uses the global WebSocket API — works in browsers and any runtime that
 * provides a spec-compliant WebSocket (Deno, Bun, Node 22+ with undici).
 */
export class Connection {
  /**
   * @param {string} url  WebSocket URL (e.g. "ws://localhost:8080")
   * @param {object} [opts]
   * @param {string}  opts.token  Session token (required). Persisted across reconnects.
   * @param {boolean} [opts.autoReconnect=false]
   * @param {number}  [opts.reconnectDelayMs=1000]
   * @param {number}  [opts.maxReconnectAttempts=5]
   * @param {boolean} [opts.autoAck=true]
   * @param {((state: object, msg: object) => object)|null} [opts.applyDelta=null]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.token = opts.token;
    this.autoReconnect = opts.autoReconnect ?? false;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.autoAck = opts.autoAck ?? true;
    this._applyDelta = opts.applyDelta ?? defaultApplyDelta;

    /** @type {object|null} */
    this.state = null;
    /** @type {string|null} */
    this.playerId = null;
    /** @type {boolean} */
    this.resumed = false;
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
    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      this._clientSeq = 0;
      this.state = null;
      this.playerId = null;
      this.connected = false;

      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this._ws = ws;

      let settled = false;

      ws.onerror = (event) => {
        const err = event instanceof ErrorEvent ? event.error ?? event.message : event;
        this._fire(this._onError, err);
        if (!settled) { settled = true; reject(err); }
      };

      ws.onclose = (event) => {
        this.connected = false;
        const willReconnect = !this._intentionalClose && this.autoReconnect
          && this._reconnectAttempts < this.maxReconnectAttempts;

        this._fire(this._onDisconnect, {
          code: event.code,
          reason: event.reason ?? "",
          willReconnect,
        });

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before sync (code ${event.code})`));
        }

        if (willReconnect) {
          this._scheduleReconnect();
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          const raw = event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : event.data;
          msg = JSON.parse(raw);
        } catch {
          return; // ignore non-JSON
        }

        if (msg.kind === SYNC_REQUEST) {
          ws.send(JSON.stringify({ kind: SYNC_RESPONSE, t: msg.t, ct: Date.now(), token: this.token }));
          return;
        }

        if (msg.kind === SYNC_RESULT) {
          this.rtt = msg.rtt;
          this.playerId = msg.playerId;
          this.resumed = msg.resumed ?? false;
          this.serverFrame = msg.serverFrame;
          this.tickRateHz = msg.tickRateHz;
          this.clockOffset = msg.serverTimeMs - (Date.now() - this.rtt / 2);
          this.connected = true;
          this._reconnectAttempts = 0;
          this._fire(this._onConnect, {
            rtt: this.rtt,
            playerId: this.playerId,
            resumed: this.resumed,
            serverFrame: this.serverFrame,
            tickRateHz: this.tickRateHz,
          });
          // Don't resolve yet — wait for initial snapshot
          return;
        }

        if (msg.kind === SNAPSHOT) {
          this.state = msg.state;
          this._fire(this._onStateChange, this.state);
          if (this.autoAck) {
            this._sendAckRaw(msg.state.frame);
          }
          if (!settled) { settled = true; resolve(); }
          return;
        }

        if (msg.kind === DELTA) {
          if (this.state && msg.baseFrame === this.state.frame) {
            this.state = this._applyDelta(this.state, msg);
            this._fire(this._onStateChange, this.state);
            if (this.autoAck) {
              this._sendAckRaw(this.state.frame);
            }
          } else {
            console.warn(
              `Connection: delta baseFrame ${msg.baseFrame} does not match state.frame ${this.state?.frame}, skipping`
            );
          }
          return;
        }

        if (msg.kind === GAME_EVENT) {
          this._fire(this._onGameEvent, msg);
          return;
        }
      };
    });
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
      this._ws.send(JSON.stringify({ kind: ACK, frame }));
    }
  }

  /**
   * Intentional disconnect — sends logout to destroy the session, no reconnection.
   */
  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ kind: LOGOUT }));
      }
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
