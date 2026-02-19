import { KeyboardDevice } from "./KeyboardDevice.js";
import { PointerDevice } from "./PointerDevice.js";
import { GamepadDevice } from "./GamepadDevice.js";
import { TouchDevice } from "./TouchDevice.js";

/**
 * Aggregates all input devices and provides a unified poll() method.
 *
 * The user creates an InputManager, queries `inputManager.poll()` inside
 * their update callback, and calls `dispose()` when done.
 */
export class InputManager {
  /**
   * @param {object} opts
   * @param {Element} opts.target — element for pointer/touch events (required)
   * @param {boolean} [opts.keyboard=true]
   * @param {boolean} [opts.pointer=true]
   * @param {boolean} [opts.gamepad=false]
   * @param {boolean} [opts.touch=false]
   * @param {number} [opts.gamepadDeadZone=0.1]
   */
  constructor({
    target,
    keyboard: enableKeyboard = true,
    pointer: enablePointer = true,
    gamepad: enableGamepad = false,
    touch: enableTouch = false,
    gamepadDeadZone = 0.1,
  }) {
    if (!target) throw new Error("target element is required");

    this.keyboard = enableKeyboard ? new KeyboardDevice() : null;
    this.pointer = enablePointer ? new PointerDevice(target) : null;
    this.gamepad = enableGamepad ? new GamepadDevice({ deadZone: gamepadDeadZone }) : null;
    this.touch = enableTouch ? new TouchDevice(target) : null;
  }

  /**
   * Poll all enabled devices and return unified input state.
   * @returns {{
   *   keys: Set<string>,
   *   justPressed: Set<string>,
   *   justReleased: Set<string>,
   *   pointer: { x: number, y: number, dx: number, dy: number, buttons: number, locked: boolean },
   *   gamepads: Array<{ index: number, id: string, axes: number[], buttons: boolean[] }>,
   *   touches: Array<{ id: number, x: number, y: number }>,
   * }}
   */
  poll() {
    const kb = this.keyboard
      ? this.keyboard.poll()
      : { keys: new Set(), justPressed: new Set(), justReleased: new Set() };

    const ptr = this.pointer
      ? this.pointer.poll()
      : { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, locked: false };

    const gp = this.gamepad
      ? this.gamepad.poll()
      : { gamepads: [] };

    const tch = this.touch
      ? this.touch.poll()
      : { touches: [] };

    return {
      keys: kb.keys,
      justPressed: kb.justPressed,
      justReleased: kb.justReleased,
      pointer: ptr,
      gamepads: gp.gamepads,
      touches: tch.touches,
    };
  }

  /** Detach all devices and null references. */
  dispose() {
    if (this.keyboard) { this.keyboard.detach(); this.keyboard = null; }
    if (this.pointer) { this.pointer.detach(); this.pointer = null; }
    if (this.gamepad) { this.gamepad.detach(); this.gamepad = null; }
    if (this.touch) { this.touch.detach(); this.touch = null; }
  }
}
