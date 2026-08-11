import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const script = resolve("scripts/run-secure-prompt.ps1");
const cliScript = resolve("scripts/run-secure-cli.ps1");

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

test("secure CLI prompt forwards an argument array without shell evaluation", {
  skip: process.platform !== "win32",
}, () => {
  const source = readFileSync(cliScript, "utf8");
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(
    manifest.scripts["nova:cli:prompt"],
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-secure-cli.ps1",
  );
  assert.match(source, /ValueFromRemainingArguments/);
  assert.match(source, /@ForwardedArguments/);
  assert.doesNotMatch(source, /Invoke-Expression|Start-Process/);
  assert.doesNotMatch(source, /Write-(Host|Output).*Password/i);

  const missingArguments = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    cliScript,
  ], { encoding: "utf8" });
  assert.equal(missingArguments.status, 1);
  assert.match(`${missingArguments.stdout}\n${missingArguments.stderr}`, /Provide a NOVA CLI command after --/);
  assert.doesNotMatch(missingArguments.stdout, /Enter the NOVA password/);

  const escapedScript = cliScript.replaceAll("'", "''");
  const command = `
    . '${escapedScript}'
    $testSecret = ConvertTo-SecureString 'test-only-password' -AsPlainText -Force
    $helpOutput = Invoke-NovaSecureCli -Password $testSecret -Arguments @('help') | Out-String
    if ($helpOutput -notmatch 'NOVA chain CLI') { throw 'real CLI help command was not forwarded' }
    if ($script:novaSecureCliExitCode -ne 0) { throw 'real CLI exit code was not retained' }
    if (Test-Path Env:NOVA_KEY_PASSWORD) { throw 'password remained after real CLI action' }

    $script:capturedArguments = @()
    Invoke-NovaSecureCli -Password $testSecret -Arguments @('record', 'create', '--file', 'path with space', '--note', 'value;not-a-command') -CommandAction {
      param([string[]]$ForwardedArguments)
      if ($env:NOVA_KEY_PASSWORD -ne 'test-only-password') { throw 'command could not read password' }
      $script:capturedArguments = $ForwardedArguments
      $script:novaSecureCliExitCode = 23
    }
    $expected = @('record', 'create', '--file', 'path with space', '--note', 'value;not-a-command')
    if ((Compare-Object $expected $script:capturedArguments -SyncWindow 0).Count -ne 0) { throw 'arguments changed during forwarding' }
    if ($script:novaSecureCliExitCode -ne 23) { throw 'child exit code was not retained' }
    if (Test-Path Env:NOVA_KEY_PASSWORD) { throw 'password remained after CLI action' }
    $testSecret.Dispose()
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
