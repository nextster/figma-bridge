import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRelay, openDatabase, relayConfig } from "./app.mjs";

const config = relayConfig(process.env);
fs.mkdirSync(path.dirname(path.resolve(config.database)), { recursive: true, mode: 0o700 });
const db = openDatabase(config.database);
const relay = createRelay({ config, db });

relay.server.listen(config.port, config.host, () => {
  console.log(`Figma Bridge relay listening on ${config.host}:${config.port} for ${config.publicUrl} (signup: ${config.signup})`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Figma Bridge relay stopping after ${signal}`);
  await relay.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
