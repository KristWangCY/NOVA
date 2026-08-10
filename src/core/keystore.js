import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "./crypto.js";

const KDF_PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32 });
const MINIMUM_PASSWORD_LENGTH = 12;

export function assertValidKeystorePassword(password) {
  if (typeof password !== "string" || password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`keystore password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }
}

function metadata(record) {
  return {
    version: record.version,
    type: record.type,
    address: record.address,
    publicKey: record.publicKey,
    label: record.label,
  };
}

function deriveKey(password, salt, parameters) {
  return scryptSync(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: 128 * 1024 * 1024,
  });
}

export function isEncryptedKeystore(value) {
  return Boolean(value && value.version === 1 && value.type === "nova-keystore" && value.crypto);
}

export function encryptKeyRecord(keyRecord, password) {
  assertValidKeystorePassword(password);
  if (!keyRecord?.privateKey || publicKeyFromPrivate(keyRecord.privateKey) !== keyRecord.publicKey) {
    throw new Error("key record is missing a valid private key");
  }
  if (addressFromPublicKey(keyRecord.publicKey) !== keyRecord.address) {
    throw new Error("key record address does not match its public key");
  }

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const shell = {
    version: 1,
    type: "nova-keystore",
    address: keyRecord.address,
    publicKey: keyRecord.publicKey,
    label: keyRecord.label ?? "account",
  };
  const encryptionKey = deriveKey(password, salt, KDF_PARAMETERS);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(canonicalJson(metadata(shell))));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(keyRecord), "utf8"),
    cipher.final(),
  ]);

  return {
    ...shell,
    crypto: {
      cipher: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      kdf: "scrypt",
      salt: salt.toString("base64"),
      parameters: KDF_PARAMETERS,
    },
  };
}

export function decryptKeyRecord(keystore, password) {
  if (!isEncryptedKeystore(keystore)) {
    throw new Error("file is not a supported NOVA keystore");
  }
  const { crypto } = keystore;
  if (crypto.cipher !== "aes-256-gcm" || crypto.kdf !== "scrypt") {
    throw new Error("unsupported keystore encryption scheme");
  }
  const parameters = crypto.parameters;
  if (
    parameters?.N !== KDF_PARAMETERS.N
    || parameters?.r !== KDF_PARAMETERS.r
    || parameters?.p !== KDF_PARAMETERS.p
    || parameters?.keyLength !== KDF_PARAMETERS.keyLength
  ) {
    throw new Error("unsupported keystore KDF parameters");
  }

  try {
    const encryptionKey = deriveKey(password, Buffer.from(crypto.salt, "base64"), parameters);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(crypto.iv, "base64"));
    decipher.setAAD(Buffer.from(canonicalJson(metadata(keystore))));
    decipher.setAuthTag(Buffer.from(crypto.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(crypto.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const keyRecord = JSON.parse(plaintext);
    if (
      keyRecord.address !== keystore.address
      || keyRecord.publicKey !== keystore.publicKey
      || publicKeyFromPrivate(keyRecord.privateKey) !== keystore.publicKey
      || addressFromPublicKey(keyRecord.publicKey) !== keyRecord.address
    ) {
      throw new Error("decrypted key does not match keystore metadata");
    }
    return keyRecord;
  } catch {
    throw new Error("unable to decrypt keystore: wrong password or corrupted file");
  }
}

export function unlockKeyFile(contents, password) {
  if (isEncryptedKeystore(contents)) {
    if (!password) {
      throw new Error("this key is encrypted; set the configured password environment variable");
    }
    return decryptKeyRecord(contents, password);
  }
  if (!contents?.privateKey) {
    throw new Error("key file has no private key");
  }
  return contents;
}
