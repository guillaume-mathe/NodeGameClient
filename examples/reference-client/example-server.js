import { createServer, JSONEnvelopeCodec } from "node-game-server";

const logic = {
  createInitialState() {
    return { frame: 0, timeMs: 0, players: [] };
  },
  tick(state, actions, ctx) {
    let players = state.players;
    for (const a of actions) {
      if (a.type === "MOVE") {
        players = players.map(p =>
          p.id === a.playerId ? { ...p, x: a.x ?? p.x, y: a.y ?? p.y } : p
        );
      }
    }
    return { frame: ctx.frame, timeMs: state.timeMs + ctx.dtMs, players };
  },
  onGameEvent(state, event) {
    if (event.type === "CONNECT") {
      return { ...state, players: [...state.players, { id: event.playerId, x: 0, y: 0 }] };
    }
    if (event.type === "DISCONNECT") {
      return { ...state, players: state.players.filter(p => p.id !== event.playerId) };
    }
    return state;
  },
};

const server = createServer(logic, new JSONEnvelopeCodec(), {
  tickRateHz: 30,
  port: 8080,
});

server.start();
console.log("Server listening on ws://localhost:8080");
