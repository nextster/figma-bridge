// Platform helpers for setup and development scripts. Functions take the
// platform and filesystem probes as arguments so Windows paths can be tested
// on macOS.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const LAUNCH_AGENT_LABEL = "dev.nextster.figma-bridge";
export const WINDOWS_STARTUP_FILE = "Figma Bridge companion.vbs";

/**
 * Homebrew's process.execPath points into a versioned Cellar directory that
 * disappears after `brew upgrade node`. Prefer the stable prefix symlink.
 */
export function stableNodePath(execPath, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const match = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!match) return execPath;
  const [, prefix, formula] = match;
  for (const candidate of [path.posix.join(prefix, "opt", formula, "bin", "node"), path.posix.join(prefix, "bin", "node")]) {
    try {
      if (exists(candidate) && realpath(candidate) === realpath(execPath)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return execPath;
}

/** Finds an executable on PATH, honoring PATHEXT on Windows. */
export function findExecutable(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(value => value.toLowerCase())
    : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Node refuses to spawn .cmd/.bat files without a shell. Run them through
 * cmd.exe with each argument quoted instead of enabling shell parsing.
 */
export function commandInvocation(executable, args, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const line = [executable, ...args].map(quoteWindowsArgument).join(" ");
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true }
    };
  }
  return { command: executable, args, options: {} };
}

export function quoteWindowsArgument(value) {
  const text = String(value);
  if (/[\r\n"%]/.test(text)) throw new Error(`Unsupported character in Windows command argument: ${JSON.stringify(text)}`);
  return `"${text}"`;
}

export function runTool(name, args, { check = true, env = process.env, platform = process.platform } = {}) {
  const executable = findExecutable(name, { env, platform });
  if (!executable) {
    if (check) throw new Error(`${name} was not found on PATH`);
    return { status: null, stdout: "", stderr: `${name} was not found on PATH`, missing: true };
  }
  const invocation = commandInvocation(executable, args, { platform, env });
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsHide: true, ...invocation.options });
  if (check && result.status !== 0) throw new Error(`${name} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result;
}

export function launchAgentPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function launchAgentPlist({ nodePath, bootstrap, stateDir, home = os.homedir() }) {
  return plist({
    Label: LAUNCH_AGENT_LABEL,
    ProgramArguments: [
      "/usr/bin/env",
      "-i",
      `HOME=${home}`,
      "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      nodePath,
      bootstrap,
      "companion"
    ],
    RunAtLoad: true,
    // A second companion exits successfully when the port is already owned;
    // launchd should only restart real failures.
    KeepAlive: { SuccessfulExit: false },
    StandardOutPath: path.join(stateDir, "companion.log"),
    StandardErrorPath: path.join(stateDir, "companion.error.log")
  });
}

export function windowsStartupDirectory(env = process.env) {
  const appData = env.APPDATA || path.win32.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming");
  return path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/** A hidden launcher so the companion starts at sign-in without a console window. */
export function windowsStartupScript({ nodePath, bootstrap }) {
  const quote = value => `""${String(value).replaceAll('"', '""')}""`;
  return [
    "' Starts the Figma Bridge companion at sign-in without a console window.",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run "${quote(nodePath)} ${quote(bootstrap)} companion", 0, False`,
    ""
  ].join("\r\n");
}

export function claudeDesktopConfigPath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return null;
}

/** Adds or removes only the figma-bridge entry and preserves everything else. */
export function updateClaudeDesktopConfig(existingText, entry) {
  const config = existingText && existingText.trim() ? JSON.parse(existingText) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("claude_desktop_config.json must contain a JSON object");
  const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? { ...config.mcpServers } : {};
  if (entry) servers["figma-bridge"] = entry;
  else delete servers["figma-bridge"];
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
}

export function writePrivateJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function plist(value) {
  const body = Object.entries(value).map(([key, item]) => `  <key>${escapeXml(key)}</key>\n${plistValue(item, "  ")}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function plistValue(value, indent) {
  if (Array.isArray(value)) return `${indent}<array>\n${value.map(item => `${indent}  <string>${escapeXml(item)}</string>`).join("\n")}\n${indent}</array>`;
  if (value === true) return `${indent}<true/>`;
  if (value === false) return `${indent}<false/>`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>\n${plistValue(item, `${indent}  `)}`);
    return `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
  }
  return `${indent}<string>${escapeXml(String(value))}</string>`;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
