import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { hashObject } from "../core/canonical.js";
import { validateGenesis } from "../core/genesis.js";
import { isEncryptedKeystore } from "../core/keystore.js";
import { readVerifiedNodeHome } from "./backup.js";
import { atomicWriteJson, readJson } from "./files.js";
import { advertisedNodeUrl } from "./node-config.js";
import { NodeHomeLock } from "./node-lock.js";
import { readDeployment } from "./deployment.js";

const BUNDLE_FIELDS = [
  "version",
  "type",
  "createdAt",
  "node",
  "validator",
  "genesis",
  "config",
  "nodeKeystore",
  "bundleHash",
];

function assertEmptyOrMissing(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`refusing to overwrite non-empty directory: ${path}`);
  }
}

function bundlePayload(bundle) {
  return {
    version: bundle.version,
    type: bundle.type,
    createdAt: bundle.createdAt,
    node: bundle.node,
    validator: bundle.validator,
    genesis: bundle.genesis,
    config: bundle.config,
    nodeKeystore: bundle.nodeKeystore,
  };
}

export function verifyValidatorBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("validator bundle must be an object");
  }
  if (JSON.stringify(Object.keys(bundle).sort()) !== JSON.stringify([...BUNDLE_FIELDS].sort())) {
    throw new Error("validator bundle contains unsupported or missing fields");
  }
  if (bundle.version !== 1 || bundle.type !== "nova-validator-bundle") {
    throw new Error("unsupported NOVA validator bundle format");
  }
  if (!Number.isSafeInteger(bundle.createdAt) || bundle.createdAt <= 0) {
    throw new Error("validator bundle has an invalid creation time");
  }
  if (!/^node[1-9][0-9]*$/.test(bundle.node)) throw new Error("validator bundle has an invalid node name");
  if (hashObject(bundlePayload(bundle)) !== bundle.bundleHash) {
    throw new Error("validator bundle checksum does not match its contents");
  }
  validateGenesis(bundle.genesis);
  if (!isEncryptedKeystore(bundle.nodeKeystore)) {
    throw new Error("validator bundle key must be an encrypted keystore");
  }
  if (bundle.config.version !== 2 || bundle.config.name !== bundle.node) {
    throw new Error("validator bundle requires a matching version 2 node config");
  }
  const validator = bundle.genesis.validators.find(({ address }) => address === bundle.validator);
  if (
    !validator
    || validator.publicKey !== bundle.nodeKeystore.publicKey
    || validator.address !== bundle.nodeKeystore.address
  ) {
    throw new Error("validator bundle identity is not in its genesis");
  }
  if (advertisedNodeUrl(bundle.config) !== validator.url) {
    throw new Error("validator bundle advertised URL differs from genesis");
  }
  if (!bundle.config.keyPasswordEnv) throw new Error("validator bundle is missing its password environment name");
  if (!Array.isArray(bundle.config.peers)) throw new Error("validator bundle peers must be an array");
  const expectedPeers = bundle.genesis.validators
    .filter(({ address }) => address !== validator.address)
    .map(({ url }) => url)
    .sort();
  if (JSON.stringify([...bundle.config.peers].sort()) !== JSON.stringify(expectedPeers)) {
    throw new Error("validator bundle peers differ from genesis");
  }
  return {
    valid: true,
    chainId: bundle.genesis.chainId,
    node: bundle.node,
    validator: bundle.validator,
    url: validator.url,
    passwordEnvironment: bundle.config.keyPasswordEnv,
    createdAt: bundle.createdAt,
  };
}

export function createValidatorBundle(networkDirectory, node, output) {
  if (!/^node[1-9][0-9]*$/.test(node)) throw new Error("--node must look like node1");
  const root = resolve(networkDirectory);
  const { deployment } = readDeployment(root);
  const deploymentNode = deployment.nodes.find(({ name }) => name === node);
  if (!deploymentNode) throw new Error(`${node} is not in the deployment manifest`);
  const home = resolve(root, node);
  const lock = new NodeHomeLock(home);
  try {
    const snapshot = readVerifiedNodeHome(home);
    if (snapshot.height !== 0) {
      throw new Error("validator bootstrap bundles can only be created before the network produces blocks");
    }
    const config = readJson(resolve(home, "config.json"));
    const nodeKeystore = readJson(resolve(home, "node-key.json"));
    const unsigned = {
      version: 1,
      type: "nova-validator-bundle",
      createdAt: Date.now(),
      node,
      validator: deploymentNode.validator,
      genesis: snapshot.genesis,
      config,
      nodeKeystore,
    };
    const bundle = { ...unsigned, bundleHash: hashObject(unsigned) };
    const verification = verifyValidatorBundle(bundle);
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) throw new Error(`refusing to overwrite existing validator bundle: ${target}`);
    atomicWriteJson(target, bundle);
    return { ...verification, output: target };
  } finally {
    lock.release();
  }
}

export function installValidatorBundle(bundleFile, home) {
  const source = resolve(bundleFile);
  const bundle = readJson(source);
  const verification = verifyValidatorBundle(bundle);
  const target = resolve(home);
  assertEmptyOrMissing(target);
  const staging = resolve(dirname(target), `.${basename(target)}.installing-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  try {
    atomicWriteJson(resolve(staging, "genesis.json"), bundle.genesis);
    atomicWriteJson(resolve(staging, "config.json"), bundle.config);
    atomicWriteJson(resolve(staging, "node-key.json"), bundle.nodeKeystore);
    if (existsSync(target)) rmdirSync(target);
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...verification, source, installedTo: target };
}
