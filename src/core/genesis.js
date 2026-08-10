import { addressFromPublicKey } from "./crypto.js";

export function validateGenesis(genesis) {
  if (!genesis || genesis.version !== 1) {
    throw new Error("unsupported genesis version");
  }
  if (typeof genesis.chainId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(genesis.chainId)) {
    throw new Error("invalid chainId");
  }
  if (!Number.isSafeInteger(genesis.genesisTime) || genesis.genesisTime <= 0) {
    throw new Error("invalid genesisTime");
  }
  if (!Number.isSafeInteger(genesis.blockTimeMs) || genesis.blockTimeMs < 500) {
    throw new Error("blockTimeMs must be at least 500");
  }
  if (!Array.isArray(genesis.validators) || genesis.validators.length < 1) {
    throw new Error("genesis must contain at least one validator");
  }

  const addresses = new Set();
  const urls = new Set();
  for (const validator of genesis.validators) {
    if (addressFromPublicKey(validator.publicKey) !== validator.address) {
      throw new Error(`validator ${validator.name ?? "unknown"} has an invalid address`);
    }
    if (addresses.has(validator.address)) {
      throw new Error("genesis contains a duplicate validator");
    }
    addresses.add(validator.address);
    let parsed;
    try {
      parsed = new URL(validator.url);
    } catch {
      throw new Error(`validator ${validator.name ?? validator.address} has an invalid URL`);
    }
    if (parsed.protocol !== "http:" || validator.url !== parsed.origin) {
      throw new Error(`validator ${validator.name ?? validator.address} URL must be a canonical HTTP origin`);
    }
    if (urls.has(parsed.origin)) throw new Error("genesis contains a duplicate validator URL");
    urls.add(parsed.origin);
  }
  if (!genesis.allocations || typeof genesis.allocations !== "object" || Array.isArray(genesis.allocations)) {
    throw new Error("genesis allocations must be an object");
  }
  return true;
}
