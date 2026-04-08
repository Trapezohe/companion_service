from __future__ import annotations

import base64
import os
import re
import subprocess
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path

from tests.common import ROOT, assert_matches, assert_not_matches, read, read_json, run_bash


class InstallerSurfaceTests(unittest.TestCase):
    def test_root_scripts_expose_installer_and_tray_staging_entrypoints_directly(self) -> None:
        self.assertTrue((ROOT / "scripts/build-macos-pkg.sh").exists())
        self.assertTrue((ROOT / "scripts/build-windows-msi.ps1").exists())
        self.assertTrue((ROOT / "scripts/build-tray-macos.sh").exists())
        self.assertTrue((ROOT / "scripts/build-tray-windows.ps1").exists())
        self.assertFalse((ROOT / "package.json").exists())

    def test_tray_stage_scripts_write_internal_artifacts_outside_dist_installers(self) -> None:
        macos_script = read("scripts/build-tray-macos.sh")
        windows_script = read("scripts/build-tray-windows.ps1")

        assert_matches(self, macos_script, r"dist/stage")
        assert_matches(self, macos_script, r'--prefix "\$\{UI_DIR\}" run build')
        assert_not_matches(self, macos_script, r'OUT_DIR="\$\{ROOT_DIR\}/dist/installers"')
        assert_matches(self, windows_script, r"dist[\\/]stage")
        assert_matches(self, windows_script, r"npm --prefix \$uiDir run build")
        assert_not_matches(self, windows_script, r"dist[\\/]installers")

    def test_macos_tray_stage_script_can_resolve_cargo_from_standard_home_path(self) -> None:
        macos_script = read("scripts/build-tray-macos.sh")

        assert_matches(self, macos_script, r'CARGO_BIN="\$\{CARGO:-\$\(command -v cargo \|\| true\)\}"')
        assert_matches(self, macos_script, r'if \[\[ -z "\$\{CARGO_BIN\}" && -x "\$\{HOME\}/\.cargo/bin/cargo" \]\]; then')
        assert_matches(self, macos_script, r'"\$\{CARGO_BIN\}" build --manifest-path "\$\{ROOT_DIR\}/tray/Cargo\.toml" --release --features custom-protocol')

    def test_public_docs_and_release_copy_describe_tray_as_bundled_installer_ux(self) -> None:
        readme = read("README.md")
        workflow = read(".github/workflows/release-installers.yml")

        assert_not_matches(self, readme, r"build:tray:")
        assert_not_matches(self, readme, r"tray shell bundle is optional", re.I)
        assert_matches(self, readme, r"desktop tray panel is installed together", re.I)

        assert_not_matches(self, workflow, r"tray shell bundle is optional", re.I)
        assert_matches(self, workflow, r"desktop tray panel is installed together", re.I)

    def test_tray_shell_loads_react_frontend_and_no_longer_uses_legacy_static_panel(self) -> None:
        tray_config = read_json("tray/tauri.conf.json")
        react_index = read("tray/ui-react/index.html")
        react_main = read("tray/ui-react/src/main.tsx")
        react_pkg = read_json("tray/ui-react/package.json")

        self.assertEqual(tray_config["build"]["devUrl"], "http://localhost:1420")
        self.assertEqual(tray_config["build"]["frontendDist"], "ui-react/dist")
        self.assertFalse(tray_config["app"]["withGlobalTauri"])
        self.assertEqual(react_pkg["scripts"]["build"], "tsc -b && vite build")
        assert_matches(self, react_index, r"<div id=\"root\"></div>")
        assert_matches(self, react_index, r'src="/src/main\.tsx"')
        assert_matches(self, react_main, r'createRoot\(document\.getElementById\(["\']root["\']\)!')
        self.assertFalse((ROOT / "tray/ui/index.html").exists())

    def test_status_panel_window_is_configured_like_tray_dropdown(self) -> None:
        tray_config = read_json("tray/tauri.conf.json")
        status_window = next(window for window in tray_config["app"]["windows"] if window["label"] == "status")

        self.assertFalse(status_window["decorations"])
        self.assertTrue(status_window["alwaysOnTop"])
        self.assertTrue(status_window["skipTaskbar"])

    def test_tray_clicks_are_unified_around_custom_panel(self) -> None:
        tray_rs = read("tray/src/tray.rs")
        lib_rs = read("tray/src/lib.rs")

        assert_not_matches(self, tray_rs, r"\.menu\(&menu\)")
        assert_not_matches(self, tray_rs, r"MenuBuilder::new")
        assert_matches(self, lib_rs, r"MouseButton::Right")
        assert_matches(self, lib_rs, r"should_open_status_panel_for_tray_event")

    def test_macos_installer_bootstrap_uses_user_accessible_temp_script_and_targets_installed_app(self) -> None:
        postinstall = read("packaging/macos/postinstall")

        assert_matches(self, postinstall, r'mktemp "\/Users\/Shared\/trapezohe-companion-bootstrap\.XXXXXX"')
        assert_not_matches(self, postinstall, r"mktemp -t trapezohe-companion-bootstrap")
        assert_not_matches(self, postinstall, r"mktemp /tmp/trapezohe-companion-bootstrap\.XXXXXX\.sh")
        assert_matches(self, postinstall, r'TRAY_APP_PATH="/Applications/GhastAI Companion\.app"')
        assert_matches(self, postinstall, r'TRAY_BIN_PATH="\$\{TRAY_APP_PATH\}/Contents/MacOS/trapezohe-companion-tray"')

    def test_macos_installer_registers_fixed_production_extension_origin(self) -> None:
        postinstall = read("packaging/macos/postinstall")
        shared = read("crates/companion-shared/src/lib.rs")
        cli_rs = read("crates/companion-cli/src/main.rs")

        assert_matches(self, postinstall, r'"\$\{APP_CLI_PATH\}" bootstrap --mode workspace --workspace "\$\{workspace_dir\}" --no-autostart --no-start')
        assert_matches(self, shared, r'pub const FIXED_EXTENSION_ID: &str = "nnhdkkgpoeojjddikcjadgpkbfbjhcal";')
        assert_matches(self, shared, r'pub const FIXED_EXTENSION_ORIGIN: &str = "chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal";')
        assert_matches(self, cli_rs, r'const NATIVE_HOST_NAMES: &\[&str\] = &\["com\.ghast\.companion", "com\.trapezohe\.companion"\];')
        assert_matches(self, cli_rs, r'let allowed_origins = vec!\[format!\("\{FIXED_EXTENSION_ORIGIN\}/"\)\];')
        assert_not_matches(self, shared, r"olngglipkifpkolknipcbdcifbkcfhkk")

    def test_macos_installer_bundles_only_rust_runtime_inside_app(self) -> None:
        postinstall = read("packaging/macos/postinstall")
        tray_script = read("scripts/build-tray-macos.sh")
        pkg_script = read("scripts/build-macos-pkg.sh")

        assert_matches(self, tray_script, r'COMPANION_DIR="\$\{RESOURCES_DIR\}/companion"')
        assert_matches(self, tray_script, r'"\$\{CARGO_BIN\}" build --manifest-path "\$\{ROOT_DIR\}/Cargo\.toml" -p companion-cli --release')
        assert_matches(self, tray_script, r'cp "\$\{CLI_BUILD_DIR\}/trapezohe-companion" "\$\{COMPANION_DIR\}/bin/trapezohe-companion"')
        assert_not_matches(self, tray_script, r'RUNTIME_NODE_DIR="\$\{RESOURCES_DIR\}/runtime/node"')
        assert_not_matches(self, tray_script, r'cp "\$\{ROOT_DIR\}/bin/cli\.mjs"')
        assert_not_matches(self, tray_script, r'cp "\$\{ROOT_DIR\}/bin/native-host\.mjs"')
        assert_not_matches(self, tray_script, r'cp "\$\{ROOT_DIR\}/package\.json"')
        assert_not_matches(self, tray_script, r'find "\$\{ROOT_DIR\}/src" -maxdepth 1 -type f -name \'\*\.mjs\' ! -name \'\*\.test\.mjs\'')

        assert_not_matches(self, pkg_script, r'cp "\$\{ROOT_DIR\}/bin/native-host\.mjs"')
        assert_not_matches(self, pkg_script, r'cp "\$\{ROOT_DIR\}/bin/cli\.mjs"')
        assert_not_matches(self, pkg_script, r'cp "\$\{ROOT_DIR\}/package\.json"')
        assert_not_matches(self, pkg_script, r'mkdir -p "\$\{PAYLOAD_DIR\}/src"')

        assert_matches(self, postinstall, r'APP_RUNTIME_DIR="\$\{TRAY_APP_PATH\}/Contents/Resources/companion"')
        assert_matches(self, postinstall, r'APP_CLI_PATH="\$\{APP_RUNTIME_DIR\}/bin/trapezohe-companion"')
        assert_matches(self, postinstall, r'restart_companion_daemon\(\)')
        assert_matches(self, postinstall, r'if \[\[ ! -x "\$\{APP_CLI_PATH\}" \]\]; then')
        assert_matches(self, postinstall, r'"\$\{APP_CLI_PATH\}" bootstrap --mode workspace --workspace "\$\{workspace_dir\}" --no-autostart --no-start')
        assert_matches(self, postinstall, r'"\$\{APP_CLI_PATH\}" stop --force')
        assert_matches(self, postinstall, r'"\$\{APP_CLI_PATH\}" start -d')
        assert_not_matches(self, postinstall, r"APP_NODE_DIR=")
        assert_not_matches(self, postinstall, r"resolve_app_node")
        assert_not_matches(self, postinstall, r"native-host\.mjs")
        assert_not_matches(self, postinstall, r"bin/cli\.mjs")
        assert_not_matches(self, postinstall, r"Bundled Node CLI")
        assert_not_matches(self, postinstall, r"deploy_companion_service")
        assert_not_matches(self, postinstall, r'service_dir="\$\{TRAPEZOHE_DIR\}/service"')
        assert_not_matches(self, postinstall, r'wrapper="\$\{LOCAL_NODE_DIR\}/bin/trapezohe-companion"')

    def test_macos_build_scripts_use_developer_id_signing_and_notarization(self) -> None:
        tray_script = read("scripts/build-tray-macos.sh")
        pkg_script = read("scripts/build-macos-pkg.sh")
        signing_lib = read("scripts/lib/macos-signing.sh")

        assert_matches(self, tray_script, r'source "\$\{ROOT_DIR\}/scripts/lib/macos-signing\.sh"')
        assert_matches(self, tray_script, r"TRAPEZOHE_MACOS_STAGE_ROOT")
        assert_matches(self, tray_script, r'macos_sign_binary "\$\{COMPANION_DIR\}/bin/trapezohe-companion"')
        assert_matches(self, tray_script, r'macos_sign_app_bundle "\$\{APP_DIR\}"')

        assert_matches(self, pkg_script, r'source "\$\{ROOT_DIR\}/scripts/lib/macos-signing\.sh"')
        assert_matches(self, pkg_script, r"TRAPEZOHE_MACOS_STAGE_ROOT")
        assert_matches(self, pkg_script, r"SIGNED_PACKAGE_FILE=")
        assert_matches(self, pkg_script, r'macos_sign_pkg "\$\{PACKAGE_FILE\}" "\$\{SIGNED_PACKAGE_FILE\}"')
        assert_matches(self, pkg_script, r'macos_notarize_artifact "\$\{PACKAGE_FILE\}"')
        assert_matches(self, pkg_script, r'COPYFILE_DISABLE=1 /usr/bin/ditto --noextattr --norsrc "\$\{TRAY_APP_PATH\}" "\$\{APPLICATIONS_DIR\}/\$\{TRAY_APP_NAME\}"')
        assert_matches(self, pkg_script, r'/usr/bin/xattr -cr "\$\{PKG_ROOT\}" 2>/dev/null \|\| true')
        assert_matches(self, pkg_script, r'COPYFILE_DISABLE=1 pkgbuild \\')

        assert_matches(self, signing_lib, r"APPLE_DEVELOPER_ID_APP_IDENTITY")
        assert_matches(self, signing_lib, r"APPLE_DEVELOPER_ID_INSTALLER_IDENTITY")
        assert_matches(self, signing_lib, r"TRAPEZOHE_MACOS_SIGNING_ENV_FILE")
        assert_matches(self, signing_lib, r"macos_sign_binary\(\)")
        assert_matches(self, signing_lib, r"codesign --force --sign")
        assert_matches(self, signing_lib, r"--options runtime --timestamp")
        assert_matches(self, signing_lib, r"macos_require_notary_acceptance")
        assert_matches(self, signing_lib, r"--output-format json")
        assert_matches(self, signing_lib, r"xcrun notarytool log")
        assert_matches(self, signing_lib, r"productsign --sign")
        assert_matches(self, signing_lib, r"xcrun notarytool submit")
        assert_matches(self, signing_lib, r"xcrun stapler staple")

    def test_macos_signing_helpers_normalize_identity_subjects(self) -> None:
        signing_lib_path = ROOT / "scripts/lib/macos-signing.sh"
        result = run_bash(
            textwrap.dedent(
                f'''
                source "{signing_lib_path}"
                printf '%s\\n' "$(macos_normalize_identity_name 'Developer ID Application: peng wang (VW9LG92726),UID=VW9LG92726')"
                printf '%s\\n' "$(macos_normalize_identity_name 'Developer ID Installer: peng wang (VW9LG92726)')"
                '''
            )
        )
        self.assertEqual(
            result.stdout.strip().splitlines(),
            [
                "Developer ID Application: peng wang (VW9LG92726)",
                "Developer ID Installer: peng wang (VW9LG92726)",
            ],
        )

    def test_macos_tray_control_prefers_bundled_rust_cli(self) -> None:
        daemon_rs = read("tray/src/daemon.rs")

        assert_matches(self, daemon_rs, r"resolve_bundled_cli_invocation_from")
        assert_matches(self, daemon_rs, r'Resources"\)\s*\.join\("companion"\)\s*\.join\("bin"\)\s*\.join\("trapezohe-companion"')
        assert_not_matches(self, daemon_rs, r'Resources"\)\s*\.join\("runtime"\)\s*\.join\("node"\)')
        assert_not_matches(self, daemon_rs, r'Resources"\)\s*\.join\("companion"\)\s*\.join\("bin"\)\s*\.join\("cli\.mjs"')

    def test_windows_installer_hands_runtime_over_to_installed_cli(self) -> None:
        installer = read("packaging/windows/install-companion.ps1")
        wxs = read("packaging/windows/installer.wxs")
        run_install = read("packaging/windows/run-install.cmd")
        msi_build_script = read("scripts/build-windows-msi.ps1")

        assert_matches(self, installer, r'^param\(\s*\[switch\]\$StopTrayOnly,\s*\[switch\]\$Cleanup\s*\)', re.M)
        assert_matches(self, installer, r'\$ProgressPreference = "SilentlyContinue"')
        for name in [
            "Write-InstallerStatus",
            "Write-InstallerStep",
            "Resolve-InstallerCommand",
            "Build-CmdProcessArgumentList",
            "Resolve-LoggedProcessLaunchSpec",
            "Invoke-LoggedProcess",
            "Start-DetachedInstallerCommand",
            "Stop-RunningTrayProcesses",
            "Stop-InstalledCompanionDaemon",
            "Get-CompanionCliCandidates",
            "Create-DesktopShortcut",
            "Create-StartMenuShortcut",
            "Remove-DesktopShortcut",
            "Remove-StartMenuShortcut",
            "Remove-TrayAutoStart",
            "Register-TrayAutoStart",
        ]:
            assert_matches(self, installer, rf"function {name}")

        assert_matches(self, installer, r'Resolve-LoggedProcessLaunchSpec -FilePath \$FilePath -ArgumentList \$ArgumentList')
        assert_matches(self, installer, r'switch \(\$extension\) \{[\s\S]+?"\.cmd" \{[\s\S]+?"\.bat" \{[\s\S]+?"\.ps1" \{')
        assert_matches(self, installer, r'return @\("/d", "/s", "/c",')
        assert_matches(self, installer, r'ArgumentList = Build-CmdProcessArgumentList -FilePath \$FilePath -ArgumentList \$ArgumentList')
        assert_matches(self, installer, r'\[System\.Diagnostics\.Process\]::Start\(\$psi\)')
        assert_matches(self, installer, r'\$psi\.CreateNoWindow = \$true')
        assert_matches(self, installer, r'\$psi\.RedirectStandardOutput = \$true')
        assert_matches(self, installer, r'\$psi\.RedirectStandardError = \$true')
        assert_matches(self, installer, r'\$proc\.StandardOutput\.ReadToEnd\(\)')
        assert_matches(self, installer, r'Start-Process -FilePath \$cmdCli -ArgumentList @\("/d", "/s", "/c",')
        assert_matches(self, installer, r"schtasks\.exe")
        assert_matches(self, installer, r"TrapezoheCompanionTrayOnce")
        assert_matches(self, installer, r"MSI deferred custom actions run in Session 0")
        assert_matches(self, installer, r'Get-Process -Name "trapezohe-companion-tray" -ErrorAction SilentlyContinue')
        assert_matches(self, installer, r'Stop-Process -Force -ErrorAction SilentlyContinue')
        assert_matches(self, installer, r'\$stagedCompanionCliPath = Join-Path \$stagedCompanionBinDir "trapezohe-companion\.exe"')
        assert_matches(self, installer, r'\$bundledCompanionCliPath = Join-Path \$PSScriptRoot "trapezohe-companion\.exe"')
        assert_matches(self, installer, r'if \(Test-Path \$stagedCompanionCliPath\) \{')
        assert_matches(self, installer, r'\$pathCli = Resolve-InstallerCommand @\("trapezohe-companion\.exe", "trapezohe-companion\.cmd", "trapezohe-companion"\)')
        assert_matches(self, installer, r'\$cliCandidates = @\(Get-CompanionCliCandidates\)')
        assert_matches(self, installer, r'Invoke-LoggedProcess -FilePath \$cliPath -ArgumentList @\("stop", "--force"\) -LogPrefix "companion-stop"')
        assert_matches(self, installer, r'Write-InstallerLog "Using bundled Rust companion CLI: \$bundledCompanionCliPath"')
        assert_matches(self, installer, r'Invoke-LoggedProcess -FilePath \$bundledCompanionCliPath -ArgumentList @\("bootstrap", "--mode", "workspace", "--workspace", \$workspace, "--no-autostart", "--no-start"\) -LogPrefix "bootstrap"')
        assert_matches(self, installer, r'Start-DetachedInstallerCommand -FilePath \$trayExePath -ArgumentList @\(\)')
        assert_matches(self, installer, r'Invoke-LoggedProcess -FilePath "schtasks\.exe" -ArgumentList @\([\s\S]+?"/Create", "/TN", \$taskName', re.S)
        assert_matches(self, installer, r'if \(\$StopTrayOnly\) \{[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop started\."[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Stop-InstalledCompanionDaemon[\s\S]+?Write-InstallerLog "Windows installer tray pre-stop finished\."[\s\S]+?exit 0[\s\S]+?\}', re.S)
        assert_not_matches(self, installer, r'& npm install -g \$packageTarballPath 2>&1 \| ForEach-Object')
        assert_not_matches(self, installer, r'& trapezohe-companion bootstrap --mode workspace --workspace "\$workspace" 2>&1 \| ForEach-Object')
        assert_not_matches(self, installer, r"Removing previous global install before reinstall\.\.\.")
        assert_not_matches(self, installer, r"npm-uninstall")
        assert_matches(self, installer, r'Write-InstallerStep 1 4 "Checking bundled companion runtime\."')
        assert_matches(self, installer, r'Write-InstallerStep 2 4 "Stopping any previous companion process\."')
        assert_matches(self, installer, r'Write-InstallerStep 3 4 "Running first-time companion setup\."')
        assert_matches(self, installer, r'Write-InstallerStep 4 4 "Saving tray startup preferences and launching the tray\."')
        assert_matches(self, installer, r'Write-InstallerLog "Tray launch is responsible for syncing auto-start and ensuring the background service if needed\."')
        assert_matches(self, installer, r'Write-InstallerStatus "Windows installer completed successfully\."')
        assert_matches(self, installer, r'\$installerFlowMarker = "tray-launch-v1"')
        assert_matches(self, installer, r'Write-InstallerLog "Windows installer bootstrap started \(version=\$version, flow=\$installerFlowMarker\)\."')
        assert_matches(self, installer, r'\$bootstrapOk = Bootstrap-Companion[\s\S]+?if \(-not \$bootstrapOk\) \{[\s\S]+?throw "GhastAI Companion bootstrap failed\.[\s\S]+?\}[\s\S]+?Write-InstallerStep 4 4 "Saving tray startup preferences and launching the tray\."[\s\S]+?Write-StartupPolicy[\s\S]+?Register-TrayAutoStart[\s\S]+?Launch-TrayOnce[\s\S]+?Write-InstallerStatus "Windows installer completed successfully\."[\s\S]+?exit 0', re.S)
        assert_matches(self, installer, r'New-ItemProperty -Path \$trayRunKey -Name \$trayRunValueName')
        assert_matches(self, installer, r'Write-InstallerLog "Bootstrap-Companion returned: \$bootstrapOk"')
        assert_matches(self, installer, r'FATAL: unhandled exception:')
        assert_matches(self, installer, r'FATAL: stack trace:')
        assert_matches(self, installer, r'Warning: failed to write unified startup policy:')
        assert_matches(self, installer, r'Warning: failed to launch tray executable:')
        assert_matches(self, installer, r'throw "GhastAI Companion bootstrap failed\.')
        assert_not_matches(self, installer, r"PostBootstrapFinish")
        assert_not_matches(self, installer, r"Detached post-bootstrap finisher")
        assert_not_matches(self, installer, r"Restart-CompanionDaemon")
        assert_matches(self, installer, r'Write-InstallerStatus "Bundled companion runtime is ready\."')
        assert_not_matches(self, installer, r"Node\.js")
        assert_not_matches(self, installer, r"npm install -g")
        assert_matches(self, msi_build_script, r'cargo build --manifest-path \(Join-Path \$root "Cargo\.toml"\) -p companion-cli --release')
        assert_matches(self, msi_build_script, r'\$bundledCliPath = Join-Path \$sourceDir "trapezohe-companion\.exe"')
        assert_matches(self, msi_build_script, r'Copy-Item \$compiledCliPath \$bundledCliPath')
        assert_not_matches(self, msi_build_script, r"npm pack")
        assert_not_matches(self, msi_build_script, r'& node ')
        assert_matches(self, wxs, r'Source="\$\(var\.InstallerSourceDir\)/trapezohe-companion\.exe"')
        assert_matches(self, wxs, r'Return="check"')
        assert_matches(self, wxs, r'Id="StopTrayBeforeInstall"')
        assert_matches(self, wxs, r'Condition="\(Installed OR WIX_UPGRADE_DETECTED\) AND NOT REMOVE~=&quot;ALL&quot;"')
        assert_matches(self, wxs, r'Return="ignore"')
        assert_matches(self, installer, r'New-Object -ComObject WScript\.Shell')
        assert_matches(self, installer, r'\[Environment\]::GetFolderPath\("Desktop"\)')
        assert_matches(self, installer, r'\[Environment\]::GetFolderPath\("Programs"\)')
        assert_matches(self, installer, r'\.CreateShortcut\(')
        assert_matches(self, installer, r'\.TargetPath = \$trayExePath')
        assert_matches(self, installer, r'Create-DesktopShortcut[\s\S]+?Create-StartMenuShortcut[\s\S]+?Launch-TrayOnce', re.S)
        assert_matches(self, installer, r'if \(\$Cleanup\) \{[\s\S]+?Stop-RunningTrayProcesses[\s\S]+?Stop-InstalledCompanionDaemon[\s\S]+?Remove-DesktopShortcut[\s\S]+?Remove-StartMenuShortcut[\s\S]+?Remove-TrayAutoStart[\s\S]+?exit 0[\s\S]+?\}', re.S)
        assert_matches(self, wxs, r'Id="UninstallCleanup"')
        assert_matches(self, wxs, r'ExeCommand="cmd\.exe /c run-install\.cmd -Cleanup"')
        assert_matches(self, wxs, r'REMOVE~=&quot;ALL&quot;')
        assert_matches(self, run_install, r'install-companion\.ps1" %\*')

    def test_readme_cli_help_and_install_scripts_no_longer_ask_for_ext_id(self) -> None:
        readme = read("README.md")
        cli_rs = read("crates/companion-cli/src/main.rs")
        installer = read("install.sh")
        windows_installer = read("install.ps1")

        assert_not_matches(self, readme, r"--ext-id")
        assert_not_matches(self, readme, r"register <your-extension-id>")
        assert_not_matches(self, readme, r"chrome://extensions/")

        assert_matches(self, cli_rs, r'#\[arg\(long = "ext-id", hide = true, action = ArgAction::Append\)\]')
        assert_not_matches(self, cli_rs, r"register <ext-id>")
        assert_not_matches(self, cli_rs, r"repair register_native_host --ext-id")
        assert_not_matches(self, cli_rs, r"bootstrap --ext-id")

        assert_not_matches(self, installer, r"Extension ID \(or press Enter to skip\)")
        assert_not_matches(self, installer, r"cmd\+=\(--ext-id")

        assert_not_matches(self, windows_installer, r"--ext-id")
        assert_not_matches(self, windows_installer, r"Extension ID \(or press Enter to skip\)")
        assert_not_matches(self, windows_installer, r"chrome://extensions/")
        assert_not_matches(self, windows_installer, r"register <extension-id>")

    def test_readme_and_install_scripts_no_longer_present_npm_as_runtime_path(self) -> None:
        readme = read("README.md")
        installer = read("install.sh")
        windows_installer = read("install.ps1")

        assert_not_matches(self, readme, r"npm install -g trapezohe-companion")
        assert_not_matches(self, readme, r"node bin/cli\.mjs --help")
        assert_matches(self, readme, r"Linux script now installs the Rust CLI with Cargo")
        assert_matches(self, readme, r"signed release installers")
        assert_not_matches(self, readme, r"npm test")

        assert_matches(self, installer, r"cargo install --git")
        assert_matches(self, installer, r"trapezohe-companion-macos\.pkg")
        assert_not_matches(self, installer, r"npm install -g")
        assert_not_matches(self, installer, r"Node\.js 18\+")

        assert_matches(self, windows_installer, r"trapezohe-companion-windows\.msi")
        assert_matches(self, windows_installer, r"msiexec\.exe")
        assert_not_matches(self, windows_installer, r"npm install -g")
        assert_not_matches(self, windows_installer, r"Node\.js 18\+")

    def test_versions_stay_aligned_for_next_release(self) -> None:
        workspace = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))
        tray_cargo = tomllib.loads((ROOT / "tray/Cargo.toml").read_text(encoding="utf-8"))
        tauri_config = read_json("tray/tauri.conf.json")

        self.assertEqual(workspace["workspace"]["package"]["version"], "0.1.19")
        self.assertEqual(tray_cargo["package"]["version"], "0.1.19")
        self.assertEqual(tauri_config["version"], "0.1.19")

    def test_readme_and_release_copy_describe_signed_macos_flow_without_unsigned_claim(self) -> None:
        readme = read("README.md")
        workflow = read(".github/workflows/release-installers.yml")

        assert_not_matches(self, readme, r"Installers are currently unsigned", re.I)
        assert_matches(self, readme, r"macOS installer is signed and notarized", re.I)
        assert_matches(self, readme, r"Windows installer may still trigger SmartScreen", re.I)

        assert_not_matches(self, workflow, r"Since these installers are not code-signed", re.I)
        assert_matches(self, workflow, r"macOS installer is Developer ID signed and notarized", re.I)
        assert_matches(self, workflow, r"Windows — SmartScreen")

    def test_macos_tray_updater_is_wired_for_signed_in_app_updates(self) -> None:
        cargo_toml = read("tray/Cargo.toml")
        tauri_config = read_json("tray/tauri.conf.json")
        capabilities = read("tray/capabilities/default.json")
        panel = read("tray/ui-react/src/components/panel/CompanionPanel.tsx")
        home_page = read("tray/ui-react/src/components/panel/HomePage.tsx")
        settings_page = read("tray/ui-react/src/components/panel/SettingsPage.tsx")
        translations = read("tray/ui-react/src/lib/translations.ts")
        tray_lib = read("tray/src/lib.rs")
        updater_rs = read("tray/src/update.rs")

        assert_matches(self, cargo_toml, r'tauri-plugin-updater\s*=\s*(?:"2"|\{\s*version\s*=\s*"2")')
        assert_matches(self, capabilities, r"updater:default")

        self.assertTrue(tauri_config["plugins"]["updater"]["active"])
        assert_matches(self, str(tauri_config["plugins"]["updater"]["endpoints"][0]), r"https://github\.com/Trapezohe/companion_service/releases/latest/download/latest\.json")
        assert_matches(self, str(tauri_config["plugins"]["updater"]["pubkey"]), r"\S+")

        assert_matches(self, tray_lib, r"tauri_plugin_updater::Builder")
        assert_matches(self, tray_lib, r"install_update")
        assert_matches(self, updater_rs, r"download_and_install")
        assert_matches(self, updater_rs, r"Automatic updates only work for the packaged app installed in /Applications or ~/Applications")

        assert_matches(self, panel, r'invoke<StatusSnapshot>\("check_update"\)')
        assert_matches(self, panel, r'invoke<StatusSnapshot>\("install_update"\)')
        assert_matches(self, home_page, r"update\?\.available")
        assert_matches(self, home_page, r"update\.can_install")
        assert_matches(self, home_page, r"onInstallUpdate")
        assert_matches(self, settings_page, r'invoke\("open_release_page"\)')
        assert_matches(self, translations, r"updateAvailable:")
        assert_matches(self, translations, r"updateNow:")

    def test_tray_panel_surface_is_narrow_react_dashboard_with_language_switching(self) -> None:
        app = read("tray/ui-react/src/App.tsx")
        panel = read("tray/ui-react/src/components/panel/CompanionPanel.tsx")
        home_page = read("tray/ui-react/src/components/panel/HomePage.tsx")
        settings_page = read("tray/ui-react/src/components/panel/SettingsPage.tsx")
        logs_page = read("tray/ui-react/src/components/panel/LogsPage.tsx")
        translations = read("tray/ui-react/src/lib/translations.ts")
        vite_config = read("tray/ui-react/vite.config.ts")

        assert_matches(self, app, r"CompanionPanel")
        assert_matches(self, panel, r"HomePage")
        assert_matches(self, panel, r"PermissionsPage")
        assert_matches(self, panel, r"LogsPage")
        assert_matches(self, panel, r"SettingsPage")
        assert_matches(self, vite_config, r"strictPort:\s*true")
        assert_matches(self, vite_config, r"alias:")
        assert_matches(self, translations, r'footer:\s*"点面板外即可关闭"')
        assert_matches(self, home_page, r"MenuRow")
        assert_matches(self, home_page, r'onNavigate\("permissions"\)')
        assert_matches(self, home_page, r'onNavigate\("logs"\)')
        assert_matches(self, home_page, r'onNavigate\("settings"\)')
        assert_matches(self, settings_page, r'onLangChange\("en"\)')
        assert_matches(self, settings_page, r'onLangChange\("zh"\)')
        assert_matches(self, logs_page, r"tabBlocked")
        assert_matches(self, logs_page, r"logsEmptyHint")

    def test_tray_panel_keeps_release_page_fallback_and_renders_mcp_status_cards(self) -> None:
        home_page = read("tray/ui-react/src/components/panel/HomePage.tsx")
        settings_page = read("tray/ui-react/src/components/panel/SettingsPage.tsx")

        assert_matches(self, settings_page, r'invoke\("open_release_page"\)')
        assert_matches(self, home_page, r"StatusBadge")
        assert_matches(self, home_page, r"mcpServices")
        assert_matches(self, home_page, r"visibleMcpServers\.map")
        assert_matches(self, home_page, r'server\.status === "connected"')

    def test_tray_panel_uses_dark_anchored_dropdown_surface(self) -> None:
        panel_css = read("tray/ui-react/src/index.css")
        panel = read("tray/ui-react/src/components/panel/CompanionPanel.tsx")
        tauri_config = read_json("tray/tauri.conf.json")

        assert_matches(self, panel_css, r"color-scheme:\s*dark")
        assert_matches(self, panel_css, r"background:\s*transparent")
        assert_matches(self, panel, r"rounded-\[12px\]")
        assert_matches(self, panel, r"overflow-y-auto")
        assert_matches(self, panel, r"h-screen")
        self.assertEqual(tauri_config["app"]["windows"][0]["width"], 360)
        self.assertEqual(tauri_config["app"]["windows"][0]["minWidth"], 360)

    def test_tray_panel_keeps_service_actions_in_settings_and_version_on_overview(self) -> None:
        home_page = read("tray/ui-react/src/components/panel/HomePage.tsx")
        settings_page = read("tray/ui-react/src/components/panel/SettingsPage.tsx")

        assert_matches(self, home_page, r'onNavigate\("logs"\)')
        assert_matches(self, home_page, r'onNavigate\("settings"\)')
        assert_matches(self, home_page, r"tr\.version")
        assert_matches(self, home_page, r"update\?\.available")
        assert_not_matches(self, home_page, r"upToDate")
        assert_matches(self, settings_page, r'invoke\("restart_service"\)')
        assert_matches(self, settings_page, r'invoke\("stop_service"\)')
        assert_matches(self, settings_page, r'invoke\("quit_tray"\)')

    def test_react_panel_snapshot_and_update_actions_stay_wired_through_tauri_invokes(self) -> None:
        panel = read("tray/ui-react/src/components/panel/CompanionPanel.tsx")
        home_page = read("tray/ui-react/src/components/panel/HomePage.tsx")

        assert_matches(self, panel, r'invoke<StatusSnapshot>\("get_status_snapshot"\)')
        assert_matches(self, panel, r'invoke<StatusSnapshot>\("check_update"\)')
        assert_matches(self, panel, r'invoke<StatusSnapshot>\("install_update"\)')
        assert_matches(self, panel, r'invoke\("set_display_language"')
        assert_matches(self, panel, r"onAfterAction=\{fetchSnapshot\}")
        assert_matches(self, home_page, r"onInstallUpdate")

    def test_release_workflow_publishes_macos_updater_archive_signature_and_manifest(self) -> None:
        workflow = read(".github/workflows/release-installers.yml")
        updater_script = read("scripts/build-macos-updater-artifacts.sh")
        updater_lib = read("scripts/lib/tauri-updater.sh")
        signing_lib = read("scripts/lib/macos-signing.sh")

        assert_matches(self, workflow, r"build-macos-updater-artifacts\.sh")
        assert_matches(self, workflow, r"trapezohe-companion-macos\.app\.tar\.gz")
        assert_matches(self, workflow, r"trapezohe-companion-macos\.app\.tar\.gz\.sig")
        assert_matches(self, workflow, r"latest\.json")
        assert_matches(self, workflow, r"TAURI_SIGNING_PRIVATE_KEY|TRAPEZOHE_UPDATER_PRIVATE_KEY")

        assert_matches(self, updater_script, r"latest\.json")
        assert_matches(self, updater_script, r"\.app\.tar\.gz")
        assert_matches(self, updater_script, r"\.sig")
        assert_matches(self, updater_script, r'TRAPEZOHE_MACOS_STAGE_ROOT:-\$\{ROOT_DIR\}/dist/stage/macos-tray/\$\{VERSION\}')
        assert_matches(self, updater_script, r"github\.com/Trapezohe/companion_service/releases/download/v\$\{VERSION\}")
        assert_matches(self, updater_script, r'macos_notarize_app_bundle "\$\{APP_PATH\}"')
        assert_not_matches(self, updater_script, r'macos_notarize_artifact "\$\{APP_PATH\}"')

        assert_matches(self, updater_lib, r"@tauri-apps/cli@2\.10\.1")
        assert_matches(self, updater_lib, r"signer[\s\S]+sign")
        assert_matches(self, updater_lib, r'TAURI_PRIVATE_KEY_PASSWORD="\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD\}"')
        assert_matches(self, updater_lib, r'case "\$\{TAURI_PRIVATE_KEY_PASSWORD:-\}" in[\s\S]+EMPTY[\s\S]+TAURI_PRIVATE_KEY_PASSWORD=""')
        for env_name in [
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PATH",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
            "TAURI_PRIVATE_KEY",
            "TAURI_PRIVATE_KEY_PATH",
            "TAURI_PRIVATE_KEY_PASSWORD",
        ]:
            assert_matches(self, updater_lib, rf"-u {env_name}")
        assert_matches(self, signing_lib, r"macos_notarize_app_bundle\(\)")
        assert_matches(self, signing_lib, r'ditto -c -k --sequesterRsrc --keepParent')
        assert_matches(self, signing_lib, r'xcrun stapler staple "\$\{app_path\}"')

    def test_windows_build_scripts_no_longer_shell_out_to_node_for_plan_generation(self) -> None:
        tray_script = read("scripts/build-tray-windows.ps1")
        msi_script = read("scripts/build-windows-msi.ps1")

        assert_matches(self, tray_script, r"function Get-WindowsTrayBuildPlan")
        assert_matches(self, tray_script, r'\$TargetTriple = \$env:TRAPEZOHE_WINDOWS_TARGET')
        assert_matches(self, tray_script, r'\$DefaultWindowsTarget = "x86_64-pc-windows-msvc"')
        assert_matches(self, tray_script, r'@\("xwin"\) \+ \$cargoArgs \+ @\("--target", \$finalTarget\)')
        assert_matches(self, tray_script, r'"tray/target/\$finalTarget/release/\$TrayExeName"')
        assert_not_matches(self, tray_script, r'& node ')

        assert_matches(self, msi_script, r"function Get-WindowsMsiBuildPlan")
        assert_matches(self, msi_script, r"function Render-WindowsMsiSource")
        assert_matches(self, msi_script, r'\$WindowsInstallerFolderName = "TrapezoheCompanion"')
        assert_matches(self, msi_script, r'if \(\$SchemaVersion -eq "wix4"\)')
        assert_matches(self, msi_script, r'if \(\$SchemaVersion -ne "wix3"\)')
        assert_not_matches(self, msi_script, r'& node ')

    def test_github_macos_release_flow_writes_signing_env_file_and_uses_it(self) -> None:
        workflow = read(".github/workflows/release-installers.yml")
        signing_lib = read("scripts/lib/macos-signing.sh")

        assert_matches(self, workflow, r'env:\s+APPLE_ID: \$\{\{ secrets\.APPLE_ID \}\}[\s\S]+APPLE_DEVELOPER_ID_APP_P12_BASE64: \$\{\{ secrets\.APPLE_DEVELOPER_ID_APP_P12_BASE64 \}\}')
        assert_matches(self, workflow, r'APPLE_DEVELOPER_ID_APP_P12_PASSWORD: \$\{\{ secrets\.APPLE_DEVELOPER_ID_APP_P12_PASSWORD \}\}')
        assert_matches(self, workflow, r'APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64: \$\{\{ secrets\.APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64 \}\}')
        assert_matches(self, workflow, r'APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD: \$\{\{ secrets\.APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD \}\}')
        assert_matches(self, workflow, r"Validate macOS signing inputs")
        assert_matches(self, workflow, r"Missing required macOS signing secrets:")
        assert_matches(self, workflow, r"APPLE_DEVELOPER_ID_APP_P12_BASE64")
        assert_matches(self, workflow, r"TAURI_SIGNING_PRIVATE_KEY")
        assert_matches(self, workflow, r"brew --prefix openssl@3")
        assert_matches(self, workflow, r"brew install openssl@3")
        assert_matches(self, workflow, r'OPENSSL_BIN="\$\{BREW_OPENSSL_PREFIX\}/bin/openssl"')
        assert_matches(self, workflow, r'"\$\{OPENSSL_BIN\}" version')
        assert_matches(self, workflow, r"base64\.b64decode\(value, validate=True\)")
        assert_matches(self, workflow, r"decoded to 0 bytes")
        assert_matches(self, workflow, r'"\$\{OPENSSL_BIN\}" pkcs12 -legacy[\s\S]+-in "\$\{APP_P12\}"')
        assert_matches(self, workflow, r'APP_PEM="\$\{RUNNER_TEMP\}/developer-id-app\.pem"')
        assert_matches(self, workflow, r'INSTALLER_PEM="\$\{RUNNER_TEMP\}/developer-id-installer\.pem"')
        assert_matches(self, workflow, r'security import "\$\{APP_PEM\}"[\s\S]+-k "\$\{KEYCHAIN_PATH\}"')
        assert_matches(self, workflow, r'security import "\$\{INSTALLER_PEM\}"[\s\S]+-k "\$\{KEYCHAIN_PATH\}"')
        assert_matches(self, workflow, r"DETECTED_APPLE_DEVELOPER_ID_APP_IDENTITY")
        assert_matches(self, workflow, r"DETECTED_APPLE_DEVELOPER_ID_INSTALLER_IDENTITY")
        assert_matches(self, workflow, r'SIGNING_ENV_FILE="\$\{RUNNER_TEMP\}/trapezohe-macos-signing\.env"')
        assert_matches(self, workflow, r'APP_IDENTITY="\$\{APPLE_DEVELOPER_ID_APP_IDENTITY:-\$\{DETECTED_APPLE_DEVELOPER_ID_APP_IDENTITY:-\}\}"')
        assert_matches(self, workflow, r'INSTALLER_IDENTITY="\$\{APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-\$\{DETECTED_APPLE_DEVELOPER_ID_INSTALLER_IDENTITY:-\}\}"')
        assert_matches(self, workflow, r"printf 'export APPLE_DEVELOPER_ID_APP_IDENTITY=%q\\n' \"\$\{APP_IDENTITY\}\"")
        assert_matches(self, workflow, r"printf 'export APPLE_DEVELOPER_ID_INSTALLER_IDENTITY=%q\\n' \"\$\{INSTALLER_IDENTITY\}\"")
        assert_matches(self, workflow, r'TAURI_KEY_FILE="\$\{RUNNER_TEMP\}/tauri-updater-signing-key"')
        assert_matches(self, workflow, r"printf '%s' \"\$\{TAURI_SIGNING_PRIVATE_KEY\}\" > \"\$\{TAURI_KEY_FILE\}\"")
        assert_matches(self, workflow, r"printf 'export TAURI_PRIVATE_KEY_PATH=%q\\n' \"\$\{TAURI_KEY_FILE\}\"")
        assert_matches(self, workflow, r"printf 'export TAURI_PRIVATE_KEY_PASSWORD=%q\\n' \"\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-\}\"")
        assert_matches(self, workflow, r'echo "TRAPEZOHE_MACOS_SIGNING_ENV_FILE=\$\{SIGNING_ENV_FILE\}" >> "\$GITHUB_ENV"')
        assert_matches(self, workflow, r'echo "TRAPEZOHE_UPDATER_ENV_FILE=\$\{SIGNING_ENV_FILE\}" >> "\$GITHUB_ENV"')
        assert_matches(self, workflow, r'rm -f "\$\{RUNNER_TEMP\}/tauri-updater-signing-key" \|\| true')
        assert_matches(self, workflow, r'rm -f "\$\{RUNNER_TEMP\}/developer-id-app\.p12" "\$\{RUNNER_TEMP\}/developer-id-installer\.p12" "\$\{RUNNER_TEMP\}/developer-id-app\.pem" "\$\{RUNNER_TEMP\}/developer-id-installer\.pem" \|\| true')
        assert_matches(self, workflow, r"Verify signed macOS release artifacts")
        assert_matches(self, workflow, r"xcrun stapler validate dist/installers/trapezohe-companion-macos\.pkg")
        assert_matches(self, workflow, r'latest = json\.loads\(Path\("dist/installers/latest\.json"\)\.read_text\(\)\)')
        assert_matches(self, signing_lib, r'source "\$\{TRAPEZOHE_MACOS_SIGNING_ENV_FILE\}"')


