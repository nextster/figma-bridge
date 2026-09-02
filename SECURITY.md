# Security

Report vulnerabilities privately to the repository owner. Do not include live pairing tokens or Figma document data in reports.

Figma Bridge is designed for a single-user local machine. It binds only to loopback and authenticates Figma plugin connections. It is not a network service and must not be exposed through a reverse proxy or port forward.

First-time automatic pairing accepts only the Figma plugin's expected browser origins and requires an explicit local macOS approval. The companion then returns the existing random token over that loopback WebSocket, and Figma stores it in `clientStorage`. Ordinary reconnects continue to require the token; it is never exposed through MCP status or logs.
