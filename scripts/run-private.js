import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { readJson } from "../src/runtime/files.js";
import { isEncryptedKeystore } from "../src/core/keystore.js";
import { runValidatorProcesses } from "./lib/run-validators.js";

const root = resolve(".nova/private");
const defaultPasswordVariable = "NOVA_KEY_PASSWORD";

const rootExists = existsSync(root);
const rootIsEmpty = rootExists && readdirSync(root).length === 0;
const requiredNetworkFiles = [
  resolve(root, "genesis.json"),
  resolve(root, "faucet-key.json"),
  ...[1, 2, 3].flatMap((index) => [
    resolve(root, `node${index}/config.json`),
    resolve(root, `node${index}/genesis.json`),
    resolve(root, `node${index}/node-key.json`),
  ]),
];

if (!rootExists || rootIsEmpty) {
  const password = process.env[defaultPasswordVariable];
  if (!password) {
    throw new Error(`Set $env:${defaultPasswordVariable} before creating the secure network.`);
  }
  const created = initializeDevnet({
    directory: root,
    chainId: "nova-private-1",
    encryptKeys: true,
    keyPassword: password,
    keyPasswordEnv: defaultPasswordVariable,
  });
  console.log(`Created secure network ${created.genesis.chainId}`);
  console.log(`Encrypted faucet: ${created.faucet.keyFile}`);
  console.log(`Faucet address: ${created.faucet.address}`);
} else if (!requiredNetworkFiles.every((path) => existsSync(path))) {
  throw new Error(
    `Private network directory is incomplete: ${root}. Move it aside for inspection, then run nova:secure again.`,
  );
}

const config = readJson(resolve(root, "node1/config.json"));
const storedKey = readJson(resolve(root, "node1/node-key.json"));
if (!isEncryptedKeystore(storedKey)) {
  throw new Error("private network validator key is unexpectedly unencrypted");
}
if (!config.keyPasswordEnv || !process.env[config.keyPasswordEnv]) {
  throw new Error(`Set $env:${config.keyPasswordEnv || defaultPasswordVariable} before starting the secure network.`);
}

runValidatorProcesses(root);
