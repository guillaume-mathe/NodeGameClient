/**
 * Captures keyboard input from keydown/keyup events.
 *
 * Tracks currently held keys, plus per-frame justPressed/justReleased sets
 * that accumulate between poll() calls.
 */
export class KeyboardDevice {
  /**
   * @param {EventTarget} [target] — element to listen on (default: globalThis)
   */
  constructor(target) {
    this._defaultTarget = target ?? globalThis;
    this._target = null;
    this._enabled = true;

    /** Currently held key codes. */
    this._keys = new Set();
    this._justPressedAccum = new Set();
    this._justReleasedAccum = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    this.attach(this._defaultTarget);
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    this._enabled = !!value;
    if (!this._enabled) {
      this.detach();
      this._keys.clear();
      this._justPressedAccum.clear();
      this._justReleasedAccum.clear();
    } else if (!this._target) {
      this.attach(this._defaultTarget);
    }
  }

  /**
   * Snapshot current state, swap accumulators, and clear them.
   * @returns {{ keys: Set<string>, justPressed: Set<string>, justReleased: Set<string> }}
   */
  poll() {
    if (!this._enabled) {
      return { keys: new Set(), justPressed: new Set(), justReleased: new Set() };
    }
    const justPressed = this._justPressedAccum;
    const justReleased = this._justReleasedAccum;
    this._justPressedAccum = new Set();
    this._justReleasedAccum = new Set();
    return { keys: new Set(this._keys), justPressed, justReleased };
  }

  /** @param {EventTarget} target */
  attach(target) {
    if (this._target) this.detach();
    this._target = target;
    this._target.addEventListener("keydown", this._onKeyDown);
    this._target.addEventListener("keyup", this._onKeyUp);
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("keydown", this._onKeyDown);
    this._target.removeEventListener("keyup", this._onKeyUp);
    this._target = null;
  }

  /** @private */
  _onKeyDown(e) {
    if (e.repeat) return;
    this._keys.add(e.code);
    this._justPressedAccum.add(e.code);
  }

  /** @private */
  _onKeyUp(e) {
    this._keys.delete(e.code);
    this._justReleasedAccum.add(e.code);
  }
}
