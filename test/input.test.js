import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KeyboardDevice } from "../src/input/KeyboardDevice.js";
import { PointerDevice } from "../src/input/PointerDevice.js";
import { GamepadDevice } from "../src/input/GamepadDevice.js";
import { TouchDevice } from "../src/input/TouchDevice.js";
import { InputManager } from "../src/input/InputManager.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Creates a mock EventTarget that stores handlers and can fire events. */
function createMockTarget() {
  const handlers = {};

  return {
    addEventListener(type, handler) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(handler);
    },
    removeEventListener(type, handler) {
      if (!handlers[type]) return;
      handlers[type] = handlers[type].filter((h) => h !== handler);
    },
    /** Fire a synthetic event to all listeners of the given type. */
    fire(type, eventProps = {}) {
      for (const h of handlers[type] ?? []) h(eventProps);
    },
    /** Check if any listeners are registered for the given type. */
    hasListeners(type) {
      return (handlers[type] ?? []).length > 0;
    },
  };
}

/** Creates a mock element with getBoundingClientRect and EventTarget methods. */
function createMockElement(rect = { left: 0, top: 0, width: 800, height: 600 }) {
  const target = createMockTarget();
  return {
    ...target,
    getBoundingClientRect: () => rect,
    requestPointerLock() {},
  };
}

// ---------------------------------------------------------------------------
// Document mock for pointer lock
// ---------------------------------------------------------------------------

let origDoc;

function installMockDocument() {
  origDoc = globalThis.document;
  const docTarget = createMockTarget();
  globalThis.document = {
    addEventListener: docTarget.addEventListener,
    removeEventListener: docTarget.removeEventListener,
    fire: docTarget.fire,
    pointerLockElement: null,
    exitPointerLock() {},
  };
}

function cleanupMockDocument() {
  if (origDoc !== undefined) globalThis.document = origDoc;
  else delete globalThis.document;
}

// ---------------------------------------------------------------------------
// globalThis EventTarget mock (for KeyboardDevice default target in Node)
// ---------------------------------------------------------------------------

let origGlobalAddEventListener;
let origGlobalRemoveEventListener;
let globalMockTarget;

function installGlobalEventTarget() {
  origGlobalAddEventListener = globalThis.addEventListener;
  origGlobalRemoveEventListener = globalThis.removeEventListener;
  globalMockTarget = createMockTarget();
  globalThis.addEventListener = globalMockTarget.addEventListener;
  globalThis.removeEventListener = globalMockTarget.removeEventListener;
}

function cleanupGlobalEventTarget() {
  if (origGlobalAddEventListener !== undefined) {
    globalThis.addEventListener = origGlobalAddEventListener;
  } else {
    delete globalThis.addEventListener;
  }
  if (origGlobalRemoveEventListener !== undefined) {
    globalThis.removeEventListener = origGlobalRemoveEventListener;
  } else {
    delete globalThis.removeEventListener;
  }
  globalMockTarget = null;
}

// ---------------------------------------------------------------------------
// Navigator mock for gamepads
// ---------------------------------------------------------------------------

let origGetGamepads;

function installMockNavigator(gamepads = []) {
  origGetGamepads = navigator.getGamepads;
  Object.defineProperty(navigator, "getGamepads", {
    value: () => gamepads,
    writable: true,
    configurable: true,
  });
}

function cleanupMockNavigator() {
  if (origGetGamepads !== undefined) {
    Object.defineProperty(navigator, "getGamepads", {
      value: origGetGamepads,
      writable: true,
      configurable: true,
    });
  } else {
    delete navigator.getGamepads;
  }
}

// ---------------------------------------------------------------------------
// KeyboardDevice
// ---------------------------------------------------------------------------

