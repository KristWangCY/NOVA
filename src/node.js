import { createServer } from "node:http";
import {
  createProposal,
  createVote,
  quorumSize,
  verifyCommittedBlock,
  verifyProposal,
  verifyVote,
} from "./core/block.js";
import {
  createPeerAuthHeaders,
  PEER_AUTH_SCHEME,
  PeerReplayCache,
  verifyPeerAuth,
} from "./core/peer-auth.js";
import { applyTransaction, cloneState } from "./core/state.js";
import { isRecordTransaction, validateTransactionBasic } from "./core/transaction.js";
import { createSignedStatus } from "./core/signed-status.js";
import { NodeStorage } from "./runtime/storage.js";
import { NodeHomeLock } from "./runtime/node-lock.js";
import { advertisedNodeUrl, localNodeUrl } from "./runtime/node-config.js";

const MAX_BODY_BYTES = 1024 * 1024;
const PROPOSAL_RECOVERY_VERSION = 1;
const PROPOSAL_RECOVERY_FIELDS = ["version", "proposal", "proofVote"];

function hasExactFields(value, fields) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseRequestJson(body) {
  return body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function fetchJson(url, options, timeoutMs) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `peer returned HTTP ${response.status}`);
  }
  return payload;
}

export class NovaNode {
  constructor(home, { quiet = false, keyPassword } = {}) {
    this.homeLock = new NodeHomeLock(home);
    try {
      this.storage = new NodeStorage(home, { keyPassword }).load();
    } catch (error) {
      this.homeLock.release();
      throw error;
    }
    this.config = this.storage.config;
    this.genesis = this.storage.genesis;
    this.key = this.storage.key;
    this.quiet = quiet;
    this.server = null;
    this.syncing = false;
    this.producingSlots = new Set();
    this.recoveringVoteLock = false;
    this.lastVoteRecoveryAt = 0;
    this.backgroundTasks = new Set();
    this.stopping = false;
    this.stopped = false;
    this.stopPromise = null;
    this.peerReplayCache = new PeerReplayCache();
  }

  log(message, details = "") {
    if (!this.quiet) {
      const suffix = details ? ` ${details}` : "";
      console.log(`[${new Date().toISOString()}] [${this.config.name}] ${message}${suffix}`);
    }
  }

