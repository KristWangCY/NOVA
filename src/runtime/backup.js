import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createGenesisBlock, verifyCommittedBlock } from "../core/block.js";
import { hashObject } from "../core/canonical.js";
import { validateGenesis } from "../core/genesis.js";
import { createGenesisState, stateRoot } from "../core/state.js";
import { atomicWriteJson, readJson } from "./files.js";
import { NodeHomeLock } from "./node-lock.js";

function backupPayload(backup) {
  return {
    version: backup.version,
    type: backup.type,
    createdAt: backup.createdAt,
    genesis: backup.genesis,
    chain: backup.chain,
  };
}

export function verifyBackup(backup) {
  if (!backup || backup.version !== 1 || backup.type !== "nova-chain-backup") {
    throw new Error("unsupported NOVA backup format");
  }
  if (!Number.isSafeInteger(backup.createdAt) || backup.createdAt <= 0) {
    throw new Error("backup has an invalid creation time");
  }
  if (hashObject(backupPayload(backup)) !== backup.snapshotHash) {
    throw new Error("backup checksum does not match its contents");
  }
  validateGenesis(backup.genesis);
  if (!Array.isArray(backup.chain) || backup.chain.length === 0) {
    throw new Error("backup chain is empty");
  }

  const expectedGenesisBlock = createGenesisBlock(backup.genesis);
  if (backup.chain[0].hash !== expectedGenesisBlock.hash) {
    throw new Error("backup genesis block does not match its genesis configuration");
  }
  let state = createGenesisState(backup.genesis);
  let tip = expectedGenesisBlock;
  for (const block of backup.chain.slice(1)) {
    state = verifyCommittedBlock(block, backup.genesis, tip, state);
    tip = block;
  }
  return {
    valid: true,
    chainId: backup.genesis.chainId,
    height: tip.header.height,
    blockHash: tip.hash,
    stateRoot: stateRoot(state),
    createdAt: backup.createdAt,
    state,
  };
}

export function createBackup(home, output) {
  const { genesis, chain } = readVerifiedNodeHome(home);
  const unsigned = {
    version: 1,
    type: "nova-chain-backup",
    createdAt: Date.now(),
    genesis,
    chain,
  };
  const backup = { ...unsigned, snapshotHash: hashObject(unsigned) };
  const verification = verifyBackup(backup);
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  atomicWriteJson(target, backup);
  return { ...verification, output: target };
}

export function verifyNodeHome(home) {
  const { nodeHome, genesis, chain, ...verification } = readVerifiedNodeHome(home);
  return verification;
}

export function readVerifiedNodeHome(home) {
  const nodeHome = resolve(home);
  const genesis = readJson(resolve(nodeHome, "genesis.json"));
  const chainPath = resolve(nodeHome, "chain.json");
  const chain = existsSync(chainPath) ? readJson(chainPath) : [createGenesisBlock(genesis)];
  const unsigned = {
    version: 1,
    type: "nova-chain-backup",
    createdAt: Date.now(),
    genesis,
    chain,
  };
  const verification = verifyBackup({ ...unsigned, snapshotHash: hashObject(unsigned) });
  return { ...verification, nodeHome, genesis, chain };
}

export function restoreBackup(home, backupFile) {
  const nodeHome = resolve(home);
  const lock = new NodeHomeLock(nodeHome);
  try {
    const backup = readJson(resolve(backupFile));
    const verification = verifyBackup(backup);
    const existingGenesis = readJson(resolve(nodeHome, "genesis.json"));
    if (hashObject(existingGenesis) !== hashObject(backup.genesis)) {
      throw new Error("backup genesis does not match the target node");
    }

    const key = readJson(resolve(nodeHome, "node-key.json"));
    if (!backup.genesis.validators.some((validator) => validator.address === key.address && validator.publicKey === key.publicKey)) {
      throw new Error("target node key is not a validator in this backup");
    }
    readJson(resolve(nodeHome, "config.json"));

    atomicWriteJson(resolve(nodeHome, "chain.json"), backup.chain);
    atomicWriteJson(resolve(nodeHome, "state.json"), verification.state);
    atomicWriteJson(resolve(nodeHome, "mempool.json"), []);
    atomicWriteJson(resolve(nodeHome, "votes.json"), {});
    return { ...verification, restoredTo: nodeHome };
  } finally {
    lock.release();
  }
}
