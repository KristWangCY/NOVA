import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { quorumSize } from "../core/block.js";
import { hashObject } from "../core/canonical.js";
import { verifySignedStatus } from "../core/signed-status.js";
import { verifyBackup } from "./backup.js";
import { readDeployment } from "./deployment.js";
import { atomicWriteJson } from "./files.js";

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_BLOCK_PAGE_BYTES = 32 * 1024 * 1024;
const MAX_REMOTE_CHAIN_BYTES = 128 * 1024 * 1024;
const BLOCK_PAGE_SIZE = 10;
const MAX_REMOTE_BACKUP_BLOCKS = 1_000_000;

class RemoteUnavailableError extends Error {}

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

async function fetchJsonLimited(url, { timeoutMs, maxBytes, aggregateBudget }) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new RemoteUnavailableError(`remote node is unreachable: ${error.message}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (
    aggregateBudget
    && Number.isFinite(declaredLength)
    && aggregateBudget.usedBytes + declaredLength > aggregateBudget.maxBytes
  ) {
    throw new Error(`remote chain exceeds ${aggregateBudget.maxBytes} downloaded bytes`);
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
        if (aggregateBudget) {
          aggregateBudget.usedBytes += chunk.length;
          if (aggregateBudget.usedBytes > aggregateBudget.maxBytes) {
            throw new Error(`remote chain exceeds ${aggregateBudget.maxBytes} downloaded bytes`);
          }
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError") {
        throw new RemoteUnavailableError(`remote node response timed out: ${error.message}`);
      }
      throw error;
    }
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("remote node returned invalid JSON");
  }
  if (!response.ok) throw new Error(payload?.error ?? `remote node returned HTTP ${response.status}`);
  return payload;
}

async function querySignedStatus(node, genesis, timeoutMs) {
  const challenge = randomUUID();
  const response = await fetchJsonLimited(
    `${node.url}/status/signed?challenge=${encodeURIComponent(challenge)}`,
    { timeoutMs, maxBytes: MAX_STATUS_BYTES },
  );
  const verified = verifySignedStatus({
    response,
    genesis,
    expectedValidator: node.validator,
    challenge,
  });
  if (verified.status.name !== node.name) throw new Error("signed status reports the wrong node name");
  if (verified.status.validatorKeyEncrypted !== true) {
    throw new Error("distributed validator reports an unencrypted key");
  }
  return verified;
}

export async function diagnoseRemoteDeployment({ directory, timeoutMs = 1500 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("remote diagnosis timeout must be between 100 and 10000 milliseconds");
  }
  const { root, genesis, deployment } = readDeployment(directory);
  const quorum = quorumSize(genesis.validators.length);
  const report = {
    version: 1,
    remote: true,
    checkedAt: Date.now(),
    directory: root,
    chainId: genesis.chainId,
    expectedValidators: genesis.validators.length,
    quorum,
    onlineValidators: 0,
    operational: false,
    nodes: deployment.nodes.map((node) => ({
      name: node.name,
      url: node.url,
      validator: node.validator,
      valid: false,
      reachable: false,
      status: null,
      clockOffsetMs: null,
      error: null,
      securityFailure: false,
    })),
    checks: [],
    backupSource: null,
  };
  addCheck(report, "deployment", "pass", `deployment manifest is valid for ${genesis.chainId}`);

  await Promise.all(report.nodes.map(async (node) => {
    try {
      const verified = await querySignedStatus(node, genesis, timeoutMs);
      node.reachable = true;
      node.valid = true;
      node.status = verified.status;
      node.clockOffsetMs = verified.clockOffsetMs;
      report.onlineValidators += 1;
      addCheck(report, `signed-status.${node.name}`, "pass", `${node.name} returned a valid signed status`);
    } catch (error) {
      node.error = error.message;
      node.reachable = !(error instanceof RemoteUnavailableError);
      node.securityFailure = node.reachable;
      if (node.securityFailure) {
        addCheck(report, `signed-status.${node.name}`, "fail", `${node.name} returned an invalid signed status: ${error.message}`);
      }
    }
  }));

  if (report.onlineValidators < quorum) {
    addCheck(
      report,
      "remote-quorum",
      "fail",
      `only ${report.onlineValidators}/${genesis.validators.length} validators returned valid signed status; quorum is ${quorum}`,
    );
    return finalize(report);
  }
  report.operational = true;
  if (report.onlineValidators === genesis.validators.length) {
    addCheck(report, "remote-quorum", "pass", `all ${report.onlineValidators} validators returned valid signed status`);
  } else {
    addCheck(
      report,
      "remote-quorum",
      "warn",
      `${report.onlineValidators}/${genesis.validators.length} validators are authenticated and quorum remains available`,
    );
  }

  const online = report.nodes.filter(({ valid }) => valid);
  const reference = online[0].status;
  const sameHeight = online.every(({ status }) => status.height === reference.height);
  const sameHead = online.every(
    ({ status }) => status.height === reference.height && status.blockHash === reference.blockHash,
  );
  if (sameHead) {
    addCheck(report, "remote-heads", "pass", `authenticated validators agree at height ${reference.height}`);
  } else if (sameHeight) {
    report.operational = false;
    addCheck(report, "remote-heads", "fail", `authenticated validators conflict at height ${reference.height}`);
  } else {
    addCheck(report, "remote-heads", "warn", "authenticated validators are at different heights and may be synchronizing");
  }
  return finalize(report);
}

async function fetchChainAtSignedHead(node, timeoutMs) {
  const height = node.status.height;
  if (height + 1 > MAX_REMOTE_BACKUP_BLOCKS) {
    throw new Error(`remote chain exceeds the ${MAX_REMOTE_BACKUP_BLOCKS} block safety limit`);
  }
  const blocks = [];
  const aggregateBudget = { usedBytes: 0, maxBytes: MAX_REMOTE_CHAIN_BYTES };
  while (blocks.length <= height) {
    const remaining = height + 1 - blocks.length;
    const limit = Math.min(BLOCK_PAGE_SIZE, remaining);
    const payload = await fetchJsonLimited(
      `${node.url}/blocks?from=${blocks.length}&limit=${limit}`,
      { timeoutMs, maxBytes: MAX_BLOCK_PAGE_BYTES, aggregateBudget },
    );
    if (!Array.isArray(payload.blocks) || payload.blocks.length !== limit) {
      throw new Error(`remote node returned an incomplete block page at height ${blocks.length}`);
    }
    blocks.push(...payload.blocks);
  }
  return blocks;
}

function sharedPrefix(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index].hash !== right[index].hash) return index - 1;
  }
  return length - 1;
}

export async function createRemoteNetworkBackup({ directory, output, timeoutMs = 5000 }) {
  const { genesis } = readDeployment(directory);
  const diagnosis = await diagnoseRemoteDeployment({ directory, timeoutMs });
  if (diagnosis.nodes.some(({ securityFailure }) => securityFailure)) {
    throw new Error("remote backup refused because a configured validator returned an invalid signed status");
  }
  if (!diagnosis.operational) {
    throw new Error("remote backup requires authenticated validator quorum without a conflicting same-height head");
  }

  const createdAt = Date.now();
  const candidates = [];
  const failures = [];
  await Promise.all(diagnosis.nodes.filter(({ valid }) => valid).map(async (node) => {
    try {
      const chain = await fetchChainAtSignedHead(node, timeoutMs);
      const unsigned = { version: 1, type: "nova-chain-backup", createdAt, genesis, chain };
      const backup = { ...unsigned, snapshotHash: hashObject(unsigned) };
      const verification = verifyBackup(backup);
      if (verification.height !== node.status.height || verification.blockHash !== node.status.blockHash) {
        throw new Error("downloaded chain does not match the validator's signed head");
      }
      candidates.push({ node, chain, backup, verification });
    } catch (error) {
      failures.push({ node: node.name, error: error.message });
    }
  }));

  if (candidates.length < diagnosis.quorum) {
    throw new Error(`only ${candidates.length} complete remote chains passed verification; quorum is ${diagnosis.quorum}`);
  }
  candidates.sort((left, right) => (
    right.verification.height - left.verification.height
    || left.node.name.localeCompare(right.node.name)
  ));
  const highest = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const prefixHeight = sharedPrefix(highest.chain, candidate.chain);
    if (prefixHeight !== Math.min(highest.verification.height, candidate.verification.height)) {
      throw new Error(`${candidate.node.name} remote chain diverges from ${highest.node.name} at height ${prefixHeight + 1}`);
    }
  }

  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  atomicWriteJson(target, highest.backup);
  return {
    valid: true,
    chainId: genesis.chainId,
    height: highest.verification.height,
    blockHash: highest.verification.blockHash,
    stateRoot: highest.verification.stateRoot,
    createdAt,
    output: target,
    sourceNode: highest.node.name,
    observedValidators: candidates.length,
    unavailableValidators: diagnosis.nodes.length - diagnosis.onlineValidators,
    failedChainDownloads: failures,
  };
}
