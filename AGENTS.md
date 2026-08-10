# NOVA contributor guide

NOVA is a long-lived personal blockchain project. Treat the repository as a product, not a disposable demo.

## Product direction

- The owner is learning blockchain development. Explain consequential choices in plain Chinese.
- Optimize for a chain the owner can operate independently: reproducible startup, observable state, safe defaults, and documented recovery.
- `docs/PRODUCT.md` is the living product brief. Record newly confirmed requirements there.
- Record architecture choices that are expensive to reverse as ADRs under `docs/adr/`.

## Engineering invariants

- Consensus and state transitions must be deterministic. Never use floating point for token amounts.
- Persisted or signed formats are protocol surfaces. Version them and add compatibility tests before changing them.
- Private keys must never be committed. Runtime data belongs under `.nova/`, which is gitignored.
- The private-network path must keep validator and faucet keys encrypted. Plaintext keys are allowed only in explicitly labeled devnet/test fixtures.
- Any writer or restore operation for a node home must respect `NodeHomeLock`; derived state must remain rebuildable from the signed chain log.
- Graceful node stop must reject new background work, close HTTP, drain tracked writers, and release `NodeHomeLock` last. A stopped node instance must never be reused to write its former home.
- Startup may discard invalid non-final mempool data after replaying the signed chain, but must fail closed on an invalid next-height persisted vote lock; only locks already covered by the committed chain may be pruned automatically.
- Network-level backups must verify every configured validator home and a shared chain prefix before selecting the highest valid source.
- Record transactions may commit hashes and explicitly public metadata, never local file contents or local paths. Preserve historical transfer signing payloads and state roots when adding transaction types.
- Validator write requests must retain `ed25519-v1` authentication over the exact method, target, and body bytes, with chain/domain separation, clock-window checks, and replay rejection. Do not present this as TLS confidentiality.
- A proposer must verify at least `quorum - 1` distinct non-self peer votes before writing its own vote lock. Historical proposal recovery requires a valid vote proof bound to the authenticated sender, and must never unlock or replace a conflicting local vote.
- Distributed topology files must remain secret-free and require private transport. Validator bundles may contain exactly one encrypted validator identity, must not be cloned to multiple devices, and are never a substitute for a live-chain backup.
- Remote status decisions must verify a fresh challenge-bound `nova-signed-status` response against the expected genesis validator. Remote backups require quorum complete chains, signed-head agreement, full replay verification, and a shared chain prefix before selecting a source.
- Validate untrusted network input before mutating state.
- Do not describe the prototype consensus as production-grade BFT. Its limits are documented in ADR 0001.
- Run `npm test` after protocol or state changes. Add an end-to-end test for behavior crossing node boundaries.

## Current stack

- Node.js 22+, ECMAScript modules, and built-in APIs only.
- No runtime dependencies in the current prototype. This keeps the devnet auditable and runnable on the owner's current machine.
- Source lives in `src/`; executable workflows live in `scripts/`; tests live in `test/`.
