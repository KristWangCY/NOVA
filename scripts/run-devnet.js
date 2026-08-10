import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { runValidatorProcesses } from "./lib/run-validators.js";

const root = resolve(".nova/devnet");
if (!existsSync(root)) {
  const created = initializeDevnet({ directory: root });
  console.log(`Created ${created.genesis.chainId}`);
  console.log(`Faucet key: ${created.faucet.keyFile}`);
  console.log(`Faucet address: ${created.faucet.address}`);
  console.warn("WARNING: devnet validator and faucet keys are unencrypted test keys.");
}

runValidatorProcesses(root);
