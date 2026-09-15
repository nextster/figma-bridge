import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOAuthServer, normalizeApprovalCode } from "../src/oauth.mjs";
import { createOAuthStore, migrateOAuth } from "../src/oauth-store.mjs";

const TEST_REDIRECT = "http://127.0.0.1:43123/callback";
const ACCOUNT = "account-owner";
const DEVICE = "device-owner";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const VERIFIER = "v".repeat(64);
const silentLogger = { error() {}, warn() {}, info() {} };

async function createHarness(t, { wrapStore = store => store, ...options } = {}) {
  const clock = createClock();
  const db = new DatabaseSync(":memory:");
  migrateOAuth(db);
  const store = createOAuthStore(db, { now: clock.now });
  const revoked = [];
  let oauth;
  const server = http.createServer(async (req, res) => {
    if (await oauth.handle(req, res)) return;
    if (new URL(req.url, "http://localhost").pathname === "/mcp") {
      protectedMcp(oauth, req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  oauth = createOAuthServer({
    issuer: origin,
    store: wrapStore(store),
    now: clock.now,
    logger: silentLogger,
    clientIp: req => req.headers["x-test-ip"] ?? req.socket.remoteAddress,
    onGrantRevoked: event => revoked.push(event),
    ...options
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  const h = {
    clock,
    db,
    store,
    oauth,
    origin,
    revoked,

    async register(metadata, headers = {}) {
      const response = await fetch(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof metadata === "string" ? metadata : JSON.stringify(metadata)
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },

    async registerPublicClient(metadata = {}) {
      const { status, body } = await h.register({
        client_name: "Codex",
        redirect_uris: [TEST_REDIRECT],
        token_endpoint_auth_method: "none",
        ...metadata
      });
      assert.equal(status, 201, JSON.stringify(body));
      return body;
    },

    authorizeUrl(clientId, overrides = {}) {
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        state: "state-1",
        code_challenge: challengeFor(VERIFIER),
        code_challenge_method: "S256",
        resource: `${origin}/mcp`
      });
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) query.delete(key);
        else query.set(key, value);
      }
      return `${origin}/oauth/authorize?${query}`;
    },

    // Loads the authorization page like a browser.
    async openPage(url, headers = {}) {
      const response = await fetch(url, { headers, redirect: "manual" });
      const html = await response.text();
      assert.equal(response.status, 200, html);
      return { ...parsePage(html), response, html };
    },

    async status(requestId, secret) {
      const response = await fetch(`${origin}/oauth/authorize/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: requestId, secret })
      });
      return { httpStatus: response.status, ...(await response.json()) };
    },

    lookup(code, identity = {}) {
      return oauth.lookupApproval({ code, accountId: ACCOUNT, deviceId: DEVICE, ...identity });
    },

    // Opens the page, lets the plugin look up and decide the typed code, and
    // returns the redirect the browser page would follow.
    async approve(url, { approve = true, accountId = ACCOUNT, deviceId = DEVICE } = {}) {
      const page = await h.openPage(url);
      assert.equal((await h.status(page.requestId, page.secret)).status, "pending");
      const approval = oauth.lookupApproval({ code: page.code, accountId, deviceId });
      assert.equal(approval.requestId, page.requestId);
      assert.deepEqual(oauth.decideApproval({ requestId: approval.requestId, approve, accountId, deviceId }), {
        status: approve ? "approved" : "denied"
      });
      assert.equal((await h.status(page.requestId, "wrong-secret")).status, "expired");
      return (await h.status(page.requestId, page.secret)).redirect;
    },

    async authorizeManually(options = {}) {
      const client = await h.registerPublicClient();
      const redirect = new URL(await h.approve(h.authorizeUrl(client.client_id), options));
      return { clientId: client.client_id, verifier: VERIFIER, redirect };
    },

    async connect(options = {}) {
      const { clientId, verifier, redirect } = await h.authorizeManually(options);
      const { status, body } = await h.token({
        grant_type: "authorization_code",
        client_id: clientId,
        code: redirect.searchParams.get("code"),
        code_verifier: verifier
      });
      assert.equal(status, 200, JSON.stringify(body));
      return { clientId, tokens: body };
    },

    async token(form, { headers = {}, path = "/oauth/token" } = {}) {
      const body = form instanceof URLSearchParams ? form : new URLSearchParams(form);
      const response = await fetch(`${origin}${path}`, { method: "POST", headers, body });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
    },

    async mcpStatus(token) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: "{}"
      });
      await response.body?.cancel();
      return { status: response.status, challenge: response.headers.get("www-authenticate") };
    }
  };
  return h;
}

function protectedMcp(oauth, req, res) {
  const header = req.headers.authorization ?? "";
  const grant = header.startsWith("Bearer ") ? oauth.verifyAccessToken(header.slice(7)) : null;
  if (!grant) {
    res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${oauth.resourceMetadataUrl}"` }).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accountId: grant.accountId }));
}

function createClock(start = Date.UTC(2026, 0, 1)) {
  let current = start;
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    }
  };
}

function challengeFor(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function parsePage(html) {
  const code = /<div class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})<\/div>/.exec(html);
  const payload = /const payload = (\{[^<]*?\});/.exec(html);
  assert.ok(code && payload, `authorization page is missing request data: ${html}`);
  const { request, secret } = JSON.parse(payload[1]);
  return { code: code[1], requestId: request, secret };
}

