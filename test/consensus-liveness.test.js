import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProposal } from "../src/core/block.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createPeerAuthHeaders } from "../src/core/peer-auth.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { readJson } from "../src/runtime/files.js";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function nextSlot(genesis) {
  return Math.max(
    Math.floor(Date.now() / genesis.blockTimeMs) + 1,
    Math.floor(genesis.genesisTime / genesis.blockTimeMs) + 1,
  );
}

function proposalFor({ network, nodes, transaction, slot = nextSlot(network.genesis) }) {
  const proposer = nodes[slot % nodes.length];
  return createProposal({
    genesis: network.genesis,
    tip: nodes[0].storage.tip,
    state: nodes[0].storage.state,
    transactions: [transaction],
    key: proposer.key,
    slot,
    timestamp: slot * network.genesis.blockTimeMs,
  });
}

test("an isolated proposer does not self-lock and finalizes after one peer joins", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-peer-first-liveness-test-"));
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort: 19000 + Math.floor(Math.random() * 300),
    blockTimeMs: 800,
    chainId: "nova-peer-first-liveness-test-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  let forgedPeer;
  t.after(async () => {
    if (forgedPeer?.listening) {
      await new Promise((resolveClose) => forgedPeer.close(resolveClose));
    }
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  await nodes[0].start();
  forgedPeer = createServer((request, response) => {
    const url = new URL(request.url, network.nodes[1].url);
    const payload = url.pathname === "/proposals"
      ? { vote: { validator: network.genesis.validators[1].address, signature: "forged" } }
      : url.pathname === "/blocks"
        ? { blocks: [] }
        : { accepted: true };
    const body = JSON.stringify(payload);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolveListen, rejectListen) => {
    forgedPeer.once("error", rejectListen);
    forgedPeer.listen(Number(new URL(network.nodes[1].url).port), "127.0.0.1", resolveListen);
  });
  const faucet = readJson(network.faucet.keyFile);
  const recipient = generateKeyRecord("peer-first-recipient");
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "1100000",
    fee: "2",
    nonce: 1,
    memo: "wait for a peer before self vote",
  });
  nodes[0].addTransaction(transaction);
  await delay(network.genesis.blockTimeMs * 4);
  assert.equal(nodes[0].status().height, 0);
  assert.deepEqual(nodes[0].storage.votes, {});

  await new Promise((resolveClose) => forgedPeer.close(resolveClose));
  await nodes[1].start();
  await waitFor(
    () => [nodes[0], nodes[1]].every((node) => node.transactionReceipt(transaction.id).final),
    "two-validator finality after staggered startup",
  );
  assert.ok([nodes[0], nodes[1]].every((node) => node.storage.state.balances[recipient.address] === "1100000"));

  await nodes[2].start();
  await waitFor(
    () => nodes.every((node) => node.transactionReceipt(transaction.id).final),
    "late validator catch-up",
  );
  assert.ok(nodes.every((node) => node.status().blockHash === nodes[0].status().blockHash));
});

test("a validator recovers a persisted proposal after the original response is lost", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-lock-recovery-test-"));
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort: 19350 + Math.floor(Math.random() * 250),
    blockTimeMs: 800,
    chainId: "nova-lock-recovery-test-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const faucet = readJson(network.faucet.keyFile);
  const recipient = generateKeyRecord("lock-recovery-recipient");
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "2200000",
    fee: "3",
    nonce: 1,
    memo: "recover a peer vote whose response was lost",
  });
  const proposal = proposalFor({ network, nodes, transaction });
  const proofVote = nodes[1].signProposal(proposal);

  await Promise.all([nodes[0].start(), nodes[1].start()]);
  await waitFor(
    () => [nodes[0], nodes[1]].every((node) => node.transactionReceipt(transaction.id).final),
    "persisted proposal recovery",
  );
  assert.equal(nodes[1].storage.state.balances[recipient.address], "2200000");

  const recoveryUrl = `${network.nodes[1].url}/proposals/recover`;
  const mismatchedBody = JSON.stringify({ version: 1, proposal, proofVote });
  const mismatchedProof = await fetch(recoveryUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createPeerAuthHeaders({
        chainId: network.genesis.chainId,
        key: nodes[0].key,
        recipient: nodes[1].key.address,
        method: "POST",
        url: recoveryUrl,
        body: mismatchedBody,
      }),
    },
    body: mismatchedBody,
  });
  assert.equal(mismatchedProof.status, 400);
  assert.match((await mismatchedProof.json()).error, /proof does not belong to its authenticated sender/);

  await nodes[2].start();
  await waitFor(() => nodes[2].transactionReceipt(transaction.id).final, "recovered block synchronization");
});

test("a persisted empty proposal is recovered and remains synchronizable", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-empty-lock-recovery-test-"));
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort: 19600 + Math.floor(Math.random() * 80),
    blockTimeMs: 800,
    chainId: "nova-empty-lock-recovery-test-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const slot = nextSlot(network.genesis);
  const proposer = nodes[slot % nodes.length];
  const proposal = createProposal({
    genesis: network.genesis,
    tip: nodes[0].storage.tip,
    state: nodes[0].storage.state,
    transactions: [],
    key: proposer.key,
    slot,
    timestamp: slot * network.genesis.blockTimeMs,
  });
  nodes[1].signProposal(proposal);

  await Promise.all([nodes[0].start(), nodes[1].start()]);
  await waitFor(
    () => [nodes[0], nodes[1]].every((node) => node.status().height === 1),
    "persisted empty proposal recovery",
  );
  assert.ok([nodes[0], nodes[1]].every((node) => node.storage.tip.transactions.length === 0));

  await nodes[2].start();
  await waitFor(() => nodes[2].status().height === 1, "historical empty block synchronization");
  assert.equal(nodes[2].status().blockHash, nodes[0].status().blockHash);
  assert.equal(nodes[2].storage.tip.transactions.length, 0);
});

test("two conflicting persisted locks converge through the remaining unlocked validator", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-conflicting-lock-liveness-test-"));
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort: 19700 + Math.floor(Math.random() * 250),
    blockTimeMs: 800,
    chainId: "nova-conflicting-lock-liveness-test-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  const faucet = readJson(network.faucet.keyFile);
  const recipientA = generateKeyRecord("conflicting-lock-a");
  const recipientB = generateKeyRecord("conflicting-lock-b");
  const transactionA = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipientA.address,
    amount: "3300000",
    fee: "4",
    nonce: 1,
    memo: "proposal A",
  });
  const transactionB = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipientB.address,
    amount: "4400000",
    fee: "5",
    nonce: 1,
    memo: "proposal B",
  });
  const slot = nextSlot(network.genesis);
  const proposalA = proposalFor({ network, nodes, transaction: transactionA, slot });
  const proposalB = proposalFor({ network, nodes, transaction: transactionB, slot });
  assert.notEqual(proposalA.hash, proposalB.hash);
  nodes[0].signProposal(proposalA);
  nodes[1].signProposal(proposalB);

  await Promise.all(nodes.map((node) => node.start()));
  await waitFor(
    () => nodes.every((node) => node.status().height === 1),
    "conflicting lock convergence",
  );
  const committedHashes = new Set(nodes.map((node) => node.status().blockHash));
  assert.equal(committedHashes.size, 1);
  const committedHash = nodes[0].status().blockHash;
  assert.ok(committedHash === proposalA.hash || committedHash === proposalB.hash);
  const balances = nodes[0].storage.state.balances;
  assert.notEqual(Boolean(balances[recipientA.address]), Boolean(balances[recipientB.address]));
});
