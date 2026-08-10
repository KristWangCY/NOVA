import { hashObject } from "./canonical.js";
import { parseAmount, validateTransactionBasic } from "./transaction.js";

export function createGenesisState(genesis) {
  const balances = {};
  let totalSupply = 0n;
  for (const [address, value] of Object.entries(genesis.allocations ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const amount = parseAmount(value, `genesis allocation for ${address}`, { allowZero: true });
    balances[address] = amount.toString();
    totalSupply += amount;
  }
  return {
    version: 1,
    height: 0,
    balances,
    nonces: {},
    totalSupply: totalSupply.toString(),
    burnedFees: "0",
  };
}

export function cloneState(state) {
  return structuredClone(state);
}

export function stateRoot(state) {
  return hashObject(state);
}

export function applyTransaction(state, transaction, chainId) {
  validateTransactionBasic(transaction, chainId);
  const currentNonce = state.nonces[transaction.from] ?? 0;
  if (transaction.nonce !== currentNonce + 1) {
    throw new Error(`invalid nonce: expected ${currentNonce + 1}, received ${transaction.nonce}`);
  }

  const fee = parseAmount(transaction.fee, "fee", { allowZero: transaction.type === "transfer" });
  const senderBalance = BigInt(state.balances[transaction.from] ?? "0");
  const amount = transaction.type === "transfer" ? parseAmount(transaction.amount, "amount") : 0n;
  const total = amount + fee;
  if (senderBalance < total) {
    throw new Error("insufficient balance");
  }

  state.balances[transaction.from] = (senderBalance - total).toString();
  if (transaction.type === "transfer") {
    state.balances[transaction.to] = (BigInt(state.balances[transaction.to] ?? "0") + amount).toString();
  }
  state.nonces[transaction.from] = transaction.nonce;
  state.burnedFees = (BigInt(state.burnedFees) + fee).toString();
  state.totalSupply = (BigInt(state.totalSupply) - fee).toString();
  return state;
}

export function executeTransactions(baseState, transactions, chainId, height) {
  const nextState = cloneState(baseState);
  for (const transaction of transactions) {
    applyTransaction(nextState, transaction, chainId);
  }
  nextState.height = height;
  return nextState;
}
