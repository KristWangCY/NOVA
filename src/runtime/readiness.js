import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { hashObject } from "../core/canonical.js";
import { verifyBackup } from "./backup.js";
import { atomicWriteJson, readJson } from "./files.js";
import { createNetworkBackup, diagnoseNetwork } from "./network-inspection.js";
import { createRemoteNetworkBackup, diagnoseRemoteDeployment } from "./remote-network.js";

export const READINESS_DAYS = 7;
export const READINESS_TIME_ZONE = "Europe/London";
export const READINESS_AUTOMATIC_BACKUP_ATTEMPTS = 3;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^nova1[0-9a-f]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_FIELDS = [
  "version", "type", "timeZone", "chainId", "createdAt", "updatedAt", "entries", "journalHash",
];
const ENTRY_FIELDS = [
  "version", "type", "date", "recordedAt", "mode", "chainId", "transaction", "doctor", "backup",
  "previousEntryHash", "entryHash",
];
const TRANSACTION_FIELDS = ["id", "type", "from", "height", "blockHash", "blockTimestamp"];
const DOCTOR_FIELDS = [
  "checkedAt", "expectedValidators", "onlineValidators", "quorum", "height", "blockHash",
];
const BACKUP_FIELDS = ["createdAt", "height", "blockHash", "stateRoot", "snapshotHash"];

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactFields(value, fields, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
}

function assertHeight(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function entryPayload(entry) {
  const { entryHash, ...payload } = entry;
  return payload;
}

function journalPayload(journal) {
  const { journalHash, ...payload } = journal;
  return payload;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLockOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`readiness journal contains an invalid lock file: ${path}`);
  }
}

export class ReadinessJournalLock {
  constructor(journalFile) {
    this.path = `${resolve(journalFile)}.lock`;
    this.instanceId = randomUUID();
    this.released = false;
    this.owner = {
      version: 1,
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: Date.now(),
    };
    this.acquire();
    this.exitHandler = () => this.release();
    process.once("exit", this.exitHandler);
  }

