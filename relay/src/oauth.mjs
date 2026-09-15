// OAuth 2.1 authorization server that lets MCP clients such as Claude and
// Codex connect to the hosted relay without a shared bearer token.
//
// The authorization page shows a short approval code. The user types it into
// the Figma Bridge plugin, which looks the request up and decides it for the
// plugin's own account. Nothing is pushed to the plugin unsolicited, and codes
// and tokens never pass through the plugin; only SHA-256 hashes are stored.

import crypto from "node:crypto";
import { approvalPage, errorPage } from "./oauth-page.mjs";

export const SCOPE = "figma";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ACCESS_TOKEN_TTL = HOUR;
const REFRESH_TOKEN_TTL = 90 * DAY;
const REQUEST_TTL = 10 * MINUTE;
const CODE_TTL = 2 * MINUTE;

const MAX_CLIENTS = 500;
const MAX_PENDING_REQUESTS = 200;
const MAX_PENDING_PER_IP = 5;
const PER_IP_PER_HOUR = 20;
const GLOBAL_PER_HOUR = 200;
const TOKEN_PER_IP_PER_HOUR = 600;
const LOOKUP_WINDOW = 10 * MINUTE;
const LOOKUPS_PER_DEVICE = 10;
const LOOKUPS_PER_ACCOUNT = 20;
const LOOKUPS_PER_IP = 60;
const MAX_LIMITER_KEYS = 10000;

const REFRESH_REUSE_GRACE = 30 * SECOND;
const MAX_GRANT_LIFETIME = 365 * DAY;

const ACCESS_TOKEN_PREFIX = "fba_";
const REFRESH_TOKEN_PREFIX = "fbr_";
const CLIENT_ID_PREFIX = "fbc_";

const AUTH_METHOD_NONE = "none";
const AUTH_METHOD_BASIC = "client_secret_basic";
const AUTH_METHOD_POST = "client_secret_post";
const AUTH_METHODS = [AUTH_METHOD_NONE, AUTH_METHOD_BASIC, AUTH_METHOD_POST];
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 60;
const MAX_USER_AGENT_LENGTH = 160;

const REGISTER_BODY_LIMIT = 64 << 10;
const STATUS_BODY_LIMIT = 4 << 10;
const TOKEN_BODY_LIMIT = 64 << 10;
const REVOKE_BODY_LIMIT = 16 << 10;

const APPROVAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const APPROVAL_CODE_LENGTH = 8;
const APPROVAL_CODE_ATTEMPTS = 5;
const DEFAULT_CLIENT_NAME = "MCP client";

// Redirect URIs of hosted clients whose callbacks bind the result to the
// signed-in user's own account. Loopback redirects are always accepted.
const TRUSTED_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback"
];

