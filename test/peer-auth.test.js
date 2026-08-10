import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyRecord } from "../src/core/crypto.js";
import {
  createPeerAuthHeaders,
  PEER_AUTH_WINDOW_MS,
  PeerReplayCache,
  verifyPeerAuth,
} from "../src/core/peer-auth.js";

function fixture() {
  const keys = [generateKeyRecord("validator-1"), generateKeyRecord("validator-2")];
  const genesis = {
    chainId: "nova-peer-auth-1",
    validators: keys.map((key, index) => ({
      name: `validator-${index + 1}`,
      address: key.address,
      publicKey: key.publicKey,
      url: `http://127.0.0.1:${6101 + index}`,
    })),
  };
  return { keys, genesis };
}

function verify({
  headers,
  genesis,
  recipient,
  body,
  url,
  now,
  replayCache = new PeerReplayCache(),
  method = "POST",
}) {
  return verifyPeerAuth({ headers, genesis, recipient, method, url, body, now, replayCache });
}

test("validator request signatures bind chain, method, target, and exact body bytes", () => {
  const { keys, genesis } = fixture();
  const now = 1_800_000_000_000;
  const url = "http://127.0.0.1:6102/transactions?gossip=0";
  const body = JSON.stringify({ message: "signed peer payload", order: [1, 2, 3] });
  const headers = createPeerAuthHeaders({
    chainId: genesis.chainId,
    key: keys[0],
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp: now,
    requestId: "11111111-1111-4111-8111-111111111111",
  });

  assert.throws(() => verify({ headers, genesis, recipient: keys[1].address, body: `${body} `, url, now }), /signature is invalid/);
  assert.throws(() => verify({ headers, genesis, recipient: keys[1].address, body, url: `${url}&extra=1`, now }), /signature is invalid/);
  assert.throws(() => verify({ headers, genesis, recipient: keys[1].address, body, url, now, method: "PUT" }), /signature is invalid/);
  assert.throws(() => verify({ headers, genesis, recipient: keys[0].address, body, url, now }), /signature is invalid/);
  assert.deepEqual(
    verify({ headers, genesis, recipient: keys[1].address, body, url, now }),
    {
      validator: keys[0].address,
      timestamp: now,
      requestId: "11111111-1111-4111-8111-111111111111",
      version: 1,
    },
  );
});

test("peer authentication rejects unknown keys, identity substitution, and wrong chains", () => {
  const { keys, genesis } = fixture();
  const attacker = generateKeyRecord("attacker");
  const now = 1_800_000_000_000;
  const url = "http://127.0.0.1:6102/blocks";
  const body = "{}";
  const requestId = "22222222-2222-4222-8222-222222222222";

  const attackerHeaders = createPeerAuthHeaders({
    chainId: genesis.chainId,
    key: attacker,
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp: now,
    requestId,
  });
  assert.throws(() => verify({ headers: attackerHeaders, genesis, recipient: keys[1].address, body, url, now }), /not a validator/);

  const validHeaders = createPeerAuthHeaders({
    chainId: genesis.chainId,
    key: keys[0],
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp: now,
    requestId,
  });
  assert.throws(
    () => verify({ headers: { ...validHeaders, "x-nova-peer": keys[1].address }, genesis, recipient: keys[1].address, body, url, now }),
    /signature is invalid/,
  );

  const wrongChainHeaders = createPeerAuthHeaders({
    chainId: "nova-other-chain-1",
    key: keys[0],
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp: now,
    requestId,
  });
  assert.throws(() => verify({ headers: wrongChainHeaders, genesis, recipient: keys[1].address, body, url, now }), /signature is invalid/);
});

test("peer authentication enforces its clock window and one-time request ids", () => {
  const { keys, genesis } = fixture();
  const now = 1_800_000_000_000;
  const url = "http://127.0.0.1:6102/proposals";
  const body = "{}";
  const create = (timestamp, requestId) => createPeerAuthHeaders({
    chainId: genesis.chainId,
    key: keys[0],
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp,
    requestId,
  });

  assert.throws(
    () => verify({
      headers: create(now - PEER_AUTH_WINDOW_MS - 1, "33333333-3333-4333-8333-333333333333"),
      genesis,
      recipient: keys[1].address,
      body,
      url,
      now,
    }),
    /outside the acceptable window/,
  );
  assert.throws(
    () => verify({
      headers: create(now + PEER_AUTH_WINDOW_MS + 1, "44444444-4444-4444-8444-444444444444"),
      genesis,
      recipient: keys[1].address,
      body,
      url,
      now,
    }),
    /outside the acceptable window/,
  );

  const replayCache = new PeerReplayCache();
  const headers = create(now, "55555555-5555-4555-8555-555555555555");
  verify({ headers, genesis, recipient: keys[1].address, body, url, now, replayCache });
  assert.throws(() => verify({ headers, genesis, recipient: keys[1].address, body, url, now, replayCache }), /already received/);
});

test("invalid signatures do not consume replay cache entries", () => {
  const { keys, genesis } = fixture();
  const now = 1_800_000_000_000;
  const url = "http://127.0.0.1:6102/blocks";
  const body = "{}";
  const replayCache = new PeerReplayCache({ maxEntries: 1 });
  const headers = createPeerAuthHeaders({
    chainId: genesis.chainId,
    key: keys[0],
    recipient: keys[1].address,
    method: "POST",
    url,
    body,
    timestamp: now,
    requestId: "66666666-6666-4666-8666-666666666666",
  });

  assert.throws(() => verify({ headers, genesis, recipient: keys[1].address, body: "[]", url, now, replayCache }), /signature is invalid/);
  assert.doesNotThrow(() => verify({ headers, genesis, recipient: keys[1].address, body, url, now, replayCache }));
});
