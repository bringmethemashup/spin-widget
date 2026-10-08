<#
  Spin Widget - Skip Click helper (Windows)

  Runs on the CLASS COMPUTER. When the instructor taps "Skip ad" in Teacher view on her phone,
  this makes one real left-click at the spot you calibrated (where YouTube's Skip button shows up),
  then puts the mouse back where it was. It does nothing else, and it only clicks while the class
  app is reporting that an ad is playing.

  First run:   Start-SkipClick.bat   (it asks for the class code, then calibrates)
  Recalibrate: Start-SkipClick.bat -Recalibrate     (do this if the player size/position changes)
  New code:    Start-SkipClick.bat -Code ABC123
#>
param(
  [string]$Code,
  [switch]$Recalibrate
)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$SupaUrl = 'https://txkmwsnvtwobhrdrablw.supabase.co'
$SupaKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4a213c252dHdvYmhyZHJhYmx3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTY0MjQsImV4cCI6MjA5ODY3MjQyNH0.S4gQFyfNUhcUbIh5vBaNEj3VxQONTYcuc9VaSCxN74c'

$cfgDir  = Join-Path $env:APPDATA 'SpinSkip'
$cfgFile = Join-Path $cfgDir 'settings.json'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = $null
if (Test-Path $cfgFile) { try { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { $cfg = $null } }
if (-not $cfg) { $cfg = [pscustomobject]@{ code = ''; x = $null; y = $null } }
function Save-Cfg { $cfg | ConvertTo-Json | Set-Content -Path $cfgFile -Encoding UTF8 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SpinNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Same pixel units for reading and setting the mouse position, whatever the display scaling is.
[void][SpinNative]::SetProcessDPIAware()

# ---- class code ----
if ($Code) { $cfg.code = $Code.Trim().ToUpper(); Save-Cfg }
if (-not $cfg.code) {
  $cfg.code = (Read-Host 'Class code (shown on the class screen next to the QR code)').Trim().ToUpper()
  Save-Cfg
}
if ($cfg.code -notmatch '^[A-Za-z0-9]{4,16}$') {
  Write-Host "That code doesn't look right: $($cfg.code)"; $cfg.code = ''; Save-Cfg
  Read-Host 'Press Enter to close'; exit 1
}
$Code = $cfg.code

# ---- where to click ----
function Get-Mouse {
  $p = New-Object SpinNative+POINT
  [void][SpinNative]::GetCursorPos([ref]$p)
  return $p
}
function Set-Spot {
  Write-Host ''
  Write-Host 'CALIBRATE'
  Write-Host "Put the class screen the way it is during class. When YouTube shows an ad, its Skip button"
  Write-Host 'appears at the bottom right of the video. After the countdown, this records where the mouse'
  Write-Host 'is, so move the mouse onto that spot and leave it there. (If no ad is showing, just point'
  Write-Host 'at where the button would be, bottom right of the video.)'
  Write-Host ''
  Read-Host 'Press Enter to start the countdown' | Out-Null
  for ($i = 8; $i -ge 1; $i--) { Write-Host "  recording in $i ..."; Start-Sleep -Seconds 1 }
  $p = Get-Mouse
  $cfg.x = $p.X; $cfg.y = $p.Y; Save-Cfg
  [console]::Beep(880, 200)
  Write-Host "Saved the spot: $($p.X), $($p.Y)"
}
if ($Recalibrate -or $null -eq $cfg.x -or $null -eq $cfg.y) { Set-Spot }

function Send-SkipClick([int]$x, [int]$y) {
  $back = Get-Mouse
  [void][SpinNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [SpinNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # left button down
  Start-Sleep -Milliseconds 50
  [SpinNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # left button up
  Start-Sleep -Milliseconds 100
  [void][SpinNative]::SetCursorPos($back.X, $back.Y)            # mouse goes back where it was
}

# ---- listen for Skip taps ----
$headers = @{ apikey = $SupaKey; Authorization = "Bearer $SupaKey" }
$body = (@{ p_code = $Code } | ConvertTo-Json -Compress)
$last = $null; $lastClick = [datetime]::MinValue; $fails = 0; $said = ''
Write-Host ''
Write-Host "Skip Click is running for class code $Code. Click spot: $($cfg.x), $($cfg.y)."
Write-Host 'Leave this window open during class (you can minimize it). Close it to stop.'
Write-Host ''
while ($true) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$SupaUrl/rest/v1/rpc/spin_live_skip_get" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 5
    $fails = 0
    if ($null -eq $r) {
      if ($said -ne 'wait') { Write-Host 'Waiting for the class screen to share this code ...'; $said = 'wait' }
    } else {
      if ($null -eq $last) {
        $last = [int]$r.n
        Write-Host 'Connected. Waiting for Skip taps from the teacher phone.'; $said = 'ok'
      } elseif ([int]$r.n -gt $last) {
        $last = [int]$r.n
        $fresh = ($null -ne $r.age) -and ([double]$r.age -lt 8)
        $gap = ((Get-Date) - $lastClick).TotalSeconds
        if ($fresh -and $gap -gt 2) {
          Send-SkipClick ([int]$cfg.x) ([int]$cfg.y)
          $lastClick = Get-Date
          Write-Host ("{0}  clicked the skip spot" -f (Get-Date -Format 'HH:mm:ss'))
        }
      }
    }
  } catch {
    $fails++
    if ($fails -eq 1 -or ($fails % 20) -eq 0) { Write-Host "Can't reach the server right now ($($_.Exception.Message)). Retrying ..." }
  }
  Start-Sleep -Milliseconds 700
}
