import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertExplorerPortAvailable,
  EXPLORER_HOST,
  resolveExplorerPort,
} from "./lib/explorer-launch.js";

const explorerCli = resolve("explorer/node_modules/vinext/dist/cli.js");
if (!existsSync(explorerCli)) {
  throw new Error("Explorer dependencies are missing. Run: npm run setup");
}

const secure = process.argv.includes("--secure");
const explorerPort = resolveExplorerPort();
await assertExplorerPortAvailable(explorerPort);
const services = [
  {
    name: secure ? "private-network" : "devnet",
    command: process.execPath,
    args: [resolve(secure ? "scripts/run-private.js" : "scripts/run-devnet.js")],
    cwd: resolve("."),
  },
  {
    name: "explorer",
    command: process.execPath,
    args: [explorerCli, "dev", "--hostname", EXPLORER_HOST, "--port", String(explorerPort)],
    cwd: resolve("explorer"),
  },
];

console.log(`Starting NOVA ${secure ? "secure private network" : "devnet"} and local explorer...`);
console.log(`Explorer: http://${EXPLORER_HOST}:${explorerPort}`);
console.log("Press Ctrl+C to stop every NOVA service.");

const children = services.map((service) => ({
  ...service,
  child: spawn(service.command, service.args, {
    cwd: service.cwd,
    stdio: "inherit",
    windowsHide: true,
  }),
}));

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
for (const { name, child } of children) {
  child.once("exit", (code) => {
    if (!stopping && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      stop(code || 1);
    }
  });
}
