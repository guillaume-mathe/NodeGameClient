import {
  Connection,
  GameLoop,
  InputManager,
  StateStore,
  lerpEntity,
} from "/dist/node-game-client.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

const SPEED = 5;
const PLAYER_SIZE = 30;

// ---- Setup ----

const connection = new Connection("ws://localhost:8080", {
  token: crypto.randomUUID(),
  autoAck: true,
});

const inputManager = new InputManager({
  target: canvas,
  keyboard: true,
  pointer: false,
  gamepad: false,
  touch: false,
});

let stateStore = null;
let loop = null;

// ---- Update (fixed timestep) ----

function update(sendAction) {
  const input = inputManager.poll();
  let dx = 0;
  let dy = 0;

  if (input.keys.has("KeyW") || input.keys.has("ArrowUp")) dy -= SPEED;
  if (input.keys.has("KeyS") || input.keys.has("ArrowDown")) dy += SPEED;
  if (input.keys.has("KeyA") || input.keys.has("ArrowLeft")) dx -= SPEED;
  if (input.keys.has("KeyD") || input.keys.has("ArrowRight")) dx += SPEED;

  if (dx !== 0 || dy !== 0) {
    sendAction({ type: "MOVE", dx, dy });
  }
}

// ---- Render (every rAF frame) ----

function render(_state, alpha, _timestamp) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const interpolated = stateStore?.getInterpolatedState();
  if (!interpolated) return;

  const { prev, next, alpha: storeAlpha } = interpolated;
  const prevPlayers = prev.players ?? [];
  const nextPlayers = next.players ?? [];

  // Build lookup for prev players by id
  const prevById = new Map(prevPlayers.map((p) => [p.id, p]));

  for (const np of nextPlayers) {
    const pp = prevById.get(np.id) ?? np;
    const player = lerpEntity(pp, np, storeAlpha, ["x", "y"]);
    const isLocal = player.id === connection.playerId;

    // Player square
    const hue = player.hue ?? 200;
    ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
    ctx.fillRect(
      player.x - PLAYER_SIZE / 2,
      player.y - PLAYER_SIZE / 2,
      PLAYER_SIZE,
      PLAYER_SIZE,
    );

    // Local player border
    if (isLocal) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        player.x - PLAYER_SIZE / 2,
        player.y - PLAYER_SIZE / 2,
        PLAYER_SIZE,
        PLAYER_SIZE,
      );
    }

    // Player ID label
    ctx.fillStyle = "#fff";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(
      player.id,
      player.x,
      player.y - PLAYER_SIZE / 2 - 4,
    );
  }

  // HUD
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "12px monospace";
  ctx.textAlign = "left";
  ctx.fillText(`FPS: ${Math.round(loop?.fps ?? 0)}`, 8, 16);
  ctx.fillText(`Players: ${nextPlayers.length}`, 8, 30);
  ctx.fillText(`Ping: ${Math.round(connection.rtt)}ms`, 8, 44);
}

// ---- Connect and start ----

async function main() {
  try {
    await connection.connect();

    statusEl.classList.add("connected");
    statusEl.innerHTML = '<span class="dot"></span>Connected';

    stateStore = new StateStore({ connection });
    loop = new GameLoop({ connection, update, render });
    loop.start();
  } catch (err) {
    statusEl.innerHTML =
      '<span class="dot"></span>Connection failed — is the server running?';
    console.error("Failed to connect:", err);
  }
}

connection.onDisconnect(() => {
  statusEl.classList.remove("connected");
  statusEl.innerHTML = '<span class="dot"></span>Disconnected';
});

// ---- Cleanup ----

window.addEventListener("beforeunload", () => {
  loop?.stop();
  inputManager.dispose();
  stateStore?.dispose();
  connection.disconnect();
});

main();
