import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Only finite safe integers can be canonicalized");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [, item] of entries) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError("Unsupported value in canonical JSON");
      }
    }
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }

  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashObject(value) {
  return sha256(canonicalJson(value));
}

export function merkleRoot(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return sha256("");
  }

  let level = ids.map((id) => sha256(id));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(left + right));
    }
    level = next;
  }
  return level[0];
}
