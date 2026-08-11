import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  assertExplorerPortAvailable,
  DEFAULT_EXPLORER_PORT,
  EXPLORER_HOST,
  resolveExplorerPort,
} from "../scripts/lib/explorer-launch.js";

test("NOVA Explorer uses an isolated configurable local port", () => {
  assert.equal(DEFAULT_EXPLORER_PORT, 3100);
  assert.equal(EXPLORER_HOST, "127.0.0.1");
  assert.equal(resolveExplorerPort({}), 3100);
  assert.equal(resolveExplorerPort({ NOVA_EXPLORER_PORT: " 3200 " }), 3200);
  for (const value of ["0", "1023", "65536", "3.1", "abc", "4101", "4102", "4103"]) {
    assert.throws(
      () => resolveExplorerPort({ NOVA_EXPLORER_PORT: value }),
      /NOVA_EXPLORER_PORT/,
    );
  }
});

test("NOVA Explorer rejects an occupied port with an actionable error", async (t) => {
  const holder = createServer();
  t.after(() => new Promise((resolveClose) => holder.close(resolveClose)));
  await new Promise((resolveListen, rejectListen) => {
    holder.once("error", rejectListen);
    holder.listen({ host: EXPLORER_HOST, port: 0, exclusive: true }, resolveListen);
  });
  const address = holder.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    assertExplorerPortAvailable(address.port),
    new RegExp(`${EXPLORER_HOST}:${address.port} is already in use`),
  );

  const launch = spawnSync(process.execPath, [resolve("scripts/run-nova.js"), "--secure"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NOVA_EXPLORER_PORT: String(address.port),
      NOVA_KEY_PASSWORD: "not-used-before-port-check",
    },
  });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, new RegExp(`${EXPLORER_HOST}:${address.port} is already in use`));
  assert.doesNotMatch(launch.stdout, /Starting NOVA/);
});
