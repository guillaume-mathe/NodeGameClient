import { createServer, JSONEnvelopeCodec } from "node-game-server";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const CANVAS_W = 800;
const CANVAS_H = 600;

// ---- Game logic ----

const logic = {
  createInitialState() {
    return { frame: 0, timeMs: 0, players: [] };
  },
  tick(state, actions, ctx) {
    let players = state.players;
    for (const a of actions) {
      if (a.type === "MOVE") {
        players = players.map((p) => {
          if (p.id !== a.playerId) return p;
          const x = Math.max(0, Math.min(CANVAS_W, p.x + (a.dx ?? 0)));
          const y = Math.max(0, Math.min(CANVAS_H, p.y + (a.dy ?? 0)));
          return { ...p, x, y };
        });
      }
    }
    return { frame: ctx.frame, timeMs: state.timeMs + ctx.dtMs, players };
  },
  onGameEvent(state, event) {
    if (event.type === "CONNECT") {
      const hue = Math.floor(Math.random() * 360);
      return {
        ...state,
        players: [
          ...state.players,
          { id: event.playerId, x: CANVAS_W / 2, y: CANVAS_H / 2, hue },
        ],
      };
    }
    if (event.type === "DISCONNECT") {
      return {
        ...state,
        players: state.players.filter((p) => p.id !== event.playerId),
      };
    }
    return state;
  },
};

const gameServer = createServer(logic, new JSONEnvelopeCodec(), {
  tickRateHz: 30,
  port: 8080,
});

gameServer.start();
console.log("Game server listening on ws://localhost:8080");

// ---- Static HTTP server ----

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".map": "application/json",
  ".css": "text/css",
};

const routes = {
  "/": join(__dirname, "index.html"),
  "/game.js": join(__dirname, "game.js"),
};

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Static route match
  if (routes[url.pathname]) {
    return serve(res, routes[url.pathname]);
  }

  // Serve NodeGameClient dist files
  if (url.pathname.startsWith("/dist/node-game-client")) {
    const file = url.pathname.slice("/dist/".length);
    if (file.includes("..")) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    return serve(res, join(__dirname, "..", "..", "dist", file));
  }

  // Serve NodeGameInputManager dist files
  if (url.pathname.startsWith("/dist/node-game-input-manager")) {
    const file = url.pathname.slice("/dist/".length);
    if (file.includes("..")) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    return serve(res, join(__dirname, "..", "..", "..", "NodeGameInputManager", "dist", file));
  }

  res.writeHead(404);
  res.end("Not found");
});

async function serve(res, filePath) {
  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

httpServer.listen(3000, () => {
  console.log("HTTP server listening on http://localhost:3000");
});