describe("KeyboardDevice", () => {
  let target;
  let device;

  beforeEach(() => {
    target = createMockTarget();
    device = new KeyboardDevice(target);
  });

  afterEach(() => {
    device.detach();
  });

  it("tracks currently held keys", () => {
    target.fire("keydown", { code: "KeyW", repeat: false });
    target.fire("keydown", { code: "KeyA", repeat: false });

    const state = device.poll();
    expect(state.keys.has("KeyW")).toBe(true);
    expect(state.keys.has("KeyA")).toBe(true);

    target.fire("keyup", { code: "KeyW" });
    const state2 = device.poll();
    expect(state2.keys.has("KeyW")).toBe(false);
    expect(state2.keys.has("KeyA")).toBe(true);
  });

  it("justPressed/justReleased accumulate between polls and reset after poll", () => {
    target.fire("keydown", { code: "KeyW", repeat: false });
    target.fire("keydown", { code: "KeyA", repeat: false });

    const state1 = device.poll();
    expect(state1.justPressed.has("KeyW")).toBe(true);
    expect(state1.justPressed.has("KeyA")).toBe(true);
    expect(state1.justReleased.size).toBe(0);

    // After poll, accumulators should be cleared
    const state2 = device.poll();
    expect(state2.justPressed.size).toBe(0);

    // Release a key — should appear in next poll's justReleased
    target.fire("keyup", { code: "KeyW" });
    const state3 = device.poll();
    expect(state3.justReleased.has("KeyW")).toBe(true);
  });

  it("ignores key repeat events", () => {
    target.fire("keydown", { code: "KeyW", repeat: false });
    device.poll(); // clear accumulators

    target.fire("keydown", { code: "KeyW", repeat: true });
    const state = device.poll();
    expect(state.justPressed.size).toBe(0);
  });

  it("disabled device returns empty state", () => {
    target.fire("keydown", { code: "KeyW", repeat: false });
    device.enabled = false;

    const state = device.poll();
    expect(state.keys.size).toBe(0);
    expect(state.justPressed.size).toBe(0);
    expect(state.justReleased.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PointerDevice
// ---------------------------------------------------------------------------

describe("PointerDevice", () => {
  let element;
  let device;

  beforeEach(() => {
    installMockDocument();
    element = createMockElement();
    device = new PointerDevice(element);
  });

  afterEach(() => {
    device.detach();
    cleanupMockDocument();
  });

  it("tracks position relative to element", () => {
    element.fire("pointermove", {
      clientX: 100, clientY: 200,
      movementX: 5, movementY: 10,
    });

    const state = device.poll();
    expect(state.x).toBe(100);
    expect(state.y).toBe(200);
  });

  it("accumulates movement delta, resets after poll", () => {
    element.fire("pointermove", { clientX: 10, clientY: 10, movementX: 5, movementY: 3 });
    element.fire("pointermove", { clientX: 20, clientY: 20, movementX: 10, movementY: 7 });

    const state1 = device.poll();
    expect(state1.dx).toBe(15);
    expect(state1.dy).toBe(10);

    // After poll, deltas should be reset
    const state2 = device.poll();
    expect(state2.dx).toBe(0);
    expect(state2.dy).toBe(0);
  });

  it("tracks button state from pointerdown/pointerup", () => {
    element.fire("pointerdown", { buttons: 1 });
    const state1 = device.poll();
    expect(state1.buttons).toBe(1);

    element.fire("pointerup", { buttons: 0 });
    const state2 = device.poll();
    expect(state2.buttons).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GamepadDevice
// ---------------------------------------------------------------------------

describe("GamepadDevice", () => {
  let device;

  afterEach(() => {
    if (device) device.detach();
    cleanupMockNavigator();
  });

  it("polls navigator.getGamepads() and returns axes/buttons", () => {
    installMockNavigator([
      {
        connected: true,
        index: 0,
        id: "Xbox Controller",
        axes: [0.5, -0.8, 0.0, 0.0],
        buttons: [{ pressed: true }, { pressed: false }],
      },
    ]);

    device = new GamepadDevice({ deadZone: 0.1 });
    const state = device.poll();

    expect(state.gamepads).toHaveLength(1);
    expect(state.gamepads[0].id).toBe("Xbox Controller");
    expect(state.gamepads[0].axes[0]).toBe(0.5);
    expect(state.gamepads[0].buttons[0]).toBe(true);
    expect(state.gamepads[0].buttons[1]).toBe(false);
  });

  it("applies dead zone to axes", () => {
    installMockNavigator([
      {
        connected: true,
        index: 0,
        id: "Gamepad",
        axes: [0.05, -0.03, 0.5, -0.8],
        buttons: [],
      },
    ]);

    device = new GamepadDevice({ deadZone: 0.1 });
    const state = device.poll();

    // Below dead zone → snapped to 0
    expect(state.gamepads[0].axes[0]).toBe(0);
    expect(state.gamepads[0].axes[1]).toBe(0);
    // Above dead zone → pass through
    expect(state.gamepads[0].axes[2]).toBe(0.5);
    expect(state.gamepads[0].axes[3]).toBe(-0.8);
  });
});

// ---------------------------------------------------------------------------
// TouchDevice
// ---------------------------------------------------------------------------

describe("TouchDevice", () => {
  let element;
  let device;

  beforeEach(() => {
    element = createMockElement();
    device = new TouchDevice(element);
  });

  afterEach(() => {
    device.detach();
  });

  it("tracks active touches with element-relative positions", () => {
    element.fire("touchstart", {
      changedTouches: [
        { identifier: 0, clientX: 100, clientY: 200 },
        { identifier: 1, clientX: 300, clientY: 400 },
      ],
    });

    const state = device.poll();
    expect(state.touches).toHaveLength(2);
    expect(state.touches.find((t) => t.id === 0)).toEqual({ id: 0, x: 100, y: 200 });
    expect(state.touches.find((t) => t.id === 1)).toEqual({ id: 1, x: 300, y: 400 });
  });

  it("removes touches on touchend/touchcancel", () => {
    element.fire("touchstart", {
      changedTouches: [
        { identifier: 0, clientX: 100, clientY: 200 },
        { identifier: 1, clientX: 300, clientY: 400 },
      ],
    });

    element.fire("touchend", {
      changedTouches: [{ identifier: 0, clientX: 100, clientY: 200 }],
    });

    const state1 = device.poll();
    expect(state1.touches).toHaveLength(1);
    expect(state1.touches[0].id).toBe(1);

    element.fire("touchcancel", {
      changedTouches: [{ identifier: 1, clientX: 300, clientY: 400 }],
    });

    const state2 = device.poll();
    expect(state2.touches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// InputManager
// ---------------------------------------------------------------------------

describe("InputManager", () => {
  let element;

  beforeEach(() => {
    installGlobalEventTarget();
    installMockDocument();
    installMockNavigator([]);
    element = createMockElement();
  });

  afterEach(() => {
    cleanupMockDocument();
    cleanupMockNavigator();
    cleanupGlobalEventTarget();
  });

  it("poll() returns unified InputState from all enabled devices", () => {
    const mgr = new InputManager({
      target: element,
      keyboard: true,
      pointer: true,
      gamepad: true,
      touch: true,
    });

    const state = mgr.poll();

    // Keyboard fields
    expect(state.keys).toBeInstanceOf(Set);
    expect(state.justPressed).toBeInstanceOf(Set);
    expect(state.justReleased).toBeInstanceOf(Set);

    // Pointer fields
    expect(state.pointer).toHaveProperty("x");
    expect(state.pointer).toHaveProperty("y");
    expect(state.pointer).toHaveProperty("dx");
    expect(state.pointer).toHaveProperty("dy");
    expect(state.pointer).toHaveProperty("buttons");
    expect(state.pointer).toHaveProperty("locked");

    // Gamepad/touch fields
    expect(Array.isArray(state.gamepads)).toBe(true);
    expect(Array.isArray(state.touches)).toBe(true);

    mgr.dispose();
  });

  it("disabled devices return empty/default state", () => {
    const mgr = new InputManager({
      target: element,
      keyboard: false,
      pointer: false,
      gamepad: false,
      touch: false,
    });

    const state = mgr.poll();

    expect(state.keys.size).toBe(0);
    expect(state.justPressed.size).toBe(0);
    expect(state.justReleased.size).toBe(0);
    expect(state.pointer.x).toBe(0);
    expect(state.pointer.buttons).toBe(0);
    expect(state.gamepads).toHaveLength(0);
    expect(state.touches).toHaveLength(0);

    mgr.dispose();
  });

  it("dispose() detaches all devices", () => {
    const mgr = new InputManager({
      target: element,
      keyboard: true,
      pointer: true,
      gamepad: false,
      touch: false,
    });

    mgr.dispose();

    expect(mgr.keyboard).toBeNull();
    expect(mgr.pointer).toBeNull();
    expect(mgr.gamepad).toBeNull();
    expect(mgr.touch).toBeNull();
  });
});
