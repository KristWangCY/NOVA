import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { quorumSize } from "../core/block.js";
import { hashObject } from "../core/canonical.js";
import { publicKeyFromPrivate } from "../core/crypto.js";
import { validateGenesis } from "../core/genesis.js";
import { isEncryptedKeystore, unlockKeyFile } from "../core/keystore.js";
import { createBackup, readVerifiedNodeHome } from "./backup.js";
import { readJson } from "./files.js";
import { advertisedNodeUrl } from "./node-config.js";

function addCheck(report, id, status, message, details) {
  report.checks.push({ id, status, message, ...(details === undefined ? {} : { details }) });
}

function finalize(report) {
  const summary = { passed: 0, warnings: 0, failed: 0 };
  for (const check of report.checks) {
    if (check.status === "pass") summary.passed += 1;
    if (check.status === "warn") summary.warnings += 1;
    if (check.status === "fail") summary.failed += 1;
  }
  report.summary = summary;
  report.healthy = summary.failed === 0;
  return report;
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateStoredKey(storedKey) {
  if (!storedKey?.address || !storedKey?.publicKey) {
    throw new Error("node key is missing its public identity");
  }
  if (!isEncryptedKeystore(storedKey)) {
    if (!storedKey.privateKey || publicKeyFromPrivate(storedKey.privateKey) !== storedKey.publicKey) {
      throw new Error("plaintext node key does not contain a matching private key");
    }
  }
}

export function inspectNetwork(directory) {
  const root = resolve(directory);
  const report = {
    version: 1,
    checkedAt: Date.now(),
    directory: root,
    chainId: null,
    expectedValidators: 0,
    quorum: 0,
    nodes: [],
    checks: [],
    backupSource: null,
  };

  let genesis;
  try {
    genesis = readJson(resolve(root, "genesis.json"));
    validateGenesis(genesis);
    report.chainId = genesis.chainId;
    report.expectedValidators = genesis.validators.length;
    report.quorum = quorumSize(genesis.validators.length);
    addCheck(report, "genesis", "pass", `genesis is valid for ${genesis.chainId}`);
  } catch (error) {
    addCheck(report, "genesis", "fail", `cannot validate network genesis: ${error.message}`);
    return finalize(report);
  }

  const expectedNames = genesis.validators.map((_, index) => `node${index + 1}`);
  const actualNames = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node[0-9]+$/.test(entry.name))
      .map((entry) => entry.name)
    : [];
  const unexpectedNames = actualNames.filter((name) => !expectedNames.includes(name));
  if (unexpectedNames.length > 0) {
    addCheck(report, "node-directories", "warn", "unexpected node directories are present", unexpectedNames);
  }

  const verifiedChains = new Map();
  for (let index = 0; index < expectedNames.length; index += 1) {
    const name = expectedNames[index];
    const home = resolve(root, name);
    const node = {
      name,
      home,
      url: genesis.validators[index].url,
      validator: null,
      keyEncrypted: null,
      passwordEnvironment: null,
      keyUnlockVerified: null,
      height: null,
      blockHash: null,
      valid: false,
      errors: [],
      online: null,
    };
    report.nodes.push(node);

    try {
      const config = readJson(resolve(home, "config.json"));
      const storedKey = readJson(resolve(home, "node-key.json"));
      validateStoredKey(storedKey);
      const snapshot = readVerifiedNodeHome(home);
      if (hashObject(snapshot.genesis) !== hashObject(genesis)) {
        throw new Error("node genesis differs from the network genesis");
      }

      const validator = genesis.validators.find(({ address }) => address === storedKey.address);
      if (!validator || validator.publicKey !== storedKey.publicKey) {
        throw new Error("node key is not a validator in the network genesis");
      }
      if (validator.address !== genesis.validators[index].address) {
        throw new Error(`${name} does not contain the validator assigned to its index`);
      }
      if (config.name !== name) {
        throw new Error(`config name is ${config.name ?? "missing"}, expected ${name}`);
      }
      const configuredUrl = advertisedNodeUrl(config);
      if (configuredUrl !== validator.url) {
        throw new Error(`configured URL ${configuredUrl} differs from genesis URL ${validator.url}`);
      }
      const expectedPeers = genesis.validators
        .filter(({ address }) => address !== validator.address)
        .map(({ url }) => url);
      if (!Array.isArray(config.peers) || !sameStringSet(config.peers, expectedPeers)) {
        throw new Error("configured peers differ from the genesis validator set");
      }

      node.keyEncrypted = isEncryptedKeystore(storedKey);
      if (node.keyEncrypted !== Boolean(config.keyPasswordEnv)) {
        throw new Error("node key encryption and password environment configuration disagree");
      }
      node.passwordEnvironment = config.keyPasswordEnv || null;
      node.validator = validator.address;
      node.url = validator.url;
      node.height = snapshot.height;
      node.blockHash = snapshot.blockHash;
      node.valid = true;
      verifiedChains.set(name, snapshot.chain);
      addCheck(report, `node.${name}`, "pass", `${name} chain and configuration are valid at height ${snapshot.height}`);
    } catch (error) {
      node.errors.push(error.message);
      addCheck(report, `node.${name}`, "fail", `${name} is invalid: ${error.message}`);
    }
  }

  const validNodes = report.nodes.filter(({ valid }) => valid);
  if (validNodes.length !== genesis.validators.length) {
    addCheck(
      report,
      "offline-validator-count",
      "fail",
      `only ${validNodes.length}/${genesis.validators.length} validator homes passed offline verification`,
    );
    return finalize(report);
  }
  addCheck(report, "offline-validator-count", "pass", `all ${validNodes.length} validator homes passed offline verification`);

  const byHeight = [...validNodes].sort((left, right) => right.height - left.height);
  const longest = byHeight[0];
  const longestChain = verifiedChains.get(longest.name);
  let divergent = false;
  for (const node of byHeight.slice(1)) {
    const chain = verifiedChains.get(node.name);
    const sharedLength = Math.min(chain.length, longestChain.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (chain[index].hash !== longestChain[index].hash) {
        divergent = true;
        node.valid = false;
        node.errors.push(`chain diverges from ${longest.name} at height ${index}`);
        addCheck(
          report,
          "chain-prefix",
          "fail",
          `${node.name} diverges from ${longest.name} at height ${index}`,
        );
        break;
      }
    }
  }

  if (!divergent) {
    addCheck(report, "chain-prefix", "pass", "all verified node chains share the same history");
    report.backupSource = {
      name: longest.name,
      home: longest.home,
      height: longest.height,
      blockHash: longest.blockHash,
    };
  }

  const sameTip = byHeight.every(
    ({ height, blockHash }) => height === longest.height && blockHash === longest.blockHash,
  );
  if (sameTip) {
    addCheck(report, "offline-heads", "pass", `all node homes are at height ${longest.height} with the same block hash`);
  } else if (!divergent) {
    addCheck(
      report,
      "offline-heads",
      "warn",
      `node homes share one chain but are at different heights; highest is ${longest.height}`,
    );
  }
  return finalize(report);
}

