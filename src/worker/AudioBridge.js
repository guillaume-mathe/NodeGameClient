/**
 * AudioContext lifecycle manager that bridges connection events to audio handlers.
 *
 * Manages AudioContext creation, user-gesture resume, and forwards
 * state changes and game events to a handler object with the context.
 */
export class AudioBridge {
  /**
   * @param {object} opts
   * @param {{ onStateChange(cb: Function): Function, onGameEvent(cb: Function): Function }} opts.connection
   * @param {{ onStateChange?(state: object, ctx: AudioContext): void, onGameEvent?(event: object, ctx: AudioContext): void }} opts.handler
   * @param {string[]} [opts.resumeEvents=["click","keydown","touchstart"]]
   * @param {EventTarget} [opts.target=globalThis]
   */
  constructor({ connection, handler, resumeEvents, target } = {}) {
    if (!connection) throw new Error("AudioBridge requires a connection");
    if (!handler) throw new Error("AudioBridge requires a handler");

    this._connection = connection;
    this._handler = handler;
    this._resumeEvents = resumeEvents ?? ["click", "keydown", "touchstart"];
    this._target = target ?? globalThis;

    this._context = null;
    this._started = false;
    this._unsubscribeState = null;
    this._unsubscribeGameEvent = null;

    this._resumeHandler = () => {
      if (this._context && this._context.state === "suspended") {
        this._context.resume();
      }
    };
  }

  /**
   * Create an AudioContext, subscribe to connection events,
   * and install user-gesture resume listeners.
   */
  start() {
    if (this._started) return;

    this._context = new AudioContext();

    this._unsubscribeState = this._connection.onStateChange((state) => {
      this._handler.onStateChange?.(state, this._context);
    });

    this._unsubscribeGameEvent = this._connection.onGameEvent((event) => {
      this._handler.onGameEvent?.(event, this._context);
    });

    for (const ev of this._resumeEvents) {
      this._target.addEventListener(ev, this._resumeHandler);
    }

    this._started = true;
  }

  /**
   * Unsubscribe from connection, remove resume listeners, suspend context.
   */
  stop() {
    if (!this._started) return;

    this._unsubscribeState();
    this._unsubscribeState = null;
    this._unsubscribeGameEvent();
    this._unsubscribeGameEvent = null;

    for (const ev of this._resumeEvents) {
      this._target.removeEventListener(ev, this._resumeHandler);
    }

    this._context.suspend();
    this._started = false;
  }

  /**
   * Stop, close the AudioContext, and release all references.
   */
  dispose() {
    this.stop();
    this._context?.close();
    this._context = null;
    this._connection = null;
    this._handler = null;
  }

  /** @returns {AudioContext|null} */
  get context() {
    return this._context;
  }

  /** @returns {boolean} */
  get started() {
    return this._started;
  }
}
