import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const script = resolve("scripts/run-secure-prompt.ps1");

test("secure prompt launcher declares masked input and explicit cleanup", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /Read-Host .* -AsSecureString/);
  assert.match(source, /SecureStringToBSTR/);
  assert.match(source, /ZeroFreeBSTR/);
  assert.match(source, /Remove-Item Env:NOVA_KEY_PASSWORD/);
  assert.match(source, /\.Dispose\(\)/);
  assert.doesNotMatch(source, /Write-(Host|Output).*Password/i);
});

test("secure prompt exposes the secret only during its action and rejects short values", {
  skip: process.platform !== "win32",
}, () => {
  const escapedScript = script.replaceAll("'", "''");
  const command = `
    . '${escapedScript}'
    $testSecret = ConvertTo-SecureString 'test-only-password' -AsPlainText -Force
    $script:observed = $false
    Invoke-WithNovaPassword -Password $testSecret -Action {
      if ($env:NOVA_KEY_PASSWORD -ne 'test-only-password') { throw 'action could not read password' }
      $script:observed = $true
    }
    if (-not $script:observed) { throw 'test action did not run' }
    if (Test-Path Env:NOVA_KEY_PASSWORD) { throw 'password remained after successful action' }

    try {
      Invoke-WithNovaPassword -Password $testSecret -Action { throw 'expected action failure' }
      throw 'failing action unexpectedly succeeded'
    } catch {
      if ($_.Exception.Message -ne 'expected action failure') { throw }
    }
    if (Test-Path Env:NOVA_KEY_PASSWORD) { throw 'password remained after failed action' }

    $shortSecret = ConvertTo-SecureString 'short' -AsPlainText -Force
    try {
      Invoke-WithNovaPassword -Password $shortSecret -Action { throw 'short password action ran' }
      throw 'short password was accepted'
    } catch {
      if ($_.Exception.Message -notmatch 'at least 12 characters') { throw }
    }
    if (Test-Path Env:NOVA_KEY_PASSWORD) { throw 'password remained after rejected action' }
    $testSecret.Dispose()
    $shortSecret.Dispose()
  `;
  const environment = { ...process.env };
  delete environment.NOVA_KEY_PASSWORD;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
});
