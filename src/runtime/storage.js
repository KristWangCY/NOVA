import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGenesisBlock, verifyProposal, votePayload } from "../core/block.js";
import { verifyObject } from "../core/crypto.js";
import { validateGenesis } from "../core/genesis.js";
import { applyTransaction, cloneState, createGenesisState } from "../core/state.js";
import { verifyCommittedBlock } from "../core/block.js";
import { atomicWriteJson, readJson } from "./files.js";
import { isEncryptedKeystore, unlockKeyFile } from "../core/keystore.js";
import { advertisedNodeUrl } from "./node-config.js";

const VOTE_LOCK_FIELDS = ["hash", "proposal", "vote"];
const VOTE_FIELDS = ["validator", "signature"];

function sameFields(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function readRecoverableMempool(path) {
  if (!existsSync(path)) return { entries: [], malformed: false };
  try {
    const value = readJson(path);
    return Array.isArray(value)
      ? { entries: value, malformed: false }
      : { entries: [], malformed: true };
  } catch (error) {
    if (error instanceof SyntaxError) return { entries: [], malformed: true };
    throw error;
  }
}

function recoverMempool(entries, state, chainId) {
  const candidateState = cloneState(state);
  const retained = [];
  for (const transaction of entries) {
    try {
      applyTransaction(candidateState, transaction, chainId);
      retained.push(transaction);
    } catch {
      // Mempool data is non-final and recoverable; committed, duplicated, or invalid entries are discarded.
    }
  }
  return retained;
}

function recoverVoteLocks(value, { genesis, tip, state, key }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted validator vote locks must be an object");
  }
  const recovered = {};
  let discarded = 0;
  for (const [heightKey, lock] of Object.entries(value)) {
    if (!/^[1-9][0-9]*$/.test(heightKey) || !Number.isSafeInteger(Number(heightKey))) {
      throw new Error("persisted validator vote lock has an invalid height");
    }
    const height = Number(heightKey);
    if (height <= tip.header.height) {
      discarded += 1;
      continue;
    }
    if (height !== tip.header.height + 1) {
      throw new Error("persisted validator vote lock is ahead of the next block height");
    }
    if (!sameFields(lock, VOTE_LOCK_FIELDS) || lock.hash !== lock.proposal?.hash) {
      throw new Error(`persisted validator vote lock at height ${height} is malformed`);
    }
    verifyProposal(lock.proposal, genesis, tip, state);
    if (
      lock.proposal.header.height !== height
      || !sameFields(lock.vote, VOTE_FIELDS)
      || lock.vote.validator !== key.address
      || !verifyObject(votePayload(lock.proposal), lock.vote.signature, key.publicKey)
    ) {
      throw new Error(`persisted validator vote lock at height ${height} is invalid`);
    }
    recovered[heightKey] = lock;
  }
  return { locks: recovered, discarded };
}

export class NodeStorage {
  constructor(home, { keyPassword } = {}) {
    this.home = resolve(home);
    this.keyPassword = keyPassword;
    this.paths = {
      config: resolve(this.home, "config.json"),
      genesis: resolve(this.home, "genesis.json"),
      key: resolve(this.home, "node-key.json"),
      chain: resolve(this.home, "chain.json"),
      state: resolve(this.home, "state.json"),
      mempool: resolve(this.home, "mempool.json"),
      votes: resolve(this.home, "votes.json"),
    };
  }

  load() {
    this.config = readJson(this.paths.config);
    advertisedNodeUrl(this.config);
    this.genesis = readJson(this.paths.genesis);
    const storedKey = readJson(this.paths.key);
    const password = this.keyPassword ?? (this.config.keyPasswordEnv ? process.env[this.config.keyPasswordEnv] : undefined);
    this.keyEncrypted = isEncryptedKeystore(storedKey);
    this.key = unlockKeyFile(storedKey, password);
    validateGenesis(this.genesis);

    const validatorIndex = this.genesis.validators.findIndex(({ address }) => address === this.key.address);
    const validator = this.genesis.validators[validatorIndex];
    if (!validator || validator.publicKey !== this.key.publicKey) {
      throw new Error("node key is not in the genesis validator set");
    }
    const expectedName = `node${validatorIndex + 1}`;
    if (this.config.name !== expectedName) {
      throw new Error(`node config name ${this.config.name ?? "missing"} does not match validator assignment ${expectedName}`);
    }
    if (advertisedNodeUrl(this.config) !== validator.url) {
      throw new Error("node advertised URL differs from its genesis validator URL");
    }
    const expectedPeers = this.genesis.validators
      .filter(({ address }) => address !== validator.address)
      .map(({ url }) => url)
      .sort();
    if (
      !Array.isArray(this.config.peers)
      || JSON.stringify([...this.config.peers].sort()) !== JSON.stringify(expectedPeers)
    ) {
      throw new Error("node peers differ from the genesis validator set");
    }

    const expectedGenesisBlock = createGenesisBlock(this.genesis);
    this.chain = existsSync(this.paths.chain) ? readJson(this.paths.chain) : [expectedGenesisBlock];
    if (!Array.isArray(this.chain) || this.chain.length === 0 || this.chain[0].hash !== expectedGenesisBlock.hash) {
      throw new Error("stored chain does not match genesis");
    }

    let replayedState = createGenesisState(this.genesis);
    let tip = expectedGenesisBlock;
    for (const block of this.chain.slice(1)) {
      replayedState = verifyCommittedBlock(block, this.genesis, tip, replayedState);
      tip = block;
    }
    this.state = replayedState;
    const storedMempool = readRecoverableMempool(this.paths.mempool);
    this.mempool = recoverMempool(storedMempool.entries, this.state, this.genesis.chainId);
    const storedVotes = existsSync(this.paths.votes) ? readJson(this.paths.votes) : {};
    const recoveredVotes = recoverVoteLocks(storedVotes, {
      genesis: this.genesis,
      tip: this.tip,
      state: this.state,
      key: this.key,
    });
    this.votes = recoveredVotes.locks;
    this.recovery = {
      malformedMempool: storedMempool.malformed,
      discardedMempoolEntries: storedMempool.entries.length - this.mempool.length,
      discardedCommittedVoteLocks: recoveredVotes.discarded,
    };

    this.persistChainAndState();
    this.persistMempool();
    this.persistVotes();
    return this;
  }

  get tip() {
    return this.chain.at(-1);
  }

  persistChainAndState() {
    atomicWriteJson(this.paths.chain, this.chain);
    atomicWriteJson(this.paths.state, this.state);
  }

  persistMempool() {
    atomicWriteJson(this.paths.mempool, this.mempool);
  }

  persistVotes() {
    atomicWriteJson(this.paths.votes, this.votes);
  }
}
