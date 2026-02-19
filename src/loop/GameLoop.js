/**
 * requestAnimationFrame-based game loop with fixed-timestep updates
 * and variable-rate rendering.
 *
 * The server is authoritative — the client loop doesn't simulate physics.
 * Each fixed step calls the user's `update` callback (to poll input and
 * send actions), and each render frame calls the user's `render` callback
 * with an interpolation alpha.
 */
export class GameLoop {
  /**
   * @param {object} opts
   * @param {import('../net/Connection.js').Connection} opts.connection
   * @param {(sendAction: (action: object) => void) => void} opts.update
   * @param {(state: object|null, alpha: number, timestamp: number) => void} opts.render
   * @param {number} [opts.tickRateHz] — defaults to connection.tickRateHz
   */
  constructor({ connection, update, render, tickRateHz }) {
    if (!connection) throw new Error("connection is required");
    if (typeof update !== "function") throw new Error("update callback is required");
    if (typeof render !== "function") throw new Error("render callback is required");

    this._connection = connection;
    this._update = update;
    this._render = render;
    this._tickRateHz = tickRateHz ?? null; // resolved at start() if null

    this._running = false;
    this._paused = false;
    this._userPaused = false;
    this._visibilityPaused = false;

    this._rafId = null;
    this._prevTime = -1;
    this._accumulator = 0;

    this._fps = 0;
    this._frameTimeMs = 0;

    // EMA smoothing factor for FPS (closer to 1 = more responsive)
    this._fpsAlpha = 0.1;

    // Bound once, reused every update tick
    this._sendAction = (action) => this._connection.sendAction(action);

    // Bound frame callback for rAF
    this._frame = this._frame.bind(this);

    // Visibility change handler
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  /** Whether the loop is running. */
  get running() { return this._running; }

  /** Whether the loop is paused. */
  get paused() { return this._paused; }

  /** Smoothed frames-per-second (exponential moving average). */
  get fps() { return this._fps; }

  /** Timestamp of the last rAF frame in ms. */
  get frameTimeMs() { return this._frameTimeMs; }

  /**
   * Start the rAF loop. No-op if already running.
   */
  start() {
    if (this._running) return;

    const hz = this._tickRateHz ?? this._connection.tickRateHz;
    this._fixedDt = 1000 / hz;
    this._maxDt = this._fixedDt * 4;

    this._running = true;
    this._paused = false;
    this._userPaused = false;
    this._visibilityPaused = false;
    this._prevTime = -1;
    this._accumulator = 0;

    this._fps = 0;
    this._frameTimeMs = 0;

    document.addEventListener("visibilitychange", this._onVisibilityChange);
    this._rafId = requestAnimationFrame(this._frame);
  }

  /**
   * Stop the loop completely. Resets all timing state.
   */
  stop() {
    if (!this._running) return;

    this._running = false;
    this._paused = false;
    this._userPaused = false;
    this._visibilityPaused = false;

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    document.removeEventListener("visibilitychange", this._onVisibilityChange);

    this._prevTime = -1;
    this._accumulator = 0;
  }

  /**
   * Pause update/render without stopping the loop.
   */
  pause() {
    if (!this._running || this._userPaused) return;
    this._userPaused = true;
    this._paused = true;
  }

  /**
   * Resume from a user-initiated pause. Resets accumulator to avoid
   * catch-up burst.
   */
  resume() {
    if (!this._running || !this._userPaused) return;
    this._userPaused = false;
    this._paused = this._visibilityPaused;
    if (!this._paused) {
      this._prevTime = -1;
      this._accumulator = 0;
    }
  }

  // -- Internal --

  /** @private */
  _frame(timestamp) {
    this._frameTimeMs = timestamp;

    if (this._paused) {
      this._rafId = requestAnimationFrame(this._frame);
      return;
    }

    // First frame or after resume — skip dt calculation
    if (this._prevTime < 0) {
      this._prevTime = timestamp;
      this._rafId = requestAnimationFrame(this._frame);
      return;
    }

    let dt = timestamp - this._prevTime;
    if (dt > this._maxDt) dt = this._maxDt;
    this._prevTime = timestamp;
    this._accumulator += dt;

    // Fixed-timestep update ticks
    while (this._accumulator >= this._fixedDt) {
      this._update(this._sendAction);
      this._accumulator -= this._fixedDt;
    }

    // Render with interpolation alpha
    const alpha = this._accumulator / this._fixedDt;
    this._render(this._connection.state, alpha, timestamp);

    // Update FPS estimate (EMA)
    if (dt > 0) {
      const instantFps = 1000 / dt;
      this._fps = this._fps === 0
        ? instantFps
        : this._fps + this._fpsAlpha * (instantFps - this._fps);
    }

    this._rafId = requestAnimationFrame(this._frame);
  }

  /** @private */
  _onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      this._visibilityPaused = true;
      if (!this._userPaused) {
        this._paused = true;
      }
    } else {
      this._visibilityPaused = false;
      if (!this._userPaused) {
        this._paused = false;
        // Reset timing to avoid catch-up burst
        this._prevTime = -1;
        this._accumulator = 0;
      }
    }
  }
}
