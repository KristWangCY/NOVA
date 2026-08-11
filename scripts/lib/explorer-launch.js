import { createServer } from "node:net";

export const DEFAULT_EXPLORER_PORT = 3100;
export const EXPLORER_HOST = "127.0.0.1";
export const RESERVED_LOCAL_NODE_PORTS = new Set([4101, 4102, 4103]);

export function resolveExplorerPort(environment = process.env) {
  const raw = environment.NOVA_EXPLORER_PORT?.trim() || String(DEFAULT_EXPLORER_PORT);
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("NOVA_EXPLORER_PORT must be an integer between 1024 and 65535");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("NOVA_EXPLORER_PORT must be an integer between 1024 and 65535");
  }
  if (RESERVED_LOCAL_NODE_PORTS.has(port)) {
    throw new Error(`NOVA_EXPLORER_PORT ${port} conflicts with a default validator API port`);
  }
  return port;
}

export function assertExplorerPortAvailable(port, host = EXPLORER_HOST) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      const message = error?.code === "EADDRINUSE"
        ? `NOVA Explorer cannot start because ${host}:${port} is already in use; set NOVA_EXPLORER_PORT to another local port`
        : `NOVA Explorer cannot check ${host}:${port}: ${error.message}`;
      rejectPromise(new Error(message));
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  });
}
