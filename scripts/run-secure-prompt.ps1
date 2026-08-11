$ErrorActionPreference = "Stop"

function Invoke-WithNovaPassword {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [Security.SecureString]$Password,

    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  [IntPtr]$novaPasswordPointer = [IntPtr]::Zero
  $novaPlainPassword = $null
  try {
    $novaPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    $novaPlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($novaPasswordPointer)
    if ([string]::IsNullOrEmpty($novaPlainPassword) -or $novaPlainPassword.Length -lt 12) {
      throw "NOVA password must contain at least 12 characters."
    }
    $env:NOVA_KEY_PASSWORD = $novaPlainPassword
    $novaPlainPassword = $null
    & $Action
  } finally {
    $novaPlainPassword = $null
    Remove-Item Env:NOVA_KEY_PASSWORD -ErrorAction SilentlyContinue
    if ($novaPasswordPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($novaPasswordPointer)
    }
  }
}

if ($MyInvocation.InvocationName -ne ".") {
  $novaPassword = Read-Host "Create or enter the NOVA password" -AsSecureString
  $novaRepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $script:novaChildExitCode = 0
  try {
    Push-Location $novaRepositoryRoot
    try {
      Invoke-WithNovaPassword -Password $novaPassword -Action {
        & node (Join-Path $PSScriptRoot "run-nova.js") --secure
        $script:novaChildExitCode = $LASTEXITCODE
      }
    } finally {
      Pop-Location
    }
  } finally {
    if ($null -ne $novaPassword) {
      $novaPassword.Dispose()
      $novaPassword = $null
    }
  }
  if ($script:novaChildExitCode -ne 0) {
    exit $script:novaChildExitCode
  }
}
