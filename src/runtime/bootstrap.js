import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { generateKeyRecord } from "../core/crypto.js";
import { validateGenesis } from "../core/genesis.js";
import { atomicWriteJson } from "./files.js";
import { assertValidKeystorePassword, encryptKeyRecord } from "../core/keystore.js";
import { validateNetworkTopology } from "./topology.js";

function assertEmptyOrMissing(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`refusing to overwrite non-empty directory: ${path}`);
  }
}

export function initializeDevnet({
  directory,
  validators = 3,
  basePort = 4101,
  blockTimeMs = 1500,
  chainId = "nova-local-1",
  initialSupply = "1000000000000",
  encryptKeys = false,
  keyPassword,
  keyPasswordEnv = "NOVA_KEY_PASSWORD",
}) {
  if (!Number.isInteger(validators) || validators < 1 || validators > 20) {
    throw new Error("validators must be between 1 and 20");
  }
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort + validators > 65535) {
    throw new Error("invalid base port");
  }
  if (encryptKeys) {
    try {
      assertValidKeystorePassword(keyPassword);
    } catch (error) {
      throw new Error(`secure network initialization requires ${keyPasswordEnv}: ${error.message}`);
    }
  }

  const nodes = Array.from({ length: validators }, (_, index) => ({
    url: `http://127.0.0.1:${basePort + index}`,
    listenHost: "127.0.0.1",
    port: basePort + index,
    password: encryptKeys ? keyPassword : undefined,
    passwordEnv: encryptKeys ? keyPasswordEnv : null,
  }));
  return initializeConfiguredNetwork({
    directory,
    chainId,
    blockTimeMs,
    initialSupply,
    nodes,
    faucetPassword: encryptKeys ? keyPassword : undefined,
    faucetPasswordEnv: encryptKeys ? keyPasswordEnv : null,
    transport: "local-only",
  });
}

function initializeConfiguredNetwork({
  directory,
  chainId,
  blockTimeMs,
  initialSupply,
  nodes,
  faucetPassword,
  faucetPasswordEnv,
  transport,
}) {
  const root = resolve(directory);
  assertEmptyOrMissing(root);
  const stagingRoot = resolve(dirname(root), `.${basename(root)}.initializing-${randomUUID()}`);
  mkdirSync(stagingRoot, { recursive: true });

  const validatorKeys = nodes.map((_, index) => generateKeyRecord(`validator-${index + 1}`));
  const encryptKeys = Boolean(faucetPassword);
  const faucetKey = generateKeyRecord(encryptKeys ? "private-faucet" : "devnet-faucet");
  const genesis = {
    version: 1,
    chainId,
    genesisTime: Date.now(),
    blockTimeMs,
    denomination: {
      name: "NOVA",
      symbol: "NOVA",
      smallestUnit: "unova",
      decimals: 6,
    },
    validators: validatorKeys.map((key, index) => ({
      name: `validator-${index + 1}`,
      address: key.address,
      publicKey: key.publicKey,
      url: nodes[index].url,
    })),
    allocations: {
      [faucetKey.address]: initialSupply,
    },
  };
  validateGenesis(genesis);

  try {
    atomicWriteJson(resolve(stagingRoot, "genesis.json"), genesis);
    atomicWriteJson(
      resolve(stagingRoot, "faucet-key.json"),
      encryptKeys ? encryptKeyRecord(faucetKey, faucetPassword) : faucetKey,
    );

    for (let index = 0; index < nodes.length; index += 1) {
      const home = resolve(stagingRoot, `node${index + 1}`);
      mkdirSync(home, { recursive: true });
      atomicWriteJson(resolve(home, "genesis.json"), genesis);
      atomicWriteJson(
        resolve(home, "node-key.json"),
        encryptKeys ? encryptKeyRecord(validatorKeys[index], nodes[index].password) : validatorKeys[index],
      );
      atomicWriteJson(resolve(home, "config.json"), {
        version: 2,
        name: `node${index + 1}`,
        listenHost: nodes[index].listenHost,
        port: nodes[index].port,
        advertisedUrl: nodes[index].url,
        proposalDelayMs: Math.min(500, Math.floor(blockTimeMs / 3)),
        syncIntervalMs: 750,
        requestTimeoutMs: 1200,
        maxTransactionsPerBlock: 500,
        emptyBlockIntervalMs: 30000,
        keyPasswordEnv: nodes[index].passwordEnv,
        peers: genesis.validators.filter((_, peerIndex) => peerIndex !== index).map(({ url }) => url),
      });
    }

    if (transport !== "local-only") {
      atomicWriteJson(resolve(stagingRoot, "deployment.json"), {
        version: 1,
        type: "nova-network-deployment",
        chainId,
        transport,
        faucetPasswordEnv,
        nodes: nodes.map((node, index) => ({
          name: `node${index + 1}`,
          validator: validatorKeys[index].address,
          url: node.url,
          listenHost: node.listenHost,
          port: node.port,
          passwordEnv: node.passwordEnv,
        })),
      });
    }

    if (existsSync(root)) rmdirSync(root);
    renameSync(stagingRoot, root);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    directory: root,
    genesis,
    faucet: {
      address: faucetKey.address,
      balance: initialSupply,
      keyFile: resolve(root, "faucet-key.json"),
      encrypted: encryptKeys,
    },
    nodes: genesis.validators.map((validator, index) => ({
      name: `node${index + 1}`,
      url: validator.url,
      home: resolve(root, `node${index + 1}`),
      validator: validator.address,
      keyEncrypted: encryptKeys,
      passwordEnvironment: nodes[index].passwordEnv,
    })),
    deploymentFile: transport === "local-only" ? null : resolve(root, "deployment.json"),
  };
}

export function initializeNetworkFromTopology({ directory, topology, environment = process.env }) {
  const normalized = validateNetworkTopology(topology);
  const secrets = [
    { name: normalized.faucetPasswordEnv, password: environment[normalized.faucetPasswordEnv] },
    ...normalized.validators.map(({ passwordEnv }) => ({ name: passwordEnv, password: environment[passwordEnv] })),
  ];
  for (const secret of secrets) {
    try {
      assertValidKeystorePassword(secret.password);
    } catch (error) {
      throw new Error(`secure topology initialization requires ${secret.name}: ${error.message}`);
    }
  }
  const passwordOwners = new Map();
  for (const secret of secrets) {
    if (passwordOwners.has(secret.password)) {
      throw new Error(`${secret.name} must use a password different from ${passwordOwners.get(secret.password)}`);
    }
    passwordOwners.set(secret.password, secret.name);
  }
  return initializeConfiguredNetwork({
    directory,
    chainId: normalized.chainId,
    blockTimeMs: normalized.blockTimeMs,
    initialSupply: normalized.initialSupply,
    nodes: normalized.validators.map((validator) => ({
      ...validator,
      password: environment[validator.passwordEnv],
    })),
    faucetPassword: environment[normalized.faucetPasswordEnv],
    faucetPasswordEnv: normalized.faucetPasswordEnv,
    transport: normalized.transport,
  });
}
