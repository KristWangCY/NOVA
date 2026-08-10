import { isIP } from "node:net";

export const TOPOLOGY_VERSION = 1;
export const REQUIRED_TRANSPORT = "private-network-required";

const TOPOLOGY_FIELDS = [
  "version",
  "chainId",
  "blockTimeMs",
  "initialSupply",
  "transport",
  "faucetPasswordEnv",
  "validators",
];
const VALIDATOR_FIELDS = ["url", "listenHost", "port", "passwordEnv"];
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactFields(value, allowed, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function assertEnvironmentName(value, label) {
  if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)) {
    throw new Error(`${label} must be an uppercase environment variable name`);
  }
}

function isPrivateIpv4(hostname) {
  const [first, second] = hostname.split(".").map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127;
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized);
}

function normalizeAdvertisedUrl(value, port, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:") throw new Error(`${label} must use http inside the required private transport`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${label} must be an origin without a path, query, or fragment`);
  if (!parsed.port || Number(parsed.port) !== port) throw new Error(`${label} port must match the validator listen port`);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "0.0.0.0" || hostname === "::") throw new Error(`${label} cannot advertise an unspecified listen address`);
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && !isPrivateIpv4(hostname)) {
    throw new Error(`${label} cannot advertise a globally routable IPv4 address over plaintext HTTP`);
  }
  if (ipVersion === 6 && !isPrivateIpv6(hostname)) {
    throw new Error(`${label} cannot advertise a globally routable IPv6 address over plaintext HTTP`);
  }
  return parsed.origin;
}

function normalizeListenHost(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 253
    || value.trim() !== value
    || /[\s/?#]/.test(value)
  ) {
    throw new Error(`${label} must be a host or interface address`);
  }
  return value;
}

export function validateNetworkTopology(value) {
  assertExactFields(value, TOPOLOGY_FIELDS, "network topology");
  if (value.version !== TOPOLOGY_VERSION) throw new Error("unsupported network topology version");
  if (typeof value.chainId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(value.chainId)) {
    throw new Error("invalid topology chainId");
  }
  if (!Number.isSafeInteger(value.blockTimeMs) || value.blockTimeMs < 500 || value.blockTimeMs > 60_000) {
    throw new Error("topology blockTimeMs must be between 500 and 60000");
  }
  if (typeof value.initialSupply !== "string" || !/^[1-9][0-9]*$/.test(value.initialSupply)) {
    throw new Error("topology initialSupply must be a positive decimal integer string");
  }
  if (value.transport !== REQUIRED_TRANSPORT) {
    throw new Error(`topology transport must be ${REQUIRED_TRANSPORT}`);
  }
  assertEnvironmentName(value.faucetPasswordEnv, "faucetPasswordEnv");
  if (!Array.isArray(value.validators) || value.validators.length < 3 || value.validators.length > 20) {
    throw new Error("distributed topology must contain between 3 and 20 validators");
  }

  const urls = new Set();
  const passwordEnvironments = new Set([value.faucetPasswordEnv]);
  const validators = value.validators.map((validator, index) => {
    const label = `validators[${index}]`;
    assertExactFields(validator, VALIDATOR_FIELDS, label);
    if (!Number.isSafeInteger(validator.port) || validator.port < 1024 || validator.port > 65535) {
      throw new Error(`${label}.port must be between 1024 and 65535`);
    }
    assertEnvironmentName(validator.passwordEnv, `${label}.passwordEnv`);
    if (passwordEnvironments.has(validator.passwordEnv)) {
      throw new Error("faucet and validator password environment names must be unique");
    }
    passwordEnvironments.add(validator.passwordEnv);
    const url = normalizeAdvertisedUrl(validator.url, validator.port, `${label}.url`);
    if (urls.has(url)) throw new Error("validator advertised URLs must be unique");
    urls.add(url);
    return {
      url,
      listenHost: normalizeListenHost(validator.listenHost, `${label}.listenHost`),
      port: validator.port,
      passwordEnv: validator.passwordEnv,
    };
  });

  return {
    version: TOPOLOGY_VERSION,
    chainId: value.chainId,
    blockTimeMs: value.blockTimeMs,
    initialSupply: value.initialSupply,
    transport: REQUIRED_TRANSPORT,
    faucetPasswordEnv: value.faucetPasswordEnv,
    validators,
  };
}

export function createNetworkTopologyTemplate() {
  return {
    version: TOPOLOGY_VERSION,
    chainId: "nova-private-1",
    blockTimeMs: 1500,
    initialSupply: "1000000000000",
    transport: REQUIRED_TRANSPORT,
    faucetPasswordEnv: "NOVA_FAUCET_PASSWORD",
    validators: [
      { url: "http://10.99.0.11:4101", listenHost: "10.99.0.11", port: 4101, passwordEnv: "NOVA_NODE1_PASSWORD" },
      { url: "http://10.99.0.12:4102", listenHost: "10.99.0.12", port: 4102, passwordEnv: "NOVA_NODE2_PASSWORD" },
      { url: "http://10.99.0.13:4103", listenHost: "10.99.0.13", port: 4103, passwordEnv: "NOVA_NODE3_PASSWORD" },
    ],
  };
}
