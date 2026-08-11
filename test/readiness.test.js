import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashObject } from "../src/core/canonical.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import { createTransfer } from "../src/core/transaction.js";
import { NovaNode } from "../src/node.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { createNetworkBackup } from "../src/runtime/network-inspection.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";
import {
  appendReadinessEvidence,
  captureReadinessDay,
  londonDate,
  ReadinessJournalLock,
  summarizeReadiness,
  verifyReadinessJournal,
} from "../src/runtime/readiness.js";

const cli = resolve("src/cli.js");
const CHAIN_ID = "nova-readiness-evidence-1";
const SENDER = `nova1${"1".repeat(40)}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function syntheticEvidence(date, index, overrides = {}) {
  const blockHash = hashObject({ date, index, type: "block" });
  const evidence = {
    recordedAt: Date.parse(`${date}T12:00:00Z`),
    mode: "local",
    chainId: CHAIN_ID,
    transaction: {
      id: hashObject({ date, index, type: "transaction" }),
      type: index % 2 === 0 ? "record" : "transfer",
      from: SENDER,
      height: 10 + index,
      blockHash: hashObject({ date, index, type: "transaction-block" }),
      blockTimestamp: Date.parse(`${date}T09:00:00Z`),
    },
    doctor: {
      checkedAt: Date.parse(`${date}T11:00:00Z`),
      expectedValidators: 3,
      onlineValidators: 3,
      quorum: 2,
      height: 100 + index,
      blockHash,
    },
    backup: {
      createdAt: Date.parse(`${date}T10:00:00Z`),
      height: 100 + index,
      blockHash,
      stateRoot: hashObject({ date, index, type: "state" }),
      snapshotHash: hashObject({ date, index, type: "backup" }),
    },
  };
  return {
    ...evidence,
    ...overrides,
    transaction: { ...evidence.transaction, ...(overrides.transaction ?? {}) },
    doctor: { ...evidence.doctor, ...(overrides.doctor ?? {}) },
    backup: { ...evidence.backup, ...(overrides.backup ?? {}) },
  };
}

test("Europe/London dates remain explicit across UTC and BST boundaries", () => {
  assert.equal(londonDate(Date.parse("2026-01-01T00:30:00Z")), "2026-01-01");
  assert.equal(londonDate(Date.parse("2026-06-01T22:59:59Z")), "2026-06-01");
  assert.equal(londonDate(Date.parse("2026-06-01T23:00:00Z")), "2026-06-02");
  assert.equal(londonDate(Date.parse("2025-03-30T00:59:59Z")), "2025-03-30");
  assert.equal(londonDate(Date.parse("2025-03-30T01:00:00Z")), "2025-03-30");
});

test("readiness requires seven consecutive unique days and resets after a gap", () => {
  let journal = null;
  for (let day = 1; day <= 7; day += 1) {
    journal = appendReadinessEvidence(journal, syntheticEvidence(`2026-07-0${day}`, day));
  }
  const ready = summarizeReadiness(journal);
  assert.equal(ready.ready, true);
  assert.equal(ready.currentStreak, 7);
  assert.equal(ready.longestStreak, 7);
  assert.deepEqual(ready.qualifyingPeriod, { from: "2026-07-01", to: "2026-07-07" });

  let gapped = null;
  gapped = appendReadinessEvidence(gapped, syntheticEvidence("2026-07-01", 11));
  gapped = appendReadinessEvidence(gapped, syntheticEvidence("2026-07-02", 12));
  gapped = appendReadinessEvidence(gapped, syntheticEvidence("2026-07-04", 13));
  const incomplete = summarizeReadiness(gapped);
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.longestStreak, 2);
  assert.equal(incomplete.currentStreak, 1);
  assert.equal(incomplete.remainingDays, 6);
});

test("readiness rejects duplicate evidence, incompatible formats, and hash-chain tampering", () => {
  const firstEvidence = syntheticEvidence("2026-07-01", 21);
  const first = appendReadinessEvidence(null, firstEvidence);
  assert.throws(
    () => appendReadinessEvidence(first, syntheticEvidence("2026-07-01", 22)),
    /already exists/,
  );
  assert.throws(
    () => appendReadinessEvidence(
      first,
      syntheticEvidence("2026-07-02", 23, { transaction: { id: firstEvidence.transaction.id } }),
    ),
    /transaction ids must be unique/,
  );
  assert.throws(() => verifyReadinessJournal({ ...first, version: 2 }), /unsupported/);
  assert.throws(
    () => verifyReadinessJournal({ ...first, unexpected: true }),
    /unsupported or missing fields/,
  );

  const changedEvidence = structuredClone(first);
  changedEvidence.entries[0].doctor.checkedAt += 1;
  assert.throws(() => verifyReadinessJournal(changedEvidence), /entry hash/);

  const twoDays = appendReadinessEvidence(first, syntheticEvidence("2026-07-02", 24));
  const changedHistory = structuredClone(twoDays);
  changedHistory.entries[0].doctor.checkedAt -= 1;
  const { entryHash: oldEntryHash, ...changedEntryPayload } = changedHistory.entries[0];
  changedHistory.entries[0].entryHash = hashObject(changedEntryPayload);
  const { journalHash: oldJournalHash, ...changedJournalPayload } = changedHistory;
  changedHistory.journalHash = hashObject(changedJournalPayload);
  assert.throws(() => verifyReadinessJournal(changedHistory), /hash chain is broken/);
  assert.ok(oldEntryHash);
  assert.ok(oldJournalHash);
});

test("readiness rejects inconsistent transaction, backup, doctor, and distributed evidence", () => {
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 31, {
      transaction: { blockTimestamp: Date.parse("2026-06-30T20:00:00Z") },
    })),
    /transaction was not committed on the entry date/,
  );
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 32, {
      backup: { createdAt: Date.parse("2026-06-30T20:00:00Z") },
    })),
    /backup was not created on the entry date/,
  );
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 33, {
      backup: { height: 101 },
      doctor: { height: 100 },
    })),
    /must match the observed healthy chain head/,
  );
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 36, {
      backup: { height: 99 },
      doctor: { height: 100 },
    })),
    /must match the observed healthy chain head/,
  );
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 34, {
      backup: { blockHash: "a".repeat(64) },
      doctor: { blockHash: "b".repeat(64) },
    })),
    /must match the observed healthy chain head/,
  );
  assert.throws(
    () => appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 35, {
      mode: "distributed",
      doctor: { onlineValidators: 1 },
    })),
    /authenticated validator quorum/,
  );
});

test("readiness journal lock enforces one writer and releases cleanly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-readiness-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = resolve(root, "journal.json");
  const first = new ReadinessJournalLock(journal);
  assert.throws(() => new ReadinessJournalLock(journal), /already in use/);
  first.release();
  assert.equal(existsSync(`${journal}.lock`), false);
  const second = new ReadinessJournalLock(journal);
  second.release();
});

test("readiness CLI returns 2 until seven days qualify", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-readiness-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journalFile = resolve(root, "journal.json");
  let journal = appendReadinessEvidence(null, syntheticEvidence("2026-07-01", 41));
  atomicWriteJson(journalFile, journal);

  const incomplete = spawnSync(
    process.execPath,
    [cli, "readiness", "report", "--journal", journalFile, "--json", "--require-ready"],
    { encoding: "utf8" },
  );
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).ready, false);

  for (let day = 2; day <= 7; day += 1) {
    journal = appendReadinessEvidence(journal, syntheticEvidence(`2026-07-0${day}`, 40 + day));
  }
  atomicWriteJson(journalFile, journal);
  const ready = spawnSync(
    process.execPath,
    [cli, "readiness", "report", "--journal", journalFile, "--json", "--require-ready"],
    { encoding: "utf8" },
  );
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).ready, true);
});

test("readiness captures real three-node finality and refuses a degraded local network", { timeout: 40_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-readiness-network-test-"));
  const basePort = 26_000 + Math.floor(Math.random() * 1_000);
  const network = initializeDevnet({
    directory: resolve(root, "network"),
    basePort,
    blockTimeMs: 800,
    chainId: "nova-readiness-network-1",
  });
  const nodes = network.nodes.map(({ home }) => new NovaNode(home, { quiet: true }));
  t.after(async () => {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    rmSync(root, { recursive: true, force: true });
  });
  await Promise.all(nodes.map((node) => node.start()));

  const faucet = readJson(network.faucet.keyFile);
  const recipient = generateKeyRecord("readiness-recipient");
  const transaction = createTransfer({
    chainId: network.genesis.chainId,
    key: faucet,
    to: recipient.address,
    amount: "1000",
    fee: "1",
    nonce: 1,
    memo: "daily readiness evidence",
  });
  nodes[0].addTransaction(transaction);
  await waitFor(
    () => nodes.every((node) => node.transactionReceipt(transaction.id).final),
    "three-node transaction finality",
  );

  const backupFile = resolve(root, "backup.json");
  createNetworkBackup(network.directory, backupFile);
  const journalFile = resolve(root, "readiness", "journal.json");
  const captured = await captureReadinessDay({
    journalFile,
    backupFile,
    transactionId: transaction.id,
    networkDirectory: network.directory,
    timeoutMs: 2_000,
  });
  assert.equal(captured.entry.transaction.id, transaction.id);
  assert.equal(captured.entry.mode, "local");
  assert.equal(captured.entry.doctor.onlineValidators, 3);
  assert.equal(captured.report.ready, false);
  assert.equal(verifyReadinessJournal(readJson(journalFile)).entries.length, 1);
  assert.equal(existsSync(`${journalFile}.lock`), false);

  await nodes[2].stop();
  const refusedJournal = resolve(root, "readiness", "degraded.json");
  await assert.rejects(
    captureReadinessDay({
      journalFile: refusedJournal,
      backupFile,
      transactionId: transaction.id,
      networkDirectory: network.directory,
      timeoutMs: 1_000,
    }),
    /doctor did not report a healthy network/,
  );
  assert.equal(existsSync(refusedJournal), false);
  assert.equal(existsSync(`${refusedJournal}.lock`), false);
});
