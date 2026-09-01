import net from "node:net";
import { controlSocketPath } from "./paths.mjs";

export function requestControl(method, params = {}, options = {}) {
  const socketPath = options.socketPath || controlSocketPath(options.env || process.env);
  const timeoutMs = options.timeoutMs || 35_000;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => socket.destroy(new Error(`bridge request timed out: ${method}`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error || "bridge request failed"));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
  });
}