  runBackground(operation) {
    if (this.stopping || this.stopped) return null;
    let task;
    task = Promise.resolve()
      .then(() => {
        if (this.stopping || this.stopped) return undefined;
        return operation();
      })
      .catch((error) => {
        this.log("background task failed:", error.message);
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
    this.backgroundTasks.add(task);
    return task;
  }

  assertWritableInstance() {
    if (this.stopped) {
      throw new Error("a stopped node instance cannot mutate its node home");
    }
  }

  status() {
    return {
      name: this.config.name,
      chainId: this.genesis.chainId,
      validator: this.key.address,
      validatorKeyEncrypted: this.storage.keyEncrypted,
      advertisedUrl: advertisedNodeUrl(this.config),
      height: this.storage.tip.header.height,
      blockHash: this.storage.tip.hash,
      blockTimeMs: this.genesis.blockTimeMs,
      validators: this.genesis.validators.length,
      quorum: quorumSize(this.genesis.validators.length),
      peerAuthentication: PEER_AUTH_SCHEME,
      peers: this.config.peers.length,
      mempoolSize: this.storage.mempool.length,
    };
  }

  overview() {
    let totalTransactions = 0;
    let totalRecords = 0;
    for (const block of this.storage.chain) {
      totalTransactions += block.transactions.length;
      totalRecords += block.transactions.filter(isRecordTransaction).length;
    }
    return {
      ok: true,
      ...this.status(),
      latestBlockTime: this.storage.tip.header.timestamp,
      totalTransactions,
      totalRecords,
      totalSupply: this.storage.state.totalSupply,
      burnedFees: this.storage.state.burnedFees,
      accounts: Object.keys(this.storage.state.balances).length,
      denomination: this.genesis.denomination,
      validatorSet: this.genesis.validators.map(({ name, address, url }) => ({ name, address, url })),
    };
  }

  recentTransactions({ limit = 20, address } = {}) {
    const transactions = [];
    for (let blockIndex = this.storage.chain.length - 1; blockIndex >= 1; blockIndex -= 1) {
      const block = this.storage.chain[blockIndex];
      for (let transactionIndex = block.transactions.length - 1; transactionIndex >= 0; transactionIndex -= 1) {
        const transaction = block.transactions[transactionIndex];
        if (address && transaction.from !== address && transaction.to !== address) {
          continue;
        }
        transactions.push({
          transactionId: transaction.id,
          status: "committed",
          final: true,
          height: block.header.height,
          blockHash: block.hash,
          timestamp: block.header.timestamp,
          transactionIndex,
          confirmations: this.storage.tip.header.height - block.header.height + 1,
          transaction,
        });
        if (transactions.length >= limit) {
          return transactions;
        }
      }
    }
    return transactions;
  }

  recentRecords({ limit = 20, owner, contentHash, category } = {}) {
    const records = [];
    for (let blockIndex = this.storage.chain.length - 1; blockIndex >= 1; blockIndex -= 1) {
      const block = this.storage.chain[blockIndex];
      for (let transactionIndex = block.transactions.length - 1; transactionIndex >= 0; transactionIndex -= 1) {
        const transaction = block.transactions[transactionIndex];
        if (!isRecordTransaction(transaction)) continue;
        if (owner && transaction.from !== owner) continue;
        if (contentHash && transaction.contentHash !== contentHash) continue;
        if (category && transaction.category !== category) continue;
        records.push({
          transactionId: transaction.id,
          status: "committed",
          final: true,
          height: block.header.height,
          blockHash: block.hash,
          timestamp: block.header.timestamp,
          transactionIndex,
          confirmations: this.storage.tip.header.height - block.header.height + 1,
          transaction,
        });
        if (records.length >= limit) return records;
      }
    }
    return records;
  }

  blockByIdentifier(identifier) {
    if (/^(0|[1-9][0-9]*)$/.test(identifier)) {
      const height = Number(identifier);
      if (!Number.isSafeInteger(height)) return undefined;
      return this.storage.chain[height];
    }
    if (/^[0-9a-f]{64}$/.test(identifier)) {
      return this.storage.chain.find(({ hash }) => hash === identifier);
    }
    return undefined;
  }

  transactionReceipt(transactionId) {
    const pending = this.storage.mempool.find(({ id }) => id === transactionId);
    if (pending) {
      return {
        transactionId,
        status: "pending",
        final: false,
        transaction: pending,
      };
    }

    for (let blockIndex = this.storage.chain.length - 1; blockIndex >= 1; blockIndex -= 1) {
      const block = this.storage.chain[blockIndex];
      const transactionIndex = block.transactions.findIndex(({ id }) => id === transactionId);
      if (transactionIndex !== -1) {
        return {
          transactionId,
          status: "committed",
          final: true,
          height: block.header.height,
          blockHash: block.hash,
          timestamp: block.header.timestamp,
          transactionIndex,
          confirmations: this.storage.tip.header.height - block.header.height + 1,
          transaction: block.transactions[transactionIndex],
        };
      }
    }
    return { transactionId, status: "not_found", final: false };
  }

  pruneMempool() {
    const candidateState = cloneState(this.storage.state);
    const retained = [];
    for (const transaction of this.storage.mempool) {
      try {
        applyTransaction(candidateState, transaction, this.genesis.chainId);
        retained.push(transaction);
      } catch {
        // A committed transaction or an invalid nonce makes this entry obsolete.
      }
    }
    this.storage.mempool = retained;
    this.storage.persistMempool();
  }

  addTransaction(transaction, { gossip = true } = {}) {
    this.assertWritableInstance();
    validateTransactionBasic(transaction, this.genesis.chainId);
    if (this.storage.mempool.some(({ id }) => id === transaction.id)) {
      return { accepted: true, duplicate: true, ...this.transactionReceipt(transaction.id) };
    }

    const candidateState = cloneState(this.storage.state);
    for (const pending of this.storage.mempool) {
      applyTransaction(candidateState, pending, this.genesis.chainId);
    }
    applyTransaction(candidateState, transaction, this.genesis.chainId);
    this.storage.mempool.push(transaction);
    this.storage.persistMempool();
    if (gossip) {
      this.runBackground(() => this.broadcastTransaction(transaction));
    }
    return { accepted: true, duplicate: false, ...this.transactionReceipt(transaction.id) };
  }

  signProposal(proposal, { allowHistorical = false } = {}) {
    this.assertWritableInstance();
    const nextState = verifyProposal(proposal, this.genesis, this.storage.tip, this.storage.state);
    const heightKey = String(proposal.header.height);
    const existing = this.storage.votes[heightKey];
    if (existing) {
      if (existing.hash !== proposal.hash) {
        throw new Error(`validator is locked on a different proposal at height ${heightKey}`);
      }
      return existing.vote;
    }

    const currentSlot = Math.floor(Date.now() / this.genesis.blockTimeMs);
    if (
      proposal.header.slot > currentSlot + 1
      || (!allowHistorical && proposal.header.slot < currentSlot - 2)
    ) {
      throw new Error("proposal is outside the acceptable time window");
    }
    // Holding the result proves deterministic execution succeeded before voting.
    if (nextState.height !== proposal.header.height) {
      throw new Error("proposal execution produced an invalid height");
    }
    const vote = createVote(proposal, this.key);
    this.storage.votes[heightKey] = { hash: proposal.hash, proposal, vote };
    this.storage.persistVotes();
    return vote;
  }

  currentVoteLock() {
    return this.storage.votes[String(this.storage.tip.header.height + 1)] ?? null;
  }

  verifiedUniqueVotes(proposal, candidates) {
    const votes = new Map();
    for (const vote of candidates) {
      try {
        verifyVote(proposal, vote, this.genesis);
        votes.set(vote.validator, vote);
      } catch {
        // A malformed, forged, or wrong-proposal vote cannot contribute to quorum.
      }
    }
    return [...votes.values()];
  }

  async finalizeProposal(proposal, candidates) {
    const votes = this.verifiedUniqueVotes(proposal, candidates);
    if (votes.length < quorumSize(this.genesis.validators.length)) return false;
    const block = { ...proposal, commit: { votes } };
    this.commitBlock(block);
    await this.broadcastBlock(block);
    return true;
  }

  async recoverPersistedVoteLock() {
    this.assertWritableInstance();
    if (this.recoveringVoteLock) return;
    this.recoveringVoteLock = true;
    try {
      await this.synchronize();
      const lock = this.currentVoteLock();
      if (!lock) return;
      const body = JSON.stringify({
        version: PROPOSAL_RECOVERY_VERSION,
        proposal: lock.proposal,
        proofVote: lock.vote,
      });
      const results = await Promise.allSettled(this.config.peers.map((peer) => this.fetchPeerJson(
        `${peer}/proposals/recover`,
        { method: "POST", body },
      )));
      const votes = [lock.vote];
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.vote) votes.push(result.value.vote);
      }
      const committed = await this.finalizeProposal(lock.proposal, votes);
      if (!committed) {
        this.log(
          `locked proposal #${lock.proposal.header.height} did not reach quorum`,
          `votes=${this.verifiedUniqueVotes(lock.proposal, votes).length}`,
        );
      }
    } catch (error) {
      this.log("locked proposal recovery skipped:", error.message);
    } finally {
      this.recoveringVoteLock = false;
    }
  }

