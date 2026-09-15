# Relay operations

The relay lets Figma Bridge work without a local companion: Figma plugins connect outbound to `wss://<relay>/plugin`, and MCP clients use `https://<relay>/mcp` with OAuth. The reference deployment is the Fly.io app in [fly.toml](../fly.toml).

## Deploy

Deploying changes a public service; do it only when the owner asks.

```bash
fly apps create figma-bridge
fly volumes create figma_bridge_data --region fra --size 1
fly deploy
```

Configuration lives in `fly.toml`:

| Variable | Meaning |
| --- | --- |
| `FIGMA_BRIDGE_PUBLIC_URL` | HTTPS origin used as OAuth issuer and resource, for example `https://figma-bridge.fly.dev`. |
| `FIGMA_BRIDGE_DB` | SQLite database on the volume. |
| `FIGMA_BRIDGE_SIGNUP` | `invite` (default), `open`, or `closed` (only device links). |
| `FIGMA_BRIDGE_TRUST_PROXY` | `fly` to rate-limit by the `Fly-Client-IP` header. Leave empty elsewhere. |
| `FIGMA_BRIDGE_OAUTH_REDIRECT_URIS` | Optional comma-separated extra HTTPS redirect URIs for other hosted MCP clients. |

Run exactly one machine. Plugin connections and pending tool calls are routed in memory.

## Invites

```bash
fly ssh console -C "node relay/src/cli.mjs invite --note laptop --days 7"
```

Give the printed code to the person who should get a new account. They enter it in the plugin under **Relay**. Invites are single-use. To add your own second computer or browser to an existing account, use **Link another Figma** in the plugin instead.

## Self-hosting under another domain

Figma plugins can reach only domains listed in the manifest, so a different relay host needs a rebuilt development plugin:

1. Set the host in `figma-plugin/manifest.json` (`allowedDomains`), `figma-plugin/scripts/build.mjs` (`DEFAULT_RELAY_URL`), `plugins/figma-bridge/.mcp.json`, and `fly.toml`.
2. Run `npm run verify`, then import the manifest again in Figma Desktop.

## Data handled

- Stored: invite hashes, account ids, device names and secret hashes, OAuth clients, request metadata (client address and user agent for pending requests), grants, and token hashes.
- Not stored: Figma document content. Tool arguments and results pass through memory only; handoff assets are kept in memory for 30 minutes.
- Logs contain no tokens, codes, secrets, or tool payloads. Request logging (`FIGMA_BRIDGE_LOG_REQUESTS=true`) records only method, path, status, and duration.

## Local testing

```bash
FIGMA_BRIDGE_PUBLIC_URL=http://localhost:8787 PORT=8787 HOST=127.0.0.1 FIGMA_BRIDGE_DB=./relay.db npm run relay
FIGMA_BRIDGE_DB=./relay.db node relay/src/cli.mjs invite
FIGMA_BRIDGE_RELAY_URL=ws://localhost:8787/plugin npm run build
```

Import the rebuilt plugin in Figma Desktop, choose **Relay**, and add `http://localhost:8787/mcp` to a client.