function assertErrorPage(response, html, status) {
  assert.equal(response.status, status, html);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(html, /Connection failed/);
  assert.doesNotMatch(html, /<script/);
}

function lookupFails(fn, code) {
  assert.throws(fn, error => error.code === code);
}

test("metadata documents advertise the issuer, resource, and PKCE", async t => {
  const h = await createHarness(t);
  const resource = await (await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${h.origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [h.origin]);
  assert.deepEqual(resource.scopes_supported, ["figma"]);
  const root = await (await fetch(`${h.origin}/.well-known/oauth-protected-resource`)).json();
  assert.equal(root.resource, h.origin);

  const response = await fetch(`${h.origin}/.well-known/oauth-authorization-server`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const server = await response.json();
  assert.equal(server.issuer, h.origin);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.equal(server.registration_endpoint, `${h.origin}/oauth/register`);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ["none", "client_secret_basic", "client_secret_post"]);
  assert.equal(server.authorization_response_iss_parameter_supported, true);

  const preflight = await fetch(`${h.origin}/.well-known/oauth-authorization-server`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type, MCP-Protocol-Version");
  const head = await fetch(`${h.origin}/.well-known/oauth-protected-resource`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const post = await fetch(`${h.origin}/.well-known/oauth-authorization-server`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");

  const wrongMethod = await fetch(`${h.origin}/oauth/token`, { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  const unmatched = await fetch(`${h.origin}/oauth/unknown`);
  assert.equal(unmatched.status, 404);
});

test("protected resource challenge advertises metadata for forged tokens", async t => {
  const h = await createHarness(t);
  const { status, challenge } = await h.mcpStatus("fba_forged");
  assert.equal(status, 401);
  assert.equal(challenge, `Bearer resource_metadata="${h.origin}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal(h.oauth.verifyAccessToken("fbr_not-an-access-token"), null);
  assert.equal(h.oauth.verifyAccessToken(undefined), null);
});

test("registration accepts only loopback and trusted callbacks", async t => {
  const h = await createHarness(t, { extraRedirectUris: [" https://relay.example/callback ", ""] });
  const cases = new Map([
    ["http://localhost:5555/callback", 201],
    ["http://[::1]:5555/callback", 201],
    ["http://127.0.0.1/callback?tenant=1", 201],
    ["https://claude.ai/api/mcp/auth_callback", 201],
    ["https://claude.com/api/mcp/auth_callback", 201],
    ["https://relay.example/callback", 201],
    ["https://claude.ai/api/mcp/auth_callback/", 400],
    ["https://evil.example/callback", 400],
    ["http://evil.example/callback", 400],
    ["cursor://anysphere.cursor-mcp/oauth", 400],
    ["http://127.0.0.1:5555/callback#fragment", 400],
    ["http://user@127.0.0.1:5555/callback", 400],
    ["http://127.0.0.1:5555\\@evil.example/callback", 400],
    ["http:/localhost/callback", 400],
    ["//localhost/callback", 400]
  ]);
  for (const [uri, expected] of cases) {
    const { status, body } = await h.register({ redirect_uris: [uri], token_endpoint_auth_method: "none" });
    assert.equal(status, expected, `${uri}: ${JSON.stringify(body)}`);
    if (expected === 400) assert.equal(body.error, "invalid_redirect_uri");
  }
});

test("registration validates metadata and returns secrets only for confidential clients", async t => {
  const h = await createHarness(t);
  const defaults = await h.register({ redirect_uris: [TEST_REDIRECT], client_name: "  Claude   Co\tde\n Desktop  " });
  assert.equal(defaults.status, 201);
  assert.equal(defaults.headers.get("access-control-allow-origin"), "*");
  assert.match(defaults.body.client_id, /^fbc_/);
  assert.equal(defaults.body.token_endpoint_auth_method, "client_secret_basic");
  assert.deepEqual(defaults.body.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(defaults.body.response_types, ["code"]);
  assert.equal(defaults.body.client_name, "Claude Code Desktop");
  assert.equal(typeof defaults.body.client_secret, "string");
  assert.equal(defaults.body.client_secret_expires_at, 0);
  assert.equal(defaults.body.client_id_issued_at, Math.floor(h.clock.now().getTime() / 1000));
  const stored = h.store.getClient(defaults.body.client_id);
  assert.equal(stored.secretHash, crypto.createHash("sha256").update(defaults.body.client_secret).digest("hex"));

  const publicClient = await h.register({ redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: "none" });
  assert.equal(publicClient.body.client_secret, undefined);
  assert.equal(publicClient.body.client_name, undefined);

  const longName = await h.register({ redirect_uris: [TEST_REDIRECT], client_name: "x".repeat(100) });
  assert.equal(longName.body.client_name.length, 60);

  const invalid = [
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: Array(11).fill(TEST_REDIRECT) }, "invalid_redirect_uri"],
    [{ redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    [{ redirect_uris: [TEST_REDIRECT], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ redirect_uris: [TEST_REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
    [{ redirect_uris: TEST_REDIRECT }, "invalid_client_metadata"],
    [{ redirect_uris: [TEST_REDIRECT], client_name: 7 }, "invalid_client_metadata"],
    ["not json", "invalid_client_metadata"],
    [JSON.stringify({ redirect_uris: [TEST_REDIRECT], client_name: "x".repeat(70 * 1024) }), "invalid_client_metadata"]
  ];
  for (const [metadata, error] of invalid) {
    const { status, body } = await h.register(metadata);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.error, error);
  }
});

test("registration is rate limited per IP and globally", async t => {
  const h = await createHarness(t);
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await h.register({ redirect_uris: [TEST_REDIRECT] }, { "x-test-ip": "192.0.2.1" })).status, 201);
  }
  const limited = await h.register({ redirect_uris: [TEST_REDIRECT] }, { "x-test-ip": "192.0.2.1" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "temporarily_unavailable");
  // The request rejected per IP still counted against the global window.
  for (let index = 21; index < 200; index += 1) {
    assert.equal((await h.register({ redirect_uris: [TEST_REDIRECT] }, { "x-test-ip": `192.0.2.${index}` })).status, 201);
  }
  assert.equal((await h.register({ redirect_uris: [TEST_REDIRECT] }, { "x-test-ip": "198.51.100.1" })).status, 429);
  h.clock.advance(HOUR);
  assert.equal((await h.register({ redirect_uris: [TEST_REDIRECT] }, { "x-test-ip": "192.0.2.1" })).status, 201);
});

test("authorization code is single-use and bound to PKCE", async t => {
  const h = await createHarness(t);
  const { clientId, verifier, redirect } = await h.authorizeManually();
  const code = redirect.searchParams.get("code");
  assert.equal(redirect.searchParams.get("state"), "state-1");
  assert.equal(redirect.searchParams.get("iss"), h.origin);
  assert.ok(code);
  assert.equal(`${redirect.origin}${redirect.pathname}`, TEST_REDIRECT);
  const form = { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: TEST_REDIRECT };

  let result = await h.token({ ...form, code_verifier: "x".repeat(43) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_grant");
  result = await h.token({ ...form, code_verifier: verifier, redirect_uri: "http://127.0.0.1:43123/other" });
  assert.equal(result.body.error_description, "redirect_uri does not match the authorization request");

  result = await h.token({ ...form, code_verifier: verifier });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.token_type, "Bearer");
  assert.equal(result.body.expires_in, 3600);
  assert.equal(result.body.scope, "figma");
  assert.match(result.body.access_token, /^fba_/);
  assert.match(result.body.refresh_token, /^fbr_/);
  assert.equal(result.headers.get("pragma"), "no-cache");
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await h.mcpStatus(result.body.access_token)).status, 200);

  result = await h.token({ ...form, code_verifier: verifier });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_grant");
});

test("authorization codes expire and belong to the requesting client", async t => {
  const h = await createHarness(t);
  const { clientId, verifier, redirect } = await h.authorizeManually();
  const other = await h.registerPublicClient();
  const code = redirect.searchParams.get("code");
  let result = await h.token({ grant_type: "authorization_code", client_id: other.client_id, code, code_verifier: verifier });
  assert.equal(result.body.error, "invalid_grant");
  h.clock.advance(2 * MINUTE);
  result = await h.token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier });
  assert.equal(result.body.error_description, "authorization code is invalid or expired");
});

test("denied approval redirects with access_denied", async t => {
  const h = await createHarness(t);
  const { redirect } = await h.authorizeManually({ approve: false });
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("error_description"), "the Figma Bridge user denied access");
  assert.equal(redirect.searchParams.get("code"), null);
  assert.equal(redirect.searchParams.get("state"), "state-1");
  assert.equal(redirect.searchParams.get("iss"), h.origin);
});

test("refresh rotates tokens and revoke disconnects", async t => {
  const h = await createHarness(t);
  const { clientId, tokens: first } = await h.connect();
  const refreshForm = { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token };
  const second = await h.token(refreshForm);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.refresh_token, first.refresh_token);

  let result = await h.token(refreshForm);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_grant");
  result = await h.token({ grant_type: "refresh_token", client_id: "fbc_other", refresh_token: second.body.refresh_token });
  assert.equal(result.status, 401);
  assert.equal((await h.mcpStatus(second.body.access_token)).status, 200);

  result = await h.token({ client_id: clientId, token: second.body.refresh_token }, { path: "/oauth/revoke" });
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(result.headers.get("cache-control"), "no-store");
  for (const token of [first.access_token, second.body.access_token]) {
    assert.equal((await h.mcpStatus(token)).status, 401);
  }
  result = await h.token({ client_id: clientId, token: "unknown" }, { path: "/oauth/revoke" });
  assert.equal(result.status, 200);
});

test("revocation ignores tokens of other clients", async t => {
  const h = await createHarness(t);
  const { tokens } = await h.connect();
  const other = await h.registerPublicClient();
  const result = await h.token({ client_id: other.client_id, token: tokens.access_token }, { path: "/oauth/revoke" });
  assert.equal(result.status, 200);
  assert.equal((await h.mcpStatus(tokens.access_token)).status, 200);
});

test("authorize rejects mismatched redirect and missing PKCE without redirecting", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  let response = await fetch(h.authorizeUrl(clientId, { redirect_uri: "http://127.0.0.1:1/other", code_challenge: undefined }), { redirect: "manual" });
  assertErrorPage(response, await response.text(), 400);
  response = await fetch(h.authorizeUrl(clientId, { redirect_uri: "http://127.0.0.1:9999/callback", code_challenge: undefined }), { redirect: "manual" });
  const html = await response.text();
  assertErrorPage(response, html, 400);
  assert.match(html, /PKCE S256/);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM oauth_requests").get().count, 0);
});

test("pre-approval errors render an error page instead of redirecting", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const cases = [
    [h.authorizeUrl("fbc_unknown"), 400, /not registered/],
    [h.authorizeUrl(clientId, { redirect_uri: "https://claude.ai/api/mcp/auth_callback" }), 400, /redirect address/],
    [h.authorizeUrl(clientId, { response_type: "token" }), 400, /unsupported response type/],
    [h.authorizeUrl(clientId, { code_challenge_method: "plain" }), 400, /PKCE S256/],
    [h.authorizeUrl(clientId, { code_challenge: "short" }), 400, /PKCE S256/],
    [h.authorizeUrl(clientId, { resource: "https://other.example/mcp" }), 400, /different resource/],
    [`${h.authorizeUrl(clientId)}&resource=${encodeURIComponent("https://other.example/mcp")}`, 400, /different resource/]
  ];
  for (const [url, status, message] of cases) {
    const response = await fetch(url, { redirect: "manual" });
    const html = await response.text();
    assertErrorPage(response, html, status);
    assert.match(html, message);
  }
  for (let index = 0; index < 20; index += 1) await h.openPage(h.authorizeUrl(clientId), { "x-test-ip": "192.0.2.50" });
  const limited = await fetch(h.authorizeUrl(clientId), { headers: { "x-test-ip": "192.0.2.50" }, redirect: "manual" });
  const html = await limited.text();
  assertErrorPage(limited, html, 429);
  assert.match(html, /Too many connection requests/);
});

test("authorize resolves loopback redirects on any port and a single registered URI", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId, { redirect_uri: "http://127.0.0.1:50001/callback" }));
  assert.equal(h.store.getRequest(page.requestId).redirectUri, "http://127.0.0.1:50001/callback");
  const omitted = await h.openPage(h.authorizeUrl(clientId, { redirect_uri: undefined, resource: undefined }));
  assert.equal(h.store.getRequest(omitted.requestId).redirectUri, TEST_REDIRECT);
  for (const redirect of ["http://localhost:50001/callback", "http://127.0.0.1:50001/other", "http://127.0.0.1:50001/callback?x=1"]) {
    const response = await fetch(h.authorizeUrl(clientId, { redirect_uri: redirect }));
    assertErrorPage(response, await response.text(), 400);
  }
  const multi = await h.registerPublicClient({ redirect_uris: [TEST_REDIRECT, "http://localhost:43123/callback"] });
  const response = await fetch(h.authorizeUrl(multi.client_id, { redirect_uri: undefined }));
  assertErrorPage(response, await response.text(), 400);
});

test("authorize rejects HEAD and limits requests per IP", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const head = await fetch(h.authorizeUrl(clientId), { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
  const post = await fetch(h.authorizeUrl(clientId), { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  for (let index = 0; index < 20; index += 1) await h.openPage(h.authorizeUrl(clientId));
  const limited = await fetch(h.authorizeUrl(clientId));
  assert.equal(limited.status, 429);
  await limited.body.cancel();
  h.clock.advance(HOUR);
  await h.openPage(h.authorizeUrl(clientId));
});

test("pending authorization requests are capped", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  for (let index = 0; index < 20; index += 1) {
    await h.openPage(h.authorizeUrl(clientId), { "x-test-ip": `203.0.113.${index}` });
  }
  const response = await fetch(h.authorizeUrl(clientId), { headers: { "x-test-ip": "203.0.113.99" } });
  const html = await response.text();
  assertErrorPage(response, html, 429);
  assert.match(html, /unfinished connection requests/);
  h.clock.advance(10 * MINUTE);
  await h.openPage(h.authorizeUrl(clientId), { "x-test-ip": "203.0.113.99" });
});

test("authorize retries approval code collisions with fresh codes", async t => {
  const attempts = [];
  let conflicts = 1;
  const h = await createHarness(t, {
    wrapStore: store => ({
      ...store,
      createRequest(request, limits) {
        attempts.push({ id: request.id, approvalHash: request.approvalHash });
        if (attempts.length <= conflicts) throw Object.assign(new Error("duplicate"), { code: "conflict" });
        return store.createRequest(request, limits);
      }
    })
  });
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].approvalHash, attempts[1].approvalHash);
  assert.notEqual(attempts[0].id, attempts[1].id);
  assert.equal(page.requestId, attempts[1].id);

  attempts.length = 0;
  conflicts = Infinity;
  const response = await fetch(h.authorizeUrl(clientId));
  assertErrorPage(response, await response.text(), 500);
  assert.equal(attempts.length, 5);
});

test("approved request mints one code only before expiry", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();

  const page = await h.openPage(h.authorizeUrl(clientId));
  const approval = h.lookup(page.code);
  h.oauth.decideApproval({ requestId: approval.requestId, approve: true, accountId: ACCOUNT, deviceId: DEVICE });
  const first = await h.status(page.requestId, page.secret);
  assert.equal(first.status, "approved");
  assert.match(first.redirect, /code=/);
  const second = await h.status(page.requestId, page.secret);
  assert.deepEqual(second, { httpStatus: 200, status: "done" });

  const late = await h.openPage(h.authorizeUrl(clientId));
  const lateApproval = h.lookup(late.code);
  h.oauth.decideApproval({ requestId: lateApproval.requestId, approve: true, accountId: ACCOUNT, deviceId: DEVICE });
  h.clock.advance(11 * MINUTE);
  assert.deepEqual(await h.status(late.requestId, late.secret), { httpStatus: 200, status: "expired" });
  assert.equal(h.store.getRequest(late.requestId).codeHash, "");

  const pending = await h.openPage(h.authorizeUrl(clientId));
  h.clock.advance(10 * MINUTE);
  assert.equal((await h.status(pending.requestId, pending.secret)).status, "expired");
});

test("status endpoint requires the browser secret and a bounded JSON body", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId));
  assert.deepEqual(await h.status(page.requestId, ""), { httpStatus: 404, status: "expired" });
  assert.deepEqual(await h.status("unknown", page.secret), { httpStatus: 404, status: "expired" });
  for (const body of ["not json", JSON.stringify({ request: 1 }), JSON.stringify({ request: page.requestId, secret: "x".repeat(5000) })]) {
    const response = await fetch(`${h.origin}/oauth/authorize/status`, { method: "POST", body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid" });
  }
  assert.equal(h.store.getRequest(page.requestId).browserHash, crypto.createHash("sha256").update(page.secret).digest("hex"));
});

test("reused refresh token revokes the connection only after the grace window", async t => {
  const h = await createHarness(t);
  const { clientId, tokens: first } = await h.connect();
  const oldRefresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token };
  const second = await h.token(oldRefresh);
  assert.equal(second.status, 200);

  let result = await h.token(oldRefresh);
  assert.equal(result.body.error, "invalid_grant");
  assert.equal(result.body.error_description, "refresh token is invalid, expired, or revoked");
  assert.equal((await h.mcpStatus(second.body.access_token)).status, 200);
  assert.deepEqual(h.revoked, []);

  h.clock.advance(MINUTE);
  result = await h.token(oldRefresh);
  assert.equal(result.status, 400);
  assert.equal(result.body.error_description, "refresh token was already used; the connection was revoked");
  assert.equal((await h.mcpStatus(second.body.access_token)).status, 401);
  result = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: second.body.refresh_token });
  assert.equal(result.status, 400);
  assert.deepEqual(h.revoked, [{ accountId: ACCOUNT, clientName: "Codex", reason: "refresh_token_reuse" }]);
  assert.deepEqual(h.oauth.listGrants(ACCOUNT), []);
});

test("refresh stops after the maximum grant lifetime", async t => {
  const h = await createHarness(t);
  const { clientId, tokens } = await h.connect();
  const createdAt = h.clock.now().getTime();
  let refreshToken = tokens.refresh_token;
  for (const days of [80, 80, 80, 80, 44]) {
    h.clock.advance(days * DAY);
    const result = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    refreshToken = result.body.refresh_token;
  }
  const [grant] = h.oauth.listGrants(ACCOUNT);
  assert.equal(grant.expiresAt.getTime(), createdAt + 365 * DAY);

  h.clock.advance(2 * DAY);
  const expired = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, "invalid_grant");
  assert.deepEqual(h.oauth.listGrants(ACCOUNT), []);
  assert.deepEqual(h.revoked, []);
});

test("refresh tokens expire and require the refresh prefix and resource", async t => {
  const h = await createHarness(t);
  const { clientId, tokens } = await h.connect();
  let result = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.access_token });
  assert.equal(result.body.error_description, "refresh token is invalid");
  result = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource: "https://other.example" });
  assert.equal(result.body.error_description, "refresh token is invalid");
  h.clock.advance(91 * DAY);
  result = await h.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
  assert.equal(result.body.error_description, "refresh token is invalid, expired, or revoked");
});

test("client authentication supports none, basic, and post", async t => {
  const h = await createHarness(t);
  const basic = (await h.register({ redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).body;
  const post = (await h.register({ redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: "client_secret_post" })).body;
  const publicClient = await h.registerPublicClient();
  const authorization = (id, secret) => ({
    Authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`
  });
  const attempt = (form, headers) => h.token({ grant_type: "password", ...form }, { headers });
  const authenticated = { status: 400, error: "unsupported_grant_type" };
  const rejected = { status: 401, error: "invalid_client" };
  const summary = result => ({ status: result.status, error: result.body.error });

  assert.deepEqual(summary(await attempt({}, authorization(basic.client_id, basic.client_secret))), authenticated);
  assert.deepEqual(summary(await attempt({ client_id: basic.client_id }, authorization(basic.client_id, basic.client_secret))), authenticated);
  assert.deepEqual(summary(await attempt({ client_id: post.client_id }, authorization(basic.client_id, basic.client_secret))), rejected);
  assert.deepEqual(summary(await attempt({ client_id: basic.client_id, client_secret: basic.client_secret })), rejected);
  assert.deepEqual(summary(await attempt({}, authorization(basic.client_id, "wrong"))), rejected);

  assert.deepEqual(summary(await attempt({ client_id: post.client_id, client_secret: post.client_secret })), authenticated);
  assert.deepEqual(summary(await attempt({}, authorization(post.client_id, post.client_secret))), rejected);
  assert.deepEqual(summary(await attempt({ client_id: post.client_id })), rejected);

  assert.deepEqual(summary(await attempt({ client_id: publicClient.client_id })), authenticated);
  const unknown = await attempt({ client_id: "fbc_unknown" });
  assert.deepEqual(summary(unknown), rejected);
  assert.equal(unknown.headers.get("www-authenticate"), 'Basic realm="figma-bridge-oauth"');
  assert.deepEqual(summary(await attempt({})), rejected);
  assert.deepEqual(summary(await attempt({}, { Authorization: "Basic %%%" })), rejected);
  assert.deepEqual(summary(await attempt({}, authorization("%zz", "secret"))), rejected);
});

test("token endpoint parses only bounded form bodies and validates resource indicators", async t => {
  const h = await createHarness(t);
  const { clientId, verifier, redirect } = await h.authorizeManually();
  const code = redirect.searchParams.get("code");
  const json = await fetch(`${h.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId })
  });
  assert.equal(json.status, 401);
  assert.equal((await json.json()).error, "invalid_client");

  for (const body of ["client_id=%zz", "client_id=a;b", `client_id=${clientId}&pad=${"x".repeat(65 * 1024)}`]) {
    const response = await fetch(`${h.origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request", error_description: "token request must be form-encoded" });
  }

  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier });
  form.append("resource", `${h.origin}/mcp`);
  form.append("resource", "https://other.example/mcp");
  let result = await h.token(form);
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "invalid_target", error_description: `resource must be ${h.origin}/mcp` });

  const valid = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier });
  valid.append("resource", `${h.origin}/mcp/`);
  valid.append("resource", `${h.origin}/`);
  result = await h.token(valid);
  assert.equal(result.status, 200, JSON.stringify(result.body));
});

