import { ActionBuffer } from "./actionBuffer.js";

/**
 * Client-side prediction with server reconciliation.
 *
 * Applies a user-supplied `predict` function immediately when actions are sent,
 * then reconciles with authoritative server state as it arrives. Unacknowledged
 * actions are re-applied on top of each new server state to maintain a smooth
 * predicted view.
 */
export class PredictionManager {
  /**
   * @param {object} opts
   * @param {import('../net/Connection.js').Connection} opts.connection - Connection instance (required)
   * @param {(state: object, action: object) => object} opts.predict - Prediction function (required)
   * @param {((serverState: object, previousPredictedState: object) => void)|null} [opts.onMisprediction] - Optional misprediction callback
   * @param {number} [opts.capacity] - Action buffer size (default: 64)
   */
  constructor({ connection, predict, onMisprediction, capacity } = {}) {
    this._connection = connection;
    this._predict = predict;
    this._onMisprediction = onMisprediction ?? null;
    this._actionBuffer = new ActionBuffer(capacity ?? 64);
    this._predictedState = null;

    this._unsubscribe = connection.onStateChange((state) => this._reconcile(state));
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

    const baseState = this._predictedState ?? conn.state;
    if (baseState) {
      this._predictedState = this._predict(baseState, action);
    }
  }

  /**
   * Reconcile predicted state with authoritative server state.
   * Called on every onStateChange from the connection.
   * @private
   * @param {object} serverState
   */
  _reconcile(serverState) {
    const previousPredicted = this._predictedState;

    this._actionBuffer.discardThrough(serverState.frame);

    let predicted = serverState;
    for (const entry of this._actionBuffer.entries()) {
      predicted = this._predict(predicted, entry.action);
    }
    this._predictedState = predicted;

    if (this._onMisprediction && previousPredicted !== null) {
      this._onMisprediction(serverState, previousPredicted);
    }
  }

  /** The current predicted state, or `null` if no actions have been sent. */
  get predictedState() {
    return this._predictedState;
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
