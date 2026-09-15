import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOAuthStore, migrateOAuth } from "../src/oauth-store.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RESOURCE = "https://relay.example/mcp";
const POLICY = { reuseGraceMs: 30 * SECOND, maxGrantLifetimeMs: 365 * DAY };

function setup(t) {
  let current = Date.UTC(2026, 0, 1);
  const clock = { now: () => new Date(current), advance: ms => { current += ms; } };
  const db = new DatabaseSync(":memory:");
  migrateOAuth(db);
  migrateOAuth(db);
  t.after(() => db.close());
  const store = createOAuthStore(db, { now: clock.now });
  const later = ms => new Date(clock.now().getTime() + ms);
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

  const helpers = {
    clock,
    db,
    store,
    count,
    createClient(clientId) {
      store.createClient({ clientId, name: "Client", redirectUris: ["http://127.0.0.1/cb"], authMethod: "none" });
    },
    createRequest(id, clientId, overrides = {}) {
      store.createRequest({
        id,
        browserHash: `browser-${id}`,
        approvalHash: `approval-${id}`,
        clientId,
        redirectUri: "http://127.0.0.1/cb",
        state: "state",
        codeChallenge: "challenge",
        resource: RESOURCE,
        expiresAt: later(10 * MINUTE),
        ...overrides
      });
    },
    decide(id, approve = true, identity = { accountId: "account", deviceId: "device" }) {
      assert.ok(store.lookupRequest({ approvalHash: `approval-${id}`, ...identity }));
      return store.decideRequest({ requestId: id, approve, ...identity });
    },
    tokens(prefix) {
      return [
        { hash: `access-${prefix}`, kind: "access", expiresAt: later(HOUR) },
        { hash: `refresh-${prefix}`, kind: "refresh", expiresAt: later(90 * DAY) }
      ];
    },
    connect(id, clientId) {
      helpers.createRequest(id, clientId);
      helpers.decide(id);
      assert.equal(store.issueCode(id, `code-${id}`, later(2 * MINUTE)), true);
      store.exchangeCode({
        requestId: id,
        codeHash: `code-${id}`,
        grant: { id: `grant-${id}`, clientId, clientName: "Client", accountId: "account", resource: RESOURCE },
        tokens: helpers.tokens(id)
      });
      return `grant-${id}`;
    }
  };
  return helpers;
}

function assertStoreError(fn, code) {
  assert.throws(fn, error => error.code === code);
}

test("store enforces client, pending request, and approval code uniqueness limits", t => {
  const s = setup(t);
  s.store.createClient({ clientId: "a", redirectUris: ["http://127.0.0.1/cb"], authMethod: "none" }, { maxClients: 1 });
  assertStoreError(() => s.store.createClient({ clientId: "b", redirectUris: [], authMethod: "none" }, { maxClients: 1 }), "limit");
  assert.deepEqual(s.store.getClient("a").redirectUris, ["http://127.0.0.1/cb"]);
  assert.equal(s.store.getClient("missing"), null);

  s.createRequest("r1", "a");
  assertStoreError(() => s.createRequest("r2", "a", { approvalHash: "approval-r1" }), "conflict");
  assertStoreError(() => s.createRequest("r1", "a", { approvalHash: "approval-other" }), "conflict");
  assertStoreError(() => s.store.createRequest({
    id: "r3", browserHash: "b", approvalHash: "approval-r3", clientId: "a", redirectUri: "x", codeChallenge: "c",
    resource: RESOURCE, expiresAt: new Date(s.clock.now().getTime() + MINUTE)
  }, { maxPending: 1 }), "limit");
  assert.equal(s.count("oauth_requests"), 1);
  s.store.createRequest({
    id: "r5", browserHash: "b", approvalHash: "approval-r5", clientId: "a", redirectUri: "x", codeChallenge: "c",
    resource: RESOURCE, clientIp: "198.51.100.1", expiresAt: new Date(s.clock.now().getTime() + MINUTE)
  }, { maxPendingPerIp: 1 });
  assertStoreError(() => s.store.createRequest({
    id: "r6", browserHash: "b", approvalHash: "approval-r6", clientId: "a", redirectUri: "x", codeChallenge: "c",
    resource: RESOURCE, clientIp: "198.51.100.1", expiresAt: new Date(s.clock.now().getTime() + MINUTE)
  }, { maxPendingPerIp: 1 }), "limit");
  s.store.createRequest({
    id: "r7", browserHash: "b", approvalHash: "approval-r7", clientId: "a", redirectUri: "x", codeChallenge: "c",
    resource: RESOURCE, clientIp: "198.51.100.2", expiresAt: new Date(s.clock.now().getTime() + MINUTE)
  }, { maxPendingPerIp: 1 });
  assert.throws(() => s.createRequest("r4", "missing-client"), /FOREIGN KEY/);
});

