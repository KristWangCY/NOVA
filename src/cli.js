#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyRecord } from "./core/crypto.js";
import { encryptKeyRecord, isEncryptedKeystore, unlockKeyFile } from "./core/keystore.js";
import { createRecord, createTransfer } from "./core/transaction.js";
import { NovaNode } from "./node.js";
import { createBackup, restoreBackup, verifyBackup, verifyNodeHome } from "./runtime/backup.js";
import { initializeDevnet, initializeNetworkFromTopology } from "./runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "./runtime/files.js";
import { hashFile } from "./runtime/file-hash.js";
import { createNetworkBackup, diagnoseNetwork } from "./runtime/network-inspection.js";
import { localNodeUrl } from "./runtime/node-config.js";
import { createNetworkTopologyTemplate } from "./runtime/topology.js";
import {
  createValidatorBundle,
  installValidatorBundle,
  verifyValidatorBundle,
} from "./runtime/validator-bundle.js";
import { createRemoteNetworkBackup, diagnoseRemoteDeployment } from "./runtime/remote-network.js";

function parseOptions(args) {
  const options = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function required(options, name) {
  if (options[name] === undefined || options[name] === true) {
    throw new Error(`missing required option --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return options[name];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function formatNova(unova, decimals = 6) {
  const value = BigInt(unova);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NOVA`;
}

function passwordFromEnvironment(options, { required: isRequired = false } = {}) {
  const variable = options.passwordEnv || "NOVA_KEY_PASSWORD";
  const password = process.env[variable];
  if (isRequired && !password) {
    throw new Error(`set $env:${variable} to a password of at least 12 characters`);
  }
  return password;
}

function printHelp() {
  console.log(`NOVA chain CLI

Commands:
  nova devnet init [--dir .nova/devnet] [--validators 3] [--base-port 4101]
  nova network init --dir .nova/private [--password-env NOVA_KEY_PASSWORD]
  nova network template --out nova-topology.json
  nova network init --dir .nova/distributed --topology nova-topology.json
  nova bundle create --network .nova/distributed --node node1 --out node1-bundle.json
  nova bundle verify --file node1-bundle.json
  nova bundle install --file node1-bundle.json --home .nova/node1
  nova node start --home .nova/devnet/node1
  nova node verify --home .nova/devnet/node1
  nova doctor [--network .nova/private] [--offline] [--require-online] [--json]
  nova doctor --deployment .nova/distributed [--timeout 1500] [--json]
  nova backup create --home .nova/devnet/node1 --out .nova/backups/nova.json
  nova backup create --network .nova/private --out .nova/backups/nova.json
  nova backup create --deployment .nova/distributed --out .nova/backups/nova.json [--timeout 5000]
  nova backup verify --file .nova/backups/nova.json
  nova backup restore --home .nova/devnet/node1 --file .nova/backups/nova.json
  nova status [--url http://127.0.0.1:4101]
  nova account create --out .nova/alice-keystore.json [--label alice] [--password-env NOVA_KEY_PASSWORD]
  nova account inspect --key .nova/alice-keystore.json
  nova account balance --address nova1... [--url http://127.0.0.1:4101]
  nova tx transfer --key FILE --to nova1... --amount UNOVA [--fee 1] [--memo TEXT] [--url URL]
  nova tx status --id TRANSACTION_ID [--url http://127.0.0.1:4101]
  nova record create --key KEYSTORE --file FILE --title TEXT [--category document] [--note TEXT]
  nova record verify --file FILE [--url http://127.0.0.1:4101] [--json]
  nova record list [--owner nova1...] [--hash SHA256] [--category document] [--limit 20]

Amounts are integer unova. 1 NOVA = 1,000,000 unova.`);
}

function printDiagnosis(report) {
  const label = report.healthy
    ? (report.summary.warnings > 0 ? "HEALTHY WITH WARNINGS" : "HEALTHY")
    : "ATTENTION REQUIRED";
  console.log(`NOVA doctor: ${label}`);
  console.log(`Network: ${report.chainId ?? "unknown"} (${report.directory})`);
  if (report.remote) {
    console.log(`Validators: ${report.onlineValidators}/${report.expectedValidators} authenticated online; quorum ${report.quorum}`);
  } else {
    console.log(`Validators: ${report.nodes.filter(({ valid }) => valid).length}/${report.expectedValidators} valid offline, ${report.onlineValidators}/${report.expectedValidators} online`);
  }
  for (const check of report.checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.message}`);
  }
  if (report.backupSource) {
    console.log(`Recommended backup source: ${report.backupSource.name} at height ${report.backupSource.height}`);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const [group, action] = options._;
  if (!group || group === "help" || options.help) {
    printHelp();
    return;
  }

  if (group === "devnet" && action === "init") {
    const result = initializeDevnet({
      directory: resolve(options.dir || ".nova/devnet"),
      validators: Number(options.validators || 3),
      basePort: Number(options.basePort || 4101),
      blockTimeMs: Number(options.blockTime || 1500),
      chainId: options.chainId || "nova-local-1",
    });
    console.log(`Initialized ${result.genesis.chainId} with ${result.nodes.length} validators`);
    console.log(`Directory: ${result.directory}`);
    console.log(`Faucet:   ${result.faucet.address} (${formatNova(result.faucet.balance)})`);
    console.warn("WARNING: devnet validator and faucet keys are unencrypted test keys.");
    for (const node of result.nodes) {
      console.log(`${node.name}:     ${node.url}  ${node.home}`);
    }
    return;
  }

  if (group === "network" && action === "init") {
    if (options.topology) {
      for (const option of ["validators", "basePort", "blockTime", "chainId", "passwordEnv"]) {
        if (options[option] !== undefined) {
          throw new Error(`--${option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} cannot be combined with --topology`);
        }
      }
      const topologyFile = resolve(required(options, "topology"));
      const result = initializeNetworkFromTopology({
        directory: resolve(options.dir || ".nova/distributed"),
        topology: readJson(topologyFile),
      });
      console.log(`Initialized distributed-ready ${result.genesis.chainId} with ${result.nodes.length} validators`);
      console.log(`Directory:  ${result.directory}`);
      console.log(`Deployment: ${result.deploymentFile}`);
      console.log(`Faucet:     ${result.faucet.address} (${formatNova(result.faucet.balance)})`);
      for (const node of result.nodes) {
        console.log(`${node.name}: ${node.url}  ${node.home}  unlock=$env:${node.passwordEnvironment}`);
      }
      console.warn("REQUIRED: keep every HTTP endpoint inside a private network; request signatures do not encrypt traffic.");
      return;
    }
    const passwordVariable = options.passwordEnv || "NOVA_KEY_PASSWORD";
    const result = initializeDevnet({
      directory: resolve(options.dir || ".nova/private"),
      validators: Number(options.validators || 3),
      basePort: Number(options.basePort || 4101),
      blockTimeMs: Number(options.blockTime || 1500),
      chainId: options.chainId || "nova-private-1",
      encryptKeys: true,
      keyPassword: passwordFromEnvironment(options, { required: true }),
      keyPasswordEnv: passwordVariable,
    });
    console.log(`Initialized secure ${result.genesis.chainId} with ${result.nodes.length} validators`);
    console.log(`Directory: ${result.directory}`);
    console.log(`Faucet:   ${result.faucet.address} (${formatNova(result.faucet.balance)})`);
    console.log(`Keys:     encrypted; unlock variable is $env:${passwordVariable}`);
    for (const node of result.nodes) {
      console.log(`${node.name}:     ${node.url}  ${node.home}`);
    }
    return;
  }

  if (group === "network" && action === "template") {
    const output = resolve(required(options, "out"));
    if (existsSync(output)) throw new Error(`refusing to overwrite existing topology file: ${output}`);
    mkdirSync(dirname(output), { recursive: true });
    atomicWriteJson(output, createNetworkTopologyTemplate());
    console.log(`Created public topology template: ${output}`);
    console.log("Edit the three private-network URLs, then set all four password environment variables before network init.");
    return;
  }

  if (group === "node" && action === "start") {
    const node = await new NovaNode(resolve(required(options, "home"))).start();
    const stop = async () => {
      await node.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  if (group === "bundle" && action === "create") {
    const result = createValidatorBundle(
      resolve(required(options, "network")),
      required(options, "node"),
      resolve(required(options, "out")),
    );
    console.log(JSON.stringify(result, null, 2));
    console.warn("SENSITIVE: this bundle contains one encrypted validator key; transfer it privately and do not install it twice.");
    return;
  }

  if (group === "bundle" && action === "verify") {
    console.log(JSON.stringify(verifyValidatorBundle(readJson(resolve(required(options, "file")))), null, 2));
    return;
  }

  if (group === "bundle" && action === "install") {
    const result = installValidatorBundle(
      resolve(required(options, "file")),
      resolve(required(options, "home")),
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(`Start with: node src/cli.js node start --home ${result.installedTo}`);
    return;
  }

  if (group === "node" && action === "verify") {
    const verification = verifyNodeHome(resolve(required(options, "home")));
    const { state, ...publicResult } = verification;
    console.log(JSON.stringify(publicResult, null, 2));
    return;
  }

  if (group === "doctor") {
    if (options.offline && options.requireOnline) {
      throw new Error("--offline and --require-online cannot be used together");
    }
    const timeoutMs = Number(options.timeout || 750);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
      throw new Error("--timeout must be an integer between 100 and 10000 milliseconds");
    }
    if (options.deployment && (options.network || options.offline || options.requireOnline)) {
      throw new Error("--deployment cannot be combined with --network, --offline, or --require-online");
    }
    const report = options.deployment
      ? await diagnoseRemoteDeployment({ directory: resolve(options.deployment), timeoutMs })
      : await diagnoseNetwork({
        directory: resolve(options.network || ".nova/private"),
        probeOnline: !options.offline,
        requireOnline: Boolean(options.requireOnline),
        timeoutMs,
      });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printDiagnosis(report);
    }
    if (!report.healthy) process.exitCode = 1;
    return;
  }

  if (group === "backup" && action === "create") {
    const sources = [options.home, options.network, options.deployment].filter(Boolean);
    if (sources.length !== 1) {
      throw new Error("choose exactly one of --home, --network, or --deployment when creating a backup");
    }
    const output = resolve(required(options, "out"));
    const result = options.deployment
      ? await createRemoteNetworkBackup({
        directory: resolve(options.deployment),
        output,
        timeoutMs: Number(options.timeout || 5000),
      })
      : options.network
        ? createNetworkBackup(resolve(options.network), output)
        : createBackup(resolve(required(options, "home")), output);
    const { state, ...publicResult } = result;
    console.log(JSON.stringify(publicResult, null, 2));
    return;
  }

  if (group === "backup" && action === "verify") {
    const result = verifyBackup(readJson(resolve(required(options, "file"))));
    const { state, ...publicResult } = result;
    console.log(JSON.stringify(publicResult, null, 2));
    return;
  }

  if (group === "backup" && action === "restore") {
    const home = resolve(required(options, "home"));
    const config = readJson(resolve(home, "config.json"));
    let running = false;
    try {
      const response = await fetch(`${localNodeUrl(config)}/health`, {
        signal: AbortSignal.timeout(400),
      });
      running = response.ok;
    } catch {
      running = false;
    }
    if (running) {
      throw new Error("stop the target node before restoring a backup");
    }
    const result = restoreBackup(home, resolve(required(options, "file")));
    const { state, ...publicResult } = result;
    console.log(JSON.stringify(publicResult, null, 2));
    return;
  }

  if (group === "status") {
    const status = await requestJson(`${options.url || "http://127.0.0.1:4101"}/status`);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (group === "account" && action === "create") {
    const output = resolve(required(options, "out"));
    mkdirSync(dirname(output), { recursive: true });
    const key = generateKeyRecord(options.label || "account");
    const storedKey = options.insecurePlain
      ? key
      : encryptKeyRecord(key, passwordFromEnvironment(options, { required: true }));
    atomicWriteJson(output, storedKey);
    console.log(`Created ${key.address}`);
    console.log(`Key file: ${output} (${options.insecurePlain ? "INSECURE PLAINTEXT" : "encrypted"})`);
    return;
  }

  if (group === "account" && action === "inspect") {
    const storedKey = readJson(resolve(required(options, "key")));
    console.log(JSON.stringify({
      address: storedKey.address,
      publicKey: storedKey.publicKey,
      label: storedKey.label,
      encrypted: isEncryptedKeystore(storedKey),
    }, null, 2));
    return;
  }

  if (group === "account" && action === "balance") {
    const url = options.url || "http://127.0.0.1:4101";
    const account = await requestJson(`${url}/accounts/${encodeURIComponent(required(options, "address"))}`);
    console.log(`${account.address}: ${account.balance} unova (${formatNova(account.balance)}) nonce=${account.nonce} height=${account.height}`);
    return;
  }

  if (group === "tx" && action === "transfer") {
    const url = options.url || "http://127.0.0.1:4101";
    const storedKey = readJson(resolve(required(options, "key")));
    if (!isEncryptedKeystore(storedKey)) {
      console.warn("WARNING: signing with an unencrypted private key; use this only for the local devnet");
    }
    const key = unlockKeyFile(storedKey, passwordFromEnvironment(options));
    const status = await requestJson(`${url}/status`);
    const account = await requestJson(`${url}/accounts/${encodeURIComponent(key.address)}`);
    const transaction = createTransfer({
      chainId: status.chainId,
      key,
      to: required(options, "to"),
      amount: required(options, "amount"),
      fee: options.fee || "1",
      nonce: account.nonce + 1,
      memo: options.memo || "",
    });
    const result = await requestJson(`${url}/transactions`, { method: "POST", body: JSON.stringify(transaction) });
    console.log(`Accepted transaction ${result.transactionId}`);
    console.log(`Status: ${result.status}. Query with: node src/cli.js tx status --id ${result.transactionId}`);
    return;
  }

  if (group === "tx" && action === "status") {
    const url = options.url || "http://127.0.0.1:4101";
    const receipt = await requestJson(`${url}/transactions/${encodeURIComponent(required(options, "id"))}`);
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (group === "record" && action === "create") {
    const url = options.url || "http://127.0.0.1:4101";
    const storedKey = readJson(resolve(required(options, "key")));
    if (!isEncryptedKeystore(storedKey)) {
      console.warn("WARNING: signing with an unencrypted private key; use this only for the local devnet");
    }
    const key = unlockKeyFile(storedKey, passwordFromEnvironment(options));
    const file = await hashFile(resolve(required(options, "file")));
    const status = await requestJson(`${url}/status`);
    const account = await requestJson(`${url}/accounts/${encodeURIComponent(key.address)}`);
    const transaction = createRecord({
      chainId: status.chainId,
      key,
      contentHash: file.contentHash,
      contentSize: file.contentSize,
      title: required(options, "title"),
      category: options.category || "document",
      note: options.note || "",
      fee: options.fee || "1",
      nonce: account.nonce + 1,
    });
    console.warn("NOTICE: title, category, note, file size, and SHA-256 hash become permanent public chain data; the file and local path are not uploaded.");
    const result = await requestJson(`${url}/transactions`, { method: "POST", body: JSON.stringify(transaction) });
    console.log(`Accepted record ${result.transactionId}`);
    console.log(`SHA-256: ${file.contentHash} (${file.contentSize} bytes)`);
    console.log(`Status: ${result.status}. Query with: node src/cli.js tx status --id ${result.transactionId}`);
    return;
  }

  if (group === "record" && action === "verify") {
    const url = options.url || "http://127.0.0.1:4101";
    const file = await hashFile(resolve(required(options, "file")));
    const result = await requestJson(`${url}/records?hash=${encodeURIComponent(file.contentHash)}&limit=100`);
    const records = result.records.filter(
      ({ transaction }) => transaction.contentSize === file.contentSize,
    );
    const verification = {
      verified: records.length > 0,
      file: file.file,
      hashAlgorithm: file.hashAlgorithm,
      contentHash: file.contentHash,
      contentSize: file.contentSize,
      matches: records,
    };
    if (options.json) {
      console.log(JSON.stringify(verification, null, 2));
    } else {
      console.log(`${verification.verified ? "VERIFIED" : "NOT RECORDED"}: ${file.contentHash} (${file.contentSize} bytes)`);
      for (const record of records) {
        console.log(`- ${record.transaction.title} / ${record.transaction.category} / block #${record.height} / ${record.transactionId}`);
      }
    }
    if (!verification.verified) process.exitCode = 2;
    return;
  }

  if (group === "record" && action === "list") {
    const url = options.url || "http://127.0.0.1:4101";
    const parameters = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.owner) parameters.set("owner", options.owner);
    if (options.hash) parameters.set("hash", options.hash);
    if (options.category) parameters.set("category", options.category);
    const result = await requestJson(`${url}/records?${parameters}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.records.length === 0) {
      console.log("No committed records found.");
    } else {
      for (const record of result.records) {
        console.log(`#${record.height} ${record.transaction.title} [${record.transaction.category}] ${record.transaction.contentHash} ${record.transactionId}`);
      }
    }
    return;
  }

  throw new Error(`unknown command: ${argv.join(" ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(`NOVA error: ${error.message}`);
    process.exitCode = 1;
  });
}
