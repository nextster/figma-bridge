import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ".agents/plugins/marketplace.json",
  "companion/src/server.mjs",
  "runtime/runtime-bootstrap.mjs",
  "figma-plugin/manifest.json",
  "plugins/figma-bridge/.codex-plugin/plugin.json",
  "plugins/figma-bridge/.mcp.json",
  "plugins/figma-bridge/mcp/server.mjs",
  "plugins/figma-bridge/skills/figma-bridge/SKILL.md"
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`missing required file: ${relative}`);
}

for (const relative of [
  "package.json",
  ".agents/plugins/marketplace.json",
  "figma-plugin/manifest.json",
  "plugins/figma-bridge/.codex-plugin/plugin.json",
  "plugins/figma-bridge/.mcp.json"
]) JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

for (const relative of [
  "companion/src/server.mjs",
  "companion/src/client.mjs",
  "companion/src/cli.mjs",
  "runtime/runtime-bootstrap.mjs",
  "plugins/figma-bridge/mcp/server.mjs",
  "scripts/setup.mjs",
  "scripts/dev.mjs"
]) run(process.execPath, ["--check", path.join(root, relative)]);

run("python3", [
  "/Users/artem/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py",
  path.join(root, "plugins", "figma-bridge")
]);
run("python3", [
  "/Users/artem/.codex/skills/.system/skill-creator/scripts/quick_validate.py",
  path.join(root, "plugins", "figma-bridge", "skills", "figma-bridge")
]);

if (fs.existsSync(path.join(root, ".git"))) run("git", ["-C", root, "diff", "--check"]);

function run(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}
