import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../src/core/canonical.js";
import { createGenesisBlock, createProposal, createVote, verifyCommittedBlock } from "../src/core/block.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createGenesisState } from "../src/core/state.js";
import { createRecord, createTransfer, validateTransactionBasic } from "../src/core/transaction.js";

function fixture() {
  const keys = [generateKeyRecord("v1"), generateKeyRecord("v2"), generateKeyRecord("v3")];
  const faucet = generateKeyRecord("faucet");
  const recipient = generateKeyRecord("recipient");
  const blockTimeMs = 1000;
  const slot = Math.floor(Date.now() / blockTimeMs);
  const genesis = {
    version: 1,
    chainId: "nova-test-1",
    genesisTime: Date.now() - 1000,
    blockTimeMs,
    validators: keys.map((key, index) => ({
      name: `v${index + 1}`,
      address: key.address,
      publicKey: key.publicKey,
      url: `http://127.0.0.1:${5001 + index}`,
    })),
    allocations: { [faucet.address]: "1000000" },
  };
  return { keys, faucet, recipient, genesis, slot };
}

test("canonical JSON sorts object keys recursively", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, b: 2 } }), '{"a":{"b":2,"d":4},"z":1}');
});

test("signed transaction rejects tampering", () => {
  const { faucet, recipient, genesis } = fixture();
  const transaction = createTransfer({
    chainId: genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "50",
    nonce: 1,
  });
  assert.equal(validateTransactionBasic(transaction, genesis.chainId), true);
  assert.throws(() => validateTransactionBasic({ ...transaction, amount: "51" }, genesis.chainId), /signature|id/);
  assert.throws(() => validateTransactionBasic({ ...transaction, unsigned: "data" }, genesis.chainId), /unsupported or missing fields/);
});

test("signed record anchors a content hash while only charging its fee", () => {
  const { keys, faucet, genesis, slot } = fixture();
  const state = createGenesisState(genesis);
  const tip = createGenesisBlock(genesis);
  const contentHash = sha256("private file contents stay off chain");
  const transaction = createRecord({
    chainId: genesis.chainId,
    key: faucet,
    contentHash,
    contentSize: 36,
    title: "Ownership note",
    category: "document",
    note: "Public metadata only",
    fee: "3",
    nonce: 1,
  });
  assert.equal(validateTransactionBasic(transaction, genesis.chainId), true);
  assert.throws(
    () => validateTransactionBasic({ ...transaction, contentHash: sha256("tampered") }, genesis.chainId),
    /signature|id/,
  );
  const zeroFee = createRecord({ ...transaction, key: faucet, fee: "0" });
  assert.throws(() => validateTransactionBasic(zeroFee, genesis.chainId), /fee must be positive/);

  const proposal = createProposal({
    genesis,
    tip,
    state,
    transactions: [transaction],
    key: keys[slot % keys.length],
    slot,
    timestamp: slot * genesis.blockTimeMs,
  });
  const block = { ...proposal, commit: { votes: [createVote(proposal, keys[0]), createVote(proposal, keys[1])] } };
  const next = verifyCommittedBlock(block, genesis, tip, state);
  assert.equal(next.balances[faucet.address], "999997");
  assert.equal(next.nonces[faucet.address], 1);
  assert.equal(next.burnedFees, "3");
  assert.equal(next.totalSupply, "999997");
  assert.equal(Object.hasOwn(next, "records"), false, "record history belongs in signed blocks, not duplicated state");
});

test("two of three validator votes commit a deterministic state transition", () => {
  const { keys, faucet, recipient, genesis, slot } = fixture();
  const state = createGenesisState(genesis);
  const tip = createGenesisBlock(genesis);
  const proposer = keys[slot % keys.length];
  const transaction = createTransfer({
    chainId: genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "100",
    fee: "2",
    nonce: 1,
  });
  const proposal = createProposal({
    genesis,
    tip,
    state,
    transactions: [transaction],
    key: proposer,
    slot,
    timestamp: slot * genesis.blockTimeMs,
  });
  const block = { ...proposal, commit: { votes: [createVote(proposal, keys[0]), createVote(proposal, keys[1])] } };
  const next = verifyCommittedBlock(block, genesis, tip, state);
  assert.equal(next.balances[recipient.address], "100");
  assert.equal(next.balances[faucet.address], "999898");
  assert.equal(next.burnedFees, "2");
  assert.equal(next.totalSupply, "999998");
});

test("a block with fewer than two validator votes is rejected", () => {
  const { keys, genesis, slot } = fixture();
  const state = createGenesisState(genesis);
  const tip = createGenesisBlock(genesis);
  const proposal = createProposal({
    genesis,
    tip,
    state,
    transactions: [],
    key: keys[slot % keys.length],
    slot,
    timestamp: slot * genesis.blockTimeMs,
  });
  const block = { ...proposal, commit: { votes: [createVote(proposal, keys[0])] } };
  assert.throws(() => verifyCommittedBlock(block, genesis, tip, state), /insufficient commit votes/);
});
