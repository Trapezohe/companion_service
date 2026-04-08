param(
    [string]$Version = "",
    [switch]$Archive
)

$ErrorActionPreference = "Stop"

$DefaultWindowsTarget = "x86_64-pc-windows-msvc"
$TrayManifestPath = "tray/Cargo.toml"
$TrayExeName = "trapezohe-companion-tray.exe"

function Get-HostPlatform {
    if ($env:OS -eq "Windows_NT") {
        return "win32"
    }

    $description = [string][System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    if ($description -match "Darwin|macOS") {
        return "darwin"
    }
    if ($description -match "Linux") {
        return "linux"
    }

    return $description.Trim().ToLowerInvariant()
}

function Get-WindowsTrayBuildPlan {
    param(
        [string]$HostPlatform = (Get-HostPlatform),
        [string]$TargetTriple = $env:TRAPEZOHE_WINDOWS_TARGET
    )

    if ([string]::IsNullOrWhiteSpace($HostPlatform)) {
        $normalizedPlatform = ""
    } else {
        $normalizedPlatform = $HostPlatform.Trim().ToLowerInvariant()
    }

    if ([string]::IsNullOrWhiteSpace($TargetTriple)) {
        $normalizedTarget = ""
    } else {
        $normalizedTarget = $TargetTriple.Trim()
    }
    $needsCrossTarget = $normalizedPlatform -ne "win32"
    $finalTarget = $null
    $cargoArgs = @("build", "--manifest-path", $TrayManifestPath, "--release")

    if ($needsCrossTarget) {
        $finalTarget = if ([string]::IsNullOrWhiteSpace($normalizedTarget)) {
            $DefaultWindowsTarget
        } else {
            $normalizedTarget
        }
        $cargoArgs = @("xwin") + $cargoArgs + @("--target", $finalTarget)
    }

    $exeRelativePath = if ($finalTarget) {
        "tray/target/$finalTarget/release/$TrayExeName"
    } else {
        "tray/target/release/$TrayExeName"
    }

    return @{
        cargoCommand = "cargo"
        cargoArgs = $cargoArgs
        targetTriple = $finalTarget
        exeName = $TrayExeName
        exeRelativePath = $exeRelativePath
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
    $cargoToml = Get-Content (Join-Path $root "Cargo.toml") -Raw
    $match = [regex]::Match($cargoToml, '(?s)\[workspace\.package\].*?^\s*version\s*=\s*"([^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $match.Success) {
        throw "Failed to resolve workspace version from Cargo.toml."
    }
    $Version = $match.Groups[1].Value
}

$uiDir = Join-Path $root "tray/ui-react"

$stageRoot = Join-Path $root "dist/stage"
$stageDir = Join-Path $stageRoot "windows-tray"
$archiveDir = Join-Path $root "dist/debug-artifacts"
$zipPath = Join-Path $archiveDir "trapezohe-companion-tray-windows.zip"
$plan = Get-WindowsTrayBuildPlan
$exeName = [string]$plan.exeName
$exeSource = Join-Path $root ([string]$plan.exeRelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)

if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

& npm --prefix $uiDir run build
if ($LASTEXITCODE -ne 0) {
    throw "Windows tray frontend build failed."
}

& $plan.cargoCommand @($plan.cargoArgs)
if ($LASTEXITCODE -ne 0) {
    throw "Windows tray build failed."
}

Copy-Item $exeSource (Join-Path $stageDir $exeName)
Copy-Item (Join-Path $root "tray/icons/icon.png") (Join-Path $stageDir "icon.png")
@"
GhastAI Companion Tray
Version: $Version

This stage directory contains the tray executable used by the platform installers.
"@ | Set-Content (Join-Path $stageDir "README.txt")

if ($Archive) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
    Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
    Write-Host "Built $zipPath"
} else {
    Write-Host "Staged $stageDir"
}
