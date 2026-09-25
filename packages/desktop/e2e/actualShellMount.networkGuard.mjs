// Test-profile network policy, injected before Core/CLI imports via NODE_OPTIONS.
// Real Core and Pi worker may use local TCP and IPC, but cannot leave this machine.
import net from "node:net";

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const host =
    typeof first === "number"
      ? typeof args[1] === "string"
        ? args[1]
        : "localhost"
      : typeof first === "string"
        ? first.startsWith("/") || first.startsWith("\\\\.\\pipe\\")
          ? "localhost"
          : first
        : typeof first === "object" && first !== null
          ? first.path
            ? "localhost"
            : (first.host ?? "localhost")
          : "localhost";
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) {
    throw new Error("Actual Shell fixture denied non-loopback TCP");
  }
  return connect.apply(this, args);
};
