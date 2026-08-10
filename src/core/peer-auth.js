import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical.js";
import { signObject, verifyObject } from "./crypto.js";

export const PEER_AUTH_VERSION = 1;
export const PEER_AUTH_SCHEME = "ed25519-v1";
export const PEER_AUTH_WINDOW_MS = 30_000;
export const PEER_AUTH_MAX_REPLAY_ENTRIES = 10_000;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

const HEADER_NAMES = Object.freeze({
  version: "x-nova-peer-version",
  validator: "x-nova-peer",
  timestamp: "x-nova-peer-timestamp",
  requestId: "x-nova-peer-request-id",
  signature: "x-nova-peer-signature",
});

export class PeerAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PeerAuthenticationError";
    this.statusCode = 401;
  }
}

function requestTarget(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function headerValue(headers, name) {
  const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0) {
    throw new PeerAuthenticationError(`missing or duplicated ${name} header`);
  }
  return value;
}

function assertSignatureFormat(signature) {
  if (!SIGNATURE_PATTERN.test(signature) || Buffer.from(signature, "base64").length !== 64) {
    throw new PeerAuthenticationError("invalid peer signature encoding");
  }
}

function signingPayload({ chainId, validator, recipient, method, target, body, timestamp, requestId }) {
  return {
    domain: "nova-peer-request",
    version: PEER_AUTH_VERSION,
    chainId,
    validator,
    recipient,
    method: method.toUpperCase(),
    target,
    bodyHash: sha256(body),
    timestamp,
    requestId,
  };
}

export class PeerReplayCache {
  constructor({ windowMs = PEER_AUTH_WINDOW_MS, maxEntries = PEER_AUTH_MAX_REPLAY_ENTRIES } = {}) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError("invalid peer authentication window");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("invalid replay cache capacity");
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  accept({ validator, requestId, timestamp, now }) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt < now) this.entries.delete(key);
    }
    const key = `${validator}:${requestId}`;
    if (this.entries.has(key)) {
      throw new PeerAuthenticationError("peer request was already received");
    }
    if (this.entries.size >= this.maxEntries) {
      throw new PeerAuthenticationError("peer replay cache capacity exceeded");
    }
    this.entries.set(key, timestamp + this.windowMs);
  }
}

export function createPeerAuthHeaders({
  chainId,
  key,
  recipient,
  method,
  url,
  body = "",
  timestamp = Date.now(),
  requestId = randomUUID(),
}) {
  if (!key?.address || !key?.privateKey) throw new TypeError("validator signing key is required");
  if (typeof recipient !== "string" || recipient.length === 0) throw new TypeError("peer recipient is required");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("invalid peer request timestamp");
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError("invalid peer request id");
  const payload = signingPayload({
    chainId,
    validator: key.address,
    recipient,
    method,
    target: requestTarget(url),
    body,
    timestamp,
    requestId,
  });
  return {
    [HEADER_NAMES.version]: String(PEER_AUTH_VERSION),
    [HEADER_NAMES.validator]: key.address,
    [HEADER_NAMES.timestamp]: String(timestamp),
    [HEADER_NAMES.requestId]: requestId,
    [HEADER_NAMES.signature]: signObject(payload, key.privateKey),
  };
}

export function verifyPeerAuth({
  headers,
  genesis,
  recipient,
  method,
  url,
  body = "",
  replayCache,
  now = Date.now(),
}) {
  if (!(replayCache instanceof PeerReplayCache)) throw new TypeError("peer replay cache is required");
  if (!Number.isSafeInteger(now)) {
    throw new TypeError("invalid peer verification clock");
  }
  if (typeof recipient !== "string" || recipient.length === 0) throw new TypeError("peer recipient is required");
  const windowMs = replayCache.windowMs;
  const version = headerValue(headers, HEADER_NAMES.version);
  const validatorAddress = headerValue(headers, HEADER_NAMES.validator);
  const timestampText = headerValue(headers, HEADER_NAMES.timestamp);
  const requestId = headerValue(headers, HEADER_NAMES.requestId);
  const signature = headerValue(headers, HEADER_NAMES.signature);

  if (version !== String(PEER_AUTH_VERSION)) throw new PeerAuthenticationError("unsupported peer authentication version");
  if (!/^(0|[1-9][0-9]*)$/.test(timestampText)) throw new PeerAuthenticationError("invalid peer request timestamp");
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > windowMs) {
    throw new PeerAuthenticationError("peer request timestamp is outside the acceptable window");
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new PeerAuthenticationError("invalid peer request id");
  assertSignatureFormat(signature);

  const validator = genesis.validators.find(({ address }) => address === validatorAddress);
  if (!validator) throw new PeerAuthenticationError("peer is not a validator in this chain");
  const payload = signingPayload({
    chainId: genesis.chainId,
    validator: validatorAddress,
    recipient,
    method,
    target: requestTarget(url),
    body,
    timestamp,
    requestId,
  });
  if (!verifyObject(payload, signature, validator.publicKey)) {
    throw new PeerAuthenticationError("peer request signature is invalid");
  }
  replayCache.accept({ validator: validatorAddress, requestId, timestamp, now });
  return { validator: validatorAddress, timestamp, requestId, version: PEER_AUTH_VERSION };
}
