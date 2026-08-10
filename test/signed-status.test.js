import test from "node:test";
import assert from "node:assert/strict";
import { quorumSize } from "../src/core/block.js";
import { generateKeyRecord } from "../src/core/crypto.js";
import {
  createSignedStatus,
  SIGNED_STATUS_WINDOW_MS,
  verifySignedStatus,
} from "../src/core/signed-status.js";

function fixture() {
  const keys = [generateKeyRecord("validator-1"), generateKeyRecord("validator-2"), generateKeyRecord("validator-3")];
  const genesis = {
    version: 1,
    chainId: "nova-signed-status-1",
    genesisTime: 1_800_000_000_000,
    blockTimeMs: 1000,
    validators: keys.map((key, index) => ({
      name: `validator-${index + 1}`,
      address: key.address,
      publicKey: key.publicKey,
      url: `http://127.0.0.1:${7101 + index}`,
    })),
    allocations: {},
  };
  const status = {
    name: "node1",
    chainId: genesis.chainId,
    validator: keys[0].address,
    validatorKeyEncrypted: true,
    advertisedUrl: genesis.validators[0].url,
    height: 42,
    blockHash: "a".repeat(64),
    blockTimeMs: genesis.blockTimeMs,
    validators: genesis.validators.length,
    quorum: quorumSize(genesis.validators.length),
    peerAuthentication: "ed25519-v1",
    peers: 2,
    mempoolSize: 0,
  };
  return { keys, genesis, status };
}

test("signed status binds a fresh challenge, validator identity, and every status field", () => {
  const { keys, genesis, status } = fixture();
  const timestamp = 1_800_000_005_000;
  const challenge = "11111111-1111-4111-8111-111111111111";
  const response = createSignedStatus({ status, key: keys[0], challenge, timestamp });
  const verified = verifySignedStatus({
    response,
    genesis,
    expectedValidator: keys[0].address,
    challenge,
    now: timestamp,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.status.height, 42);
  assert.equal(verified.clockOffsetMs, 0);

  assert.throws(
    () => verifySignedStatus({
      response: { ...response, status: { ...response.status, height: 43 } },
      genesis,
      expectedValidator: keys[0].address,
      challenge,
      now: timestamp,
    }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifySignedStatus({
      response,
      genesis,
      expectedValidator: keys[1].address,
      challenge,
      now: timestamp,
    }),
    /wrong validator/,
  );
});

test("signed status rejects a different challenge, stale response, and unsigned fields", () => {
  const { keys, genesis, status } = fixture();
  const timestamp = 1_800_000_005_000;
  const challenge = "22222222-2222-4222-8222-222222222222";
  const response = createSignedStatus({ status, key: keys[0], challenge, timestamp });
  assert.throws(
    () => verifySignedStatus({
      response,
      genesis,
      expectedValidator: keys[0].address,
      challenge: "33333333-3333-4333-8333-333333333333",
      now: timestamp,
    }),
    /challenge does not match/,
  );
  assert.throws(
    () => verifySignedStatus({
      response,
      genesis,
      expectedValidator: keys[0].address,
      challenge,
      now: timestamp + SIGNED_STATUS_WINDOW_MS + 1,
    }),
    /outside the acceptable window/,
  );
  assert.throws(
    () => verifySignedStatus({
      response: { ...response, unsigned: true },
      genesis,
      expectedValidator: keys[0].address,
      challenge,
      now: timestamp,
    }),
    /unsupported or missing fields/,
  );

  const falseQuorum = createSignedStatus({
    status: { ...status, quorum: 1 },
    key: keys[0],
    challenge,
    timestamp,
  });
  assert.throws(
    () => verifySignedStatus({
      response: falseQuorum,
      genesis,
      expectedValidator: keys[0].address,
      challenge,
      now: timestamp,
    }),
    /quorum is invalid/,
  );
});
