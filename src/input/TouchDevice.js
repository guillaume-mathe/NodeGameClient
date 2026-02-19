/**
 * Captures touch input from an element.
 *
 * Tracks active touches with positions relative to the target element.
 */
export class TouchDevice {
  /**
   * @param {Element} element — the element for coordinate-relative tracking
   */
  constructor(element) {
    this._element = element;
    this._target = null;
    this._enabled = true;

    /** @type {Map<number, { id: number, x: number, y: number }>} */
    this._touches = new Map();

    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);

    this.attach(element);
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    this._enabled = !!value;
    if (!this._enabled) {
      this.detach();
      this._touches.clear();
    } else if (!this._target) {
      this.attach(this._element);
    }
  }

  /**
   * Snapshot current active touches.
   * @returns {{ touches: Array<{ id: number, x: number, y: number }> }}
   */
  poll() {
    if (!this._enabled) {
      return { touches: [] };
    }
    return { touches: Array.from(this._touches.values()) };
  }

  /** @param {Element} target */
  attach(target) {
    if (this._target) this.detach();
    this._target = target;
    this._target.addEventListener("touchstart", this._onTouchStart);
    this._target.addEventListener("touchmove", this._onTouchMove);
    this._target.addEventListener("touchend", this._onTouchEnd);
    this._target.addEventListener("touchcancel", this._onTouchEnd);
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("touchstart", this._onTouchStart);
    this._target.removeEventListener("touchmove", this._onTouchMove);
    this._target.removeEventListener("touchend", this._onTouchEnd);
    this._target.removeEventListener("touchcancel", this._onTouchEnd);
    this._target = null;
  }

  /** @private */
  _updateTouches(changedTouches) {
    const rect = this._element.getBoundingClientRect();
    for (let i = 0; i < changedTouches.length; i++) {
      const t = changedTouches[i];
      this._touches.set(t.identifier, {
        id: t.identifier,
        x: t.clientX - rect.left,
        y: t.clientY - rect.top,
      });
    }
  }

  /** @private */
  _removeTouches(changedTouches) {
    for (let i = 0; i < changedTouches.length; i++) {
      this._touches.delete(changedTouches[i].identifier);
    }
  }

  /** @private */
  _onTouchStart(e) {
    this._updateTouches(e.changedTouches);
  }

  /** @private */
  _onTouchMove(e) {
    this._updateTouches(e.changedTouches);
  }

  /** @private */
  _onTouchEnd(e) {
    this._removeTouches(e.changedTouches);
  }
}
