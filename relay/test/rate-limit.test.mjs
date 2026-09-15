import assert from "node:assert/strict";
import test from "node:test";
import { addressIdentity, clientAddress, createRateLimiter } from "../src/rate-limit.mjs";
import { createFigmaHub } from "../../companion/src/hub.mjs";

test("rate limits never reset live windows when many keys arrive", () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock, maxKeys: 3 });
  assert.equal(limiter.allow("global", 1, 1000), true);
  assert.equal(limiter.allow("global", 1, 1000), false);
  assert.equal(limiter.allow("a", 1, 1000), true);
  assert.equal(limiter.allow("b", 1, 1000), true);
  // A flood of new keys is refused instead of evicting the global window.
  assert.equal(limiter.allow("c", 1, 1000), false);
  assert.equal(limiter.allow("global", 1, 1000), false);
  clock = 1000;
  assert.equal(limiter.allow("c", 1, 1000), true);
  assert.equal(limiter.allow("global", 1, 1000), true);
});

test("IPv6 clients are limited per /64 and mapped IPv4 is normalized", () => {
  assert.equal(addressIdentity("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(addressIdentity("2001:db8:1:2::ffff"), "2001:db8:1:2::/64");
  assert.equal(addressIdentity("2001:0db8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(addressIdentity("::1"), "0:0:0:0::/64");
  assert.equal(addressIdentity("::ffff:192.0.2.7"), "192.0.2.7");
  assert.equal(addressIdentity("192.0.2.7"), "192.0.2.7");
  const request = { socket: { remoteAddress: "10.0.0.1" }, headers: { "fly-client-ip": "2001:db8:9:9::5" } };
  assert.equal(clientAddress(request, { trustProxy: "fly" }), "2001:db8:9:9::/64");
  assert.equal(clientAddress(request, {}), "10.0.0.1");
});

test("the hub refuses new commands when a plugin stops reading", async () => {
  const hub = createFigmaHub({ maxPending: 2, maxBufferedBytes: 100, rpcTimeoutMs: 50 });
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send() {} };
  hub.register(socket, { id: "file" });
  const first = hub.request(undefined, "a", {});
  const second = hub.request(undefined, "b", {});
  await assert.rejects(hub.request(undefined, "c", {}), /Too many Figma commands/);
  await assert.rejects(first, /timed out/);
  await assert.rejects(second, /timed out/);
  socket.bufferedAmount = 101;
  await assert.rejects(hub.request(undefined, "d", {}), /not accepting commands/);
});
