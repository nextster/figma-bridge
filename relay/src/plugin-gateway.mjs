// WebSocket endpoint for Figma plugins connecting to the relay.
//
// A plugin authenticates as a device of an account (hello) or redeems an
// invite or link code (register). Afterwards the relay sends Figma commands as
// rpc.request messages, and the plugin calls account operations such as
// approving an OAuth request that the user started in their browser.

import { WebSocketServer } from "ws";
import { cleanError, createFigmaHub } from "../../companion/src/hub.mjs";

const PROTOCOL = 1;
// Plugin exports are capped at 8 MiB raw, which is about 10.7 MiB as base64 JSON.
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const ALLOWED_ORIGINS = new Set(["null", "https://www.figma.com"]);
const PUBLIC_ERRORS = new Set(["invalid_code", "rate_limited", "device_limit", "not_found", "invalid_request"]);

export function createPluginGateway({ accounts, oauth, signup = "invite", limiter, clientIp, logger = console, version }) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const hubs = new Map();

  const heartbeat = setInterval(() => {
    for (const websocket of websocketServer.clients) {
      if (websocket.isAlive === false) {
        websocket.terminate();
        continue;
      }
      websocket.isAlive = false;
      websocket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function handleUpgrade(request, socket, head) {
    const origin = request.headers.origin;
    const ip = clientIp(request);
    if ((origin !== undefined && !ALLOWED_ORIGINS.has(origin)) || !limiter.allow(`plugin-connect:${ip}`, 60, 60_000)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, websocket => onConnection(websocket, ip));
  }

  function onConnection(websocket, ip) {
    let device = null;
    let clientId = null;
    websocket.isAlive = true;
    websocket.on("pong", () => { websocket.isAlive = true; });
    const authTimeout = setTimeout(() => websocket.close(4401, "authentication required"), AUTH_TIMEOUT_MS);

    websocket.on("message", raw => void onMessage(raw));
    websocket.on("close", () => {
      clearTimeout(authTimeout);
      if (!device) return;
      const hub = hubs.get(device.accountId);
      if (hub && clientId) {
        hub.unregister(clientId, websocket);
        if (hub.size === 0) hubs.delete(device.accountId);
      }
    });

    async function onMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        websocket.close(4400, "invalid JSON");
        return;
      }
      if (!message || typeof message !== "object") {
        websocket.close(4400, "invalid message");
        return;
      }

      if (!device) {
        if (message.type === "hello") {
          const authenticated = accounts.authenticateDevice({ id: message.device?.id, secret: message.device?.secret });
          if (!authenticated) {
            websocket.close(4403, "device not recognized");
            return;
          }
          attach(authenticated, message.client);
          send({ type: "hello.ok", protocol: PROTOCOL, version, accountId: device.accountId, deviceId: device.id, clientId });
          return;
        }
        if (message.type === "register") {
          if (!limiter.allow(`register:${ip}`, 10, 10 * 60_000) || !limiter.check("register-failures", 200)) {
            send({ type: "register.error", error: "rate_limited" });
            return;
          }
          try {
            const registered = accounts.register({ code: message.code, deviceName: message.deviceName, signup });
            attach({ id: registered.id, accountId: registered.accountId }, message.client);
            send({
              type: "register.ok",
              protocol: PROTOCOL,
              version,
              device: { id: registered.id, secret: registered.secret },
              accountId: registered.accountId,
              created: registered.created,
              clientId
            });
          } catch (error) {
            if (error.code === "invalid_code") limiter.allow("register-failures", 200, 60 * 60_000);
            send({ type: "register.error", error: publicError(error) });
          }
          return;
        }
        websocket.close(4401, "authentication required");
        return;
      }

      const hub = hubs.get(device.accountId);
      if (hub?.handleMessage(clientId, websocket, message)) return;
      if (message.type === "call") {
        await onCall(message);
        return;
      }
      send({ type: "error", error: "unknown_message" });
    }

    async function onCall(message) {
      const id = typeof message.id === "string" ? message.id.slice(0, 64) : null;
      if (!limiter.allow(`plugin-call:${device.id}`, 120, 60_000)) {
        send({ type: "call.result", id, ok: false, error: "rate_limited" });
        return;
      }
      try {
        const result = await dispatchCall(message.method, message.params || {});
        send({ type: "call.result", id, ok: true, result });
      } catch (error) {
        send({ type: "call.result", id, ok: false, error: publicError(error) });
      }
    }

    async function dispatchCall(method, params) {
      const scope = { accountId: device.accountId, deviceId: device.id };
      switch (method) {
        case "approval.lookup":
          return oauth.lookupApproval({ code: params.code, ip, ...scope });
        case "approval.decide":
          if (typeof params.requestId !== "string" || typeof params.approve !== "boolean") throw codedError("invalid_request");
          return oauth.decideApproval({ requestId: params.requestId, approve: params.approve, ...scope });
        case "grants.list":
          return oauth.listGrants(device.accountId);
        case "grants.revoke":
          if (typeof params.grantId !== "string") throw codedError("invalid_request");
          return { revoked: await oauth.revokeGrant({ grantId: params.grantId, accountId: device.accountId }) };
        case "devices.link":
          return accounts.createLinkCode(scope);
        case "devices.list":
          return accounts.listDevices(device.accountId).map(item => ({ ...item, current: item.deviceId === device.id }));
        case "devices.revoke": {
          if (typeof params.deviceId !== "string") throw codedError("invalid_request");
          const revoked = accounts.revokeDevice({ accountId: device.accountId, deviceId: params.deviceId });
          if (revoked) setImmediate(() => disconnectDevice(params.deviceId, "device revoked"));
          return { revoked };
        }
        default:
          throw codedError("invalid_request");
      }
    }

    function attach(authenticated, rawClient) {
      clearTimeout(authTimeout);
      device = authenticated;
      let hub = hubs.get(device.accountId);
      if (!hub) {
        hub = createFigmaHub();
        hubs.set(device.accountId, hub);
      }
      clientId = hub.register(websocket, rawClient);
      websocket.device = device;
    }

    function send(value) {
      if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify(value));
    }
  }

  function publicError(error) {
    if (PUBLIC_ERRORS.has(error?.code)) return error.code;
    logger.error?.(`Figma Bridge relay plugin call failed: ${cleanError(error)}`);
    return "server_error";
  }

  function disconnectDevice(deviceId, reason) {
    for (const websocket of websocketServer.clients) {
      if (websocket.device?.id === deviceId) websocket.close(4403, reason);
    }
  }

  return {
    handleUpgrade,
    disconnectDevice,

    clients(accountId) {
      return hubs.get(accountId)?.publicClients() || [];
    },

    activeClientId(accountId) {
      return hubs.get(accountId)?.activeClientId || null;
    },

    request(accountId, clientId, command, args) {
      const hub = hubs.get(accountId);
      if (!hub) return Promise.reject(new Error("No Figma plugin is connected to the relay. Run Figma Bridge in the target Figma file and connect it to the relay."));
      return hub.request(clientId, command, args);
    },

    notifyAccount(accountId, notice) {
      for (const websocket of websocketServer.clients) {
        if (websocket.device?.accountId === accountId && websocket.readyState === websocket.OPEN) {
          websocket.send(JSON.stringify({ type: "notice", notice }));
        }
      }
    },

    close() {
      clearInterval(heartbeat);
      for (const websocket of websocketServer.clients) websocket.terminate();
      return new Promise(resolve => websocketServer.close(() => resolve()));
    }
  };
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
