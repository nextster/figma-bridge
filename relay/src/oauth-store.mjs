// OAuth rows store only SHA-256 hashes of client secrets, browser secrets,
// approval codes, authorization codes, and tokens. Times are Unix seconds.

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
// Rotated refresh token hashes are kept so that reuse can be detected.
const USED_TOKEN_RETENTION_SECONDS = 7 * DAY_SECONDS;
const REVOKED_GRANT_RETENTION_SECONDS = 30 * DAY_SECONDS;
const UNUSED_CLIENT_RETENTION_SECONDS = DAY_SECONDS;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    approval_hash TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    state TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT NOT NULL,
    client_ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','exchanged')),
    looked_up_by_device TEXT NOT NULL DEFAULT '',
    looked_up_account TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL DEFAULT '',
    decided_by_device TEXT NOT NULL DEFAULT '',
    decided_at INTEGER NOT NULL DEFAULT 0,
    code_hash TEXT NOT NULL DEFAULT '',
    code_expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_requests_approval ON oauth_requests(approval_hash);
  CREATE INDEX IF NOT EXISTS idx_oauth_requests_code ON oauth_requests(code_hash) WHERE code_hash != '';
  CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL,
    approved_by_device TEXT NOT NULL DEFAULT '',
    resource TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_grants_account ON oauth_grants(account_id);
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
`;

const REQUEST_COLUMNS = `id, browser_hash, approval_hash, client_id, redirect_uri, state, code_challenge, resource,
  client_ip, user_agent, status, looked_up_by_device, looked_up_account, account_id, decided_by_device, decided_at,
  code_hash, code_expires_at, created_at, expires_at`;
const GRANT_COLUMNS = "g.id, g.client_id, g.client_name, g.account_id, g.resource, g.created_at, g.last_used_at";

export function migrateOAuth(db) {
  db.exec(SCHEMA);
  const grantColumns = db.prepare("PRAGMA table_info(oauth_grants)").all().map(column => column.name);
  if (!grantColumns.includes("approved_by_device")) db.exec("ALTER TABLE oauth_grants ADD COLUMN approved_by_device TEXT NOT NULL DEFAULT ''");
}

export function createOAuthStore(db, { now = () => new Date() } = {}) {
  const statements = new Map();

  function sql(text) {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The failed statement may already have ended the transaction.
      }
      throw error;
    }
  }

  // Removes finished requests, dead tokens, revoked grants, and registrations
  // that never produced a grant within a day.
  function pruneTx(seconds) {
    sql(`DELETE FROM oauth_requests WHERE expires_at < ? OR (status IN ('denied','exchanged') AND created_at < ?)`)
      .run(seconds - HOUR_SECONDS, seconds - HOUR_SECONDS);
    sql(`DELETE FROM oauth_tokens WHERE expires_at < ? OR (used_at != 0 AND used_at < ?)`)
      .run(seconds, seconds - USED_TOKEN_RETENTION_SECONDS);
    sql(`DELETE FROM oauth_grants WHERE revoked_at != 0 AND revoked_at < ?`)
      .run(seconds - REVOKED_GRANT_RETENTION_SECONDS);
    sql(`DELETE FROM oauth_grants WHERE revoked_at = 0 AND NOT EXISTS (
      SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND t.used_at = 0)`).run();
    sql(`DELETE FROM oauth_clients WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id AND g.revoked_at = 0)
      AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.client_id)`)
      .run(seconds - UNUSED_CLIENT_RETENTION_SECONDS);
  }

  function insertTokensTx(grantId, tokens) {
    const insert = sql(`INSERT INTO oauth_tokens(token_hash, grant_id, kind, expires_at) VALUES(?, ?, ?, ?)`);
    for (const token of tokens) insert.run(token.hash, grantId, token.kind, toSeconds(token.expiresAt));
  }

  function getRequest(id) {
    return requestFromRow(sql(`SELECT ${REQUEST_COLUMNS} FROM oauth_requests WHERE id = ?`).get(String(id ?? "")));
  }

  function revokeGrantTx(grantId, seconds) {
    sql(`UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at = 0`).run(seconds, grantId);
    sql(`DELETE FROM oauth_tokens WHERE grant_id = ?`).run(grantId);
  }

  return {
    prune() {
      transaction(() => pruneTx(toSeconds(now())));
    },

    // maxClients bounds the table so the public registration endpoint cannot
    // grow it without limit.
    createClient(client, { maxClients = 0 } = {}) {
      const seconds = toSeconds(now());
      transaction(() => {
        pruneTx(seconds);
        const { count } = sql(`SELECT COUNT(*) AS count FROM oauth_clients`).get();
        if (maxClients > 0 && count >= maxClients) throw storeError("limit", "oauth client limit reached");
        sql(`INSERT INTO oauth_clients(client_id, secret_hash, client_name, redirect_uris, auth_method, created_at)
          VALUES(?, ?, ?, ?, ?, ?)`)
          .run(client.clientId, client.secretHash || "", client.name || "", JSON.stringify(client.redirectUris),
            client.authMethod, seconds);
      });
    },

    getClient(clientId) {
      const row = sql(`SELECT client_id, secret_hash, client_name, redirect_uris, auth_method, created_at
        FROM oauth_clients WHERE client_id = ?`).get(String(clientId ?? ""));
      if (!row) return null;
      return {
        clientId: row.client_id,
        secretHash: row.secret_hash,
        name: row.client_name,
        redirectUris: JSON.parse(row.redirect_uris),
        authMethod: row.auth_method,
        createdAt: fromSeconds(row.created_at)
      };
    },

    // maxPending bounds how many authorization requests can be outstanding in
    // total, and maxPendingPerIp how many one client address may hold, so a
    // single address cannot exhaust the shared budget.
    // A duplicate request id or approval code hash throws code "conflict".
    createRequest(request, { maxPending = 0, maxPendingPerIp = 0 } = {}) {
      const seconds = toSeconds(now());
      transaction(() => {
        pruneTx(seconds);
        const { count } = sql(`SELECT COUNT(*) AS count FROM oauth_requests WHERE status = 'pending' AND expires_at > ?`)
          .get(seconds);
        if (maxPending > 0 && count >= maxPending) throw storeError("limit", "oauth pending request limit reached");
        if (maxPendingPerIp > 0) {
          const perIp = sql(`SELECT COUNT(*) AS count FROM oauth_requests WHERE status = 'pending' AND expires_at > ? AND client_ip = ?`)
            .get(seconds, request.clientIp || "");
          if (perIp.count >= maxPendingPerIp) throw storeError("limit", "oauth pending request limit reached for this address");
        }
        try {
          sql(`INSERT INTO oauth_requests(id, browser_hash, approval_hash, client_id, redirect_uri, state, code_challenge,
            resource, client_ip, user_agent, status, created_at, expires_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(request.id, request.browserHash, request.approvalHash, request.clientId, request.redirectUri,
              request.state || "", request.codeChallenge, request.resource, request.clientIp || "",
              request.userAgent || "", seconds, toSeconds(request.expiresAt));
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw storeError("conflict", "oauth request id or approval code already exists");
          }
          throw error;
        }
      });
    },

    getRequest,

    getRequestByCode(codeHash) {
      if (!codeHash) return null;
      return requestFromRow(sql(`SELECT ${REQUEST_COLUMNS} FROM oauth_requests WHERE code_hash = ?`).get(codeHash));
    },

    // Finds a pending, unexpired request by approval code hash and records the
    // plugin device and account that looked it up.
    lookupRequest({ approvalHash, accountId, deviceId }) {
      if (!approvalHash || !accountId || !deviceId) return null;
      const seconds = toSeconds(now());
      return transaction(() => {
        const row = sql(`SELECT r.id, r.redirect_uri, r.expires_at, c.client_name
          FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
          WHERE r.approval_hash = ? AND r.status = 'pending' AND r.expires_at > ?`).get(approvalHash, seconds);
        if (!row) return null;
        sql(`UPDATE oauth_requests SET looked_up_by_device = ?, looked_up_account = ? WHERE id = ?`)
          .run(deviceId, accountId, row.id);
        return {
          requestId: row.id,
          clientName: row.client_name,
          redirectUri: row.redirect_uri,
          expiresAt: fromSeconds(row.expires_at)
        };
      });
    },

    // Records the decision. It changes only a pending, unexpired request that
    // the same device and account looked up, and returns null otherwise.
    decideRequest({ requestId, approve, accountId, deviceId }) {
      if (!requestId || !accountId || !deviceId) return null;
      const seconds = toSeconds(now());
      const status = approve === true ? "approved" : "denied";
      const result = sql(`UPDATE oauth_requests SET status = ?, account_id = ?, decided_by_device = ?, decided_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ? AND looked_up_by_device = ? AND looked_up_account = ?`)
        .run(status, accountId, deviceId, seconds, requestId, seconds, deviceId, accountId);
      return result.changes === 1 ? getRequest(requestId) : null;
    },

    // Attaches the authorization code to an approved request. It succeeds
    // once, and only before the request expires.
    issueCode(requestId, codeHash, codeExpiresAt) {
      const seconds = toSeconds(now());
      const result = sql(`UPDATE oauth_requests SET code_hash = ?, code_expires_at = ?
        WHERE id = ? AND status = 'approved' AND code_hash = '' AND expires_at > ?`)
        .run(codeHash, toSeconds(codeExpiresAt), requestId, seconds);
      return result.changes === 1;
    },

    // Consumes an approved code exactly once and creates the grant with its
    // first tokens in the same transaction.
    exchangeCode({ requestId, codeHash, grant, tokens }) {
      const seconds = toSeconds(now());
      transaction(() => {
        const result = sql(`UPDATE oauth_requests SET status = 'exchanged'
          WHERE id = ? AND code_hash = ? AND status = 'approved' AND code_expires_at > ? AND account_id = ?`)
          .run(requestId, codeHash, seconds, grant.accountId || "");
        if (result.changes !== 1 || !grant.accountId) throw storeError("invalid_grant", "oauth grant is invalid");
        sql(`INSERT INTO oauth_grants(id, client_id, client_name, account_id, approved_by_device, resource, created_at, last_used_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(grant.id, grant.clientId, grant.clientName, grant.accountId, grant.approvedByDevice || "", grant.resource, seconds, seconds);
        insertTokensTx(grant.id, tokens);
      });
    },

    // Rotates a refresh token. Presenting a used token after reuseGraceMs
    // revokes the grant and throws code "token_reuse" with the revoked grant.
    refreshTokens({ refreshHash, clientId, tokens, reuseGraceMs = 0, maxGrantLifetimeMs = 0 }) {
      const time = now();
      const seconds = toSeconds(time);
      const outcome = transaction(() => {
        const row = sql(`SELECT ${GRANT_COLUMNS}, t.expires_at AS token_expires_at, t.used_at
          FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = ? AND t.kind = 'refresh' AND g.revoked_at = 0 AND g.client_id = ?`)
          .get(refreshHash, String(clientId ?? ""));
        if (!row) throw storeError("invalid_grant", "oauth grant is invalid");
        const grant = grantFromRow(row);
        if (row.used_at !== 0) {
          if (time.getTime() - row.used_at * 1000 <= reuseGraceMs) throw storeError("invalid_grant", "oauth grant is invalid");
          revokeGrantTx(grant.id, seconds);
          return { reused: true, grant };
        }
        const lifetimeExceeded = maxGrantLifetimeMs > 0 && time.getTime() - grant.createdAt.getTime() > maxGrantLifetimeMs;
        if (row.token_expires_at <= seconds || lifetimeExceeded) throw storeError("invalid_grant", "oauth grant is invalid");
        const used = sql(`UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at = 0`).run(seconds, refreshHash);
        if (used.changes !== 1) throw storeError("invalid_grant", "oauth grant is invalid");
        sql(`DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at <= ?`).run(grant.id, seconds);
        sql(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`).run(seconds, grant.id);
        grant.lastUsedAt = fromSeconds(seconds);
        insertTokensTx(grant.id, tokens);
        return { reused: false, grant };
      });
      if (outcome.reused) throw storeError("token_reuse", "oauth refresh token reused", { grant: outcome.grant });
      return outcome.grant;
    },

    // Resolves an unexpired access token of an active grant and records use at
    // most once per minute.
    verifyAccessToken(tokenHash) {
      const seconds = toSeconds(now());
      const row = sql(`SELECT ${GRANT_COLUMNS}, t.expires_at AS token_expires_at
        FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
        WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at = 0`).get(tokenHash, seconds);
      if (!row) return null;
      const grant = grantFromRow(row);
      if (seconds - row.last_used_at >= 60) {
        sql(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`).run(seconds, grant.id);
        grant.lastUsedAt = fromSeconds(seconds);
      }
      return { grant, expiresAt: fromSeconds(row.token_expires_at) };
    },

    // Lists the account's usable grants. expiresAt is when the grant stops
    // yielding valid tokens: the later of its last access token and its
    // renewable refresh token, capped by the maximum grant lifetime.
    listGrants(accountId, { maxGrantLifetimeMs = 0 } = {}) {
      if (!accountId) return [];
      const time = now();
      const seconds = toSeconds(time);
      const rows = sql(`SELECT ${GRANT_COLUMNS},
          (SELECT MAX(t.expires_at) FROM oauth_tokens t
            WHERE t.grant_id = g.id AND t.kind = 'access' AND t.expires_at > ?) AS access_expires_at,
          (SELECT MAX(t.expires_at) FROM oauth_tokens t
            WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.used_at = 0 AND t.expires_at > ?) AS refresh_expires_at
        FROM oauth_grants g WHERE g.account_id = ? AND g.revoked_at = 0 ORDER BY g.last_used_at DESC, g.created_at DESC`)
        .all(seconds, seconds, accountId);
      const grants = [];
      for (const row of rows) {
        const grant = grantFromRow(row);
        let refreshUntil = row.refresh_expires_at === null ? 0 : row.refresh_expires_at * 1000;
        if (maxGrantLifetimeMs > 0) refreshUntil = Math.min(refreshUntil, grant.createdAt.getTime() + maxGrantLifetimeMs);
        const accessUntil = row.access_expires_at === null ? 0 : row.access_expires_at * 1000;
        const expiresAt = Math.max(refreshUntil, accessUntil);
        if (expiresAt > time.getTime()) grants.push({ ...grant, expiresAt: new Date(expiresAt) });
      }
      return grants;
    },

    // Revokes one of the account's grants. Grants of other accounts are
    // reported as not found.
    revokeGrant(accountId, grantId) {
      if (!accountId || !grantId) return null;
      const seconds = toSeconds(now());
      return transaction(() => {
        const row = sql(`SELECT ${GRANT_COLUMNS} FROM oauth_grants g WHERE g.id = ? AND g.account_id = ? AND g.revoked_at = 0`)
          .get(grantId, accountId);
        if (!row) return null;
        revokeGrantTx(row.id, seconds);
        return grantFromRow(row);
      });
    },

    // Revokes the whole grant that owns a token (RFC 7009). Tokens of other
    // clients are ignored.
    revokeToken(tokenHash, clientId) {
      const seconds = toSeconds(now());
      transaction(() => {
        const row = sql(`SELECT g.id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = ? AND g.client_id = ?`).get(tokenHash, String(clientId ?? ""));
        if (row) revokeGrantTx(row.id, seconds);
      });
    },

    // Revokes every grant of an account and returns how many were active.
    // Revokes the grants a removed device approved, so its approvals do not
    // outlive it.
    revokeDeviceGrants(accountId, deviceId) {
      if (!accountId || !deviceId) return 0;
      const seconds = toSeconds(now());
      return transaction(() => {
        sql(`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE account_id = ? AND approved_by_device = ?)`).run(accountId, deviceId);
        return sql(`UPDATE oauth_grants SET revoked_at = ? WHERE account_id = ? AND approved_by_device = ? AND revoked_at = 0`)
          .run(seconds, accountId, deviceId).changes;
      });
    },

    revokeAccountGrants(accountId) {
      if (!accountId) return 0;
      const seconds = toSeconds(now());
      return transaction(() => {
        sql(`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE account_id = ?)`).run(accountId);
        return sql(`UPDATE oauth_grants SET revoked_at = ? WHERE account_id = ? AND revoked_at = 0`)
          .run(seconds, accountId).changes;
      });
    }
  };
}

function requestFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    browserHash: row.browser_hash,
    approvalHash: row.approval_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    state: row.state,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
    status: row.status,
    lookedUpByDevice: row.looked_up_by_device,
    lookedUpAccount: row.looked_up_account,
    accountId: row.account_id,
    decidedByDevice: row.decided_by_device,
    decidedAt: row.decided_at ? fromSeconds(row.decided_at) : null,
    codeHash: row.code_hash,
    codeExpiresAt: fromSeconds(row.code_expires_at),
    createdAt: fromSeconds(row.created_at),
    expiresAt: fromSeconds(row.expires_at)
  };
}

function grantFromRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    accountId: row.account_id,
    resource: row.resource,
    createdAt: fromSeconds(row.created_at),
    lastUsedAt: fromSeconds(row.last_used_at)
  };
}

// Older node:sqlite releases do not expose errcode, so the message is checked too.
function isUniqueViolation(error) {
  return error?.errcode === SQLITE_CONSTRAINT_UNIQUE || error?.errcode === SQLITE_CONSTRAINT_PRIMARYKEY
    || /UNIQUE constraint failed: oauth_requests\./.test(error?.message ?? "");
}

function storeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function toSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function fromSeconds(seconds) {
  return new Date(seconds * 1000);
}
