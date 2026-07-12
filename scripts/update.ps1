[CmdletBinding()]
param(
  [string]$HealthUrl = 'http://127.0.0.1:3001/api/ping',
  [ValidateRange(1, 600)] [int]$HealthTimeoutSeconds = 60,
  [switch]$SkipDocker
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Step {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Name (exit $LASTEXITCODE)"
  }
}

function Get-RemoteHead {
  $remoteHead = git symbolic-ref --short refs/remotes/origin/HEAD 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remoteHead)) {
    throw 'Cannot resolve origin/HEAD. Configure the origin remote default branch before updating.'
  }

  return $remoteHead.Trim()
}

function Wait-ForHealth {
  param(
    [Parameter(Mandatory)] [string]$Url,
    [Parameter(Mandatory)] [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = 'No response received.'

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        Write-Host "Health check passed: $Url"
        return
      }
      $lastError = "HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
  }

  throw "Health check timed out after ${TimeoutSeconds}s: $Url. Last error: $lastError"
}

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$trackedChanges = git status --porcelain
if ($LASTEXITCODE -ne 0) {
  throw 'Cannot inspect Git working-tree state.'
}

$unsafeChanges = @($trackedChanges | Where-Object {
  $_ -and $_.Length -ge 2 -and $_.Substring(0, 2) -ne '??'
})
if ($unsafeChanges.Count -gt 0) {
  throw "Tracked changes detected. Commit or stash them before updating:`n$($unsafeChanges -join "`n")"
}

Invoke-Step 'Fetch upstream' { git fetch origin }
$remoteHead = Get-RemoteHead
Invoke-Step "Fast-forward checkout from $remoteHead" { git merge --ff-only $remoteHead }

Invoke-Step 'Install locked dependencies' { npm ci }
Invoke-Step 'Run tests' { npm test }
Invoke-Step 'Build production artifacts' { npm run build }

if (-not $SkipDocker) {
  Invoke-Step 'Rebuild and restart Docker service' { docker compose up -d --build }
  Wait-ForHealth -Url $HealthUrl -TimeoutSeconds $HealthTimeoutSeconds
} else {
  Write-Host '==> Docker restart skipped (-SkipDocker)'
}

Write-Host 'Update completed.'