export function createOAuthServer({
  issuer: publicUrl,
  store,
  now = () => new Date(),
  extraRedirectUris = [],
  clientIp = req => req.socket.remoteAddress,
  logger = console,
  onGrantRevoked
} = {}) {
  const issuer = normalizeIssuer(publicUrl);
  if (!store) throw new Error("oauth requires a store");
  const resource = `${issuer}/mcp`;
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  const extraUris = Array.from(extraRedirectUris || [], uri => String(uri).trim()).filter(Boolean);
  const limiter = createLimiter(now);

  const routes = new Map([
    ["/.well-known/oauth-protected-resource", (req, res) => protectedResourceMetadata(req, res, issuer)],
    ["/.well-known/oauth-protected-resource/mcp", (req, res) => protectedResourceMetadata(req, res, resource)],
    ["/.well-known/oauth-authorization-server", authorizationServerMetadata],
    ["/oauth/register", onlyMethods(["POST"], register)],
    ["/oauth/authorize", onlyMethods(["GET", "HEAD"], authorize)],
    ["/oauth/authorize/status", onlyMethods(["POST"], authorizeStatus)],
    ["/oauth/token", onlyMethods(["POST"], token)],
    ["/oauth/revoke", onlyMethods(["POST"], revoke)]
  ]);

  async function handle(req, res) {
    const route = routes.get(requestPath(req));
    if (!route) return false;
    try {
      await route(req, res);
    } catch (error) {
      logger.error?.(`oauth request failed: ${errorMessage(error)}`);
      if (!res.headersSent) writeOAuthError(res, 500, "server_error", "internal error");
      else res.destroy();
    }
    return true;
  }

  function protectedResourceMetadata(req, res, value) {
    if (!allowMetadataMethod(req, res)) return;
    writeJson(res, 200, {
      resource: value,
      authorization_servers: [issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Figma Bridge"
    });
  }

  function authorizationServerMetadata(req, res) {
    if (!allowMetadataMethod(req, res)) return;
    writeJson(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true
    });
  }

  async function register(req, res) {
    setCors(res);
    if (!allowRequest("register", req, PER_IP_PER_HOUR, GLOBAL_PER_HOUR)) {
      writeOAuthError(res, 429, "temporarily_unavailable", "too many client registrations; try again later");
      return;
    }
    let input;
    try {
      input = parseRegistration(await readBody(req, res, REGISTER_BODY_LIMIT));
    } catch {
      writeOAuthError(res, 400, "invalid_client_metadata", "registration body must be JSON");
      return;
    }
    if (input.redirectUris.length === 0 || input.redirectUris.length > MAX_REDIRECT_URIS) {
      writeOAuthError(res, 400, "invalid_redirect_uri", "provide between 1 and 10 redirect_uris");
      return;
    }
    for (const uri of input.redirectUris) {
      if (!allowedRedirectUri(uri)) {
        writeOAuthError(res, 400, "invalid_redirect_uri", `redirect_uri must be a loopback address or a trusted client callback: ${uri}`);
        return;
      }
    }
    const method = input.authMethod || AUTH_METHOD_BASIC;
    if (!AUTH_METHODS.includes(method)) {
      writeOAuthError(res, 400, "invalid_client_metadata", "unsupported token_endpoint_auth_method");
      return;
    }
    const grantTypes = input.grantTypes.length ? input.grantTypes : ["authorization_code", "refresh_token"];
    const unsupportedGrant = grantTypes.find(type => type !== "authorization_code" && type !== "refresh_token");
    if (unsupportedGrant !== undefined) {
      writeOAuthError(res, 400, "invalid_client_metadata", `unsupported grant type: ${unsupportedGrant}`);
      return;
    }
    const responseTypes = input.responseTypes.length ? input.responseTypes : ["code"];
    const unsupportedResponse = responseTypes.find(type => type !== "code");
    if (unsupportedResponse !== undefined) {
      writeOAuthError(res, 400, "invalid_client_metadata", `unsupported response type: ${unsupportedResponse}`);
      return;
    }

    const client = {
      clientId: CLIENT_ID_PREFIX + randomToken(16),
      name: cleanClientName(input.clientName),
      redirectUris: input.redirectUris,
      authMethod: method,
      secretHash: ""
    };
    const secret = method === AUTH_METHOD_NONE ? "" : randomToken(32);
    if (secret) client.secretHash = hashSecret(secret);
    const issuedAt = Math.floor(now().getTime() / 1000);
    try {
      store.createClient(client, { maxClients: MAX_CLIENTS });
    } catch (error) {
      if (error?.code === "limit") {
        writeOAuthError(res, 429, "temporarily_unavailable", "client registration limit reached");
        return;
      }
      logger.error?.(`oauth register failed: ${errorMessage(error)}`);
      writeOAuthError(res, 500, "server_error", "could not register client");
      return;
    }
    const response = {
      client_id: client.clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: responseTypes
    };
    if (client.name) response.client_name = client.name;
    if (secret) {
      response.client_secret = secret;
      response.client_secret_expires_at = 0;
    }
    writeJson(res, 201, response);
  }

  async function authorize(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      httpError(res, 405, "method not allowed");
      return;
    }
    const query = new URL(req.url, issuer).searchParams;
    let client;
    try {
      client = store.getClient(query.get("client_id") ?? "");
    } catch (error) {
      logger.error?.(`oauth authorize client lookup failed: ${errorMessage(error)}`);
      sendError(res, 500, "Could not verify the client. Try again.");
      return;
    }
    if (!client) {
      sendError(res, 400, "The client is not registered. Start the connection again from your AI app.");
      return;
    }
    const redirectUri = registeredRedirectUri(client, query.get("redirect_uri") ?? "");
    if (redirectUri === null || !allowedRedirectUri(redirectUri)) {
      sendError(res, 400, "The redirect address does not match the registered one. Start the connection again.");
      return;
    }
    // Invalid parameters are shown on the page instead of being redirected, so
    // the endpoint cannot be used to bounce requests to arbitrary local URLs.
    if (query.get("response_type") !== "code") {
      sendError(res, 400, "The client requested an unsupported response type.");
      return;
    }
    const challenge = query.get("code_challenge") ?? "";
    if (query.get("code_challenge_method") !== "S256" || !validPkceValue(challenge)) {
      sendError(res, 400, "The client did not send a PKCE S256 challenge. Update your AI app.");
      return;
    }
    if (!validResource(query.getAll("resource"))) {
      sendError(res, 400, "The client requested access to a different resource.");
      return;
    }
    if (!allowRequest("authorize", req, PER_IP_PER_HOUR, GLOBAL_PER_HOUR)) {
      sendError(res, 429, "Too many connection requests. Wait a little and try again.");
      return;
    }

    const browserSecret = randomToken(32);
    const request = {
      browserHash: hashSecret(browserSecret),
      clientId: client.clientId,
      redirectUri,
      state: query.get("state") ?? "",
      codeChallenge: challenge,
      resource,
      clientIp: requestIp(req),
      userAgent: truncateCodePoints(cleanClientName(req.headers["user-agent"] ?? ""), MAX_USER_AGENT_LENGTH),
      expiresAt: new Date(now().getTime() + REQUEST_TTL)
    };
    let approvalCode;
    for (let attempt = 1; ; attempt += 1) {
      approvalCode = randomApprovalCode();
      request.id = randomToken(16);
      request.approvalHash = hashSecret(approvalCode);
      try {
        store.createRequest(request, { maxPending: MAX_PENDING_REQUESTS, maxPendingPerIp: MAX_PENDING_PER_IP });
        break;
      } catch (error) {
        if (error?.code === "conflict" && attempt < APPROVAL_CODE_ATTEMPTS) continue;
        if (error?.code === "limit") {
          sendError(res, 429, "Too many unfinished connection requests. Wait 10 minutes and try again.");
          return;
        }
        logger.error?.(`oauth authorize request failed: ${errorMessage(error)}`);
        sendError(res, 500, "Could not create the connection request. Try again.");
        return;
      }
    }
    sendPage(res, 200, approvalPage({
      clientName: displayClientName(client.name),
      code: formatApprovalCode(approvalCode),
      requestId: request.id,
      browserSecret
    }));
  }

  async function authorizeStatus(req, res) {
    let input;
    try {
      input = parseStatusRequest(await readBody(req, res, STATUS_BODY_LIMIT));
    } catch {
      writeJson(res, 400, { status: "invalid" });
      return;
    }
    let request;
    try {
      request = store.getRequest(input.request);
    } catch (error) {
      logger.error?.(`oauth status lookup failed: ${errorMessage(error)}`);
      writeJson(res, 500, { status: "error" });
      return;
    }
    if (!request || !secretMatches(input.secret, request.browserHash)) {
      writeJson(res, 404, { status: "expired" });
      return;
    }
    const time = now();
    switch (request.status) {
      case "pending":
        writeJson(res, 200, { status: time.getTime() >= request.expiresAt.getTime() ? "expired" : "pending" });
        return;
      case "denied":
        writeJson(res, 200, {
          status: "denied",
          redirect: errorRedirect(request.redirectUri, request.state, "access_denied", "the Figma Bridge user denied access")
        });
        return;
      case "approved": {
        const code = randomToken(32);
        let issued;
        try {
          issued = store.issueCode(request.id, hashSecret(code), new Date(time.getTime() + CODE_TTL));
        } catch (error) {
          logger.error?.(`oauth code issue failed: ${errorMessage(error)}`);
          writeJson(res, 500, { status: "error" });
          return;
        }
        if (!issued) {
          // Codes are minted once, only while the request is still valid.
          writeJson(res, 200, { status: request.codeHash ? "done" : "expired" });
          return;
        }
        writeJson(res, 200, { status: "approved", redirect: successRedirect(request.redirectUri, request.state, code) });
        return;
      }
      default:
        writeJson(res, 200, { status: "done" });
    }
  }

  async function token(req, res) {
    setCors(res);
    if (!allowRequest("token", req, TOKEN_PER_IP_PER_HOUR)) {
      writeOAuthError(res, 429, "temporarily_unavailable", "too many token requests; try again later");
      return;
    }
    let form;
    try {
      form = await readForm(req, res, TOKEN_BODY_LIMIT);
    } catch {
      writeOAuthError(res, 400, "invalid_request", "token request must be form-encoded");
      return;
    }
    const client = authenticateClient(req, res, form);
    if (!client) return;
    switch (form.get("grant_type")) {
      case "authorization_code":
        exchangeCode(res, form, client);
        return;
      case "refresh_token":
        refresh(res, form, client);
        return;
      default:
        writeOAuthError(res, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
    }
  }

  function exchangeCode(res, form, client) {
    const code = form.get("code");
    const codeHash = hashSecret(code);
    let request;
    try {
      request = store.getRequestByCode(codeHash);
    } catch (error) {
      logger.error?.(`oauth code lookup failed: ${errorMessage(error)}`);
      writeOAuthError(res, 500, "server_error", "could not verify the authorization code");
      return;
    }
    const time = now();
    if (!code || !request || request.clientId !== client.clientId || request.status !== "approved"
      || time.getTime() >= request.codeExpiresAt.getTime()) {
      writeOAuthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
      return;
    }
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== request.redirectUri) {
      writeOAuthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
      return;
    }
    if (!pkceMatches(form.get("code_verifier"), request.codeChallenge)) {
      writeOAuthError(res, 400, "invalid_grant", "code_verifier does not match");
      return;
    }
    if (!validResource(form.all("resource"))) {
      writeOAuthError(res, 400, "invalid_target", `resource must be ${resource}`);
      return;
    }
    const grant = {
      id: randomToken(12),
      clientId: client.clientId,
      clientName: displayClientName(client.name),
      accountId: request.accountId,
      approvedByDevice: request.decidedByDevice,
      resource: request.resource
    };
    const pair = newTokenPair(time);
    try {
      store.exchangeCode({ requestId: request.id, codeHash, grant, tokens: pair.tokens });
    } catch (error) {
      if (error?.code === "invalid_grant") {
        writeOAuthError(res, 400, "invalid_grant", "authorization code was already used");
        return;
      }
      logger.error?.(`oauth code exchange failed: ${errorMessage(error)}`);
      writeOAuthError(res, 500, "server_error", "could not issue tokens");
      return;
    }
    writeTokenResponse(res, pair);
  }

  function refresh(res, form, client) {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX) || !validResource(form.all("resource"))) {
      writeOAuthError(res, 400, "invalid_grant", "refresh token is invalid");
      return;
    }
    const pair = newTokenPair(now());
    try {
      store.refreshTokens({
        refreshHash: hashSecret(refreshToken),
        clientId: client.clientId,
        tokens: pair.tokens,
        reuseGraceMs: REFRESH_REUSE_GRACE,
        maxGrantLifetimeMs: MAX_GRANT_LIFETIME
      });
    } catch (error) {
      if (error?.code === "token_reuse") {
        logger.warn?.(`oauth refresh token reuse revoked grant ${error.grant.id}`);
        notifyGrantRevoked(error.grant, "refresh_token_reuse");
        writeOAuthError(res, 400, "invalid_grant", "refresh token was already used; the connection was revoked");
        return;
      }
      if (error?.code === "invalid_grant") {
        writeOAuthError(res, 400, "invalid_grant", "refresh token is invalid, expired, or revoked");
        return;
      }
      logger.error?.(`oauth refresh failed: ${errorMessage(error)}`);
      writeOAuthError(res, 500, "server_error", "could not refresh tokens");
      return;
    }
    writeTokenResponse(res, pair);
  }

  async function revoke(req, res) {
    setCors(res);
    if (!allowRequest("revoke", req, TOKEN_PER_IP_PER_HOUR)) {
      writeOAuthError(res, 429, "temporarily_unavailable", "too many revocation requests; try again later");
      return;
    }
    let form;
    try {
      form = await readForm(req, res, REVOKE_BODY_LIMIT);
    } catch {
      writeOAuthError(res, 400, "invalid_request", "revocation request must be form-encoded");
      return;
    }
    const client = authenticateClient(req, res, form);
    if (!client) return;
    const value = form.get("token");
    if (value) {
      try {
        store.revokeToken(hashSecret(value), client.clientId);
      } catch (error) {
        logger.error?.(`oauth revoke failed: ${errorMessage(error)}`);
        writeOAuthError(res, 500, "server_error", "could not revoke token");
        return;
      }
    }
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.end();
  }

  // Applies RFC 6749 section 2.3 client authentication.
  function authenticateClient(req, res, form) {
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    let usedBasic = false;
    const basic = basicAuth(req);
    if (basic) {
      let decodedId;
      let decodedSecret;
      try {
        decodedId = queryUnescape(basic.username);
        decodedSecret = queryUnescape(basic.password);
      } catch {
        writeClientError(res);
        return null;
      }
      if (clientId && clientId !== decodedId) {
        writeClientError(res);
        return null;
      }
      clientId = decodedId;
      secret = decodedSecret;
      usedBasic = true;
    }
    let client;
    try {
      client = store.getClient(clientId);
    } catch (error) {
      logger.error?.(`oauth client lookup failed: ${errorMessage(error)}`);
      writeOAuthError(res, 500, "server_error", "could not verify client");
      return null;
    }
    if (!clientId || !client) {
      writeClientError(res);
      return null;
    }
    switch (client.authMethod) {
      case AUTH_METHOD_NONE:
        return client;
      case AUTH_METHOD_BASIC:
      case AUTH_METHOD_POST:
        if ((client.authMethod === AUTH_METHOD_BASIC) !== usedBasic || !secretMatches(secret, client.secretHash)) {
          writeClientError(res);
          return null;
        }
        return client;
      default:
        writeClientError(res);
        return null;
    }
  }

  function allowedRedirectUri(raw) {
    const url = parseRedirectUri(raw);
    if (!url) return false;
    if (url.protocol === "http:") return isLoopbackHost(url.hostname);
    if (url.protocol === "https:") return TRUSTED_REDIRECT_URIS.includes(raw) || extraUris.includes(raw);
    return false;
  }

  function validResource(values) {
    return values.every(value => {
      const trimmed = value.replace(/\/+$/, "");
      return trimmed === resource || trimmed === issuer;
    });
  }

  function successRedirect(redirectUri, state, code) {
    return appendQuery(redirectUri, state, { code, iss: issuer });
  }

  function errorRedirect(redirectUri, state, code, description) {
    return appendQuery(redirectUri, state, { error: code, error_description: description, iss: issuer });
  }

  // The per-address window is checked first so requests refused for one
  // address never consume the shared budget. Token and revocation requests
  // have no shared budget, like the Go reference, so one address cannot lock
  // every client out of refreshing.
  function allowRequest(kind, req, perIp, global) {
    if (!limiter.allow(`${kind}:${requestIp(req)}`, perIp, HOUR)) return false;
    return global === undefined || limiter.allow(kind, global, HOUR);
  }

  function requestIp(req) {
    return String(clientIp(req) ?? "");
  }

  function sendError(res, status, message) {
    sendPage(res, status, errorPage(message));
  }

  function notifyGrantRevoked(grant, reason) {
    if (typeof onGrantRevoked !== "function") return;
    const report = error => logger.error?.(`oauth revocation callback failed: ${errorMessage(error)}`);
    try {
      const result = onGrantRevoked({ accountId: grant.accountId, clientName: grant.clientName, reason });
      if (typeof result?.then === "function") result.then(undefined, report);
    } catch (error) {
      report(error);
    }
  }

  function verifyAccessToken(value) {
    if (typeof value !== "string" || !value.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const result = store.verifyAccessToken(hashSecret(value));
    if (!result || result.grant.resource !== resource) return null;
    return {
      grantId: result.grant.id,
      accountId: result.grant.accountId,
      clientId: result.grant.clientId,
      clientName: result.grant.clientName,
      expiresAt: result.expiresAt
    };
  }

  // Called by the relay when a plugin user types the code from the
  // authorization page. It never reveals whether a code expired or never
  // existed.
  function lookupApproval({ code, accountId, deviceId, ip } = {}) {
    requireIdentity(accountId, deviceId);
    const allowed = limiter.allow(`lookup:device:${deviceId}`, LOOKUPS_PER_DEVICE, LOOKUP_WINDOW)
      && limiter.allow(`lookup:account:${accountId}`, LOOKUPS_PER_ACCOUNT, LOOKUP_WINDOW)
      && (!ip || limiter.allow(`lookup:ip:${ip}`, LOOKUPS_PER_IP, LOOKUP_WINDOW));
    if (!allowed) throw approvalError("rate_limited", "too many approval code lookups; try again later");
    const normalized = normalizeApprovalCode(code);
    const found = normalized
      ? store.lookupRequest({ approvalHash: hashSecret(normalized), accountId, deviceId })
      : null;
    if (!found) {
      throw approvalError("not_found", "approval code is invalid or expired");
    }
    return {
      requestId: found.requestId,
      clientName: displayClientName(found.clientName),
      ...redirectDetails(found.redirectUri),
      expiresAt: found.expiresAt
    };
  }

  function decideApproval({ requestId, approve, accountId, deviceId } = {}) {
    requireIdentity(accountId, deviceId);
    const decided = typeof requestId === "string" && requestId
      ? store.decideRequest({ requestId, approve: approve === true, accountId, deviceId })
      : null;
    if (!decided) throw approvalError("not_found", "authorization request is invalid or expired");
    return { status: decided.status };
  }

  function redirectDetails(uri) {
    const url = parseRedirectUri(uri);
    let redirectKind = "custom";
    if (url?.protocol === "http:" && isLoopbackHost(url.hostname)) redirectKind = "loopback";
    else if (TRUSTED_REDIRECT_URIS.includes(uri)) redirectKind = "claude";
    return { redirectKind, redirectHost: url?.host ?? "" };
  }

  function listGrants(accountId) {
    if (!isNonEmptyString(accountId)) return [];
    return store.listGrants(accountId, { maxGrantLifetimeMs: MAX_GRANT_LIFETIME }).map(grant => ({
      grantId: grant.id,
      clientName: grant.clientName,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      expiresAt: grant.expiresAt
    }));
  }

  function revokeGrant({ grantId, accountId } = {}) {
    if (!isNonEmptyString(grantId) || !isNonEmptyString(accountId)) return false;
    return store.revokeGrant(accountId, grantId) !== null;
  }

  function revokeDeviceGrants({ accountId, deviceId } = {}) {
    if (!isNonEmptyString(accountId) || !isNonEmptyString(deviceId)) return 0;
    return store.revokeDeviceGrants(accountId, deviceId);
  }

  function revokeAccountGrants(accountId) {
    if (!isNonEmptyString(accountId)) return 0;
    return store.revokeAccountGrants(accountId);
  }

  return {
    issuer,
    resource,
    resourceMetadataUrl,
    handle,
    verifyAccessToken,
    lookupApproval,
    decideApproval,
    listGrants,
    revokeGrant,
    revokeDeviceGrants,
    revokeAccountGrants
  };
}