class TauriUpdaterSignerTests(unittest.TestCase):
    def _write_executable(self, path: Path, body: str) -> None:
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)

    def _run_tauri_sign(self, *, temp_dir: Path, fake_npx_body: str, exports: dict[str, str], expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        updater_lib_path = ROOT / "scripts/lib/tauri-updater.sh"
        fake_bin_dir = temp_dir / "bin"
        fake_bin_dir.mkdir(parents=True, exist_ok=True)
        archive_path = temp_dir / "artifact.tar.gz"
        signature_path = temp_dir / "artifact.tar.gz.sig.out"
        archive_path.write_text("archive", encoding="utf-8")
        self._write_executable(fake_bin_dir / "npx", fake_npx_body)

        export_lines = [f"export {key}='{value}'" for key, value in exports.items()]
        script = textwrap.dedent(
            f'''
            set -euo pipefail
            PATH="{fake_bin_dir}:$PATH"
            source "{updater_lib_path}"
            {'\n'.join(export_lines)}
            tauri_sign_archive "{archive_path}" "{signature_path}"
            '''
        )
        return run_bash(script, check=expect_success)

    def test_tauri_signer_strips_conflicting_private_key_env_vars(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            capture_path = temp_dir / "capture.txt"
            archive_path = temp_dir / "artifact.tar.gz"
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                {{
                  printf 'TAURI_SIGNING_PRIVATE_KEY=%s\\n' "${{TAURI_SIGNING_PRIVATE_KEY-__UNSET__}}"
                  printf 'TAURI_SIGNING_PRIVATE_KEY_PATH=%s\\n' "${{TAURI_SIGNING_PRIVATE_KEY_PATH-__UNSET__}}"
                  printf 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%s\\n' "${{TAURI_SIGNING_PRIVATE_KEY_PASSWORD-__UNSET__}}"
                  printf 'TAURI_PRIVATE_KEY=%s\\n' "${{TAURI_PRIVATE_KEY-__UNSET__}}"
                  printf 'TAURI_PRIVATE_KEY_PATH=%s\\n' "${{TAURI_PRIVATE_KEY_PATH-__UNSET__}}"
                  printf 'TAURI_PRIVATE_KEY_PASSWORD=%s\\n' "${{TAURI_PRIVATE_KEY_PASSWORD-__UNSET__}}"
                  printf 'ARGS=%s\\n' "$*"
                }} > "{capture_path}"
                printf 'signed' > "${{@: -1}}.sig"
                '''
            )
            result = self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={
                    "TAURI_SIGNING_PRIVATE_KEY": "inline-private-key",
                    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "EMPTY",
                },
            )
            self.assertEqual(result.returncode, 0)
            capture = capture_path.read_text(encoding="utf-8")
            for env_name in [
                "TAURI_SIGNING_PRIVATE_KEY",
                "TAURI_SIGNING_PRIVATE_KEY_PATH",
                "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
                "TAURI_PRIVATE_KEY",
                "TAURI_PRIVATE_KEY_PATH",
                "TAURI_PRIVATE_KEY_PASSWORD",
            ]:
                assert_matches(self, capture, rf"{env_name}=__UNSET__")
            assert_matches(self, capture, r"ARGS=-y @tauri-apps/cli@2\.10\.1 signer sign -f ")
            assert_matches(self, capture, rf"ARGS=.*{re.escape(str(archive_path))}")

    def test_tauri_signer_encodes_raw_minisign_secret_key_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "source.key"
            copied_key_path = temp_dir / "copied.key"
            source_key_path.write_text("untrusted comment: minisign secret key\nABCDEF123456\n", encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={
                    "TAURI_PRIVATE_KEY_PATH": str(source_key_path),
                    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "EMPTY",
                },
            )
            expected = base64.b64encode(source_key_path.read_bytes()).decode("utf-8")
            self.assertEqual(copied_key_path.read_text(encoding="utf-8"), expected)

    def test_tauri_signer_compacts_wrapped_base64_key_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-space-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "wrapped.key"
            copied_key_path = temp_dir / "copied.key"
            base64_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="
            source_key_path.write_text("'dW50cn VzdGVk\nIGNvbW1l bnQ6IHJz\naWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=='\n", encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
            )
            self.assertEqual(copied_key_path.read_text(encoding="utf-8"), base64_key)

    def test_tauri_signer_removes_embedded_quote_characters_from_wrapped_base64(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-quote-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "quoted-lines.key"
            copied_key_path = temp_dir / "copied.key"
            base64_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="
            source_key_path.write_text('"dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu"\n"IGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="\n', encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
            )
            self.assertEqual(copied_key_path.read_text(encoding="utf-8"), base64_key)

    def test_tauri_signer_encodes_raw_key_headers_even_when_spaces_were_replaced(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-underscore-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "underscore.key"
            copied_key_path = temp_dir / "copied.key"
            raw_key = "untrusted_comment:_minisign_secret_key\nABCDEF123456\n"
            source_key_path.write_text(raw_key, encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
            )
            expected = base64.b64encode(b"untrusted comment: minisign secret key\nABCDEF123456\n").decode("utf-8")
            self.assertEqual(copied_key_path.read_text(encoding="utf-8"), expected)

    def test_tauri_signer_converts_url_safe_base64_variants_back_to_standard(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-urlsafe-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "urlsafe.key"
            copied_key_path = temp_dir / "copied.key"
            standard_base64_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="
            url_safe_base64_key = standard_base64_key.replace("/", "_").replace("+", "-")
            source_key_path.write_text(url_safe_base64_key, encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
            )
            self.assertEqual(copied_key_path.read_text(encoding="utf-8"), standard_base64_key)

    def test_tauri_signer_strips_single_wrapping_quote_pair(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-quoted-key-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "quoted.key"
            copied_key_path = temp_dir / "copied.key"
            source_key_path.write_text('"dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg=="\n', encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                f'''#!/usr/bin/env bash
                set -euo pipefail
                key_path=""
                archive_path=""
                while [[ "$#" -gt 0 ]]; do
                  if [[ "$1" == "-f" ]]; then
                    key_path="$2"
                    shift 2
                    continue
                  fi
                  archive_path="$1"
                  shift
                done
                cp "$key_path" "{copied_key_path}"
                printf 'signed' > "$archive_path.sig"
                '''
            )
            self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
            )
            self.assertEqual(
                copied_key_path.read_text(encoding="utf-8"),
                "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg==",
            )

    def test_tauri_signer_fails_early_on_invalid_base64_padding(self) -> None:
        with tempfile.TemporaryDirectory(prefix="trapezohe-updater-key-invalid-padding-test-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            source_key_path = temp_dir / "invalid-padding.key"
            source_key_path.write_text("YWJjZA==ZWY=", encoding="utf-8")
            fake_npx_body = textwrap.dedent(
                """#!/usr/bin/env bash
                set -euo pipefail
                printf 'signed' > "$1.sig"
                """
            )
            result = self._run_tauri_sign(
                temp_dir=temp_dir,
                fake_npx_body=fake_npx_body,
                exports={"TAURI_PRIVATE_KEY_PATH": str(source_key_path)},
                expect_success=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "Updater key secret is malformed: found '=' padding before the end of the base64 payload",
                result.stderr + result.stdout,
            )


if __name__ == "__main__":
    unittest.main()