  commitBlock(block) {
    this.assertWritableInstance();
    if (block.header.height <= this.storage.tip.header.height) {
      if (block.hash === this.storage.chain[block.header.height]?.hash) {
        return { committed: true, duplicate: true };
      }
      throw new Error("received a conflicting historical block");
    }
    const nextState = verifyCommittedBlock(block, this.genesis, this.storage.tip, this.storage.state);
    this.storage.chain.push(block);
    this.storage.state = nextState;
    for (const height of Object.keys(this.storage.votes)) {
      if (Number(height) <= block.header.height) {
        delete this.storage.votes[height];
      }
    }
    const included = new Set(block.transactions.map(({ id }) => id));
    this.storage.mempool = this.storage.mempool.filter(({ id }) => !included.has(id));
    this.storage.persistChainAndState();
    this.storage.persistVotes();
    this.pruneMempool();
    this.log(`committed block #${block.header.height}`, `${block.hash.slice(0, 12)} txs=${block.transactions.length}`);
    return { committed: true, duplicate: false };
  }

  async broadcastTransaction(transaction) {
    await Promise.allSettled(this.config.peers.map((peer) => this.fetchPeerJson(
      `${peer}/transactions?gossip=0`,
      { method: "POST", body: JSON.stringify(transaction) },
    )));
  }

