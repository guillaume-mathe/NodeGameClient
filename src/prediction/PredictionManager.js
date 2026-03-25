import { ActionBuffer } from "./actionBuffer.js";

/**
 * Client-side prediction with server reconciliation.
 *
 * Applies a user-supplied `predict` function immediately when actions are sent,
 * then reconciles with authoritative server state as it arrives. Unacknowledged
 * actions are re-applied on top of each new server state to maintain a smooth
 * predicted view.
 *
 * **ECS mode:** When a `world` option is provided, the predict function receives
 * `(world, action)` and mutates the World in place. On reconciliation the World
 * is restored to the server authoritative state via `world.applySnapshot()` and
 * pending actions are re-applied.
 */
export class PredictionManager {
  /**
   * @param {object} opts
   * @param {import('../net/Connection.js').Connection} opts.connection - Connection instance (required)
   * @param {(state: object, action: object) => object} opts.predict - Prediction function (required).
   *   Plain mode: `(state, action) => newState`.
   *   ECS mode: `(world, action) => void` (mutates world).
   * @param {((serverState: object, previousPredictedState: object) => void)|null} [opts.onMisprediction] - Optional misprediction callback
   * @param {number} [opts.capacity] - Action buffer size (default: 64)
   * @param {object|null} [opts.world=null] - ECS World instance for ECS-aware prediction
   */
  constructor({ connection, predict, onMisprediction, capacity, world } = {}) {
    this._connection = connection;
    this._predict = predict;
    this._onMisprediction = onMisprediction ?? null;
    this._actionBuffer = new ActionBuffer(capacity ?? 64);
    this._predictedState = null;
    this._world = world ?? null;

    this._unsubscribe = connection.onStateChange((state) => this._reconcile(state));
  }

  /** ECS World instance, or `null` if not in ECS mode. */
  get world() {
    return this._world;
  }

  /**
   * Send an action through the connection with client-side prediction.
   *
   * Computes a targetFrame based on current latency, forwards the action to
   * the connection, buffers it for reconciliation, and immediately applies the
   * predict function to update predictedState.
   *
   * @param {object} action - The action to send (must have a `type` field)
   */
  sendAction(action) {
    const conn = this._connection;
    const frameDurationMs = 1000 / conn.tickRateHz;
    const latestFrame = conn.state?.frame ?? conn.serverFrame;
    const targetFrame = latestFrame + Math.max(1, Math.round(conn.rtt / 2 / frameDurationMs));

    conn.sendAction({ ...action, targetFrame });

    const clientSeq = conn._clientSeq;
    this._actionBuffer.push({ action, clientSeq, targetFrame });

    if (this._world) {
      this._predict(this._world, action);
    } else {
      const baseState = this._predictedState ?? conn.state;
      if (baseState) {
        this._predictedState = this._predict(baseState, action);
      }
    }
  }

  /**
   * Reconcile predicted state with authoritative server state.
   * Called on every onStateChange from the connection.
   * @private
   * @param {object} serverState
   */
  _reconcile(serverState) {
    const previousPredicted = this._world
      ? this._serializeWorld(serverState)
      : this._predictedState;

    this._actionBuffer.discardThrough(serverState.frame);

    if (this._world) {
      this._world.applySnapshot({ entities: serverState.entities });
      for (const entry of this._actionBuffer.entries()) {
        this._predict(this._world, entry.action);
      }
    } else {
      let predicted = serverState;
      for (const entry of this._actionBuffer.entries()) {
        predicted = this._predict(predicted, entry.action);
      }
      this._predictedState = predicted;
    }

    if (this._onMisprediction && previousPredicted !== null) {
      this._onMisprediction(serverState, previousPredicted);
    }
  }

  /**
   * The current predicted state, or `null` if no state has been received yet.
   * In ECS mode, returns a serialized snapshot of the World with frame/timeMs metadata.
   */
  get predictedState() {
    if (this._world) {
      const connState = this._connection.state;
      if (!connState) return null;
      return this._serializeWorld(connState);
    }
    return this._predictedState;
  }

  /** @private Build a state object from the World with frame/timeMs from the given state. */
  _serializeWorld(refState) {
    const snap = this._world.serialize();
    return { frame: refState.frame, timeMs: refState.timeMs, entities: snap.entities };
  }

  /** Number of unacknowledged actions in the buffer. */
  get pendingCount() {
    return this._actionBuffer.count;
  }

  /**
   * Unsubscribe from connection, clear action buffer, reset predicted state.
   */
  dispose() {
    this._unsubscribe();
    this._actionBuffer.clear();
    this._predictedState = null;
  }
}
