import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "companion/src/server.mjs",
  "fly.toml",
  "plugins/figma-bridge/.claude-plugin/plugin.json",
  "relay/Dockerfile",
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
  "plugins/figma-bridge/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "plugins/figma-bridge/.mcp.json"
]) JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

for (const relative of [
  "companion/src/server.mjs",
  "companion/src/hub.mjs",
  "companion/src/plugin-auth.mjs",
  "plugins/figma-bridge/mcp/control.mjs",
  "plugins/figma-bridge/mcp/tools.mjs",
  "plugins/figma-bridge/mcp/autostart.mjs",
  "plugins/figma-bridge/mcp/local-handoff.mjs",
  "companion/src/cli.mjs",
  "runtime/runtime-bootstrap.mjs",
  "plugins/figma-bridge/mcp/server.mjs",
  "relay/src/accounts-store.mjs",
  "relay/src/app.mjs",
  "relay/src/assets.mjs",
  "relay/src/cli.mjs",
  "relay/src/codes.mjs",
  "relay/src/main.mjs",
  "relay/src/mcp-http.mjs",
  "relay/src/oauth.mjs",
  "relay/src/oauth-store.mjs",
  "relay/src/oauth-page.mjs",
  "relay/src/plugin-gateway.mjs",
  "relay/src/rate-limit.mjs",
  "scripts/lib/agent-marketplace.mjs",
  "scripts/lib/platform.mjs",
  "scripts/setup.mjs",
  "scripts/dev.mjs"
]) run(process.execPath, ["--check", path.join(root, relative)]);

// Codex ships these validators with its system skills. They are optional so
// checks also pass on machines and CI runners without a local Codex install.
const codexSkills = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", ".system");
for (const [validator, target] of [
  ["plugin-creator/scripts/validate_plugin.py", path.join(root, "plugins", "figma-bridge")],
  ["skill-creator/scripts/quick_validate.py", path.join(root, "plugins", "figma-bridge", "skills", "figma-bridge")]
]) {
  const script = path.join(codexSkills, validator);
  if (fs.existsSync(script)) run("python3", [script, target]);
  else process.stdout.write(`Skipped optional Codex validator: ${validator}\n`);
}

if (fs.existsSync(path.join(root, ".git"))) run("git", ["-C", root, "diff", "--check"]);

function run(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}
