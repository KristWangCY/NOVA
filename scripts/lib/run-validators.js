import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readJson } from "../../src/runtime/files.js";

export function runValidatorProcesses(directory) {
  const root = resolve(directory);
  if (!existsSync(root)) {
    throw new Error(`network directory does not exist: ${root}`);
  }
  const genesis = readJson(resolve(root, "genesis.json"));
  const nodeHomes = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^node[0-9]+$/.test(entry.name))
    .sort((left, right) => Number(left.name.slice(4)) - Number(right.name.slice(4)))
    .map((entry) => resolve(root, entry.name))
    .slice(0, genesis.validators.length);

  if (nodeHomes.length !== genesis.validators.length) {
    throw new Error("network directory is incomplete; every genesis validator needs a node home");
  }

  console.log(`Starting ${nodeHomes.length} validators. Press Ctrl+C to stop.`);
  const children = nodeHomes.map((home) => spawn(
    process.execPath,
    [resolve("src/cli.js"), "node", "start", "--home", home],
    { stdio: "inherit", windowsHide: true },
  ));

  let stopping = false;
  function stop(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    process.exitCode = exitCode;
  }

  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  for (const child of children) {
    child.once("exit", (code) => {
      if (!stopping && code !== 0) {
        console.error(`A validator exited with code ${code}`);
        stop(code || 1);
      }
    });
  }
  return { children, stop, root, genesis };
}
