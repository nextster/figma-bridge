import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  auth,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
  refreshAuthorization
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createOAuthServer } from "../src/oauth.mjs";
import { createOAuthStore, migrateOAuth } from "../src/oauth-store.mjs";

const REDIRECT_URL = "http://127.0.0.1:43123/callback";
const CLIENT_NAME = "Claude Code (figma-bridge)";
const ACCOUNT = "figma-account-42";
const DEVICE = "figma-device-7";

async function startRelay(t) {
  const db = new DatabaseSync(":memory:");
  migrateOAuth(db);
  const store = createOAuthStore(db);
  let oauth;
  const server = http.createServer(async (req, res) => {
    if (await oauth.handle(req, res)) return;
    if (new URL(req.url, "http://localhost").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers.authorization ?? "";
    const grant = header.startsWith("Bearer ") ? oauth.verifyAccessToken(header.slice(7)) : null;
    if (!grant) {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${oauth.resourceMetadataUrl}"` }).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ accountId: grant.accountId, clientName: grant.clientName }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  oauth = createOAuthServer({ issuer: `http://127.0.0.1:${server.address().port}`, store, logger: { error() {}, warn() {} } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  return { oauth, db };
}

function memoryProvider(tokenEndpointAuthMethod) {
  const state = crypto.randomBytes(16).toString("base64url");
  const saved = {};
  return {
    saved,
    authorizationUrl: null,
    redirectUrl: REDIRECT_URL,
    clientMetadata: {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod
    },
    state: () => state,
    clientInformation: () => saved.client,
    saveClientInformation(information) {
      saved.client = information;
    },
    tokens: () => saved.tokens,
    saveTokens(tokens) {
      saved.tokens = tokens;
    },
    redirectToAuthorization(url) {
      this.authorizationUrl = url;
    },
    saveCodeVerifier(verifier) {
      saved.verifier = verifier;
    },
    codeVerifier: () => saved.verifier
  };
}

async function callMcp(oauth, accessToken) {
  const response = await fetch(`${oauth.issuer}/mcp`, {
    method: "POST",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: "{}"
  });
  return response;
}

for (const method of ["none", "client_secret_post", "client_secret_basic"]) {
  test(`MCP SDK client connects after plugin approval (${method})`, async t => {
    const { oauth } = await startRelay(t);
    const serverUrl = oauth.resource;
    const provider = memoryProvider(method);

    const challenge = await callMcp(oauth);
    assert.equal(challenge.status, 401);
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
    assert.equal(String(resourceMetadataUrl), oauth.resourceMetadataUrl);

    assert.equal(await auth(provider, { serverUrl, resourceMetadataUrl }), "REDIRECT");
    assert.equal(provider.saved.client.token_endpoint_auth_method, method);
    assert.equal(provider.saved.client.client_secret === undefined, method === "none");
    const authorizationUrl = provider.authorizationUrl;
    assert.equal(authorizationUrl.searchParams.get("resource"), oauth.resource);
    assert.equal(authorizationUrl.searchParams.get("scope"), "figma");

    const pageResponse = await fetch(authorizationUrl);
    const html = await pageResponse.text();
    assert.equal(pageResponse.status, 200, html);
    const code = /<div class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})<\/div>/.exec(html)[1];
    const { request, secret } = JSON.parse(/const payload = (\{[^<]*?\});/.exec(html)[1]);

    const approval = oauth.lookupApproval({ code: code.toLowerCase(), accountId: ACCOUNT, deviceId: DEVICE, ip: "198.51.100.20" });
    assert.equal(approval.requestId, request);
    assert.equal(approval.clientName, CLIENT_NAME);
    assert.equal(approval.redirectKind, "loopback");
    assert.equal(approval.redirectHost, "127.0.0.1:43123");
    assert.deepEqual(oauth.decideApproval({ requestId: approval.requestId, approve: true, accountId: ACCOUNT, deviceId: DEVICE }), {
      status: "approved"
    });

    const statusResponse = await fetch(`${oauth.issuer}/oauth/authorize/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request, secret })
    });
    const status = await statusResponse.json();
    assert.equal(status.status, "approved");
    const redirect = new URL(status.redirect);
    assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URL);
    assert.equal(redirect.searchParams.get("state"), provider.state());
    assert.equal(redirect.searchParams.get("iss"), oauth.issuer);

    assert.equal(await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      authorizationCode: redirect.searchParams.get("code")
    }), "AUTHORIZED");
    const first = provider.saved.tokens;
    let response = await callMcp(oauth, first.access_token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accountId: ACCOUNT, clientName: CLIENT_NAME });

    assert.equal(await auth(provider, { serverUrl, resourceMetadataUrl }), "AUTHORIZED");
    const second = provider.saved.tokens;
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.notEqual(second.access_token, first.access_token);
    response = await callMcp(oauth, second.access_token);
    assert.equal(response.status, 200);
    await response.body.cancel();

    const metadata = await discoverAuthorizationServerMetadata(oauth.issuer);
    await assert.rejects(
      refreshAuthorization(oauth.issuer, {
        metadata,
        clientInformation: provider.saved.client,
        refreshToken: first.refresh_token,
        resource: new URL(oauth.resource)
      }),
      InvalidGrantError
    );

    const grants = oauth.listGrants(ACCOUNT);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].clientName, CLIENT_NAME);
    assert.deepEqual(oauth.listGrants(DEVICE), []);
  });
}
