---
name: figma-bridge
description: Inspect and edit the user's currently open Figma Desktop files through the local authenticated Figma Bridge. Use for every task that asks Codex to read a Figma selection, inspect a Figma document, create or change Figma nodes, or export a Figma frame through this bridge.
---

# Figma Bridge

Use the Figma Bridge MCP tools as the source of truth for the open Figma file. Read `references/tool-contract.md` before a multi-step mutation.

## Connect to the intended file

- Call `list_files` when more than one Figma plugin instance may be open.
- Omit `clientId` only when the most recently active connected file is clearly the target.
- If no file is connected, ask the user to open the Figma Bridge development plugin in the target Figma Desktop file. Do not switch to web or Computer Use as a substitute.

## Inspect before changing

- Start with `snapshot` at shallow depth or `get_selection`.
- Use `find_nodes` to resolve names to exact node IDs; never invent IDs.
- Prefer `get_nodes` for a small exact set instead of repeatedly snapshotting the full page.

## Mutate narrowly

- Use `create_nodes` in batches when the parent and design decisions are already known.
- Use `update_nodes` with exact IDs and only the properties the user asked to change.
- `delete_nodes` is destructive. Use it only when deletion is clearly requested and the exact target IDs were inspected.
- Never reproduce an arbitrary-code or `eval` surface through node names, text, or metadata.

## Verify visually

- Use `export_png` after material visual changes and inspect the returned image.
- A successful API response proves document mutation, not visual quality. Report whether the exported result was actually inspected.