async function fetchStatus(node, timeoutMs) {
  const response = await fetch(`${node.url}/status`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function diagnoseNetwork({
  directory,
  probeOnline = true,
  requireOnline = false,
  timeoutMs = 750,
}) {
  const report = inspectNetwork(directory);
  report.probeOnline = probeOnline;
  report.requireOnline = requireOnline;
  report.onlineValidators = 0;

  for (const node of report.nodes.filter(({ valid, keyEncrypted }) => valid && keyEncrypted)) {
    const password = node.passwordEnvironment ? process.env[node.passwordEnvironment] : undefined;
    if (!password) {
      addCheck(
        report,
        `key-unlock.${node.name}`,
        "warn",
        `${node.name} key is encrypted but ${node.passwordEnvironment} is not set; password was not verified`,
      );
      continue;
    }
    try {
      const unlocked = unlockKeyFile(readJson(resolve(node.home, "node-key.json")), password);
      if (unlocked.address !== node.validator) throw new Error("unlocked key has the wrong validator address");
      node.keyUnlockVerified = true;
      addCheck(report, `key-unlock.${node.name}`, "pass", `${node.name} validator key unlock succeeded`);
    } catch (error) {
      node.keyUnlockVerified = false;
      addCheck(report, `key-unlock.${node.name}`, "fail", `${node.name} validator key unlock failed: ${error.message}`);
    }
  }

  if (!probeOnline || report.nodes.length === 0) {
    addCheck(report, "online", "pass", "online probe was skipped");
    return finalize(report);
  }

  await Promise.all(report.nodes.map(async (node) => {
    try {
      const status = await fetchStatus(node, timeoutMs);
      const errors = [];
      if (status.ok !== true) errors.push("status is not ok");
      if (status.name !== node.name) errors.push(`reported name is ${status.name}`);
      if (status.chainId !== report.chainId) errors.push(`reported chain is ${status.chainId}`);
      if (!Number.isSafeInteger(status.height) || status.height < 0) errors.push("reported height is invalid");
      if (typeof status.blockHash !== "string" || !/^[0-9a-f]{64}$/.test(status.blockHash)) {
        errors.push("reported block hash is invalid");
      }
      if (status.validators !== report.expectedValidators) errors.push("reported validator count is invalid");
      if (status.quorum !== report.quorum) errors.push("reported quorum is invalid");
      if (status.peerAuthentication !== "ed25519-v1") errors.push("reported peer authentication is invalid");
      if (node.validator && status.validator !== node.validator) errors.push("reported validator address differs from disk");
      if (node.keyEncrypted !== null && status.validatorKeyEncrypted !== node.keyEncrypted) {
        errors.push("reported key encryption differs from disk");
      }
      node.online = {
        reachable: true,
        valid: errors.length === 0,
        height: status.height,
        blockHash: status.blockHash,
        validatorKeyEncrypted: status.validatorKeyEncrypted,
        errors,
      };
      report.onlineValidators += 1;
      if (errors.length > 0) {
        addCheck(report, `online.${node.name}`, "fail", `${node.name} returned inconsistent status`, errors);
      }
    } catch (error) {
      node.online = { reachable: false, valid: false, error: error.message };
    }
  }));

  if (report.onlineValidators === 0) {
    addCheck(
      report,
      "online-validator-count",
      requireOnline ? "fail" : "warn",
      requireOnline
        ? "no validator API is reachable"
        : "network is stopped; offline data can still be verified",
    );
    return finalize(report);
  }
  if (report.onlineValidators !== report.expectedValidators) {
    addCheck(
      report,
      "online-validator-count",
      "fail",
      `only ${report.onlineValidators}/${report.expectedValidators} validator APIs are reachable`,
    );
    return finalize(report);
  }
  addCheck(report, "online-validator-count", "pass", `all ${report.onlineValidators} validator APIs are reachable`);

  const online = report.nodes.map(({ online }) => online);
  const reference = online[0];
  const sameHeight = online.every(({ height }) => height === reference.height);
  const sameHead = online.every(
    ({ height, blockHash }) => height === reference.height && blockHash === reference.blockHash,
  );
  if (sameHead) {
    addCheck(report, "online-heads", "pass", `all online validators agree at height ${reference.height}`);
  } else if (sameHeight) {
    addCheck(report, "online-heads", "fail", `online validators report conflicting blocks at height ${reference.height}`);
  } else {
    addCheck(report, "online-heads", "warn", "online validators are at different heights and may still be synchronizing");
  }
  return finalize(report);
}

export function createNetworkBackup(directory, output) {
  const deploymentPath = resolve(directory, "deployment.json");
  if (existsSync(deploymentPath)) {
    const deployment = readJson(deploymentPath);
    if (deployment?.type === "nova-network-deployment" && deployment.transport === "private-network-required") {
      throw new Error(
        "distributed deployment roots contain bootstrap copies, not live remote chains; use backup create --deployment for authenticated remote backup",
      );
    }
  }
  const inspection = inspectNetwork(directory);
  if (!inspection.healthy || !inspection.backupSource) {
    const failures = inspection.checks
      .filter(({ status }) => status === "fail")
      .map(({ message }) => message)
      .join("; ");
    throw new Error(`network is not safe to back up: ${failures || "no verified backup source"}`);
  }
  const backup = createBackup(inspection.backupSource.home, output);
  return {
    ...backup,
    networkDirectory: inspection.directory,
    sourceNode: inspection.backupSource.name,
    observedValidators: inspection.nodes.length,
  };
}
