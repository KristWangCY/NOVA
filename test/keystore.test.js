import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyRecord } from "../src/core/crypto.js";
import { decryptKeyRecord, encryptKeyRecord, isEncryptedKeystore } from "../src/core/keystore.js";

const PASSWORD = "correct horse battery staple";

test("encrypted keystore round-trips without exposing the private key", () => {
  const key = generateKeyRecord("alice");
  const keystore = encryptKeyRecord(key, PASSWORD);
  assert.equal(isEncryptedKeystore(keystore), true);
  assert.equal(keystore.address, key.address);
  assert.equal(JSON.stringify(keystore).includes(key.privateKey), false);
  assert.deepEqual(decryptKeyRecord(keystore, PASSWORD), key);
});

test("keystore rejects wrong passwords and tampered metadata", () => {
  const key = generateKeyRecord("alice");
  const keystore = encryptKeyRecord(key, PASSWORD);
  assert.throws(() => decryptKeyRecord(keystore, "this password is definitely wrong"), /wrong password|corrupted/);
  assert.throws(
    () => decryptKeyRecord({ ...keystore, label: "mallory" }, PASSWORD),
    /wrong password|corrupted/,
  );
});

test("keystore creation enforces a minimum password length", () => {
  assert.throws(() => encryptKeyRecord(generateKeyRecord("alice"), "too-short"), /at least 12/);
});
