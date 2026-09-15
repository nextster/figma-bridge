const MAX_KEYS = 10_000;

/** Fixed-window counters with a bounded key set. */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();

  function prune(timestamp) {
    for (const [key, window] of windows) {
      if (window.resetAt > timestamp && windows.size < MAX_KEYS) break;
      windows.delete(key);
    }
  }

  return {
    /** Counts one event and returns false when the key exceeded its limit. */
    allow(key, limit, windowMs) {
      const timestamp = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= timestamp) {
        prune(timestamp);
        window = { count: 0, resetAt: timestamp + windowMs };
        windows.delete(key);
        windows.set(key, window);
      }
      window.count += 1;
      return window.count <= limit;
    },

    /** Returns false when the key is already over its limit, without counting. */
    check(key, limit) {
      const window = windows.get(key);
      return !window || window.resetAt <= now() || window.count < limit;
    }
  };
}

export function clientAddress(request, { trustProxy } = {}) {
  if (trustProxy === "fly") {
    const forwarded = request.headers["fly-client-ip"];
    if (typeof forwarded === "string" && forwarded) return forwarded.slice(0, 64);
  }
  return request.socket.remoteAddress || "unknown";
}
