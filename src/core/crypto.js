import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";

function publicKeyObject(publicKey) {
  return createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
}

function privateKeyObject(privateKey) {
  return createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export function generateKeyRecord(label = "") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    version: 1,
    algorithm: "ed25519",
    label,
    address: addressFromPublicKey(publicKeyBase64),
    publicKey: publicKeyBase64,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function addressFromPublicKey(publicKey) {
  return `nova1${sha256(Buffer.from(publicKey, "base64")).slice(0, 40)}`;
}

export function signObject(value, privateKey) {
  return ed25519Sign(null, Buffer.from(canonicalJson(value)), privateKeyObject(privateKey)).toString("base64");
}

export function verifyObject(value, signature, publicKey) {
  try {
    return ed25519Verify(
      null,
      Buffer.from(canonicalJson(value)),
      publicKeyObject(publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function publicKeyFromPrivate(privateKey) {
  return createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" }).toString("base64");
}
