import { GameClient } from "./GameClient.js";
import { randomUUID } from "node:crypto";

const client = new GameClient("ws://localhost:8080", { token: randomUUID() });

client.onConnect(({ rtt, playerId, resumed, serverFrame, tickRateHz }) => {
  console.log(`Connected as ${playerId} (rtt=${rtt}ms, frame=${serverFrame}, ${tickRateHz}Hz, resumed=${resumed})`);
});

client.onStateChange((state) => {
  console.log(`State frame=${state.frame}, players=${state.players.length}`, state.players);
});

client.onGameEvent((event) => {
  console.log("Game event:", event);
});

client.onDisconnect(({ code, reason, willReconnect }) => {
  console.log(`Disconnected (code=${code}, reason=${reason}, willReconnect=${willReconnect})`);
});

await client.connect();
console.log(`Synced! playerId=${client.playerId}`);

// Send a few moves
for (let i = 1; i <= 5; i++) {
  client.sendAction({ type: "MOVE", x: i * 10, y: i * 5 });
  await new Promise(r => setTimeout(r, 200));
}

client.disconnect();
console.log("Done.");
