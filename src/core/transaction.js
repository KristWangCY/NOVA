import { addressFromPublicKey, signObject, verifyObject } from "./crypto.js";
import { hashObject } from "./canonical.js";

const ADDRESS_PATTERN = /^nova1[0-9a-f]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_MEMO_LENGTH = 256;
const MAX_RECORD_TITLE_LENGTH = 128;
const MAX_RECORD_NOTE_LENGTH = 256;

const TRANSFER_FIELDS = Object.freeze([
  "amount",
  "chainId",
  "fee",
  "from",
  "id",
  "memo",
  "nonce",
  "publicKey",
  "signature",
  "to",
  "type",
  "version",
]);

const RECORD_FIELDS = Object.freeze([
  "category",
  "chainId",
  "contentHash",
  "contentSize",
  "fee",
  "from",
  "hashAlgorithm",
  "id",
  "nonce",
  "note",
  "publicKey",
  "signature",
  "title",
  "type",
  "version",
]);

function assertExactFields(transaction, expected) {
  const actual = Object.keys(transaction).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${transaction.type || "transaction"} contains unsupported or missing fields`);
  }
}

function assertUtf8Text(value, field, { minBytes = 0, maxBytes }) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const length = Buffer.byteLength(value, "utf8");
  if (length < minBytes || length > maxBytes) {
    throw new Error(`${field} must contain ${minBytes}-${maxBytes} UTF-8 bytes`);
  }
}

export function parseAmount(value, field, { allowZero = false } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a base-10 integer string`);
  }
  const amount = BigInt(value);
  if (allowZero ? amount < 0n : amount <= 0n) {
    throw new Error(`${field} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return amount;
}

export function transactionSigningPayload(transaction) {
  if (transaction.type === "transfer") {
    const {
      version,
      chainId,
      type,
      from,
      to,
      amount,
      fee,
      nonce,
      memo,
      publicKey,
    } = transaction;
    return { version, chainId, type, from, to, amount, fee, nonce, memo, publicKey };
  }
  if (transaction.type === "record") {
    const {
      version,
      chainId,
      type,
      from,
      fee,
      nonce,
      hashAlgorithm,
      contentHash,
      contentSize,
      title,
      category,
      note,
      publicKey,
    } = transaction;
    return {
      version,
      chainId,
      type,
      from,
      fee,
      nonce,
      hashAlgorithm,
      contentHash,
      contentSize,
      title,
      category,
      note,
      publicKey,
    };
  }
  throw new Error("unsupported transaction type");
}

function signTransaction(body, key) {
  const signature = signObject(body, key.privateKey);
  const transaction = { ...body, signature };
  return { ...transaction, id: hashObject(transaction) };
}

export function createTransfer({ chainId, key, to, amount, fee = "1", nonce, memo = "" }) {
  return signTransaction({
    version: 1,
    chainId,
    type: "transfer",
    from: key.address,
    to,
    amount: String(amount),
    fee: String(fee),
    nonce,
    memo,
    publicKey: key.publicKey,
  }, key);
}

export function createRecord({
  chainId,
  key,
  contentHash,
  contentSize,
  title,
  category = "document",
  note = "",
  fee = "1",
  nonce,
}) {
  return signTransaction({
    version: 1,
    chainId,
    type: "record",
    from: key.address,
    fee: String(fee),
    nonce,
    hashAlgorithm: "sha256",
    contentHash,
    contentSize,
    title,
    category,
    note,
    publicKey: key.publicKey,
  }, key);
}

function validateCommon(transaction, expectedChainId) {
  if (transaction.chainId !== expectedChainId) {
    throw new Error("transaction chainId does not match this chain");
  }
  if (!ADDRESS_PATTERN.test(transaction.from)) {
    throw new Error("invalid NOVA sender address");
  }
  if (addressFromPublicKey(transaction.publicKey) !== transaction.from) {
    throw new Error("sender address does not match public key");
  }
  if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce <= 0) {
    throw new Error("nonce must be a positive safe integer");
  }
  const payload = transactionSigningPayload(transaction);
  if (!verifyObject(payload, transaction.signature, transaction.publicKey)) {
    throw new Error("invalid transaction signature");
  }
  if (hashObject({ ...payload, signature: transaction.signature }) !== transaction.id) {
    throw new Error("transaction id does not match its contents");
  }
}

function validateTransfer(transaction) {
  assertExactFields(transaction, TRANSFER_FIELDS);
  if (!ADDRESS_PATTERN.test(transaction.to)) {
    throw new Error("invalid NOVA recipient address");
  }
  parseAmount(transaction.amount, "amount");
  parseAmount(transaction.fee, "fee", { allowZero: true });
  assertUtf8Text(transaction.memo, "memo", { maxBytes: MAX_MEMO_LENGTH });
}

function validateRecord(transaction) {
  assertExactFields(transaction, RECORD_FIELDS);
  parseAmount(transaction.fee, "fee");
  if (transaction.hashAlgorithm !== "sha256" || !HASH_PATTERN.test(transaction.contentHash)) {
    throw new Error("record must contain a lowercase SHA-256 content hash");
  }
  if (!Number.isSafeInteger(transaction.contentSize) || transaction.contentSize < 0) {
    throw new Error("record contentSize must be a non-negative safe integer");
  }
  assertUtf8Text(transaction.title, "record title", { minBytes: 1, maxBytes: MAX_RECORD_TITLE_LENGTH });
  if (typeof transaction.category !== "string" || !CATEGORY_PATTERN.test(transaction.category)) {
    throw new Error("record category must be a lowercase slug of at most 32 characters");
  }
  assertUtf8Text(transaction.note, "record note", { maxBytes: MAX_RECORD_NOTE_LENGTH });
}

export function validateTransactionBasic(transaction, expectedChainId) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new Error("transaction must be an object");
  }
  if (transaction.version !== 1 || !["transfer", "record"].includes(transaction.type)) {
    throw new Error("unsupported transaction version or type");
  }
  if (transaction.type === "transfer") validateTransfer(transaction);
  if (transaction.type === "record") validateRecord(transaction);
  validateCommon(transaction, expectedChainId);
  return true;
}

export function isRecordTransaction(transaction) {
  return transaction?.version === 1 && transaction?.type === "record";
}
