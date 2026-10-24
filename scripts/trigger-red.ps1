<#
.SYNOPSIS
    Demo backup: trigger a RED alert for the demo mother, or reset her (Requirement 40.6).

.DESCRIPTION
    Logs in to the Maatriva backend (default doctor1 / demo1234), then calls
    POST /api/demo/trigger-red, or POST /api/demo/reset with -Reset, and prints the result.

    The backend must run with MAATRIVA_DEMO=1 (start.ps1 does this); otherwise the demo
    endpoints answer 404. All data is synthetic.

    Works on Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER BaseUrl
    Backend base URL. Default: http://127.0.0.1:8000

.PARAMETER Username
    Doctor or admin username. Default: doctor1

.PARAMETER Password
    Password for -Username. Default: demo1234 (synthetic demo credentials).

.PARAMETER Reset
    Call /api/demo/reset instead of /api/demo/trigger-red.

.EXAMPLE
    .\scripts\trigger-red.ps1

.EXAMPLE
    .\scripts\trigger-red.ps1 -Reset

.EXAMPLE
    .\scripts\trigger-red.ps1 -BaseUrl http://127.0.0.1:8765 -Username admin1
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8000',
    [string]$Username = 'doctor1',
    [string]$Password = 'demo1234',
    [switch]$Reset
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$BaseUrl = $BaseUrl.TrimEnd('/')
$TimeoutSec = 20

function Get-HttpErrorInfo {
    <# Returns @{ Status = <int or $null>; Code = <string>; Message = <string> } for an
       Invoke-RestMethod failure on PowerShell 5.1 (WebException) and 7+ (HttpResponseException). #>
    param([System.Management.Automation.ErrorRecord]$Err)

    $status = $null
    $response = $null
    if ($Err.Exception.PSObject.Properties['Response']) {
        $response = $Err.Exception.Response
    }
    if ($null -ne $response) {
        try { $status = [int]$response.StatusCode } catch { $status = $null }
    }

    $code = $null
    $message = $null
    $raw = $null
    if ($null -ne $Err.ErrorDetails -and $Err.ErrorDetails.Message) {
        $raw = $Err.ErrorDetails.Message
    }
    if ($raw) {
        try {
            $body = $raw | ConvertFrom-Json
            if ($body.PSObject.Properties['detail']) {
                $detail = $body.detail
                if ($detail -is [string]) {
                    $message = $detail
                } elseif ($null -ne $detail -and $detail.PSObject.Properties['code']) {
                    $code = [string]$detail.code
                    $message = [string]$detail.message
                } else {
                    $message = ($detail | ConvertTo-Json -Compress -Depth 5)
                }
            }
        } catch {
            $message = $raw
        }
    }
    if (-not $message) { $message = $Err.Exception.Message }
    return @{ Status = $status; Code = $code; Message = $message }
}

function Invoke-Api {
    param(
        [string]$Path,
        [hashtable]$Body,
        [string]$Token
    )
    $params = @{
        Uri         = "$BaseUrl$Path"
        Method      = 'Post'
        ContentType = 'application/json'
        TimeoutSec  = $TimeoutSec
    }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Compress) }
    if ($Token) { $params.Headers = @{ Authorization = "Bearer $Token" } }
    return Invoke-RestMethod @params
}

function Stop-WithError {
    param([string]$Text)
    Write-Host "ERROR: $Text" -ForegroundColor Red
    exit 1
}

function Write-UnreachableAndExit {
    param([hashtable]$Info)
    Stop-WithError ("Cannot reach the backend at $BaseUrl ($($Info.Message)).`n" +
        "       Is it running? Start it with .\start.ps1, or check -BaseUrl.")
}

# ---------------------------------------------------------------- login
try {
    $login = Invoke-Api -Path '/api/auth/login' -Body @{ username = $Username; password = $Password }
} catch {
    $info = Get-HttpErrorInfo $_
    if ($null -eq $info.Status) { Write-UnreachableAndExit $info }
    if ($info.Status -eq 401) {
        Stop-WithError "Login failed for '$Username': wrong username or password."
    }
    if ($info.Status -eq 404) {
        Stop-WithError "$BaseUrl/api/auth/login returned 404. Is -BaseUrl pointing at the Maatriva backend?"
    }
    Stop-WithError "Login failed (HTTP $($info.Status) $($info.Code)): $($info.Message)"
}
$token = $login.access_token
if (-not $token) { Stop-WithError "Login response from $BaseUrl had no access token." }
Write-Host "Logged in as $Username ($($login.user.role))."

# ---------------------------------------------------------------- demo call
if ($Reset) { $path = '/api/demo/reset'; $label = 'Reset demo mother' }
else        { $path = '/api/demo/trigger-red'; $label = 'Trigger RED' }

try {
    $result = Invoke-Api -Path $path -Token $token
} catch {
    $info = Get-HttpErrorInfo $_
    if ($null -eq $info.Status) { Write-UnreachableAndExit $info }
    switch ($info.Status) {
        404 {
            Stop-WithError ("$path returned 404. Demo mode is off, or the demo mother is not in " +
                "${Username}'s facility.`n       Restart the backend with MAATRIVA_DEMO=1 " +
                "(start.ps1 does this) and seed it: python -m app.seed --reset")
        }
        403 { Stop-WithError "$path is for doctor or admin users only; '$Username' is not allowed." }
        401 { Stop-WithError "The backend rejected the login token (HTTP 401). Try again." }
        409 {
            if ($info.Code -eq 'MOTHER_INACTIVE') {
                Stop-WithError "The demo mother is marked delivered. Run: .\scripts\trigger-red.ps1 -Reset"
            }
            Stop-WithError "$label failed (HTTP 409 $($info.Code)): $($info.Message)"
        }
        default { Stop-WithError "$label failed (HTTP $($info.Status) $($info.Code)): $($info.Message)" }
    }
}

# ---------------------------------------------------------------- result
$color = 'Green'
if ($result.risk_level -eq 'RED') { $color = 'Red' }
elseif ($result.risk_level -eq 'AMBER') { $color = 'Yellow' }

Write-Host "$label OK." -ForegroundColor Green
Write-Host "  mother_id : $($result.mother_id)"
if (-not $Reset) {
    $alertId = $result.alert_id
    if (-not $alertId) { $alertId = '(none)' }
    Write-Host "  alert_id  : $alertId"
}
Write-Host "  risk_level: $($result.risk_level)" -ForegroundColor $color
exit 0