  async broadcastBlock(block) {
    await Promise.allSettled(this.config.peers.map((peer) => this.fetchPeerJson(
      `${peer}/blocks`,
      { method: "POST", body: JSON.stringify(block) },
    )));
  }

  async synchronize() {
    this.assertWritableInstance();
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    try {
      for (const peer of this.config.peers) {
        try {
          const from = this.storage.tip.header.height + 1;
          const { blocks } = await fetchJson(
            `${peer}/blocks?from=${from}&limit=100`,
            { method: "GET" },
            this.config.requestTimeoutMs,
          );
          for (const block of blocks) {
            if (block.header.height === this.storage.tip.header.height + 1) {
              this.commitBlock(block);
            }
          }
        } catch {
          // A peer being unavailable is normal; the next peer or tick may catch us up.
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  async fetchPeerJson(url, options = {}) {
    const body = options.body ?? "";
    const method = options.method ?? "GET";
    const origin = new URL(url).origin;
    const recipient = this.genesis.validators.find((validator) => new URL(validator.url).origin === origin);
    if (!recipient) throw new Error(`peer URL is not in the validator set: ${origin}`);
    return fetchJson(url, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...createPeerAuthHeaders({
          chainId: this.genesis.chainId,
          key: this.key,
          recipient: recipient.address,
          method,
          url,
          body,
        }),
      },
    }, this.config.requestTimeoutMs);
  }

  authenticatePeer(request, url, body) {
    return verifyPeerAuth({
      headers: request.headers,
      genesis: this.genesis,
      recipient: this.key.address,
      method: request.method,
      url,
      body,
      replayCache: this.peerReplayCache,
    });
  }

  async produceForSlot(slot) {
    this.assertWritableInstance();
    if (this.producingSlots.has(slot)) {
      return;
    }
    this.producingSlots.add(slot);
    try {
      await this.synchronize();
      if (this.currentVoteLock()) {
        await this.recoverPersistedVoteLock();
        return;
      }
      if (this.storage.tip.header.slot >= slot) {
        return;
      }
      // Synchronization can commit pending work before this node's turn. Never
      // create a new proposal when no transactions remain; historical empty
      // blocks and persisted vote locks are still accepted and recovered.
      if (this.storage.mempool.length === 0) {
        return;
      }
      const expected = this.genesis.validators[slot % this.genesis.validators.length];
      if (expected.address !== this.key.address) {
        return;
      }

      const transactions = this.storage.mempool.slice(0, this.config.maxTransactionsPerBlock);
      const proposal = createProposal({
        genesis: this.genesis,
        tip: this.storage.tip,
        state: this.storage.state,
        transactions,
        key: this.key,
        slot,
        timestamp: Date.now(),
      });
      const results = await Promise.allSettled(this.config.peers.map((peer) => this.fetchPeerJson(
        `${peer}/proposals`,
        { method: "POST", body: JSON.stringify(proposal) },
      )));
      const peerVotes = [];
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.vote) {
          peerVotes.push(result.value.vote);
        }
      }
      const validPeerVotes = this.verifiedUniqueVotes(proposal, peerVotes)
        .filter(({ validator }) => validator !== this.key.address);
      const requiredPeerVotes = quorumSize(this.genesis.validators.length) - 1;
      if (validPeerVotes.length < requiredPeerVotes) {
        this.log(`proposal #${proposal.header.height} did not reach peer quorum`, `peerVotes=${validPeerVotes.length}`);
        return;
      }
      const ownVote = this.signProposal(proposal);
      await this.finalizeProposal(proposal, [...validPeerVotes, ownVote]);
    } catch (error) {
      this.log("block production skipped:", error.message);
    } finally {
      this.producingSlots.delete(slot);
    }
  }

