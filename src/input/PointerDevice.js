/**
 * Captures pointer (mouse) input from an element.
 *
 * Tracks position relative to the element, movement deltas (accumulated
 * between polls), button bitmask, and pointer-lock state.
 */
export class PointerDevice {
  /**
   * @param {Element} element — the element for coordinate-relative tracking
   */
  constructor(element) {
    this._element = element;
    this._target = null;
    this._enabled = true;

    this._x = 0;
    this._y = 0;
    this._dxAccum = 0;
    this._dyAccum = 0;
    this._buttons = 0;
    this._locked = false;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);

    this.attach(element);
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    this._enabled = !!value;
    if (!this._enabled) {
      this.detach();
      this._x = 0;
      this._y = 0;
      this._dxAccum = 0;
      this._dyAccum = 0;
      this._buttons = 0;
      this._locked = false;
    } else if (!this._target) {
      this.attach(this._element);
    }
  }

  /**
   * Snapshot current state and reset movement accumulators.
   * @returns {{ x: number, y: number, dx: number, dy: number, buttons: number, locked: boolean }}
   */
  poll() {
    if (!this._enabled) {
      return { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, locked: false };
    }
    const dx = this._dxAccum;
    const dy = this._dyAccum;
    this._dxAccum = 0;
    this._dyAccum = 0;
    return { x: this._x, y: this._y, dx, dy, buttons: this._buttons, locked: this._locked };
  }

  /** Request pointer lock on the element. */
  requestLock() {
    this._element.requestPointerLock();
  }

  /** Exit pointer lock. */
  exitLock() {
    document.exitPointerLock();
  }

  /** @param {Element} target */
  attach(target) {
    if (this._target) this.detach();
    this._target = target;
    this._target.addEventListener("pointermove", this._onPointerMove);
    this._target.addEventListener("pointerdown", this._onPointerDown);
    this._target.addEventListener("pointerup", this._onPointerUp);
    document.addEventListener("pointerlockchange", this._onPointerLockChange);
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("pointermove", this._onPointerMove);
    this._target.removeEventListener("pointerdown", this._onPointerDown);
    this._target.removeEventListener("pointerup", this._onPointerUp);
    document.removeEventListener("pointerlockchange", this._onPointerLockChange);
    this._target = null;
  }

  /** @private */
  _onPointerMove(e) {
    const rect = this._element.getBoundingClientRect();
    this._x = e.clientX - rect.left;
    this._y = e.clientY - rect.top;
    this._dxAccum += e.movementX;
    this._dyAccum += e.movementY;
  }

  /** @private */
  _onPointerDown(e) {
    this._buttons = e.buttons;
  }

  /** @private */
  _onPointerUp(e) {
    this._buttons = e.buttons;
  }

  /** @private */
  _onPointerLockChange() {
    this._locked = document.pointerLockElement === this._element;
  }
}
