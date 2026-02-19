/**
 * Buffers recent server states and provides interpolation between them.
 *
 * The server sends state updates at `tickRateHz` (e.g. 30 Hz), but browsers
 * render at 60+ FPS. StateStore maintains a ring buffer of recent states and
 * interpolates between them with a configurable delay so rendering is smooth.
 */
export class StateStore {
  /**
   * @param {object} opts
   * @param {import('../net/Connection.js').Connection} opts.connection - Connection instance (required)
   * @param {number} [opts.capacity] - Ring buffer size (default: connection.tickRateHz)
   * @param {number} [opts.interpolationDelayMs] - Render delay in ms (default: 3 * (1000 / tickRateHz))
   */
  constructor({ connection, capacity, interpolationDelayMs } = {}) {
    this._connection = connection;
    const tickRateHz = connection.tickRateHz;

    this._capacity = capacity ?? tickRateHz;
    this._interpolationDelayMs = interpolationDelayMs ?? 3 * (1000 / tickRateHz);

    this._buffer = new Array(this._capacity).fill(null);
    this._head = 0;
    this._count = 0;
    this._lastFrame = -1;

    this._unsubscribe = connection.onStateChange((state) => this._push(state));
  }

  // ---- Ring buffer internals ----

  /** @private */
  _push(state) {
    // Gap detection: clear buffer on non-consecutive frames
    if (this._lastFrame !== -1 && state.frame !== this._lastFrame + 1) {
      this._buffer.fill(null);
      this._head = 0;
      this._count = 0;
    }

    this._buffer[this._head] = { state, timeMs: state.timeMs };
    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) this._count++;
    this._lastFrame = state.frame;
  }

  /**
   * Returns buffer contents in chronological (insertion) order.
   * @private
   * @returns {{ state: object, timeMs: number }[]}
   */
  _entries() {
    const result = [];
    const start = (this._head - this._count + this._capacity) % this._capacity;
    for (let i = 0; i < this._count; i++) {
      result.push(this._buffer[(start + i) % this._capacity]);
    }
    return result;
  }

  // ---- Public getters ----

  /** Estimated current server time in ms. */
  get serverTimeMsEstimate() {
    return performance.now() + this._connection.clockOffset;
  }

  /** The time to render at (server time minus interpolation delay). */
  get renderTimeMs() {
    return this.serverTimeMsEstimate - this._interpolationDelayMs;
  }

  /** Interpolation delay in ms. */
  get interpolationDelayMs() {
    return this._interpolationDelayMs;
  }

  set interpolationDelayMs(value) {
    this._interpolationDelayMs = value;
  }

  /** Number of buffered states. */
  get count() {
    return this._count;
  }

  /** Buffer capacity. */
  get capacity() {
    return this._capacity;
  }

  // ---- Interpolation ----

  /**
   * Returns the bracketing states and interpolation alpha for the given render time,
   * or `null` if the buffer is empty.
   *
   * @param {number} [renderTimeMs=this.renderTimeMs] - The time to interpolate at
   * @returns {{ prev: object, next: object, alpha: number } | null}
   */
  getInterpolatedState(renderTimeMs) {
    if (this._count === 0) return null;

    if (renderTimeMs === undefined) renderTimeMs = this.renderTimeMs;

    const entries = this._entries();

    // Single state — snap
    if (entries.length === 1) {
      return { prev: entries[0].state, next: entries[0].state, alpha: 0 };
    }

    const earliest = entries[0];
    const latest = entries[entries.length - 1];

    // Before earliest — snap to earliest
    if (renderTimeMs <= earliest.timeMs) {
      return { prev: earliest.state, next: earliest.state, alpha: 0 };
    }

    // After latest — snap to latest
    if (renderTimeMs >= latest.timeMs) {
      return { prev: latest.state, next: latest.state, alpha: 0 };
    }

    // Find bracketing pair
    for (let i = 0; i < entries.length - 1; i++) {
      const prev = entries[i];
      const next = entries[i + 1];
      if (renderTimeMs >= prev.timeMs && renderTimeMs <= next.timeMs) {
        const span = next.timeMs - prev.timeMs;
        const alpha = span === 0 ? 0 : (renderTimeMs - prev.timeMs) / span;
        return { prev: prev.state, next: next.state, alpha };
      }
    }

    // Fallback (shouldn't reach here)
    return null;
  }

  /**
   * Unsubscribe from connection, clear buffer, reset counters.
   */
  dispose() {
    this._unsubscribe();
    this._buffer.fill(null);
    this._head = 0;
    this._count = 0;
    this._lastFrame = -1;
  }
}
