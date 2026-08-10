import { quorumSize } from "./block.js";
import { signObject, verifyObject } from "./crypto.js";

export const SIGNED_STATUS_VERSION = 1;
export const SIGNED_STATUS_WINDOW_MS = 30_000;

const CHALLENGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESPONSE_FIELDS = ["version", "challenge", "timestamp", "status", "signature"];
const STATUS_FIELDS = [
  "name",
  "chainId",
  "validator",
  "validatorKeyEncrypted",
  "advertisedUrl",
  "height",
  "blockHash",
  "blockTimeMs",
  "validators",
  "quorum",
  "peerAuthentication",
  "peers",
  "mempoolSize",
];

function sameFields(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function signingPayload({ challenge, timestamp, status }) {
  return {
    domain: "nova-signed-status",
    version: SIGNED_STATUS_VERSION,
    challenge,
    timestamp,
    status,
  };
}

function assertChallenge(challenge) {
  if (typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) {
    throw new Error("signed status challenge must be a UUID");
  }
}

export function createSignedStatus({ status, key, challenge, timestamp = Date.now() }) {
  assertChallenge(challenge);
  if (!sameFields(status, STATUS_FIELDS)) throw new Error("node status contains unsupported or missing fields");
  if (!key?.privateKey || key.address !== status.validator) {
    throw new Error("node status signing key does not match its validator");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("invalid signed status timestamp");
  const payload = signingPayload({ challenge, timestamp, status });
  return {
    version: SIGNED_STATUS_VERSION,
    challenge,
    timestamp,
    status,
    signature: signObject(payload, key.privateKey),
  };
}

export function verifySignedStatus({
  response,
  genesis,
  expectedValidator,
  challenge,
  now = Date.now(),
  windowMs = SIGNED_STATUS_WINDOW_MS,
}) {
  if (!sameFields(response, RESPONSE_FIELDS)) throw new Error("signed status contains unsupported or missing fields");
  if (response.version !== SIGNED_STATUS_VERSION) throw new Error("unsupported signed status version");
  assertChallenge(challenge);
  if (response.challenge !== challenge) throw new Error("signed status challenge does not match the request");
  if (
    !Number.isSafeInteger(response.timestamp)
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(windowMs)
    || windowMs < 1
    || Math.abs(now - response.timestamp) > windowMs
  ) {
    throw new Error("signed status timestamp is outside the acceptable window");
  }
  if (!sameFields(response.status, STATUS_FIELDS)) throw new Error("node status contains unsupported or missing fields");
  const validator = genesis.validators.find(({ address }) => address === expectedValidator);
  if (!validator) throw new Error("expected signed status validator is not in genesis");
  const status = response.status;
  if (status.validator !== expectedValidator) throw new Error("signed status came from the wrong validator");
  if (status.chainId !== genesis.chainId) throw new Error("signed status reports the wrong chain");
  if (status.advertisedUrl !== validator.url) throw new Error("signed status reports the wrong validator URL");
  if (typeof status.name !== "string" || !/^node[1-9][0-9]*$/.test(status.name)) {
    throw new Error("signed status node name is invalid");
  }
  if (typeof status.validatorKeyEncrypted !== "boolean") {
    throw new Error("signed status validator key protection flag is invalid");
  }
  if (!Number.isSafeInteger(status.height) || status.height < 0) throw new Error("signed status height is invalid");
  if (typeof status.blockHash !== "string" || !/^[0-9a-f]{64}$/.test(status.blockHash)) {
    throw new Error("signed status block hash is invalid");
  }
  if (status.blockTimeMs !== genesis.blockTimeMs) throw new Error("signed status block time is invalid");
  if (status.validators !== genesis.validators.length) throw new Error("signed status validator count is invalid");
  if (status.quorum !== quorumSize(genesis.validators.length)) throw new Error("signed status quorum is invalid");
  if (status.peerAuthentication !== "ed25519-v1") throw new Error("signed status peer authentication is invalid");
  if (!Number.isSafeInteger(status.peers) || status.peers !== genesis.validators.length - 1) {
    throw new Error("signed status peer count is invalid");
  }
  if (!Number.isSafeInteger(status.mempoolSize) || status.mempoolSize < 0) {
    throw new Error("signed status mempool size is invalid");
  }
  if (!verifyObject(signingPayload(response), response.signature, validator.publicKey)) {
    throw new Error("signed status signature is invalid");
  }
  return {
    valid: true,
    validator: expectedValidator,
    timestamp: response.timestamp,
    clockOffsetMs: response.timestamp - now,
    status,
  };
}
