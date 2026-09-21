import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
export const DEFAULT_RELAY_URL = "wss://figma-bridge.fly.dev/plugin";
const relayUrl = process.env.FIGMA_BRIDGE_RELAY_URL || DEFAULT_RELAY_URL;
if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?\/plugin$|^ws:\/\/localhost:\d+\/plugin$/.test(relayUrl)) {
  throw new Error("FIGMA_BRIDGE_RELAY_URL must be wss://<host>/plugin, or ws://localhost:<port>/plugin for development");
}
const auth = await fs.readFile(path.join(root, "src/bridge-auth.js"), "utf8");
const html = (await fs.readFile(path.join(root, "src/ui.html"), "utf8"))
  .replace("__FIGMA_BRIDGE_RELAY_URL__", relayUrl)
  .replace("/*__FIGMA_BRIDGE_AUTH__*/", () => `\n${auth}`);

await fs.mkdir(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/code.ts")],
  outfile: path.join(dist, "code.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  define: { __html__: JSON.stringify(html) }
});
await fs.writeFile(path.join(dist, "ui.html"), html);
