/**
 * Ring buffer for unacknowledged client actions.
 *
 * Each entry stores `{ action, clientSeq, targetFrame }`. Actions are ordered
 * by targetFrame (monotonically increasing), so discard-from-front works
 * cleanly when the server acknowledges frames.
 */
export class ActionBuffer {
  /**
   * @param {number} [capacity=64] - Maximum number of buffered entries
   */
  constructor(capacity = 64) {
    this._capacity = capacity;
    this._buffer = new Array(capacity).fill(null);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }

  /**
   * Push an entry into the buffer. If full, the oldest entry is dropped.
   * @param {{ action: object, clientSeq: number, targetFrame: number }} entry
   */
  push(entry) {
    this._buffer[this._head] = entry;
    this._head = (this._head + 1) % this._capacity;
    if (this._count === this._capacity) {
      // Full — advance tail to drop oldest
      this._tail = (this._tail + 1) % this._capacity;
    } else {
      this._count++;
    }
  }

  /**
   * Remove entries from the front while `entry.targetFrame <= frame`.
   * @param {number} frame - Discard entries with targetFrame up to and including this value
   */
  discardThrough(frame) {
    while (this._count > 0) {
      const entry = this._buffer[this._tail];
      if (entry.targetFrame > frame) break;
      this._buffer[this._tail] = null;
      this._tail = (this._tail + 1) % this._capacity;
      this._count--;
    }
  }

  /**
   * Return remaining entries in insertion order (tail → head).
   * @returns {{ action: object, clientSeq: number, targetFrame: number }[]}
   */
  entries() {
    const result = [];
    for (let i = 0; i < this._count; i++) {
      result.push(this._buffer[(this._tail + i) % this._capacity]);
    }
    return result;
  }

  /**
   * Clear the buffer, resetting all state.
   */
  clear() {
    this._buffer.fill(null);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }

  /** Number of buffered entries. */
  get count() {
    return this._count;
  }

  /** Buffer capacity. */
  get capacity() {
    return this._capacity;
  }
}
