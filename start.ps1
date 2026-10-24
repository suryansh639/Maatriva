<#
.SYNOPSIS
  One-command Windows startup for the Maatriva MVP (Requirement 41).

.DESCRIPTION
  1. Resolves Python: `py -3.10` when available, else `python`; aborts below 3.10.
  2. Creates backend\.venv when missing.
  3. Installs `pip install -r requirements.txt -c requirements.lock` when the
     SHA-256 of requirements.txt + requirements.lock differs from
     backend\.venv\.req-hash, then records the hash.
  4. Seeds the database: `python -m app.seed --if-empty` (or `--reset` with -Reset).
  5. Runs `npm ci` in web when node_modules is missing (`npm install` without a lockfile).
  6. Opens a new window for uvicorn on 127.0.0.1:8000 with MAATRIVA_DEMO=1, and
     another for the Vite dev server on 5173. -Lan passes `--host` to Vite only;
     the backend always stays on 127.0.0.1 (the browser reaches it via the Vite proxy).
  7. Prints the URLs and demo credentials.

  Stop the servers with Ctrl+C in (or by closing) their windows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start.ps1 -Lan
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start.ps1 -Reset
#>
[CmdletBinding()]
param(
    # Expose the Vite dev server on the LAN (`vite --host`). The backend stays on 127.0.0.1.
    [switch]$Lan,
    # Drop and reseed the database (`python -m app.seed --reset`) instead of `--if-empty`.
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest progress bars garble the console
Set-StrictMode -Version 2.0

$RepoRoot   = $PSScriptRoot
$BackendDir = Join-Path $RepoRoot 'backend'
$WebDir     = Join-Path $RepoRoot 'web'
$VenvDir    = Join-Path $BackendDir '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$HashFile   = Join-Path $VenvDir '.req-hash'
$ReqFile    = Join-Path $BackendDir 'requirements.txt'
$LockFile   = Join-Path $BackendDir 'requirements.lock'
$BackendPort = 8000
$WebPort     = 5173

# npm lifecycle scripts spawn cmd.exe through %ComSpec%; some shells lose it.
if (-not $env:ComSpec) {
    $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe'
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-WithError([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# Runs a native command and aborts the script when it exits non-zero.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$What) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "$What failed (exit code $LASTEXITCODE)."
    }
}

# Returns "major.minor" for a Python command, or $null when it cannot run.
function Get-PythonVersion([string]$Exe, [string[]]$PrefixArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @PrefixArgs -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
        return ([string]($out | Select-Object -First 1)).Trim()
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $old
    }
}

# Req 41.1-41.2: `py -3.10` when available, otherwise `python`; abort below 3.10.
function Resolve-Python {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $v = Get-PythonVersion 'py' @('-3.10')
        if ($v) { return @{ Exe = 'py'; Args = @('-3.10'); Version = $v } }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        Stop-WithError 'Python 3.10+ not found. Install Python 3.10 (python.org) and re-run.'
    }
    $v = Get-PythonVersion $python.Source @()
    if (-not $v) {
        Stop-WithError "Could not run '$($python.Source)'. Install Python 3.10+ and re-run."
    }
    return @{ Exe = $python.Source; Args = @(); Version = $v }
}

function Test-PythonVersionOk([string]$Version) {
    try { return ([version]$Version) -ge ([version]'3.10') } catch { return $false }
}

