import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await fs.mkdir(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/code.ts")],
  outfile: path.join(dist, "code.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  define: { __html__: JSON.stringify(await fs.readFile(path.join(root, "src/ui.html"), "utf8")) }
});
await fs.copyFile(path.join(root, "src/ui.html"), path.join(dist, "ui.html"));