test("store decisions require a lookup by the same non-empty device and account", t => {
  const s = setup(t);
  s.createClient("client");
  s.createRequest("r1", "client");
  assert.equal(s.store.decideRequest({ requestId: "r1", approve: true, accountId: "", deviceId: "" }), null);
  assert.equal(s.store.lookupRequest({ approvalHash: "approval-r1", accountId: "", deviceId: "device" }), null);
  assert.equal(s.store.lookupRequest({ approvalHash: "approval-r1", accountId: "account", deviceId: "" }), null);
  assert.equal(s.store.getRequest("r1").lookedUpByDevice, "");

  const found = s.store.lookupRequest({ approvalHash: "approval-r1", accountId: "account", deviceId: "device" });
  assert.deepEqual(found, {
    requestId: "r1",
    clientName: "Client",
    redirectUri: "http://127.0.0.1/cb",
    expiresAt: new Date(s.clock.now().getTime() + 10 * MINUTE)
  });
  assert.equal(s.store.decideRequest({ requestId: "r1", approve: true, accountId: "account", deviceId: "other" }), null);
  const decided = s.store.decideRequest({ requestId: "r1", approve: false, accountId: "account", deviceId: "device" });
  assert.equal(decided.status, "denied");
  assert.equal(decided.accountId, "account");
  assert.equal(s.store.issueCode("r1", "code", new Date(s.clock.now().getTime() + MINUTE)), false);
});

test("store mints a code once and only before the request expires", t => {
  const s = setup(t);
  s.createClient("client");
  s.createRequest("r1", "client");
  const expiry = new Date(s.clock.now().getTime() + 2 * MINUTE);
  assert.equal(s.store.issueCode("r1", "code-1", expiry), false);
  s.decide("r1");
  assert.equal(s.store.issueCode("r1", "code-1", expiry), true);
  assert.equal(s.store.issueCode("r1", "code-2", expiry), false);
  assert.equal(s.store.getRequestByCode("code-1").id, "r1");
  assert.equal(s.store.getRequestByCode(""), null);

  s.createRequest("r2", "client");
  s.decide("r2");
  s.clock.advance(10 * MINUTE);
  assert.equal(s.store.issueCode("r2", "code-3", expiry), false);
});

test("store exchanges a code once for the deciding account and rolls back failures", t => {
  const s = setup(t);
  s.createClient("client");
  s.createRequest("r1", "client");
  s.decide("r1");
  s.store.issueCode("r1", "code-r1", new Date(s.clock.now().getTime() + 2 * MINUTE));
  const grant = { id: "grant-1", clientId: "client", clientName: "Client", accountId: "account", resource: RESOURCE };
  assertStoreError(() => s.store.exchangeCode({ requestId: "r1", codeHash: "wrong", grant, tokens: s.tokens("1") }), "invalid_grant");
  assertStoreError(() => s.store.exchangeCode({ requestId: "r1", codeHash: "code-r1", grant: { ...grant, accountId: "intruder" }, tokens: s.tokens("1") }), "invalid_grant");

  const duplicate = [...s.tokens("1"), { hash: "access-1", kind: "access", expiresAt: new Date(s.clock.now().getTime() + HOUR) }];
  assert.throws(() => s.store.exchangeCode({ requestId: "r1", codeHash: "code-r1", grant, tokens: duplicate }), /UNIQUE/);
  assert.equal(s.store.getRequest("r1").status, "approved");
  assert.equal(s.count("oauth_grants"), 0);
  assert.equal(s.count("oauth_tokens"), 0);

  s.store.exchangeCode({ requestId: "r1", codeHash: "code-r1", grant, tokens: s.tokens("1") });
  assert.equal(s.store.getRequest("r1").status, "exchanged");
  assertStoreError(() => s.store.exchangeCode({ requestId: "r1", codeHash: "code-r1", grant: { ...grant, id: "grant-2" }, tokens: s.tokens("2") }), "invalid_grant");

  s.createRequest("r2", "client");
  s.decide("r2");
  s.store.issueCode("r2", "code-r2", new Date(s.clock.now().getTime() + 2 * MINUTE));
  s.clock.advance(2 * MINUTE);
  assertStoreError(() => s.store.exchangeCode({ requestId: "r2", codeHash: "code-r2", grant: { ...grant, id: "grant-3" }, tokens: s.tokens("3") }), "invalid_grant");
});

