# Publishing the Figma plugin

Figma Bridge ships as a development plugin that you import from `figma-plugin/manifest.json` in Figma Desktop. It is not published, for two reasons checked against Figma's documentation on 2026-09-15.

## Community is not an option

Figma's [plugin review guidelines](https://help.figma.com/hc/en-us/articles/360039958914-Plugin-and-widget-review-guidelines) say Figma generally does not approve plugins that expose an MCP server or otherwise provide programmatic AI access to Figma files outside Figma's official MCP server, and plugins may not require separately installed packages that manipulate Figma. Figma Bridge does both. Figma's [brand guidelines](https://www.figma.com/using-the-figma-brand/) also forbid "Figma" in product names and domains.

## Private organization publishing

[Internal plugins](https://help.figma.com/hc/en-us/articles/4404228629655-Create-internal-plugins-for-an-organization) are available only on Organization and Enterprise plans. They are not reviewed and are available to every member of the organization. If the project moves to such a plan, the owner would:

1. Enable two-factor authentication on the Figma account.
2. Add `"enablePrivatePluginApi": true` to the manifest so `figma.fileKey` works (the plugin already falls back to a random per-run id without it).
3. Prepare a 128 × 128 icon, an optional 1920 × 1080 thumbnail, a tagline, a description that explains relay and local modes, a support contact, and a privacy policy if other people will use the relay.
4. In Figma Desktop open a file, choose **Plugins → Manage plugins → … → Publish**, set **Publish to** to the organization, and review the network access disclosure (the manifest `reasoning` explains the companion and relay domains).
5. Accept Figma's developer terms in that flow. Only the account owner can do this.

Published plugins, unlike development plugins, also run in the Figma web app, which relay mode supports.