test("token and revocation endpoints are rate limited per IP", async t => {
  const h = await createHarness(t);
  const headers = { "x-test-ip": "192.0.2.77" };
  for (let index = 0; index < 600; index += 1) {
    assert.equal((await h.token({ client_id: "fbc_unknown" }, { headers })).status, 401);
  }
  const limited = await h.token({ client_id: "fbc_unknown" }, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "temporarily_unavailable");
  assert.equal((await h.token({ client_id: "fbc_unknown" }, { headers, path: "/oauth/revoke" })).status, 401);
  assert.equal((await h.token({ client_id: "fbc_unknown" }, { headers: { "x-test-ip": "192.0.2.78" } })).status, 401);
});

test("approval page escapes hostile client names and sets strict headers", async t => {
  const h = await createHarness(t);
  const hostile = `<script>alert(1)</script><a href="https://e.x">x</a>${String.fromCodePoint(0x202e)}&`;
  const client = await h.registerPublicClient({ client_name: hostile });
  const page = await h.openPage(h.authorizeUrl(client.client_id));
  assert.doesNotMatch(page.html, /<script>alert/);
  assert.doesNotMatch(page.html, /<a href/);
  assert.match(page.html, /&#60;script&#62;alert\(1\)&#60;\/script&#62;&#60;a href=&#34;https:\/\/e\.x&#34;&#62;x&#60;\/a&#62;&#38;/);
  assert.equal(page.html.includes(String.fromCodePoint(0x202e)), false);
  assert.match(page.html, /In Figma, open the Figma Bridge plugin, choose Connect AI app, and enter this code\./);

  const headers = page.response.headers;
  const csp = headers.get("content-security-policy");
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.equal(csp, `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  assert.match(page.html, new RegExp(`<script nonce="${nonce}">`));
  assert.match(page.html, new RegExp(`<style nonce="${nonce}">`));
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("content-type"), "text/html; charset=utf-8");

  const another = await h.openPage(h.authorizeUrl(client.client_id));
  assert.notEqual(another.response.headers.get("content-security-policy"), csp);
  assert.equal(h.lookup(page.code).clientName, hostile.slice(0, -2) + "&");
});

test("approval codes normalize case, separators, and look-alike letters", async t => {
  assert.equal(normalizeApprovalCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizeApprovalCode(" o1il 2345 "), "01112345");
  assert.equal(normalizeApprovalCode("0000-000U"), null);
  assert.equal(normalizeApprovalCode("0000-000"), null);
  assert.equal(normalizeApprovalCode("0000-00000"), null);
  assert.equal(normalizeApprovalCode(12345678), null);

  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId));
  assert.match(page.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const typed = ` ${page.code.slice(0, 2)} ${page.code.slice(2)} `.toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
  const approval = h.lookup(typed);
  assert.equal(approval.requestId, page.requestId);
  const stored = h.store.getRequest(page.requestId);
  assert.equal(stored.approvalHash, crypto.createHash("sha256").update(page.code.replace("-", "")).digest("hex"));
  assert.equal(stored.lookedUpByDevice, DEVICE);
  assert.equal(stored.lookedUpAccount, ACCOUNT);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM oauth_requests WHERE approval_hash = ?").get(page.code).count, 0);
});

test("lookup reports the client, redirect kind, host, and expiry", async t => {
  const h = await createHarness(t, { extraRedirectUris: ["https://relay.example/callback"] });
  const kinds = [
    ["http://[::1]:43123/callback", "loopback", "[::1]:43123"],
    ["https://claude.ai/api/mcp/auth_callback", "claude", "claude.ai"],
    ["https://relay.example/callback", "custom", "relay.example"]
  ];
  for (const [redirect, redirectKind, redirectHost] of kinds) {
    const client = await h.registerPublicClient({ client_name: "", redirect_uris: [redirect] });
    const page = await h.openPage(h.authorizeUrl(client.client_id, { redirect_uri: redirect }));
    assert.deepEqual(h.lookup(page.code), {
      requestId: page.requestId,
      clientName: "MCP client",
      redirectKind,
      redirectHost,
      expiresAt: new Date(h.clock.now().getTime() + 10 * MINUTE)
    });
  }
});

test("lookups do not reveal expired codes and are rate limited per device and account", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const expired = await h.openPage(h.authorizeUrl(clientId));
  h.clock.advance(10 * MINUTE);
  const expiredError = captureError(() => h.lookup(expired.code, { deviceId: "device-expired" }));
  const unknownError = captureError(() => h.lookup("ZZZZ-ZZZZ", { deviceId: "device-expired" }));
  assert.equal(expiredError.code, "not_found");
  assert.deepEqual([unknownError.code, unknownError.message], [expiredError.code, expiredError.message]);
  lookupFails(() => h.lookup("", { deviceId: "device-expired" }), "not_found");

  h.clock.advance(10 * MINUTE);
  const page = await h.openPage(h.authorizeUrl(clientId));
  for (let index = 0; index < 10; index += 1) lookupFails(() => h.lookup("ZZZZ-ZZZZ", { deviceId: "device-a" }), "not_found");
  lookupFails(() => h.lookup(page.code, { deviceId: "device-a" }), "rate_limited");
  assert.equal(h.lookup(page.code, { deviceId: "device-b" }).requestId, page.requestId);
  for (let index = 0; index < 9; index += 1) lookupFails(() => h.lookup("ZZZZ-ZZZZ", { deviceId: `device-c${index}` }), "not_found");
  lookupFails(() => h.lookup(page.code, { deviceId: "device-d" }), "rate_limited");
  assert.equal(h.lookup(page.code, { accountId: "account-other", deviceId: "device-d" }).requestId, page.requestId);

  h.clock.advance(10 * MINUTE);
  const fresh = await h.openPage(h.authorizeUrl(clientId));
  assert.equal(h.lookup(fresh.code, { deviceId: "device-a" }).requestId, fresh.requestId);
  assert.throws(() => h.oauth.lookupApproval({ code: fresh.code, accountId: "", deviceId: DEVICE }), TypeError);
});

test("lookups are rate limited per IP and failed lookups globally", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId));
  for (let index = 0; index < 60; index += 1) {
    lookupFails(() => h.lookup("ZZZZ-ZZZZ", { accountId: `ip-account-${index}`, deviceId: `ip-device-${index}`, ip: "198.51.100.9" }), "not_found");
  }
  lookupFails(() => h.lookup(page.code, { deviceId: "ip-device-fresh", ip: "198.51.100.9" }), "rate_limited");
  assert.equal(h.lookup(page.code, { deviceId: "ip-device-fresh", ip: "198.51.100.10" }).requestId, page.requestId);

  for (let index = 60; index < 300; index += 1) {
    lookupFails(() => h.lookup("ZZZZ-ZZZZ", { accountId: `global-account-${index}`, deviceId: `global-device-${index}` }), "not_found");
  }
  lookupFails(() => h.lookup(page.code, { accountId: "account-fresh", deviceId: "device-fresh" }), "rate_limited");
  h.clock.advance(HOUR);
  const fresh = await h.openPage(h.authorizeUrl(clientId));
  assert.equal(h.lookup(fresh.code, { accountId: "account-fresh", deviceId: "device-fresh" }).requestId, fresh.requestId);
});

test("decide requires a prior lookup by the same device and account", async t => {
  const h = await createHarness(t);
  const { client_id: clientId } = await h.registerPublicClient();
  const page = await h.openPage(h.authorizeUrl(clientId));
  const decide = identity => h.oauth.decideApproval({ requestId: page.requestId, approve: true, accountId: ACCOUNT, deviceId: DEVICE, ...identity });

  lookupFails(() => decide(), "not_found");
  h.lookup(page.code);
  lookupFails(() => decide({ deviceId: "device-other" }), "not_found");
  lookupFails(() => decide({ accountId: "account-other" }), "not_found");
  lookupFails(() => h.oauth.decideApproval({ requestId: "unknown", approve: true, accountId: ACCOUNT, deviceId: DEVICE }), "not_found");
  assert.throws(() => decide({ deviceId: "" }), TypeError);

  h.lookup(page.code, { accountId: "account-other", deviceId: "device-other" });
  lookupFails(() => decide(), "not_found");
  h.lookup(page.code);
  assert.deepEqual(decide(), { status: "approved" });
  lookupFails(() => decide(), "not_found");
  lookupFails(() => h.lookup(page.code), "not_found");
  const stored = h.store.getRequest(page.requestId);
  assert.equal(stored.accountId, ACCOUNT);
  assert.equal(stored.decidedByDevice, DEVICE);
  assert.equal(stored.decidedAt.getTime(), Math.floor(h.clock.now().getTime() / 1000) * 1000);

  const truthy = await h.openPage(h.authorizeUrl(clientId));
  h.lookup(truthy.code);
  assert.deepEqual(h.oauth.decideApproval({ requestId: truthy.requestId, approve: "yes", accountId: ACCOUNT, deviceId: DEVICE }), { status: "denied" });

  const late = await h.openPage(h.authorizeUrl(clientId));
  h.lookup(late.code);
  h.clock.advance(10 * MINUTE);
  lookupFails(() => h.oauth.decideApproval({ requestId: late.requestId, approve: true, accountId: ACCOUNT, deviceId: DEVICE }), "not_found");
});

test("grants belong to the deciding account and revocation is scoped to it", async t => {
  const h = await createHarness(t);
  const first = await h.connect({ accountId: "account-a", deviceId: "device-a" });
  h.clock.advance(MINUTE);
  const second = await h.connect({ accountId: "account-a", deviceId: "device-a" });
  const other = await h.connect({ accountId: "account-b", deviceId: "device-b" });

  const verified = h.oauth.verifyAccessToken(first.tokens.access_token);
  assert.equal(verified.accountId, "account-a");
  assert.equal(verified.clientId, first.clientId);
  assert.equal(verified.clientName, "Codex");

  const grants = h.oauth.listGrants("account-a");
  assert.equal(grants.length, 2);
  assert.deepEqual(Object.keys(grants[0]), ["grantId", "clientName", "createdAt", "lastUsedAt", "expiresAt"]);
  assert.equal(grants[0].grantId, h.oauth.verifyAccessToken(second.tokens.access_token).grantId);
  assert.equal(grants[1].expiresAt.getTime(), grants[1].createdAt.getTime() + 90 * DAY);
  const otherGrant = h.oauth.listGrants("account-b")[0];

  assert.equal(h.oauth.revokeGrant({ grantId: otherGrant.grantId, accountId: "account-a" }), false);
  assert.equal((await h.mcpStatus(other.tokens.access_token)).status, 200);
  assert.equal(h.oauth.revokeGrant({ grantId: grants[1].grantId, accountId: "account-a" }), true);
  assert.equal(h.oauth.revokeGrant({ grantId: grants[1].grantId, accountId: "account-a" }), false);
  assert.equal((await h.mcpStatus(first.tokens.access_token)).status, 401);
  assert.equal((await h.token({ grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.tokens.refresh_token })).status, 400);
  assert.equal((await h.mcpStatus(second.tokens.access_token)).status, 200);

  assert.equal(h.oauth.revokeAccountGrants("account-a"), 1);
  assert.deepEqual(h.oauth.listGrants("account-a"), []);
  assert.equal((await h.mcpStatus(second.tokens.access_token)).status, 401);
  assert.equal(h.oauth.listGrants("account-b").length, 1);
  assert.equal(h.oauth.revokeAccountGrants(""), 0);
});

test("access token verification records use at most once per minute", async t => {
  const h = await createHarness(t);
  const { tokens } = await h.connect();
  const connectedAt = h.clock.now().getTime();
  h.clock.advance(30 * SECOND);
  const verified = h.oauth.verifyAccessToken(tokens.access_token);
  assert.equal(verified.expiresAt.getTime(), connectedAt + HOUR);
  assert.equal(h.oauth.listGrants(ACCOUNT)[0].lastUsedAt.getTime(), connectedAt);
  h.clock.advance(30 * SECOND);
  h.oauth.verifyAccessToken(tokens.access_token);
  assert.equal(h.oauth.listGrants(ACCOUNT)[0].lastUsedAt.getTime(), connectedAt + MINUTE);
  h.clock.advance(HOUR);
  assert.equal(h.oauth.verifyAccessToken(tokens.access_token), null);
});

test("issuer must be an https origin or a loopback http origin", () => {
  const store = {};
  for (const issuer of ["https://relay.example", "https://relay.example/", "http://127.0.0.1:8080", "http://localhost", "http://[::1]:9"]) {
    const server = createOAuthServer({ issuer, store });
    assert.equal(server.resource, `${server.issuer}/mcp`);
    assert.equal(server.resourceMetadataUrl, `${server.issuer}/.well-known/oauth-protected-resource/mcp`);
  }
  assert.equal(createOAuthServer({ issuer: " https://Relay.Example/ ", store }).issuer, "https://relay.example");
  for (const issuer of ["http://relay.example", "https://relay.example/mcp", "https://relay.example?x=1", "https://user@relay.example", "ftp://localhost", "relay.example", ""]) {
    assert.throws(() => createOAuthServer({ issuer, store }), /https origin/, issuer);
  }
  assert.throws(() => createOAuthServer({ issuer: "https://relay.example" }), /store/);
});

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected an error");
}