  acquire(retried = false) {
    let descriptor;
    try {
      descriptor = openSync(this.path, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(this.owner, null, 2)}\n`, "utf8");
      closeSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* already closed */ }
      }
      if (error?.code !== "EEXIST" || retried) throw error;
      const existing = readLockOwner(this.path);
      if (processIsAlive(existing.pid)) {
        throw new Error(`readiness journal is already in use by process ${existing.pid}`);
      }
      unlinkSync(this.path);
      this.acquire(true);
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    process.removeListener("exit", this.exitHandler);
    try {
      const existing = readLockOwner(this.path);
      if (existing.instanceId === this.instanceId) unlinkSync(this.path);
    } catch {
      // Never remove a lock we cannot prove belongs to this instance.
    }
  }
}

export function londonDate(timestamp) {
  assertTimestamp(timestamp, "timestamp");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: READINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateNumber(date) {
  if (!DATE_PATTERN.test(date)) throw new Error("readiness date is invalid");
  const [year, month, day] = date.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error("readiness date is invalid");
  }
  return Math.floor(timestamp / 86_400_000);
}

function validateEntry(entry, { chainId, previousEntryHash, previousDate, transactionIds }) {
  assertExactFields(entry, ENTRY_FIELDS, "readiness entry");
  if (entry.version !== 1 || entry.type !== "nova-readiness-day") {
    throw new Error("unsupported NOVA readiness entry");
  }
  const dayNumber = dateNumber(entry.date);
  if (previousDate !== null && dayNumber <= previousDate) {
    throw new Error("readiness entries must be in strictly increasing date order");
  }
  assertTimestamp(entry.recordedAt, "readiness entry recordedAt");
  if (londonDate(entry.recordedAt) !== entry.date) {
    throw new Error("readiness entry was not recorded on its Europe/London date");
  }
  if (!["local", "distributed"].includes(entry.mode)) throw new Error("readiness entry mode is invalid");
  if (entry.chainId !== chainId) throw new Error("readiness entry chainId differs from the journal");
  if (entry.previousEntryHash !== previousEntryHash) throw new Error("readiness entry hash chain is broken");

  assertExactFields(entry.transaction, TRANSACTION_FIELDS, "readiness transaction evidence");
  assertHash(entry.transaction.id, "readiness transaction id");
  if (!["transfer", "record"].includes(entry.transaction.type)) {
    throw new Error("readiness evidence must use a transfer or record transaction");
  }
  if (!ADDRESS_PATTERN.test(entry.transaction.from)) throw new Error("readiness transaction sender is invalid");
  assertHeight(entry.transaction.height, "readiness transaction height");
  if (entry.transaction.height === 0) throw new Error("readiness transaction cannot be in the genesis block");
  assertHash(entry.transaction.blockHash, "readiness transaction block hash");
  assertTimestamp(entry.transaction.blockTimestamp, "readiness transaction block timestamp");
  if (londonDate(entry.transaction.blockTimestamp) !== entry.date) {
    throw new Error("readiness transaction was not committed on the entry date");
  }
  if (transactionIds.has(entry.transaction.id)) {
    throw new Error("readiness transaction ids must be unique across days");
  }
  transactionIds.add(entry.transaction.id);

  assertExactFields(entry.doctor, DOCTOR_FIELDS, "readiness doctor evidence");
  assertTimestamp(entry.doctor.checkedAt, "readiness doctor checkedAt");
  if (londonDate(entry.doctor.checkedAt) !== entry.date) {
    throw new Error("readiness doctor was not run on the entry date");
  }
  for (const field of ["expectedValidators", "onlineValidators", "quorum"]) {
    if (!Number.isSafeInteger(entry.doctor[field]) || entry.doctor[field] < 1) {
      throw new Error(`readiness doctor ${field} is invalid`);
    }
  }
  if (entry.doctor.onlineValidators > entry.doctor.expectedValidators) {
    throw new Error("readiness doctor online validator count is invalid");
  }
  if (entry.mode === "local" && entry.doctor.onlineValidators !== entry.doctor.expectedValidators) {
    throw new Error("local readiness requires every validator online");
  }
  if (entry.mode === "distributed" && entry.doctor.onlineValidators < entry.doctor.quorum) {
    throw new Error("distributed readiness requires an authenticated validator quorum");
  }
  assertHeight(entry.doctor.height, "readiness doctor height");
  assertHash(entry.doctor.blockHash, "readiness doctor block hash");

  assertExactFields(entry.backup, BACKUP_FIELDS, "readiness backup evidence");
  assertTimestamp(entry.backup.createdAt, "readiness backup createdAt");
  if (londonDate(entry.backup.createdAt) !== entry.date) {
    throw new Error("readiness backup was not created on the entry date");
  }
  assertHeight(entry.backup.height, "readiness backup height");
  for (const field of ["blockHash", "stateRoot", "snapshotHash"]) {
    assertHash(entry.backup[field], `readiness backup ${field}`);
  }
  if (entry.transaction.height > entry.backup.height) {
    throw new Error("readiness backup does not cover the daily transaction");
  }
  if (
    entry.transaction.height === entry.backup.height
    && entry.transaction.blockHash !== entry.backup.blockHash
  ) {
    throw new Error("readiness transaction and backup head conflict");
  }
  if (
    entry.backup.height !== entry.doctor.height
    || entry.backup.blockHash !== entry.doctor.blockHash
  ) {
    throw new Error("readiness backup must match the observed healthy chain head");
  }
  if (
    entry.transaction.blockTimestamp > entry.backup.createdAt
    || entry.backup.createdAt > entry.doctor.checkedAt
    || entry.doctor.checkedAt > entry.recordedAt
  ) {
    throw new Error("readiness evidence timestamps are out of order");
  }
  assertHash(entry.entryHash, "readiness entry hash");
  if (hashObject(entryPayload(entry)) !== entry.entryHash) {
    throw new Error("readiness entry hash does not match its evidence");
  }
  return dayNumber;
}

export function verifyReadinessJournal(journal) {
  assertExactFields(journal, JOURNAL_FIELDS, "readiness journal");
  if (journal.version !== 1 || journal.type !== "nova-readiness-journal") {
    throw new Error("unsupported NOVA readiness journal");
  }
  if (journal.timeZone !== READINESS_TIME_ZONE) throw new Error("unsupported readiness time zone");
  if (typeof journal.chainId !== "string" || journal.chainId.length === 0) {
    throw new Error("readiness journal chainId is invalid");
  }
  assertTimestamp(journal.createdAt, "readiness journal createdAt");
  assertTimestamp(journal.updatedAt, "readiness journal updatedAt");
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("readiness journal must contain at least one day");
  }
  if (journal.createdAt !== journal.entries[0].recordedAt) {
    throw new Error("readiness journal creation time is invalid");
  }
  if (journal.updatedAt !== journal.entries.at(-1).recordedAt) {
    throw new Error("readiness journal update time is invalid");
  }
  const transactionIds = new Set();
  let previousEntryHash = null;
  let previousDate = null;
  for (const entry of journal.entries) {
    previousDate = validateEntry(entry, {
      chainId: journal.chainId,
      previousEntryHash,
      previousDate,
      transactionIds,
    });
    previousEntryHash = entry.entryHash;
  }
  assertHash(journal.journalHash, "readiness journal hash");
  if (hashObject(journalPayload(journal)) !== journal.journalHash) {
    throw new Error("readiness journal hash does not match its contents");
  }
  return journal;
}

export function appendReadinessEvidence(journal, evidence) {
  assertPlainObject(evidence, "readiness evidence");
  const { recordedAt, mode, chainId, transaction, doctor, backup } = evidence;
  assertTimestamp(recordedAt, "readiness evidence recordedAt");
  if (journal !== null) verifyReadinessJournal(journal);
  if (journal && journal.chainId !== chainId) {
    throw new Error("readiness evidence belongs to a different chain");
  }
  const date = londonDate(recordedAt);
  if (journal?.entries.some((entry) => entry.date === date)) {
    throw new Error(`readiness evidence already exists for ${date}`);
  }
  const previousEntryHash = journal?.entries.at(-1).entryHash ?? null;
  const unsignedEntry = {
    version: 1,
    type: "nova-readiness-day",
    date,
    recordedAt,
    mode,
    chainId,
    transaction,
    doctor,
    backup,
    previousEntryHash,
  };
  const entry = { ...unsignedEntry, entryHash: hashObject(unsignedEntry) };
  const entries = [...(journal?.entries ?? []), entry];
  const unsignedJournal = {
    version: 1,
    type: "nova-readiness-journal",
    timeZone: READINESS_TIME_ZONE,
    chainId,
    createdAt: journal?.createdAt ?? recordedAt,
    updatedAt: recordedAt,
    entries,
  };
  const next = { ...unsignedJournal, journalHash: hashObject(unsignedJournal) };
  return verifyReadinessJournal(next);
}

function summarizeDoctor(report, mode) {
  if (report.healthy !== true) throw new Error("readiness doctor did not report a healthy network");
  if (mode === "local" && report.onlineValidators !== report.expectedValidators) {
    throw new Error("local readiness requires every validator API online");
  }
  if (mode === "distributed" && (
    report.operational !== true
    || report.onlineValidators < report.quorum
  )) {
    throw new Error("distributed readiness requires an authenticated validator quorum");
  }
  const headCheckId = mode === "local" ? "online-heads" : "remote-heads";
  if (!report.checks.some(({ id, status }) => id === headCheckId && status === "pass")) {
    throw new Error("readiness requires online validators to agree on one chain head");
  }
  const online = mode === "local"
    ? report.nodes.filter(({ online }) => online?.valid).map(({ online: status }) => status)
    : report.nodes.filter(({ valid }) => valid).map(({ status }) => status);
  if (online.length === 0) throw new Error("readiness doctor returned no valid online status");
  const head = online[0];
  return {
    checkedAt: report.checkedAt,
    expectedValidators: report.expectedValidators,
    onlineValidators: report.onlineValidators,
    quorum: report.quorum,
    height: head.height,
    blockHash: head.blockHash,
  };
}

function findTransactionEvidence(backup, transactionId) {
  if (!HASH_PATTERN.test(transactionId)) {
    throw new Error("readiness transaction id must be a lowercase SHA-256 hash");
  }
  let evidence = null;
  for (const block of backup.chain.slice(1)) {
    for (const transaction of block.transactions) {
      if (transaction.id !== transactionId) continue;
      if (evidence) throw new Error("readiness transaction appears more than once in the backup");
      evidence = {
        id: transaction.id,
        type: transaction.type,
        from: transaction.from,
        height: block.header.height,
        blockHash: block.hash,
        blockTimestamp: block.header.timestamp,
      };
    }
  }
  if (!evidence) throw new Error("readiness transaction is not finally committed in the verified backup");
  return evidence;
}

export async function captureReadinessDay({
  journalFile,
  backupFile,
  automaticBackupDirectory,
  transactionId,
  networkDirectory,
  deploymentDirectory,
  timeoutMs = 1500,
}) {
  if (Boolean(networkDirectory) === Boolean(deploymentDirectory)) {
    throw new Error("choose exactly one of networkDirectory or deploymentDirectory");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("readiness timeout must be between 100 and 10000 milliseconds");
  }
  const journalPath = resolve(journalFile);
  const explicitBackupPath = backupFile ? resolve(backupFile) : null;
  const automaticBackupPath = automaticBackupDirectory ? resolve(automaticBackupDirectory) : null;
  if (Boolean(explicitBackupPath) === Boolean(automaticBackupPath)) {
    throw new Error("choose exactly one of backupFile or automaticBackupDirectory");
  }
  mkdirSync(dirname(journalPath), { recursive: true });
  const lock = new ReadinessJournalLock(journalPath);
  try {
    const existing = existsSync(journalPath) ? verifyReadinessJournal(readJson(journalPath)) : null;
    const mode = networkDirectory ? "local" : "distributed";
    const automatic = Boolean(automaticBackupPath);
    const maximumAttempts = automatic ? READINESS_AUTOMATIC_BACKUP_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const resolvedBackupPath = automatic
        ? resolve(automaticBackupPath, `nova-${londonDate(Date.now())}.json`)
        : explicitBackupPath;
      if (resolvedBackupPath === journalPath) {
        throw new Error("readiness backup and journal paths must differ");
      }
      if (automatic) {
        if (mode === "local") {
          createNetworkBackup(resolve(networkDirectory), resolvedBackupPath);
        } else {
          await createRemoteNetworkBackup({
            directory: resolve(deploymentDirectory),
            output: resolvedBackupPath,
            timeoutMs,
          });
        }
      }
      const backup = readJson(resolvedBackupPath);
      const backupVerification = verifyBackup(backup);
      const report = mode === "local"
        ? await diagnoseNetwork({
          directory: resolve(networkDirectory),
          requireOnline: true,
          timeoutMs,
        })
        : await diagnoseRemoteDeployment({
          directory: resolve(deploymentDirectory),
          timeoutMs,
        });
      if (report.chainId !== backupVerification.chainId) {
        throw new Error("readiness doctor and backup belong to different chains");
      }
      const doctor = summarizeDoctor(report, mode);
      const headMatches = backupVerification.height === doctor.height
        && backupVerification.blockHash === doctor.blockHash;
      const healthyHeadAdvanced = doctor.height > backupVerification.height;
      if (!headMatches && automatic && healthyHeadAdvanced && attempt < maximumAttempts) continue;
      if (!headMatches && automatic && healthyHeadAdvanced) {
        throw new Error(
          `automatic readiness backup did not match the observed healthy chain head after ${maximumAttempts} attempts`,
        );
      }
      if (!headMatches) {
        throw new Error("readiness backup must match the observed healthy chain head");
      }
      const recordedAt = Date.now();
      const evidence = {
        recordedAt,
        mode,
        chainId: backupVerification.chainId,
        transaction: findTransactionEvidence(backup, transactionId),
        doctor,
        backup: {
          createdAt: backup.createdAt,
          height: backupVerification.height,
          blockHash: backupVerification.blockHash,
          stateRoot: backupVerification.stateRoot,
          snapshotHash: backup.snapshotHash,
        },
      };
      const journal = appendReadinessEvidence(existing, evidence);
      atomicWriteJson(journalPath, journal);
      return {
        journal: journalPath,
        backupFile: resolvedBackupPath,
        backupMode: automatic ? "automatic" : "explicit",
        backupAttempts: attempt,
        entry: journal.entries.at(-1),
        report: summarizeReadiness(journal),
      };
    }
    throw new Error("automatic readiness backup attempts were exhausted");
  } finally {
    lock.release();
  }
}

export function summarizeReadiness(journal) {
  verifyReadinessJournal(journal);
  let currentStreak = 0;
  let longestStreak = 0;
  let previous = null;
  let streakStart = null;
  let qualifyingPeriod = null;
  for (const entry of journal.entries) {
    const current = dateNumber(entry.date);
    if (previous !== null && current === previous + 1) {
      currentStreak += 1;
    } else {
      currentStreak = 1;
      streakStart = entry.date;
    }
    if (currentStreak > longestStreak) longestStreak = currentStreak;
    if (!qualifyingPeriod && currentStreak >= READINESS_DAYS) {
      qualifyingPeriod = { from: streakStart, to: entry.date };
    }
    previous = current;
  }
  const ready = longestStreak >= READINESS_DAYS;
  return {
    version: 1,
    chainId: journal.chainId,
    timeZone: journal.timeZone,
    ready,
    requiredConsecutiveDays: READINESS_DAYS,
    recordedDays: journal.entries.length,
    currentStreak,
    longestStreak,
    remainingDays: ready ? 0 : READINESS_DAYS - currentStreak,
    firstDate: journal.entries[0].date,
    lastDate: journal.entries.at(-1).date,
    qualifyingPeriod,
    journalHash: journal.journalHash,
  };
}

function emptyTrial() {
  return {
    version: 1,
    chainId: null,
    timeZone: READINESS_TIME_ZONE,
    ready: false,
    requiredConsecutiveDays: READINESS_DAYS,
    recordedDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    remainingDays: READINESS_DAYS,
    firstDate: null,
    lastDate: null,
    qualifyingPeriod: null,
    journalHash: null,
    todayRecorded: false,
  };
}

function inspectReadinessSource(sourcePath) {
  if (!existsSync(sourcePath)) return { status: "missing", error: null };
  try {
    return {
      status: readdirSync(sourcePath).length === 0 ? "empty" : "present",
      error: null,
    };
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function preflightRecommendation(state, {
  mode,
  nextAction,
  sourceFlag,
  sourcePath,
  journalPath,
}) {
  if (state === "NOT_INITIALIZED") {
    return mode === "local"
      ? {
        message: "No private network exists yet. Create and keep a strong password locally, then run the secure launcher; preflight did not create any files.",
        command: "npm.cmd run nova:secure",
      }
      : {
        message: "No distributed deployment exists yet. Create a public topology template, then follow the private three-device deployment guide.",
        command: "node src/cli.js network template --out .nova/nova-topology.json",
      };
  }
  if (state === "NOT_STARTED" || state === "IN_PROGRESS") {
    return {
      message: "Commit one meaningful transfer or record, wait for a final receipt, then record today's evidence.",
      command: `node src/cli.js readiness check ${sourceFlag} "${sourcePath}" --tx <FINAL_TRANSACTION_ID>`,
    };
  }
  if (state === "RECORDED_TODAY") {
    return {
      message: "Today's evidence is already recorded. Keep the network recoverable and return tomorrow.",
      command: null,
    };
  }
  if (state === "READY") {
    return {
      message: "The seven-day trial is complete. Preserve the journal and review the remaining deployment boundaries.",
      command: `node src/cli.js readiness report --journal "${journalPath}" --require-ready`,
    };
  }
  if (state === "BLOCKED") {
    if (nextAction === "restore-network") {
      return {
        message: "A readiness journal exists but its network source is missing. Restore the matching chain and private keys; do not initialize a replacement chain.",
        command: null,
      };
    }
    if (nextAction === "inspect-network-source") {
      return {
        message: "The network source is partial or unreadable. Preserve it for inspection and do not overwrite or initialize it in place.",
        command: null,
      };
    }
    if (nextAction === "start-network" && mode === "local") {
      return {
        message: "The private network is initialized but stopped. Start the secure network before creating a transaction or readiness evidence.",
        command: "npm.cmd run nova:secure",
      };
    }
    return {
      message: "Repair network health before creating a transaction or readiness evidence.",
      command: `node src/cli.js doctor ${sourceFlag} "${sourcePath}"`,
    };
  }
  if (state === "WRONG_NETWORK") {
    return {
      message: "Select the network that owns this readiness journal. Do not merge or rewrite journal history.",
      command: null,
    };
  }
  return {
    message: "Preserve the damaged journal and restore a known-good private copy. Do not edit or append to it.",
    command: null,
  };
}

export async function preflightReadiness({
  journalFile,
  networkDirectory,
  deploymentDirectory,
  timeoutMs = 1500,
  now = Date.now(),
}) {
  if (Boolean(networkDirectory) === Boolean(deploymentDirectory)) {
    throw new Error("choose exactly one of networkDirectory or deploymentDirectory");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("readiness timeout must be between 100 and 10000 milliseconds");
  }
  assertTimestamp(now, "readiness preflight time");
  const mode = networkDirectory ? "local" : "distributed";
  const sourcePath = resolve(networkDirectory || deploymentDirectory);
  const sourceFlag = mode === "local" ? "--network" : "--deployment";
  const journalPath = resolve(journalFile);
  const date = londonDate(now);
  const source = inspectReadinessSource(sourcePath);
  let journal = null;
  let journalStatus = "missing";
  let journalError = null;
  let trial = emptyTrial();
  if (existsSync(journalPath)) {
    try {
      journal = verifyReadinessJournal(readJson(journalPath));
      const summary = summarizeReadiness(journal);
      trial = {
        ...summary,
        todayRecorded: journal.entries.some((entry) => entry.date === date),
      };
      journalStatus = "valid";
    } catch (error) {
      journalStatus = "damaged";
      journalError = error instanceof Error ? error.message : String(error);
    }
  }

  let report = null;
  let networkIssue = source.error;
  if (source.status === "missing" || source.status === "empty") {
    networkIssue = "network source has not been initialized";
  } else if (source.status === "present") {
    try {
      report = mode === "local"
        ? await diagnoseNetwork({ directory: sourcePath, requireOnline: true, timeoutMs })
        : await diagnoseRemoteDeployment({ directory: sourcePath, timeoutMs });
    } catch (error) {
      networkIssue = error instanceof Error ? error.message : String(error);
    }
  }
  let doctor = null;
  if (report) {
    try {
      doctor = summarizeDoctor(report, mode);
    } catch (error) {
      const failures = report.checks
        ?.filter(({ status }) => status === "fail")
        .map(({ message }) => message)
        .join("; ");
      networkIssue = failures || (error instanceof Error ? error.message : String(error));
    }
  }
  const network = {
    healthy: Boolean(doctor),
    initialized: Boolean(report?.chainId && report.expectedValidators > 0),
    sourcePath,
    sourceStatus: source.status,
    chainId: report?.chainId ?? null,
    expectedValidators: report?.expectedValidators ?? 0,
    onlineValidators: report?.onlineValidators ?? 0,
    quorum: report?.quorum ?? 0,
    height: doctor?.height ?? null,
    blockHash: doctor?.blockHash ?? null,
    issue: networkIssue,
  };

  let state;
  let nextAction;
  let exitCode;
  if (journalStatus === "damaged") {
    state = "DAMAGED";
    nextAction = "restore-journal";
    exitCode = 1;
  } else if (source.status === "missing" || source.status === "empty") {
    if (journal) {
      state = "BLOCKED";
      nextAction = "restore-network";
      exitCode = 2;
    } else {
      state = "NOT_INITIALIZED";
      nextAction = "initialize-network";
      exitCode = 0;
    }
  } else if (source.status === "unreadable" || !network.initialized) {
    state = "BLOCKED";
    nextAction = "inspect-network-source";
    exitCode = 2;
  } else if (!network.healthy) {
    state = "BLOCKED";
    nextAction = mode === "local" && network.onlineValidators === 0
      ? "start-network"
      : "repair-network";
    exitCode = 2;
  } else if (journal && journal.chainId !== network.chainId) {
    state = "WRONG_NETWORK";
    nextAction = "select-matching-network";
    exitCode = 1;
  } else if (trial.ready) {
    state = "READY";
    nextAction = "review-trial";
    exitCode = 0;
  } else if (trial.todayRecorded) {
    state = "RECORDED_TODAY";
    nextAction = "return-tomorrow";
    exitCode = 0;
  } else if (!journal) {
    state = "NOT_STARTED";
    nextAction = "commit-meaningful-transaction";
    exitCode = 0;
  } else {
    state = "IN_PROGRESS";
    nextAction = "commit-meaningful-transaction";
    exitCode = 0;
  }

  return {
    version: 2,
    type: "nova-readiness-preflight",
    checkedAt: now,
    date,
    timeZone: READINESS_TIME_ZONE,
    mode,
    state,
    nextAction,
    exitCode,
    network,
    journal: {
      path: journalPath,
      status: journalStatus,
      chainId: journal?.chainId ?? null,
      error: journalError,
    },
    trial,
    recommendation: preflightRecommendation(state, {
      mode,
      nextAction,
      sourceFlag,
      sourcePath,
      journalPath,
    }),
  };
}
