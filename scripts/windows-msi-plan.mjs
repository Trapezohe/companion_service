import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_NAME = 'Trapezohe Companion Installer'
const MANUFACTURER = 'Trapezohe'
const UPGRADE_CODE = '4AF4D4EF-2C1D-4FB9-99EB-387DABEE6D20'
const INSTALL_FOLDER_NAME = 'TrapezoheCompanion'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const WIX4_TEMPLATE_PATH = path.join(SCRIPT_DIR, '..', 'packaging', 'windows', 'installer.wxs')

const MSI_FILES = [
  {
    componentId: 'RunInstallCmdComponent',
    fileId: 'RunInstallCmd',
    fileName: 'run-install.cmd',
  },
  {
    componentId: 'InstallCompanionPs1Component',
    fileId: 'InstallCompanionPs1',
    fileName: 'install-companion.ps1',
  },
  {
    componentId: 'TrayExeComponent',
    fileId: 'TrayExe',
    fileName: 'trapezohe-companion-tray.exe',
  },
  {
    componentId: 'TrayReadmeComponent',
    fileId: 'TrayReadme',
    fileName: 'tray.README.txt',
  },
]

export function getWindowsMsiBuildPlan({
  hostPlatform = process.platform,
} = {}) {
  const normalizedPlatform = String(hostPlatform || '').trim().toLowerCase()
  const isWindowsHost = normalizedPlatform === 'win32'

  return {
    builder: isWindowsHost ? 'wix' : 'wixl',
    schemaVersion: isWindowsHost ? 'wix4' : 'wix3',
    wxsSourceMode: isWindowsHost ? 'v4-template' : 'rendered',
  }
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function escapeXmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
}

function renderWix4Source() {
  return readFileSync(WIX4_TEMPLATE_PATH, 'utf8')
}

function renderWix3Source({ productVersion, installerSourceDir }) {
  const normalizedSourceDir = toPosixPath(installerSourceDir)
  const componentLines = MSI_FILES.map(({ componentId, fileId, fileName }) => `
          <Component Id="${componentId}" Guid="*">
            <File Id="${fileId}" Source="${escapeXmlAttr(`${normalizedSourceDir}/${fileName}`)}" KeyPath="yes" />
          </Component>`).join('\n')

  const componentRefLines = MSI_FILES.map(({ componentId }) => `      <ComponentRef Id="${componentId}" />`).join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${PRODUCT_NAME}" Language="1033" Version="${escapeXmlAttr(productVersion)}" Manufacturer="${MANUFACTURER}" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer ${PRODUCT_NAME} is already installed." />
    <MediaTemplate />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFilesFolder">
        <Directory Id="INSTALLFOLDER" Name="${INSTALL_FOLDER_NAME}">
${componentLines}
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="MainFeature" Title="Companion Installer" Level="1">
${componentRefLines}
    </Feature>
    <CustomAction Id="RunCompanionBootstrap" FileKey="RunInstallCmd" ExeCommand="" Execute="deferred" Return="ignore" Impersonate="yes" />
    <InstallExecuteSequence>
      <Custom Action="RunCompanionBootstrap" After="InstallFiles">NOT Installed</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
`
}

export function renderWindowsMsiSource({
  schemaVersion,
  productVersion = '',
  installerSourceDir = '',
} = {}) {
  if (schemaVersion === 'wix4') {
    return renderWix4Source()
  }
  if (schemaVersion === 'wix3') {
    return renderWix3Source({ productVersion, installerSourceDir })
  }
  throw new Error(`Unsupported Windows MSI schema version: ${schemaVersion}`)
}

function getArg(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return ''
  return process.argv[index + 1] || ''
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(getWindowsMsiBuildPlan())}\n`)
}

if (process.argv.includes('--render')) {
  const schemaVersion = getArg('--schema-version')
  const productVersion = getArg('--product-version')
  const installerSourceDir = getArg('--installer-source-dir')
  process.stdout.write(renderWindowsMsiSource({ schemaVersion, productVersion, installerSourceDir }))
}
