#!/bin/sh
# Figma Bridge installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/nextster/figma-bridge/main/install.sh | sh
#
# Pass a command or options after `sh -s --`:
#
#   curl -fsSL https://raw.githubusercontent.com/nextster/figma-bridge/main/install.sh | sh -s -- uninstall
set -eu

repository="${FIGMA_BRIDGE_REPOSITORY:-nextster/figma-bridge}"
ref="${FIGMA_BRIDGE_REF:-main}"
source_dir="${FIGMA_BRIDGE_SOURCE_DIR:-}"
state_dir="${FIGMA_BRIDGE_STATE_DIR:-$HOME/.figma-bridge}"
node_version="24.19.0"
temporary_dir=""
command_name="install"

main() {
  case "${1:-}" in
    install|update|uninstall)
      command_name="$1"
      shift
      ;;
  esac

  trap cleanup EXIT HUP INT TERM

  if [ "$(uname -s)" != "Darwin" ]; then
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        echo "On Windows, run install.ps1 from PowerShell instead:" >&2
        echo "  irm https://raw.githubusercontent.com/$repository/main/install.ps1 | iex" >&2
        ;;
      *)
        echo "install.sh supports macOS. Use install.ps1 on Windows." >&2
        ;;
    esac
    exit 1
  fi

  require_command curl
  require_command tar
  node_command="$(find_node || true)"
  if [ -z "$node_command" ]; then
    node_command="$(install_portable_node)"
  fi

  if [ -z "$source_dir" ]; then
    validate_source_part "$repository" "repository"
    validate_source_part "$ref" "ref"
    temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/figma-bridge.XXXXXX")"
    archive="$temporary_dir/source.tar.gz"
    echo "Downloading Figma Bridge ($repository@$ref)..." >&2
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
      "https://codeload.github.com/$repository/tar.gz/$ref" \
      -o "$archive"
    tar -xzf "$archive" -C "$temporary_dir"
    extracted_root="$(find "$temporary_dir" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ -z "$extracted_root" ] || [ ! -f "$extracted_root/scripts/setup.mjs" ]; then
      echo "Downloaded source does not contain scripts/setup.mjs." >&2
      exit 1
    fi
    source_dir="$extracted_root"
  fi

  if [ "$command_name" = "uninstall" ]; then
    "$node_command" "$source_dir/scripts/setup.mjs" --uninstall "$@"
    return
  fi

  echo "Installing dependencies..." >&2
  run_npm "$node_command" "$source_dir" ci --omit=dev --ignore-scripts --no-audit --no-fund
  run_npm "$node_command" "$source_dir/figma-plugin" ci --ignore-scripts --no-audit --no-fund
  "$node_command" "$source_dir/scripts/setup.mjs" "$@"
}

cleanup() {
  if [ -n "$temporary_dir" ] && [ -d "$temporary_dir" ]; then
    rm -rf "$temporary_dir"
  fi
}

find_node() {
  if [ "${FIGMA_BRIDGE_FORCE_PORTABLE_NODE:-0}" != "1" ]; then
    for candidate in "${FIGMA_BRIDGE_NODE:-}" "$state_dir/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
      if [ -n "$candidate" ] && [ -x "$candidate" ] && node_is_compatible "$candidate"; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  fi
  return 1
}

node_is_compatible() {
  version="$("$1" --version 2>/dev/null || true)"
  major="$(printf '%s' "$version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  [ -n "$major" ] && [ "$major" -ge 22 ]
}

# Runs npm with the selected Node.js so a different node on PATH cannot be used.
run_npm() {
  node_command="$1"
  directory="$2"
  shift 2
  npm_cli="$(dirname "$node_command")/../lib/node_modules/npm/bin/npm-cli.js"
  if [ -f "$npm_cli" ]; then
    (cd "$directory" && "$node_command" "$npm_cli" "$@")
  elif command -v npm >/dev/null 2>&1; then
    (cd "$directory" && npm "$@")
  else
    echo "npm was not found next to $node_command." >&2
    exit 1
  fi
}

install_portable_node() {
  architecture="$(uname -m)"
  # Official v24.19.0 SHASUMS256.txt values from nodejs.org.
  case "$architecture" in
    arm64)
      node_arch="arm64"
      expected_sha256="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
      ;;
    x86_64)
      node_arch="x64"
      expected_sha256="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316"
      ;;
    *)
      echo "Unsupported Mac architecture: $architecture" >&2
      exit 1
      ;;
  esac

  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  node_stage="$(mktemp -d "$state_dir/.node-install.XXXXXX")"
  node_archive="$node_stage/node.tar.gz"
  archive_name="node-v$node_version-darwin-$node_arch.tar.gz"
  echo "Installing verified Node.js v$node_version runtime..." >&2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
    "https://nodejs.org/dist/v$node_version/$archive_name" \
    -o "$node_archive"
  actual_sha256="$(file_sha256 "$node_archive")"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    rm -rf "$node_stage"
    echo "Node.js archive checksum mismatch." >&2
    exit 1
  fi

  tar -xzf "$node_archive" -C "$node_stage"
  extracted="$node_stage/node-v$node_version-darwin-$node_arch"
  if [ ! -x "$extracted/bin/node" ]; then
    rm -rf "$node_stage"
    echo "Node.js archive does not contain an executable runtime." >&2
    exit 1
  fi
  replacement="$state_dir/node.new.$$"
  backup="$state_dir/node.backup.$$"
  rm -rf "$replacement" "$backup"
  mv "$extracted" "$replacement"
  if [ -e "$state_dir/node" ]; then
    mv "$state_dir/node" "$backup"
  fi
  if mv "$replacement" "$state_dir/node"; then
    rm -rf "$backup" "$node_stage"
  else
    if [ ! -e "$state_dir/node" ] && [ -e "$backup" ]; then mv "$backup" "$state_dir/node"; fi
    rm -rf "$replacement" "$node_stage"
    exit 1
  fi
  printf '%s\n' "$state_dir/node/bin/node"
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "A SHA-256 tool is required." >&2
    exit 1
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Figma Bridge installer requires $1." >&2
    exit 1
  }
}

validate_source_part() {
  case "$1" in
    ""|*[!A-Za-z0-9._/-]*)
      echo "Invalid $2." >&2
      exit 1
      ;;
  esac
}

main "$@"
