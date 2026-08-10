import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isEncryptedKeystore } from "../src/core/keystore.js";
import { initializeDevnet } from "../src/runtime/bootstrap.js";
import { atomicWriteJson, readJson } from "../src/runtime/files.js";

const cli = resolve("src/cli.js");

test("CLI refuses plaintext-by-default account creation without a password", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-cli-password-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = resolve(root, "alice.json");
  const env = { ...process.env };
  delete env.NOVA_KEY_PASSWORD;
  const result = spawnSync(process.execPath, [cli, "account", "create", "--out", output], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOVA_KEY_PASSWORD/);
});

test("CLI creates and inspects an encrypted account keystore", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-cli-keystore-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = resolve(root, "alice.json");
  const env = { ...process.env, NOVA_KEY_PASSWORD: "a test-only password with enough length" };
  const created = spawnSync(
    process.execPath,
    [cli, "account", "create", "--out", output, "--label", "alice"],
    { env, encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const stored = readJson(output);
  assert.equal(isEncryptedKeystore(stored), true);
  assert.equal(Object.hasOwn(stored, "privateKey"), false);

  const inspected = spawnSync(process.execPath, [cli, "account", "inspect", "--key", output], {
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const metadata = JSON.parse(inspected.stdout);
  assert.equal(metadata.address, stored.address);
  assert.equal(metadata.encrypted, true);
  assert.equal(metadata.label, "alice");
});

test("CLI initializes a complete encrypted private network without plaintext keys", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-cli-network-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = resolve(root, "private");
  const missingPassword = spawnSync(
    process.execPath,
    [cli, "network", "init", "--dir", network, "--base-port", "48101"],
    { env: { ...process.env, NOVA_KEY_PASSWORD: "" }, encoding: "utf8" },
  );
  assert.equal(missingPassword.status, 1);
  assert.match(missingPassword.stderr, /NOVA_KEY_PASSWORD/);
  assert.equal(existsSync(network), false, "failed initialization must not leave a partial network");

  const env = { ...process.env, NOVA_KEY_PASSWORD: "a private-network test password" };
  const created = spawnSync(
    process.execPath,
    [cli, "network", "init", "--dir", network, "--base-port", "48101"],
    { env, encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Initialized secure nova-private-1 with 3 validators/);
  assert.equal(isEncryptedKeystore(readJson(resolve(network, "faucet-key.json"))), true);
  for (let index = 1; index <= 3; index += 1) {
    const home = resolve(network, `node${index}`);
    assert.equal(isEncryptedKeystore(readJson(resolve(home, "node-key.json"))), true);
    assert.equal(readJson(resolve(home, "config.json")).keyPasswordEnv, "NOVA_KEY_PASSWORD");
  }

  const diagnosed = spawnSync(
    process.execPath,
    [cli, "doctor", "--network", network, "--offline", "--json"],
    { env, encoding: "utf8" },
  );
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const report = JSON.parse(diagnosed.stdout);
  assert.equal(report.healthy, true);
  assert.equal(report.chainId, "nova-private-1");
  assert.equal(report.nodes.length, 3);
  assert.ok(report.nodes.every(({ valid, keyEncrypted }) => valid && keyEncrypted));
});

test("CLI creates, verifies, and restores a private-key-free chain backup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-cli-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = initializeDevnet({ directory: resolve(root, "network"), basePort: 48001 });
  const output = resolve(root, "backups", "chain.json");

  const created = spawnSync(
    process.execPath,
    [cli, "backup", "create", "--home", network.nodes[0].home, "--out", output],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).valid, true);

  const verified = spawnSync(process.execPath, [cli, "backup", "verify", "--file", output], {
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).chainId, network.genesis.chainId);

  const restored = spawnSync(
    process.execPath,
    [cli, "backup", "restore", "--home", network.nodes[0].home, "--file", output],
    { encoding: "utf8" },
  );
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).height, 0);

  const networkOutput = resolve(root, "backups", "network.json");
  const networkBackup = spawnSync(
    process.execPath,
    [cli, "backup", "create", "--network", network.directory, "--out", networkOutput],
    { encoding: "utf8" },
  );
  assert.equal(networkBackup.status, 0, networkBackup.stderr);
  const networkResult = JSON.parse(networkBackup.stdout);
  assert.equal(networkResult.sourceNode, "node1");
  assert.equal(networkResult.observedValidators, 3);
  assert.equal(networkResult.height, 0);
});

test("CLI creates a public topology and isolated validator bundle", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nova-cli-topology-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topologyFile = resolve(root, "topology.json");
  const template = spawnSync(
    process.execPath,
    [cli, "network", "template", "--out", topologyFile],
    { encoding: "utf8" },
  );
  assert.equal(template.status, 0, template.stderr);
  assert.equal(readJson(topologyFile).transport, "private-network-required");
  const duplicateTemplate = spawnSync(
    process.execPath,
    [cli, "network", "template", "--out", topologyFile],
    { encoding: "utf8" },
  );
  assert.equal(duplicateTemplate.status, 1);
  assert.match(duplicateTemplate.stderr, /refusing to overwrite/);

  const basePort = 45000 + Math.floor(Math.random() * 1000);
  const topology = readJson(topologyFile);
  topology.chainId = "nova-cli-topology-1";
  topology.validators = topology.validators.map((validator, index) => ({
    ...validator,
    url: `http://127.0.0.1:${basePort + index}`,
    listenHost: "127.0.0.1",
    port: basePort + index,
    passwordEnv: `NOVA_CLI_NODE${index + 1}_PASSWORD`,
  }));
  topology.faucetPasswordEnv = "NOVA_CLI_FAUCET_PASSWORD";
  atomicWriteJson(topologyFile, topology);
  const network = resolve(root, "network");
  const passwords = {
    NOVA_CLI_FAUCET_PASSWORD: "cli topology faucet password",
    NOVA_CLI_NODE1_PASSWORD: "cli topology node one password",
    NOVA_CLI_NODE2_PASSWORD: "cli topology node two password",
    NOVA_CLI_NODE3_PASSWORD: "cli topology node three password",
  };
  const missingPassword = spawnSync(
    process.execPath,
    [cli, "network", "init", "--dir", network, "--topology", topologyFile],
    { env: { ...process.env, ...passwords, NOVA_CLI_NODE3_PASSWORD: "" }, encoding: "utf8" },
  );
  assert.equal(missingPassword.status, 1);
  assert.match(missingPassword.stderr, /NOVA_CLI_NODE3_PASSWORD/);
  assert.equal(existsSync(network), false);

  const initialized = spawnSync(
    process.execPath,
    [cli, "network", "init", "--dir", network, "--topology", topologyFile],
    { env: { ...process.env, ...passwords }, encoding: "utf8" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /distributed-ready nova-cli-topology-1/);
  assert.equal(readJson(resolve(network, "node1", "config.json")).version, 2);

  const bundleFile = resolve(root, "node1-bundle.json");
  const bundled = spawnSync(
    process.execPath,
    [cli, "bundle", "create", "--network", network, "--node", "node1", "--out", bundleFile],
    { encoding: "utf8" },
  );
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.equal(JSON.parse(bundled.stdout).node, "node1");
  const verified = spawnSync(
    process.execPath,
    [cli, "bundle", "verify", "--file", bundleFile],
    { encoding: "utf8" },
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const installedHome = resolve(root, "device", "node1");
  const installed = spawnSync(
    process.execPath,
    [cli, "bundle", "install", "--file", bundleFile, "--home", installedHome],
    { encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(isEncryptedKeystore(readJson(resolve(installedHome, "node-key.json"))), true);
});