test("store rotates refresh tokens and commits the revocation on reuse", t => {
  const s = setup(t);
  s.createClient("client");
  const grantId = s.connect("r1", "client");
  const refresh = (hash, prefix, clientId = "client") => s.store.refreshTokens({ refreshHash: hash, clientId, tokens: s.tokens(prefix), ...POLICY });

  assertStoreError(() => refresh("refresh-r1", "x", "other-client"), "invalid_grant");
  assertStoreError(() => refresh("access-r1", "x"), "invalid_grant");
  s.clock.advance(5 * MINUTE);
  const rotated = refresh("refresh-r1", "r2");
  assert.equal(rotated.id, grantId);
  assert.equal(rotated.lastUsedAt.getTime(), s.clock.now().getTime());
  s.clock.advance(30 * SECOND);
  assertStoreError(() => refresh("refresh-r1", "r3"), "invalid_grant");
  assert.equal(s.store.verifyAccessToken("access-r2").grant.id, grantId);

  s.clock.advance(SECOND);
  assert.throws(() => refresh("refresh-r1", "r4"), error => error.code === "token_reuse" && error.grant.id === grantId && error.grant.accountId === "account");
  assert.notEqual(s.db.prepare("SELECT revoked_at FROM oauth_grants WHERE id = ?").get(grantId).revoked_at, 0);
  assert.equal(s.count("oauth_tokens"), 0);
  assert.equal(s.store.verifyAccessToken("access-r2"), null);
  assertStoreError(() => refresh("refresh-r2", "r5"), "invalid_grant");
});

test("store prunes finished requests, dead tokens, revoked grants, and unused clients", t => {
  const s = setup(t);
  const grantRows = () => s.db.prepare("SELECT id FROM oauth_grants ORDER BY id").all().map(row => row.id);
  const clientRows = () => s.db.prepare("SELECT client_id FROM oauth_clients ORDER BY client_id").all().map(row => row.client_id);
  for (const clientId of ["active", "unused", "pending"]) s.createClient(clientId);
  const activeGrant = s.connect("r1", "active");
  const revokedGrant = s.connect("r2", "active");
  assert.ok(s.store.revokeGrant("account", revokedGrant));
  s.createRequest("r3", "pending");
  s.createRequest("r4", "active");
  s.decide("r4", false);

  s.clock.advance(59 * MINUTE);
  s.store.prune();
  assert.equal(s.count("oauth_requests"), 4);
  s.clock.advance(2 * HOUR);
  s.store.prune();
  assert.equal(s.count("oauth_requests"), 0);
  assert.equal(s.count("oauth_tokens"), 1);
  assert.deepEqual(grantRows(), [activeGrant, revokedGrant]);
  assert.deepEqual(clientRows(), ["active", "pending", "unused"]);

  s.clock.advance(DAY);
  s.createClient("fresh");
  assert.deepEqual(clientRows(), ["active", "fresh"]);

  s.store.refreshTokens({ refreshHash: "refresh-r1", clientId: "active", tokens: s.tokens("rotated"), ...POLICY });
  s.clock.advance(7 * DAY + MINUTE);
  s.store.prune();
  assert.deepEqual(s.db.prepare("SELECT token_hash FROM oauth_tokens").all().map(row => row.token_hash), ["refresh-rotated"]);

  s.clock.advance(23 * DAY);
  s.store.prune();
  assert.deepEqual(grantRows(), [activeGrant]);

  s.clock.advance(90 * DAY);
  s.store.prune();
  assert.equal(s.count("oauth_tokens"), 0);
  assert.deepEqual(grantRows(), []);
  assert.deepEqual(clientRows(), []);
});

test("store lists live grants per account with their effective expiry", t => {
  const s = setup(t);
  s.createClient("client");
  const older = s.connect("r1", "client");
  s.clock.advance(2 * MINUTE);
  const newer = s.connect("r2", "client");
  const listed = s.store.listGrants("account", { maxGrantLifetimeMs: 30 * DAY });
  assert.deepEqual(listed.map(grant => grant.id), [newer, older]);
  assert.equal(listed[1].expiresAt.getTime(), listed[1].createdAt.getTime() + 30 * DAY);
  assert.deepEqual(s.store.listGrants("someone-else"), []);
  assert.deepEqual(s.store.listGrants(""), []);

  s.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run("refresh-r1");
  assert.equal(s.store.listGrants("account")[1].expiresAt.getTime(), listed[1].createdAt.getTime() + HOUR);
  s.clock.advance(HOUR);
  assert.deepEqual(s.store.listGrants("account").map(grant => grant.id), [newer]);

  assert.equal(s.store.revokeGrant("someone-else", newer), null);
  assert.equal(s.store.revokeGrant("account", newer).id, newer);
  assert.equal(s.store.revokeGrant("account", newer), null);
  assert.deepEqual(s.store.listGrants("account"), []);
});
