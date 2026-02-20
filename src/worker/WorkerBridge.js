/**
 * Main-thread bridge for OffscreenCanvas rendering in a Web Worker.
 *
 * Transfers a canvas to the worker, forwards connection state changes,
 * and relays non-protocol messages back to the main thread via observers.
 */
export class WorkerBridge {
  /**
   * @param {object} opts
   * @param {Worker} opts.worker
   * @param {HTMLCanvasElement} opts.canvas
   * @param {{ onStateChange(cb: Function): Function }} opts.connection
   */
  constructor({ worker, canvas, connection } = {}) {
    if (!worker) throw new Error("WorkerBridge requires a worker");
    if (!canvas) throw new Error("WorkerBridge requires a canvas");
    if (!connection) throw new Error("WorkerBridge requires a connection");

    this._worker = worker;
    this._canvas = canvas;
    this._connection = connection;
    this._started = false;
    this._offscreen = null;
    this._unsubscribeState = null;
    this._onMessage = [];

    this._worker.onmessage = (event) => {
      this._fire(this._onMessage, event.data);
    };
  }

  /**
   * Returns true if the runtime supports OffscreenCanvas.
   * @returns {boolean}
   */
  static isSupported() {
    return typeof OffscreenCanvas !== "undefined";
  }

  /**
   * Transfer the canvas to the worker, subscribe to state changes,
   * and signal the worker to begin rendering.
   */
  start() {
    if (this._started) return;

    if (!this._offscreen) {
      this._offscreen = this._canvas.transferControlToOffscreen();
    }

    this._worker.postMessage({ type: "init", canvas: this._offscreen }, [this._offscreen]);

    this._unsubscribeState = this._connection.onStateChange((state) => {
      this._worker.postMessage({ type: "state", state });
    });

    this._worker.postMessage({ type: "start" });
    this._started = true;
  }

  /**
   * Pause rendering — sends stop to worker and unsubscribes from state.
   */
  stop() {
    if (!this._started) return;

    this._worker.postMessage({ type: "stop" });
    this._unsubscribeState();
    this._unsubscribeState = null;
    this._started = false;
  }

  /**
   * Notify the worker of a canvas resize.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this._worker.postMessage({ type: "resize", width, height });
  }

  /**
   * Forward an arbitrary message to the worker.
   * @param {any} msg
   * @param {Transferable[]} [transfer]
   */
  postMessage(msg, transfer) {
    this._worker.postMessage(msg, transfer);
  }

  /**
   * Subscribe to non-protocol messages from the worker.
   * @param {Function} cb
   * @returns {Function} unsubscribe
   */
  onMessage(cb) {
    return this._subscribe(this._onMessage, cb);
  }

  /** @returns {boolean} */
  get started() {
    return this._started;
  }

  /**
   * Stop rendering, terminate the worker, and release all references.
   */
  dispose() {
    this.stop();
    this._worker.terminate();
    this._onMessage.length = 0;
    this._worker = null;
    this._canvas = null;
    this._connection = null;
    this._offscreen = null;
  }

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
}