// Accepts the code as typed: case-insensitive, with spaces or dashes, and with
// the Crockford base32 look-alikes O, I, and L.
export function normalizeApprovalCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/[\s-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (normalized.length !== APPROVAL_CODE_LENGTH) return null;
  for (const character of normalized) {
    if (!APPROVAL_ALPHABET.includes(character)) return null;
  }
  return normalized;
}

function normalizeIssuer(publicUrl) {
  const issuer = String(publicUrl ?? "").trim().replace(/\/+$/, "");
  const invalid = new Error(`oauth issuer must be an https origin without a path, got ${JSON.stringify(publicUrl)}`);
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#@\\\s]+$/i.test(issuer)) throw invalid;
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw invalid;
  }
  if (!url.host || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) throw invalid;
  return url.origin;
}

// Parses an absolute redirect URI the way browsers will follow it, and rejects
// forms that could be read differently: fragments, userinfo, backslashes,
// whitespace, and scheme-relative authority.
function parseRedirectUri(raw) {
  if (typeof raw !== "string" || /[\s\\#]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?]*)/i.exec(raw);
  if (!match || !match[1] || match[1].includes("@")) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.host || url.username || url.password || url.hash) return null;
  return url;
}

// Resolves the redirect_uri of an authorization request. Loopback URIs match
// regardless of port (RFC 8252 section 7.3).
function registeredRedirectUri(client, requested) {
  if (!requested) return client.redirectUris.length === 1 ? client.redirectUris[0] : null;
  if (client.redirectUris.includes(requested)) return requested;
  const requestedUrl = parseRedirectUri(requested);
  if (requestedUrl?.protocol !== "http:") return null;
  for (const registered of client.redirectUris) {
    const registeredUrl = parseRedirectUri(registered);
    if (registeredUrl?.protocol !== "http:" || !isLoopbackHost(registeredUrl.hostname)) continue;
    if (registeredUrl.hostname === requestedUrl.hostname && registeredUrl.pathname === requestedUrl.pathname
      && registeredUrl.search === requestedUrl.search) {
      return requested;
    }
  }
  return null;
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function appendQuery(rawUrl, state, values) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (state) url.searchParams.set("state", state);
  url.searchParams.sort();
  return url.href;
}

function newTokenPair(time) {
  const access = ACCESS_TOKEN_PREFIX + randomToken(32);
  const refresh = REFRESH_TOKEN_PREFIX + randomToken(32);
  return {
    access,
    refresh,
    tokens: [
      { hash: hashSecret(access), kind: "access", expiresAt: new Date(time.getTime() + ACCESS_TOKEN_TTL) },
      { hash: hashSecret(refresh), kind: "refresh", expiresAt: new Date(time.getTime() + REFRESH_TOKEN_TTL) }
    ]
  };
}

function writeTokenResponse(res, { access, refresh }) {
  res.setHeader("Pragma", "no-cache");
  writeJson(res, 200, {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL / SECOND,
    refresh_token: refresh,
    scope: SCOPE
  });
}

function pkceMatches(verifier, challenge) {
  if (!validPkceValue(verifier)) return false;
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  return constantTimeEqual(expected, challenge);
}

// Checks RFC 7636 length and alphabet for verifiers and S256 challenges.
function validPkceValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function cleanClientName(name) {
  const cleaned = String(name ?? "").toWellFormed().replace(/[\p{Cc}\p{Cf}]/gu, "");
  return truncateCodePoints(cleaned.split(/\s+/u).filter(Boolean).join(" "), MAX_CLIENT_NAME_LENGTH);
}

function truncateCodePoints(value, limit) {
  const codePoints = Array.from(value);
  return codePoints.length > limit ? codePoints.slice(0, limit).join("") : value;
}

function displayClientName(name) {
  return name || DEFAULT_CLIENT_NAME;
}

function randomApprovalCode() {
  let code = "";
  for (let index = 0; index < APPROVAL_CODE_LENGTH; index += 1) {
    code += APPROVAL_ALPHABET[crypto.randomInt(APPROVAL_ALPHABET.length)];
  }
  return code;
}

function formatApprovalCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secretMatches(secret, hash) {
  if (!secret || !hash) return false;
  return constantTimeEqual(hashSecret(secret), hash);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireIdentity(accountId, deviceId) {
  if (!isNonEmptyString(accountId) || !isNonEmptyString(deviceId)) {
    throw new TypeError("accountId and deviceId must be non-empty strings");
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}

function approvalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseRegistration(buffer) {
  const value = JSON.parse(buffer.toString("utf8")) ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("registration must be an object");
  return {
    redirectUris: stringArray(value.redirect_uris),
    authMethod: optionalString(value.token_endpoint_auth_method),
    grantTypes: stringArray(value.grant_types),
    responseTypes: stringArray(value.response_types),
    clientName: optionalString(value.client_name)
  };
}

function parseStatusRequest(buffer) {
  const value = JSON.parse(buffer.toString("utf8")) ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("status request must be an object");
  return { request: optionalString(value.request), secret: optionalString(value.secret) };
}

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw new TypeError("expected an array of strings");
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError("expected a string");
  return value;
}

function requestPath(req) {
  try {
    return new URL(req.url ?? "", "http://localhost").pathname;
  } catch {
    return "";
  }
}

// Reads at most limit bytes. An oversized body closes the connection after the
// response instead of draining it.
function readBody(req, res, limit) {
  return new Promise((resolve, reject) => {
    const fail = error => {
      res.setHeader("Connection", "close");
      reject(error);
    };
    if (Number(req.headers["content-length"]) > limit) {
      fail(new Error("request body too large"));
      return;
    }
    if (req.readableEnded) {
      reject(new Error("request body was already consumed"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        fail(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = error => {
      if (settled) return;
      cleanup();
      fail(error);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

// Mirrors Go's Request.ParseForm: only form-encoded bodies are read, and
// malformed encodings are errors. Repeated keys keep every value.
async function readForm(req, res, limit) {
  const contentType = req.headers["content-type"] ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (contentType && !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)) {
    throw new TypeError("invalid content type");
  }
  const text = mediaType === "application/x-www-form-urlencoded" ? (await readBody(req, res, limit)).toString("utf8") : "";
  const values = new Map();
  for (const pair of text.split("&")) {
    if (!pair) continue;
    if (pair.includes(";")) throw new TypeError("invalid semicolon separator in form");
    const separator = pair.indexOf("=");
    const key = queryUnescape(separator < 0 ? pair : pair.slice(0, separator));
    const value = queryUnescape(separator < 0 ? "" : pair.slice(separator + 1));
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return {
    get: name => values.get(name)?.[0] ?? "",
    all: name => values.get(name) ?? []
  };
}

function queryUnescape(value) {
  if (/%(?![0-9a-f]{2})/i.test(value)) throw new URIError("invalid percent-encoding");
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function basicAuth(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || header.slice(0, 6).toLowerCase() !== "basic ") return null;
  const encoded = header.slice(6);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function onlyMethods(methods, handler) {
  return (req, res) => {
    if (methods.includes(req.method)) return handler(req, res);
    res.setHeader("Allow", methods.join(", "));
    httpError(res, 405, "Method Not Allowed");
  };
}

function allowMetadataMethod(req, res) {
  setCors(res);
  switch (req.method) {
    case "OPTIONS":
      res.statusCode = 204;
      res.end();
      return false;
    case "GET":
    case "HEAD":
      return true;
    default:
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      httpError(res, 405, "method not allowed");
      return false;
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
}

function sendPage(res, status, page) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(page.headers)) res.setHeader(name, value);
  res.end(page.body);
}

function httpError(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(`${message}\n`);
}

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(`${JSON.stringify(value)}\n`);
}

function writeOAuthError(res, status, error, description) {
  writeJson(res, status, { error, error_description: description });
}

function writeClientError(res) {
  res.setHeader("WWW-Authenticate", 'Basic realm="figma-bridge-oauth"');
  writeOAuthError(res, 401, "invalid_client", "client authentication failed");
}

// Fixed-window counters per key. Each entry keeps its own window so keys with
// different windows can share one map.
function createLimiter(now) {
  const windows = new Map();

  function active(key, time) {
    const entry = windows.get(key);
    return entry && time - entry.start < entry.window ? entry : null;
  }

  function sweep(time) {
    if (windows.size <= MAX_LIMITER_KEYS) return;
    for (const [key, entry] of windows) {
      if (time - entry.start >= entry.window) windows.delete(key);
    }
  }

  return {
    allow(key, limit, window) {
      const time = now().getTime();
      sweep(time);
      const entry = active(key, time) ?? { start: time, count: 0, window };
      if (entry.count >= limit) return false;
      entry.count += 1;
      windows.set(key, entry);
      return true;
    }
  };
}
