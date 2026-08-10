import { hashObject, merkleRoot } from "./canonical.js";
import { signObject, verifyObject } from "./crypto.js";
import { createGenesisState, executeTransactions, stateRoot } from "./state.js";

export function quorumSize(validatorCount) {
  if (!Number.isInteger(validatorCount) || validatorCount < 1) {
    throw new Error("validator set cannot be empty");
  }
  return Math.ceil((validatorCount * 2) / 3);
}

export function validatorForSlot(genesis, slot) {
  return genesis.validators[slot % genesis.validators.length];
}

export function createGenesisBlock(genesis) {
  const state = createGenesisState(genesis);
  const header = {
    version: 1,
    chainId: genesis.chainId,
    height: 0,
    previousHash: null,
    timestamp: genesis.genesisTime,
    slot: -1,
    proposer: "genesis",
    transactionRoot: merkleRoot([]),
    stateRoot: stateRoot(state),
  };
  return {
    header,
    transactions: [],
    hash: hashObject(header),
    proposerSignature: null,
    commit: { votes: [] },
  };
}

export function createProposal({ genesis, tip, state, transactions, key, slot, timestamp = Date.now() }) {
  const height = tip.header.height + 1;
  const nextState = executeTransactions(state, transactions, genesis.chainId, height);
  const header = {
    version: 1,
    chainId: genesis.chainId,
    height,
    previousHash: tip.hash,
    timestamp,
    slot,
    proposer: key.address,
    transactionRoot: merkleRoot(transactions.map(({ id }) => id)),
    stateRoot: stateRoot(nextState),
  };
  const hash = hashObject(header);
  return {
    header,
    transactions,
    hash,
    proposerSignature: signObject({ chainId: genesis.chainId, blockHash: hash }, key.privateKey),
  };
}

export function votePayload(proposal) {
  return {
    chainId: proposal.header.chainId,
    height: proposal.header.height,
    slot: proposal.header.slot,
    blockHash: proposal.hash,
  };
}

export function createVote(proposal, key) {
  return {
    validator: key.address,
    signature: signObject(votePayload(proposal), key.privateKey),
  };
}

export function verifyVote(proposal, vote, genesis) {
  if (!vote || typeof vote.validator !== "string" || typeof vote.signature !== "string") {
    throw new Error("malformed validator vote");
  }
  const validator = genesis.validators.find(({ address }) => address === vote.validator);
  if (!validator || !verifyObject(votePayload(proposal), vote.signature, validator.publicKey)) {
    throw new Error("invalid validator vote");
  }
  return validator;
}

export function verifyProposal(proposal, genesis, tip, state) {
  if (!proposal?.header || !Array.isArray(proposal.transactions)) {
    throw new Error("malformed block proposal");
  }
  const { header } = proposal;
  if (header.version !== 1 || header.chainId !== genesis.chainId) {
    throw new Error("unsupported block version or chainId");
  }
  if (header.height !== tip.header.height + 1 || header.previousHash !== tip.hash) {
    throw new Error("proposal does not extend the committed tip");
  }
  if (!Number.isSafeInteger(header.slot) || header.slot <= tip.header.slot) {
    throw new Error("proposal slot must increase");
  }
  if (!Number.isSafeInteger(header.timestamp) || Math.floor(header.timestamp / genesis.blockTimeMs) !== header.slot) {
    throw new Error("proposal timestamp does not match its slot");
  }
  const expectedProposer = validatorForSlot(genesis, header.slot);
  if (!expectedProposer || header.proposer !== expectedProposer.address) {
    throw new Error("proposal was not created by this slot's validator");
  }
  if (hashObject(header) !== proposal.hash) {
    throw new Error("block hash does not match header");
  }
  if (merkleRoot(proposal.transactions.map(({ id }) => id)) !== header.transactionRoot) {
    throw new Error("transaction root does not match block contents");
  }
  if (!verifyObject({ chainId: genesis.chainId, blockHash: proposal.hash }, proposal.proposerSignature, expectedProposer.publicKey)) {
    throw new Error("invalid proposer signature");
  }

  const nextState = executeTransactions(state, proposal.transactions, genesis.chainId, header.height);
  if (stateRoot(nextState) !== header.stateRoot) {
    throw new Error("state root does not match deterministic execution");
  }
  return nextState;
}

export function verifyCommittedBlock(block, genesis, tip, state) {
  const nextState = verifyProposal(block, genesis, tip, state);
  if (!block.commit || !Array.isArray(block.commit.votes)) {
    throw new Error("block has no commit votes");
  }

  const seen = new Set();
  let validVotes = 0;
  for (const vote of block.commit.votes) {
    if (seen.has(vote.validator)) {
      continue;
    }
    try {
      verifyVote(block, vote, genesis);
      seen.add(vote.validator);
      validVotes += 1;
    } catch {
      // Invalid votes do not contribute to the commit quorum.
    }
  }
  if (validVotes < quorumSize(genesis.validators.length)) {
    throw new Error(`insufficient commit votes: received ${validVotes}`);
  }
  return nextState;
}
