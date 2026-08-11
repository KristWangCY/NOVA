param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NovaArguments
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "run-secure-prompt.ps1")

function Invoke-NovaSecureCli {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [Security.SecureString]$Password,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [scriptblock]$CommandAction
  )

  if ($Arguments.Count -eq 0) {
    throw "Provide a NOVA CLI command after --. Example: npm.cmd run nova:cli:prompt -- record create ..."
  }

  $script:novaSecureCliExitCode = 0
  if ($null -eq $CommandAction) {
    $novaCliPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "src/cli.js"
    $CommandAction = {
      param([string[]]$ForwardedArguments)
      & node $novaCliPath @ForwardedArguments
      $script:novaSecureCliExitCode = $LASTEXITCODE
    }.GetNewClosure()
  }

  Invoke-WithNovaPassword -Password $Password -Action {
    & $CommandAction $Arguments
  }
}

if ($MyInvocation.InvocationName -ne ".") {
  if ($NovaArguments.Count -eq 0) {
    throw "Provide a NOVA CLI command after --. Example: npm.cmd run nova:cli:prompt -- record create ..."
  }

  $novaCommandPassword = Read-Host "Enter the NOVA password" -AsSecureString
  try {
    Invoke-NovaSecureCli -Password $novaCommandPassword -Arguments $NovaArguments
  } finally {
    if ($null -ne $novaCommandPassword) {
      $novaCommandPassword.Dispose()
      $novaCommandPassword = $null
    }
  }

  if ($script:novaSecureCliExitCode -ne 0) {
    exit $script:novaSecureCliExitCode
  }
}
