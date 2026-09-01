# Tool contract

- `status` and `list_files` never expose the pairing token.
- `snapshot`, `get_selection`, `get_nodes`, and `find_nodes` are bounded read operations.
- `create_nodes` supports `FRAME`, `RECTANGLE`, `ELLIPSE`, and `TEXT` only.
- `update_nodes` supports name, position, size, visibility, opacity, solid RGB fill, and text characters only.
- `delete_nodes` permanently removes explicit scene-node IDs and is marked destructive.
- `export_png` returns at most 8 MiB. Lower the scale or export a smaller frame if it rejects the result.
- The plugin must remain open in each Figma file that should be available to Codex.
