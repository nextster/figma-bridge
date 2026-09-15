# Security

Report vulnerabilities privately to the repository owner. Do not include live pairing tokens, device secrets, OAuth tokens, invite codes, or Figma document data in reports.

## Local mode

Local mode is designed for a single-user computer. The companion binds only to loopback and authenticates Figma plugin connections. It is not a network service and must not be exposed through a reverse proxy or port forward.

First-time automatic pairing accepts only the Figma plugin's expected browser origins and requires an explicit approval dialog on the computer (a native dialog on macOS, a system-modal popup on Windows). The companion then returns the existing random token over that loopback WebSocket, and Figma stores it in `clientStorage`. Ordinary reconnects continue to require the token; it is never exposed through MCP status or logs.

MCP adapters reach the companion through a 0600 Unix socket or, on Windows, a named pipe with a random per-install name. Both directions of every control message are authenticated with an HMAC key stored only in the owner's state file, and requests carry a nonce and timestamp so they cannot be replayed.

## Relay mode

The relay is an internet-facing service. Its threat model assumes attackers can reach every HTTP and WebSocket endpoint.

- MCP access requires OAuth 2.1 access tokens bound to the relay's `/mcp` resource. Clients register dynamically, must use PKCE S256, and may redirect only to loopback apps, the Claude callbacks, or explicitly configured URIs. Refresh tokens rotate; reusing an old one revokes the whole connection.
- The authorization page never grants access by itself and never notifies plugins. A request is approved only when the user types its one-time code into Figma Bridge in a Figma file signed in to the account, reviews the app name, and allows it. Codes expire after ten minutes and are stored only as hashes. Never enter a code that someone else sent you: approving it grants that person access to your Figma files.
- Accounts are created only from invites (unless the operator opens signups). Plugin installations authenticate as devices with random secrets stored as hashes on the relay and in Figma `clientStorage` on the computer. Additional devices join with ten-minute link codes, and devices can be removed from the plugin.
- Tool calls are routed only to Figma files connected by the account that owns the OAuth grant.
- The relay does not store design data. SwiftUI handoff assets stay in memory for 30 minutes behind unguessable download URLs, and are served as sandboxed attachments so SVG files cannot run script on the relay origin.
- Registration, approval lookups, OAuth endpoints, and plugin calls are rate limited per client address and globally.
