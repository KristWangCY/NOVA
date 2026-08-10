import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { readJson } from "../src/runtime/files.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

const root = mkdtempSync(join(tmpdir(), "nova-demo-"));
const basePort = 32000 + Math.floor(Math.random() * 10000);
const network = initializeDevnet({ directory: root, basePort, blockTimeMs: 900 });
const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));

try {
  console.log(`NOVA demo network: ${network.genesis.chainId}`);
  console.log(`Validators: ${nodes.length}, quorum: 2, block time: ${network.genesis.blockTimeMs}ms`);
  await Promise.all(nodes.map((node) => node.start()));

  const recipient = generateKeyRecord("demo-recipient");
  const faucet = readJson(network.faucet.keyFile);
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "2500000",
    fee: "10",
    nonce: 1,
    memo: "hello from NOVA",
  });
  await postJson(`${network.nodes[0].url}/transactions`, transaction);
  await waitFor(
    () => nodes.every((node) => node.storage.state.balances[recipient.address] === "2500000"),
    "the transfer to finalize on every validator",
  );

  const height = Math.min(...nodes.map((node) => node.status().height));
  console.log(`Committed transfer: ${transaction.id}`);
  console.log(`Recipient: ${recipient.address}`);
  console.log(`Balance: 2.5 NOVA (2500000 unova)`);
  console.log(`Observed on all validators at height >= ${height}`);
  console.log("Demo succeeded.");
} finally {
  await Promise.allSettled(nodes.map((node) => node.stop()));
  rmSync(root, { recursive: true, force: true });
}
