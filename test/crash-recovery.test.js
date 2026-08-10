import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProposal, createVote } from "../src/core/block.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("restart prunes committed or corrupt mempool entries while preserving valid pending work", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-mempool-crash-test-"));
  const basePort = 16000 + Math.floor(Math.random() * 1000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-mempool-crash-test-1",
  });
  const createdNodes = [];
  const initialNodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  createdNodes.push(...initialNodes);
  t.after(async () => {
    await Promise.allSettled(createdNodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  await Promise.all(initialNodes.map((node) => node.start()));
  const faucet = readJson(network.faucet.keyFile);
  const firstRecipient = generateKeyRecord("first-crash-recipient");
  const committed = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: firstRecipient.address,
    amount: "1000000",
    fee: "2",
    nonce: 1,
    memo: "committed before crash",
  });
  initialNodes[0].addTransaction(committed);
  await waitFor(
    () => initialNodes.every((node) => node.transactionReceipt(committed.id).final),
    "first transaction finality",
  );
  await Promise.all(initialNodes.map((node) => node.stop()));

  const secondRecipient = generateKeyRecord("pending-crash-recipient");
  const pending = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: secondRecipient.address,
    amount: "2000000",
    fee: "3",
    nonce: 2,
    memo: "valid work survives restart",
  });
  const tampered = { ...pending, memo: "signature no longer matches" };
  const firstMempoolPath = resolve(network.nodes[0].home, "mempool.json");
  atomicWriteJson(firstMempoolPath, [committed, pending, tampered]);

  const recoveredNodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  createdNodes.push(...recoveredNodes);
  assert.equal(recoveredNodes[0].storage.recovery.malformedMempool, false);
  assert.equal(recoveredNodes[0].storage.recovery.discardedMempoolEntries, 2);
  assert.deepEqual(recoveredNodes[0].storage.mempool.map(({ id }) => id), [pending.id]);
  assert.deepEqual(readJson(firstMempoolPath).map(({ id }) => id), [pending.id]);

  await Promise.all(recoveredNodes.map((node) => node.start()));
  await waitFor(
    () => recoveredNodes.every((node) => node.transactionReceipt(pending.id).final),
    "preserved pending transaction finality",
  );
  assert.ok(recoveredNodes.every((node) => node.storage.state.balances[secondRecipient.address] === "2000000"));
  await Promise.all(recoveredNodes.map((node) => node.stop()));

  writeFileSync(firstMempoolPath, "{not-json", "utf8");
  const malformedRecovery = new NovaNode(network.nodes[0].home, { quiet: true });
  createdNodes.push(malformedRecovery);
  assert.equal(malformedRecovery.storage.recovery.malformedMempool, true);
  assert.deepEqual(malformedRecovery.storage.mempool, []);
  assert.deepEqual(readJson(firstMempoolPath), []);
  await malformedRecovery.stop();
});

test("restart retains a valid next-height vote lock, rejects tampering, and removes committed locks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-vote-lock-crash-test-"));
  const basePort = 18000 + Math.floor(Math.random() * 1000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-vote-lock-crash-test-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  const createdNodes = [...nodes];
  t.after(async () => {
    await Promise.allSettled(createdNodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const faucet = readJson(network.faucet.keyFile);
  const recipient = generateKeyRecord("vote-lock-recipient");
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "3000000",
    fee: "4",
    nonce: 1,
    memo: "persisted vote lock",
  });
  const slot = Math.floor(Date.now() / network.genesis.blockTimeMs) + 1;
  const proposerNode = nodes[slot % network.genesis.validators.length];
  const proposal = createProposal({
    genesis: network.genesis,
    tip: nodes[0].storage.tip,
    state: nodes[0].storage.state,
    transactions: [transaction],
    key: proposerNode.key,
    slot,
    timestamp: slot * network.genesis.blockTimeMs,
  });
  const vote = nodes[0].signProposal(proposal);
  const votesPath = resolve(network.nodes[0].home, "votes.json");
  const validLocks = readJson(votesPath);
  assert.equal(validLocks["1"].hash, proposal.hash);
  nodes[0].stop();

  const validRestart = new NovaNode(network.nodes[0].home, { quiet: true });
  createdNodes.push(validRestart);
  assert.equal(validRestart.storage.votes["1"].vote.signature, vote.signature);
  assert.equal(validRestart.storage.recovery.discardedCommittedVoteLocks, 0);
  validRestart.stop();

  atomicWriteJson(votesPath, {
    "1": {
      ...validLocks["1"],
      vote: { ...validLocks["1"].vote, signature: "forged" },
    },
  });
  assert.throws(
    () => new NovaNode(network.nodes[0].home, { quiet: true }),
    /persisted validator vote lock at height 1 is invalid/,
  );
  atomicWriteJson(votesPath, validLocks);

  const committingNode = new NovaNode(network.nodes[0].home, { quiet: true });
  createdNodes.push(committingNode);
  const block = {
    ...proposal,
    commit: { votes: [vote, createVote(proposal, nodes[1].key)] },
  };
  committingNode.commitBlock(block);
  committingNode.stop();

  // Simulate power loss after the signed chain was persisted but before a stale vote-lock file was cleared.
  atomicWriteJson(votesPath, validLocks);
  const committedRestart = new NovaNode(network.nodes[0].home, { quiet: true });
  createdNodes.push(committedRestart);
  assert.equal(committedRestart.storage.tip.header.height, 1);
  assert.deepEqual(committedRestart.storage.votes, {});
  assert.equal(committedRestart.storage.recovery.discardedCommittedVoteLocks, 1);
  assert.deepEqual(readJson(votesPath), {});
  committedRestart.stop();

  writeFileSync(votesPath, "{not-json", "utf8");
  assert.throws(
    () => new NovaNode(network.nodes[0].home, { quiet: true }),
    /JSON/,
  );
});