# Req 41.4: SHA-256 over requirements.txt followed by requirements.lock.
function Get-RequirementsHash {
    $bytes = New-Object System.Collections.Generic.List[byte]
    foreach ($f in @($ReqFile, $LockFile)) {
        if (Test-Path -LiteralPath $f) {
            $bytes.AddRange([System.IO.File]::ReadAllBytes($f))
        }
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes.ToArray()))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-PortInUse([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(300) -and $client.Connected) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# Opens a new console window running $Command in $WorkingDir. -EncodedCommand
# avoids quoting problems with paths that contain spaces or quotes.
function Start-ServerWindow([string]$Title, [string]$WorkingDir, [string]$Command) {
    $script = "`$host.UI.RawUI.WindowTitle = '$($Title -replace "'", "''")'`r`n$Command"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
    $shell = (Get-Process -Id $PID).Path
    return Start-Process -FilePath $shell -WorkingDirectory $WorkingDir -PassThru `
        -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

function Quote-Ps([string]$Value) {
    return "'" + ($Value -replace "'", "''") + "'"
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
foreach ($p in @($BackendPort, $WebPort)) {
    if (Test-PortInUse $p) {
        Stop-WithError "Port $p is already in use on 127.0.0.1. Stop the running server (close its window) and re-run."
    }
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Stop-WithError 'npm not found. Install Node.js (LTS) and re-run.'
}

# ---------------------------------------------------------------------------
# Backend: Python, venv, pinned requirements, seed
# ---------------------------------------------------------------------------
Write-Step 'Resolving Python'
$py = Resolve-Python
if (-not (Test-PythonVersionOk $py.Version)) {
    Stop-WithError "Python $($py.Version) found at '$($py.Exe)', but 3.10 or newer is required."
}
Write-Host "    Using $($py.Exe) $($py.Args -join ' ') (Python $($py.Version))"

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Step 'Creating backend\.venv'
    Invoke-Native $py.Exe (@($py.Args) + @('-m', 'venv', $VenvDir)) 'Creating the virtual environment'
}

$reqHash = Get-RequirementsHash
$oldHash = if (Test-Path -LiteralPath $HashFile) { (Get-Content -LiteralPath $HashFile -Raw).Trim() } else { '' }
if ($reqHash -ne $oldHash) {
    Write-Step 'Installing pinned backend requirements'
    $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', $ReqFile)
    if (Test-Path -LiteralPath $LockFile) { $pipArgs += @('-c', $LockFile) }
    Invoke-Native $VenvPython $pipArgs 'pip install'
    Set-Content -LiteralPath $HashFile -Value $reqHash -Encoding Ascii
} else {
    Write-Step 'Backend requirements up to date'
}

Write-Step ($(if ($Reset) { 'Reseeding the database (--reset)' } else { 'Seeding the database if empty' }))
Push-Location $BackendDir
try {
    $seedFlag = if ($Reset) { '--reset' } else { '--if-empty' }
    Invoke-Native $VenvPython @('-m', 'app.seed', $seedFlag) 'Seeding'
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# Web: node_modules
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $WebDir 'node_modules'))) {
    Push-Location $WebDir
    try {
        if (Test-Path -LiteralPath (Join-Path $WebDir 'package-lock.json')) {
            Write-Step 'Installing web dependencies (npm ci)'
            Invoke-Native 'npm.cmd' @('ci') 'npm ci'
        } else {
            Write-Step 'Installing web dependencies (npm install)'
            Invoke-Native 'npm.cmd' @('install') 'npm install'
        }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Start servers in new windows
# ---------------------------------------------------------------------------
Write-Step "Starting backend on http://127.0.0.1:$BackendPort (new window)"
$backendCmd = @"
`$env:MAATRIVA_DEMO = '1'
& $(Quote-Ps $VenvPython) -m uvicorn app.main:app --host 127.0.0.1 --port $BackendPort
"@
$backendProc = Start-ServerWindow 'Maatriva backend :8000' $BackendDir $backendCmd

Write-Step "Starting web dev server on port $WebPort (new window)"
$viteArgs = if ($Lan) { 'run dev -- --host' } else { 'run dev' }
$webCmd = @"
if (-not `$env:ComSpec) { `$env:ComSpec = Join-Path `$env:SystemRoot 'System32\cmd.exe' }
& npm.cmd $viteArgs
"@
$webProc = Start-ServerWindow 'Maatriva web :5173' $WebDir $webCmd

# Best-effort readiness check so the URLs below are usable when printed.
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$BackendPort/api/health"
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    if ($backendProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $healthy) {
    Write-Host 'WARNING: backend did not answer /api/health yet - check the backend window.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$base = "http://127.0.0.1:$WebPort"
Write-Host ''
Write-Host 'Maatriva is starting.  Synthetic data only - no real personal data.' -ForegroundColor Green
Write-Host ''
Write-Host "  Field app (ASHA):   $base/field"
Write-Host "  Doctor dashboard:   $base/doctor"
Write-Host "  Login:              $base/login"
Write-Host "  API (direct):       http://127.0.0.1:$BackendPort/api/health   docs: http://127.0.0.1:$BackendPort/docs"
if ($Lan) {
    $ips = @()
    try {
        $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.ToString().StartsWith('127.') } |
            ForEach-Object { $_.ToString() }
    } catch { }
    foreach ($ip in $ips) { Write-Host "  LAN:                http://${ip}:$WebPort/field" }
    Write-Host '  Note: plain-HTTP LAN origins disable Web Bluetooth, the service worker,' -ForegroundColor Yellow
    Write-Host '        Web Locks and crypto.randomUUID. Use the Simulated scale there.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  Demo credentials (password for all: demo1234)'
Write-Host '    doctor1   PHC Medical Officer   -> /doctor'
Write-Host '    anm1      ANM (read-only)       -> /doctor'
Write-Host '    asha1     ASHA Dankaur, Dadri   -> /field'
Write-Host '    asha2     ASHA Bil Akbarpur, Jhajhar'
Write-Host '    asha3     ASHA Rabupura, Jewar'
Write-Host '    admin1    Admin (demo endpoints only)'
Write-Host ''
Write-Host "  Backend window PID $($backendProc.Id), web window PID $($webProc.Id)."
Write-Host '  Stop the servers with Ctrl+C in their windows (or close the windows).'
