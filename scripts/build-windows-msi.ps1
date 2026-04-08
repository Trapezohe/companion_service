param(
  [Parameter(Mandatory = $false)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

$WindowsInstallerProductName = "GhastAI Companion Installer"
$WindowsInstallerManufacturer = "Trapezohe"
$WindowsInstallerUpgradeCode = "4AF4D4EF-2C1D-4FB9-99EB-387DABEE6D20"
$WindowsInstallerFolderName = "TrapezoheCompanion"
$WindowsMsiFiles = @(
  @{ componentId = "RunInstallCmdComponent"; fileId = "RunInstallCmd"; fileName = "run-install.cmd" },
  @{ componentId = "InstallCompanionPs1Component"; fileId = "InstallCompanionPs1"; fileName = "install-companion.ps1" },
  @{ componentId = "CompanionCliComponent"; fileId = "CompanionCli"; fileName = "trapezohe-companion.exe" },
  @{ componentId = "TrayExeComponent"; fileId = "TrayExe"; fileName = "trapezohe-companion-tray.exe" },
  @{ componentId = "TrayReadmeComponent"; fileId = "TrayReadme"; fileName = "tray.README.txt" }
)

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

function Get-WindowsMsiBuildPlan {
  param(
    [string]$HostPlatform = (Get-HostPlatform)
  )

  $normalizedPlatform = if ([string]::IsNullOrWhiteSpace($HostPlatform)) {
    ""
  } else {
    $HostPlatform.Trim().ToLowerInvariant()
  }
  $isWindowsHost = $normalizedPlatform -eq "win32"

  return @{
    builder = if ($isWindowsHost) { "wix" } else { "wixl" }
    schemaVersion = if ($isWindowsHost) { "wix4" } else { "wix3" }
    wxsSourceMode = if ($isWindowsHost) { "v4-template" } else { "rendered" }
  }
}

function Convert-ToPosixPath {
  param(
    [string]$Value
  )

  return [string]$Value -replace "\\", "/"
}

function ConvertTo-EscapedXmlAttribute {
  param(
    [string]$Value
  )

  $escaped = [string]$Value
  $escaped = $escaped.Replace("&", "&amp;")
  $escaped = $escaped.Replace('"', "&quot;")
  $escaped = $escaped.Replace("<", "&lt;")
  $escaped = $escaped.Replace(">", "&gt;")
  $escaped = $escaped.Replace("'", "&apos;")
  return $escaped
}

function Get-WindowsMsiTemplatePath {
  return Join-Path $root "packaging/windows/installer.wxs"
}

function Render-WindowsMsiSource {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SchemaVersion,
    [string]$ProductVersion = "",
    [string]$InstallerSourceDir = ""
  )

  if ($SchemaVersion -eq "wix4") {
    return Get-Content (Get-WindowsMsiTemplatePath) -Raw
  }

  if ($SchemaVersion -ne "wix3") {
    throw "Unsupported Windows MSI schema version: $SchemaVersion"
  }

  $normalizedSourceDir = Convert-ToPosixPath $InstallerSourceDir
  $componentLines = ($WindowsMsiFiles | ForEach-Object {
    $source = ConvertTo-EscapedXmlAttribute "$normalizedSourceDir/$($_.fileName)"
@"
          <Component Id="$($_.componentId)" Guid="*">
            <File Id="$($_.fileId)" Source="$source" KeyPath="yes" />
          </Component>
"@
  }) -join "`n"
  $componentRefLines = ($WindowsMsiFiles | ForEach-Object {
    "      <ComponentRef Id=""$($_.componentId)"" />"
  }) -join "`n"
  $escapedVersion = ConvertTo-EscapedXmlAttribute $ProductVersion

@"
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="$WindowsInstallerProductName" Language="1033" Version="$escapedVersion" Manufacturer="$WindowsInstallerManufacturer" UpgradeCode="$WindowsInstallerUpgradeCode">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallExecute" DowngradeErrorMessage="A newer $WindowsInstallerProductName is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFilesFolder">
        <Directory Id="INSTALLFOLDER" Name="$WindowsInstallerFolderName">
$componentLines
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="MainFeature" Title="Companion Installer" Level="1">
$componentRefLines
    </Feature>
    <CustomAction Id="StopTrayBeforeInstall" FileKey="RunInstallCmd" ExeCommand="-StopTrayOnly" Execute="deferred" Return="ignore" Impersonate="yes" />
    <CustomAction Id="RunCompanionBootstrap" FileKey="RunInstallCmd" ExeCommand="" Execute="deferred" Return="check" Impersonate="yes" />
    <CustomAction Id="UninstallCleanup" Directory="INSTALLFOLDER" ExeCommand="cmd.exe /c run-install.cmd -Cleanup" Return="ignore" />
    <InstallExecuteSequence>
      <Custom Action="StopTrayBeforeInstall" Before="InstallFiles">(Installed OR WIX_UPGRADE_DETECTED) AND NOT REMOVE~="ALL"</Custom>
      <Custom Action="RunCompanionBootstrap" After="InstallFiles">NOT REMOVE~="ALL"</Custom>
      <Custom Action="UninstallCleanup" Before="RemoveFiles">REMOVE~="ALL"</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
"@
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Version)) {
  $cargoToml = Get-Content (Join-Path $root "Cargo.toml") -Raw
  $match = [regex]::Match($cargoToml, '(?s)\[workspace\.package\].*?^\s*version\s*=\s*"([^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if (-not $match.Success) {
    throw "Failed to resolve workspace version from Cargo.toml."
  }
  $Version = [string]$match.Groups[1].Value
}

