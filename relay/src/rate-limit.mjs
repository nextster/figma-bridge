import net from "node:net";

const MAX_KEYS = 100_000;

/** Fixed-window counters. Unexpired windows are never evicted early. */
export function createRateLimiter({ now = () => Date.now(), maxKeys = MAX_KEYS } = {}) {
  const windows = new Map();

  function prune(timestamp) {
    for (const [key, window] of windows) {
      if (window.resetAt <= timestamp) windows.delete(key);
    }
  }

  return {
    /** Counts one event and returns false when the key exceeded its limit. */
    allow(key, limit, windowMs) {
      const timestamp = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= timestamp) {
        if (!window && windows.size >= maxKeys) prune(timestamp);
        // So many live windows means a flood from distinct addresses; refusing
        // new keys keeps existing counters intact instead of resetting them.
        if (!windows.has(key) && windows.size >= maxKeys) return false;
        window = { count: 0, resetAt: timestamp + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return window.count <= limit;
    }
  };
}

/**
 * Returns the rate-limit identity of a request. IPv6 clients control their
 * whole /64, so addresses are grouped by prefix.
 */
export function clientAddress(request, { trustProxy } = {}) {
  let address = request.socket.remoteAddress || "unknown";
  if (trustProxy === "fly") {
    const forwarded = request.headers["fly-client-ip"];
    if (typeof forwarded === "string" && forwarded) address = forwarded.trim().slice(0, 64);
  }
  return addressIdentity(address);
}

export function addressIdentity(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (net.isIPv6(address)) {
    const groups = expandIPv6(address);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
  }
  return address;
}

function expandIPv6(address) {
  const [head, tail = ""] = address.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") && tail ? tail.split(":") : [];
  if (right.some(part => part.includes(".")) || left.some(part => part.includes("."))) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(address.includes("::") ? missing : 0).fill("0"), ...right];
  return groups.length === 8 ? groups.map(group => group.toLowerCase().replace(/^0+(?=.)/, "")) : null;
}
