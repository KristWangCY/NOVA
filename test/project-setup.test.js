import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

test("project setup is reproducible and does not link the parent package into Explorer", () => {
  const rootPackage = readJson("package.json");
  const rootLock = readJson("package-lock.json");
  const explorerPackage = readJson("explorer/package.json");
  const explorerLock = readJson("explorer/package-lock.json");

  assert.equal(rootPackage.scripts.setup, "npm --prefix explorer ci");
  assert.equal(rootPackage.version, rootLock.version);
  assert.equal(rootPackage.version, rootLock.packages[""].version);
  assert.equal(explorerPackage.version, explorerLock.version);
  assert.equal(explorerPackage.version, explorerLock.packages[""].version);
  assert.equal(explorerPackage.dependencies["nova-chain"], undefined);
  assert.equal(explorerLock.packages[""].dependencies["nova-chain"], undefined);
  assert.equal(explorerLock.packages[".."], undefined);
  assert.equal(explorerLock.packages["node_modules/nova-chain"], undefined);
});
