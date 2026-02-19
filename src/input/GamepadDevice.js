/**
 * Polls navigator.getGamepads() for connected gamepad state.
 *
 * Uses gamepadconnected/gamepaddisconnected events to track which
 * indices are active, and applies a configurable dead zone to axes.
 */
export class GamepadDevice {
  /**
   * @param {object} [opts]
   * @param {number} [opts.deadZone=0.1]
   */
  constructor({ deadZone = 0.1 } = {}) {
    this._deadZone = deadZone;
    this._enabled = true;
    this._target = null;
    this._connectedIndices = new Set();

    this._onGamepadConnected = this._onGamepadConnected.bind(this);
    this._onGamepadDisconnected = this._onGamepadDisconnected.bind(this);

    // In browsers globalThis === window and has addEventListener.
    // In Node.js test environments it may not, so skip auto-attach.
    const defaultTarget = typeof globalThis.addEventListener === "function" ? globalThis : null;
    this._defaultTarget = defaultTarget;
    if (defaultTarget) this.attach(defaultTarget);
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    this._enabled = !!value;
    if (!this._enabled) {
      this.detach();
      this._connectedIndices.clear();
    } else if (!this._target && this._defaultTarget) {
      this.attach(this._defaultTarget);
    }
  }

  /**
   * Poll all connected gamepads and return their state.
   * @returns {{ gamepads: Array<{ index: number, id: string, axes: number[], buttons: boolean[] }> }}
   */
  poll() {
    if (!this._enabled || typeof navigator === "undefined" || !navigator.getGamepads) {
      return { gamepads: [] };
    }

    const raw = navigator.getGamepads();
    const gamepads = [];

    for (const gp of raw) {
      if (!gp || !gp.connected) continue;
      gamepads.push({
        index: gp.index,
        id: gp.id,
        axes: gp.axes.map((a) => Math.abs(a) < this._deadZone ? 0 : a),
        buttons: gp.buttons.map((b) => b.pressed),
      });
    }

    return { gamepads };
  }

  /** @param {EventTarget} target */
  attach(target) {
    if (this._target) this.detach();
    this._target = target;
    this._target.addEventListener("gamepadconnected", this._onGamepadConnected);
    this._target.addEventListener("gamepaddisconnected", this._onGamepadDisconnected);
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("gamepadconnected", this._onGamepadConnected);
    this._target.removeEventListener("gamepaddisconnected", this._onGamepadDisconnected);
    this._target = null;
  }

  /** @private */
  _onGamepadConnected(e) {
    this._connectedIndices.add(e.gamepad.index);
  }

  /** @private */
  _onGamepadDisconnected(e) {
    this._connectedIndices.delete(e.gamepad.index);
  }
}