  producerTick() {
    const now = Date.now();
    if (this.currentVoteLock()) {
      const recoveryIntervalMs = Math.max(1000, this.genesis.blockTimeMs * 2);
      if (now - this.lastVoteRecoveryAt >= recoveryIntervalMs) {
        this.lastVoteRecoveryAt = now;
        this.runBackground(() => this.recoverPersistedVoteLock());
      }
      return;
    }
    const slot = Math.floor(now / this.genesis.blockTimeMs);
    const elapsed = now % this.genesis.blockTimeMs;
    const expected = this.genesis.validators[slot % this.genesis.validators.length];
    if (
      elapsed >= this.config.proposalDelayMs
      && expected.address === this.key.address
      && this.storage.tip.header.slot < slot
      && this.storage.mempool.length > 0
    ) {
      this.runBackground(() => this.produceForSlot(slot));
    }
  }

  async route(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/status")) {
      sendJson(response, 200, { ok: true, ...this.status() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status/signed") {
      sendJson(response, 200, createSignedStatus({
        status: this.status(),
        key: this.key,
        challenge: url.searchParams.get("challenge"),
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/overview") {
      sendJson(response, 200, this.overview());
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/accounts/")) {
      const address = decodeURIComponent(url.pathname.slice("/accounts/".length));
      if (!/^nova1[0-9a-f]{40}$/.test(address)) {
        throw new Error("invalid NOVA address");
      }
      sendJson(response, 200, {
        address,
        balance: this.storage.state.balances[address] ?? "0",
        nonce: this.storage.state.nonces[address] ?? 0,
        height: this.storage.state.height,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/transactions") {
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
      const limit = Number.isNaN(rawLimit) ? 20 : Math.min(100, Math.max(1, rawLimit));
      const address = url.searchParams.get("address") || undefined;
      if (address && !/^nova1[0-9a-f]{40}$/.test(address)) {
        throw new Error("invalid NOVA address");
      }
      sendJson(response, 200, { transactions: this.recentTransactions({ limit, address }) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/records") {
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
      const limit = Number.isNaN(rawLimit) ? 20 : Math.min(100, Math.max(1, rawLimit));
      const owner = url.searchParams.get("owner") || undefined;
      const contentHash = url.searchParams.get("hash") || undefined;
      const category = url.searchParams.get("category") || undefined;
      if (owner && !/^nova1[0-9a-f]{40}$/.test(owner)) throw new Error("invalid NOVA record owner");
      if (contentHash && !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("invalid record content hash");
      if (category && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(category)) throw new Error("invalid record category");
      sendJson(response, 200, { records: this.recentRecords({ limit, owner, contentHash, category }) });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/records/")) {
      const transactionId = decodeURIComponent(url.pathname.slice("/records/".length));
      if (!/^[0-9a-f]{64}$/.test(transactionId)) throw new Error("invalid record transaction id");
      const receipt = this.transactionReceipt(transactionId);
      if (receipt.status === "not_found" || !isRecordTransaction(receipt.transaction)) {
        sendJson(response, 404, { error: "record not found" });
        return;
      }
      sendJson(response, 200, receipt);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/transactions/")) {
      const transactionId = decodeURIComponent(url.pathname.slice("/transactions/".length));
      if (!/^[0-9a-f]{64}$/.test(transactionId)) {
        throw new Error("invalid transaction id");
      }
      sendJson(response, 200, this.transactionReceipt(transactionId));
      return;
    }
    if (request.method === "GET" && url.pathname === "/blocks") {
      const rawFrom = Number.parseInt(url.searchParams.get("from") ?? "0", 10);
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
      const from = Number.isNaN(rawFrom) ? 0 : Math.max(0, rawFrom);
      const limit = Number.isNaN(rawLimit) ? 20 : Math.min(100, Math.max(1, rawLimit));
      sendJson(response, 200, { blocks: this.storage.chain.slice(from, from + limit) });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/blocks/")) {
      const identifier = decodeURIComponent(url.pathname.slice("/blocks/".length));
      const block = this.blockByIdentifier(identifier);
      if (!block) {
        sendJson(response, 404, { error: "block not found" });
        return;
      }
      sendJson(response, 200, { block });
      return;
    }
    if (request.method === "POST" && url.pathname === "/transactions") {
      const body = await readRequestBody(request);
      const gossip = url.searchParams.get("gossip") !== "0";
      if (!gossip) this.authenticatePeer(request, url, body);
      const transaction = parseRequestJson(body);
      const result = this.addTransaction(transaction, { gossip });
      sendJson(response, 202, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/proposals") {
      const body = await readRequestBody(request);
      this.authenticatePeer(request, url, body);
      const proposal = parseRequestJson(body);
      sendJson(response, 200, { vote: this.signProposal(proposal) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/proposals/recover") {
      const body = await readRequestBody(request);
      const authenticated = this.authenticatePeer(request, url, body);
      const recovery = parseRequestJson(body);
      if (!hasExactFields(recovery, PROPOSAL_RECOVERY_FIELDS) || recovery.version !== PROPOSAL_RECOVERY_VERSION) {
        throw new Error("unsupported or malformed proposal recovery request");
      }
      const proofValidator = verifyVote(recovery.proposal, recovery.proofVote, this.genesis);
      if (proofValidator.address !== authenticated.validator) {
        throw new Error("proposal recovery proof does not belong to its authenticated sender");
      }
      sendJson(response, 200, {
        vote: this.signProposal(recovery.proposal, { allowHistorical: true }),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/blocks") {
      const body = await readRequestBody(request);
      this.authenticatePeer(request, url, body);
      const block = parseRequestJson(body);
      if (block.header?.height > this.storage.tip.header.height + 1) {
        await this.synchronize();
      }
      sendJson(response, 200, this.commitBlock(block));
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }

  async start() {
    if (this.stopping || this.stopped) {
      throw new Error("a stopped node instance cannot be restarted; create a new NovaNode");
    }
    if (this.server) {
      throw new Error("node is already running");
    }
    this.server = createServer((request, response) => {
      const origin = request.headers.origin;
      if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(origin)) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
        response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        response.setHeader("access-control-allow-headers", "content-type");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(origin && response.hasHeader("access-control-allow-origin") ? 204 : 403);
        response.end();
        return;
      }
      this.route(request, response).catch((error) => {
        sendJson(response, error.statusCode ?? 400, { error: error.message });
      });
    });
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.config.port, this.config.listenHost, resolve);
      });
    } catch (error) {
      this.server = null;
      this.homeLock.release();
      this.stopped = true;
      throw error;
    }
    this.producerTimer = setInterval(() => this.producerTick(), 100);
    this.syncTimer = setInterval(
      () => this.runBackground(() => this.synchronize()),
      this.config.syncIntervalMs,
    );
    if (
      this.storage.recovery.malformedMempool
      || this.storage.recovery.discardedMempoolEntries > 0
      || this.storage.recovery.discardedCommittedVoteLocks > 0
    ) {
      this.log("recovered volatile state", JSON.stringify(this.storage.recovery));
    }
    this.log("listening", `${localNodeUrl(this.config)} advertised=${advertisedNodeUrl(this.config)} chain=${this.genesis.chainId}`);
    return this;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      clearInterval(this.producerTimer);
      clearInterval(this.syncTimer);
      if (this.server) {
        await new Promise((resolve) => this.server.close(resolve));
        this.server = null;
      }
      while (this.backgroundTasks.size > 0) {
        await Promise.allSettled([...this.backgroundTasks]);
      }
      this.homeLock.release();
      this.stopped = true;
      this.stopping = false;
    })();
    return this.stopPromise;
  }
}
