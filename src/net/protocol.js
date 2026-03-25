/** Keys that are part of the delta envelope/protocol, not game state fields. */
export const DELTA_PROTOCOL_KEYS = new Set([
  "kind", "frame", "baseFrame", "timeMs",
  "added", "removed", "updated", "_removedKeys",
  "entities",
]);

/** Message kind constants. */
export const SYNC_REQUEST = "sync_request";
export const SYNC_RESPONSE = "sync_response";
export const SYNC_RESULT = "sync_result";
export const SNAPSHOT = "snapshot";
export const DELTA = "delta";
export const GAME_EVENT = "game_event";
export const ACK = "ack";
export const LOGOUT = "logout";

/**
 * Default delta applier — handles the standard diffState format:
 * player changes ({ added, removed, updated } keyed on players[].id)
 * plus any changed non-player top-level state fields.
 *
 * @param {object} state  Current client state
 * @param {object} msg    Delta message from server
 * @returns {object}      New state with delta applied
 */
export function defaultApplyDelta(state, msg) {
  let players = state.players;
  if (msg.removed?.length) {
    const gone = new Set(msg.removed);
    players = players.filter(p => !gone.has(p.id));
  }
  if (msg.added?.length) players = players.concat(msg.added);
  if (msg.updated?.length) {
    const updates = new Map(msg.updated.map(p => [p.id, p]));
    players = players.map(p => updates.has(p.id) ? { ...p, ...updates.get(p.id) } : p);
  }

  const result = { ...state, frame: msg.frame, timeMs: msg.timeMs, players };

  // Merge changed non-player state fields
  for (const key of Object.keys(msg)) {
    if (!DELTA_PROTOCOL_KEYS.has(key)) {
      result[key] = msg[key];
    }
  }

  // Remove keys that were deleted from server state
  if (msg._removedKeys?.length) {
    for (const key of msg._removedKeys) {
      delete result[key];
    }
  }

  return result;
}

/**
 * ECS delta applier — handles the structured entity diff format:
 * each entry in `msg.entities` has `{ id, op, components?, removed? }`.
 *
 * @param {object} state  Current client state (`{ frame, timeMs, entities }`)
 * @param {object} msg    Delta message from server
 * @returns {object}      New state with delta applied
 */
export function defaultApplyECSDelta(state, msg) {
  let entities = state.entities ? state.entities.slice() : [];

  for (const entry of msg.entities) {
    switch (entry.op) {
      case "add":
        entities.push({ id: entry.id, components: { ...entry.components } });
        break;

      case "update": {
        const idx = entities.findIndex(e => e.id === entry.id);
        if (idx !== -1) {
          const components = { ...entities[idx].components };
          if (entry.components) {
            for (const name of Object.keys(entry.components)) {
              components[name] = { ...components[name], ...entry.components[name] };
            }
          }
          if (entry.removed) {
            for (const name of entry.removed) {
              delete components[name];
            }
          }
          entities[idx] = { id: entry.id, components };
        }
        break;
      }

      case "remove":
        entities = entities.filter(e => e.id !== entry.id);
        break;
    }
  }

  return { frame: msg.frame, timeMs: msg.timeMs, entities };
}
