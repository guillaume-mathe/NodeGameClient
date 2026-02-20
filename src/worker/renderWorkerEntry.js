/**
 * Worker-side message dispatcher for OffscreenCanvas render workers.
 *
 * Call once at the top of your worker script to wire up message handling.
 * Missing handlers are silently skipped via optional chaining.
 *
 * @param {object} [handlers]
 * @param {(canvas: OffscreenCanvas) => void} [handlers.onInit]
 * @param {(state: object) => void} [handlers.onState]
 * @param {() => void} [handlers.onStart]
 * @param {() => void} [handlers.onStop]
 * @param {(width: number, height: number) => void} [handlers.onResize]
 * @param {(data: any) => void} [handlers.onMessage]
 * @returns {{ postMessage(msg: any, transfer?: Transferable[]): void }}
 */
export function createRenderWorker(handlers = {}) {
  globalThis.onmessage = (event) => {
    const { type } = event.data;

    switch (type) {
      case "init":
        handlers.onInit?.(event.data.canvas);
        break;
      case "state":
        handlers.onState?.(event.data.state);
        break;
      case "start":
        handlers.onStart?.();
        break;
      case "stop":
        handlers.onStop?.();
        break;
      case "resize":
        handlers.onResize?.(event.data.width, event.data.height);
        break;
      default:
        handlers.onMessage?.(event.data);
        break;
    }
  };

  return {
    postMessage(msg, transfer) {
      globalThis.postMessage(msg, transfer);
    },
  };
}
