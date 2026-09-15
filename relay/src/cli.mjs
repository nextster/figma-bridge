#!/usr/bin/env node
// Relay administration. On Fly.io run for example:
//   fly ssh console -C "node relay/src/cli.mjs invite --note laptop"
import process from "node:process";
import { createAccountsStore } from "./accounts-store.mjs";
import { openDatabase } from "./app.mjs";

const [command, ...args] = process.argv.slice(2);
const database = process.env.FIGMA_BRIDGE_DB || "/data/figma-bridge.db";

if (command === "invite") {
  const db = openDatabase(database);
  const days = Number(option("--days") || 7);
  if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error("--days must be between 1 and 90");
  const invite = createAccountsStore(db).createInvite({ note: option("--note") || "", ttlMs: days * 24 * 60 * 60_000 });
  db.close();
  process.stdout.write(`Invite code: ${invite.code}\nExpires: ${invite.expiresAt}\nEnter it in the Figma Bridge plugin under Relay.\n`);
} else {
  process.stderr.write("usage: node relay/src/cli.mjs invite [--note text] [--days 7]\n");
  process.exitCode = 1;
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
