import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { readJson } from "../src/runtime/files.js";

const cli = resolve("src/cli.js");
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function runCli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("CLI records and verifies a local file without uploading its contents", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-record-cli-test-"));
  const basePort = 16000 + Math.floor(Math.random() * 1000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    validators: 1,
    basePort,
    blockTimeMs: 800,
    chainId: "nova-record-cli-test-1",
  });
  const node = new NovaNode(network.nodes[0].home, { quiet: true });
  t.after(async () => {
    await node.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await node.start();

  const originalFile = resolve(root, "personal-note.txt");
  const otherFile = resolve(root, "different-note.txt");
  const contents = "This file stays on the owner's computer.\n";
  writeFileSync(originalFile, contents, "utf8");
  writeFileSync(otherFile, "Different bytes.\n", "utf8");

  const created = await runCli([
    "record", "create",
    "--key", network.faucet.keyFile,
    "--file", originalFile,
    "--title", "Private note proof",
    "--category", "personal-note",
    "--note", "Only this metadata is public",
    "--fee", "2",
    "--url", network.nodes[0].url,
  ]);
  assert.equal(created.status, 0, created.stderr);
  const transactionId = created.stdout.match(/Accepted record ([0-9a-f]{64})/)?.[1];
  assert.match(transactionId ?? "", /^[0-9a-f]{64}$/);
  assert.equal(created.stdout.includes(contents.trim()), false);

  await waitFor(() => node.transactionReceipt(transactionId).final, "record finality");
  const verified = await runCli([
    "record", "verify",
    "--file", originalFile,
    "--url", network.nodes[0].url,
    "--json",
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  const verification = JSON.parse(verified.stdout);
  assert.equal(verification.verified, true);
  assert.equal(verification.matches.length, 1);
  assert.equal(verification.matches[0].transactionId, transactionId);
  assert.equal(verification.matches[0].transaction.title, "Private note proof");
  assert.equal(Object.hasOwn(verification.matches[0].transaction, "file"), false);
  assert.equal(Object.hasOwn(verification.matches[0].transaction, "path"), false);
  assert.equal(JSON.stringify(verification.matches[0].transaction).includes(contents.trim()), false);

  const missing = await runCli([
    "record", "verify",
    "--file", otherFile,
    "--url", network.nodes[0].url,
    "--json",
  ]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).verified, false);

  const faucet = readJson(network.faucet.keyFile);
  const listed = await runCli([
    "record", "list",
    "--owner", faucet.address,
    "--category", "personal-note",
    "--url", network.nodes[0].url,
    "--json",
  ]);
  assert.equal(listed.status, 0, listed.stderr);
  const records = JSON.parse(listed.stdout).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].transactionId, transactionId);
});