$outDir = Join-Path $root "dist/installers"
$trayStageRoot = Join-Path $root "dist/stage"
$tempRoot = if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
  $env:TEMP
} elseif (-not [string]::IsNullOrWhiteSpace($env:TMPDIR)) {
  $env:TMPDIR
} else {
  [System.IO.Path]::GetTempPath()
}
$workDir = Join-Path $tempRoot ("trapezohe-companion-msi-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $workDir "source"
$trayStageDir = Join-Path $trayStageRoot "windows-tray"
$bundledCliPath = Join-Path $sourceDir "trapezohe-companion.exe"
$msiPath = Join-Path $outDir "trapezohe-companion-windows.msi"
$generatedWxsPath = Join-Path $workDir "installer.generated.wxs"

New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Copy-Item (Join-Path $root "packaging/windows/run-install.cmd") (Join-Path $sourceDir "run-install.cmd")
Copy-Item (Join-Path $root "packaging/windows/license.rtf") (Join-Path $sourceDir "license.rtf")
$psTemplate = Get-Content (Join-Path $root "packaging/windows/install-companion.ps1") -Raw
$psRendered = $psTemplate -replace "__COMPANION_VERSION__", $Version
Set-Content -Path (Join-Path $sourceDir "install-companion.ps1") -Value $psRendered -Encoding UTF8

Push-Location $root
& cargo build --manifest-path (Join-Path $root "Cargo.toml") -p companion-cli --release
$cargoExitCode = $LASTEXITCODE
Pop-Location
if ($cargoExitCode -ne 0) {
  throw "Failed to build the Rust companion CLI for the Windows installer."
}

$compiledCliPath = Join-Path $root "target/release/trapezohe-companion.exe"
if (-not (Test-Path $compiledCliPath)) {
  throw "Compiled Rust companion CLI missing at $compiledCliPath"
}
Copy-Item $compiledCliPath $bundledCliPath

& (Join-Path $root "scripts/build-tray-windows.ps1") -Version $Version
Copy-Item (Join-Path $trayStageDir "trapezohe-companion-tray.exe") (Join-Path $sourceDir "trapezohe-companion-tray.exe")
Copy-Item (Join-Path $trayStageDir "README.txt") (Join-Path $sourceDir "tray.README.txt")

$plan = Get-WindowsMsiBuildPlan
$renderedWxs = Render-WindowsMsiSource -SchemaVersion $plan.schemaVersion -ProductVersion $Version -InstallerSourceDir $sourceDir
Set-Content -Path $generatedWxsPath -Value $renderedWxs -Encoding UTF8

if ($plan.builder -eq "wix") {
  $wix = Get-Command wix -ErrorAction SilentlyContinue
  if (-not $wix) {
    dotnet tool install --global wix --version 4.0.5 | Out-Null
    $env:PATH += ";$env:USERPROFILE\\.dotnet\\tools"
  }
  wix extension add WixToolset.UI.wixext/4.0.5 | Out-Null

  wix build `
    -arch x64 `
    -ext WixToolset.UI.wixext `
    -define ProductVersion=$Version `
    -define InstallerSourceDir=$sourceDir `
    -o $msiPath `
    $generatedWxsPath
} elseif ($plan.builder -eq "wixl") {
  $wixl = Get-Command wixl -ErrorAction SilentlyContinue
  if (-not $wixl) {
    throw "wixl is required on non-Windows hosts. Install msitools (for example: brew install msitools)."
  }

  wixl -o $msiPath $generatedWxsPath
} else {
  throw "Unsupported Windows MSI builder: $($plan.builder)"
}

if (-not (Test-Path $msiPath)) {
  throw "Windows MSI build did not produce an output file at $msiPath"
}

Write-Host "Built $msiPath"
