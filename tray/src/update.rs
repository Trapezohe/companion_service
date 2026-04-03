#[cfg(not(target_os = "macos"))]
use anyhow::anyhow;
use anyhow::Result;
#[cfg(not(target_os = "macos"))]
use reqwest::Client;
#[cfg(not(target_os = "macos"))]
use serde::Deserialize;
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "macos"))]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Wry};
#[cfg(target_os = "macos")]
use tauri_plugin_updater::UpdaterExt;

use crate::models::UpdateInfo;

#[cfg(not(target_os = "macos"))]
const GITHUB_API_URL: &str =
    "https://api.github.com/repos/Trapezohe/companion_service/releases/latest";
pub const RELEASES_PAGE_URL: &str = "https://github.com/Trapezohe/companion_service/releases";
#[allow(dead_code)]
pub const RELEASES_LATEST_JSON_URL: &str =
    "https://github.com/Trapezohe/companion_service/releases/latest/download/latest.json";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(not(target_os = "macos"))]
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStatus {
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    Installed,
    Error,
}

impl UpdateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::UpToDate => "up_to_date",
            Self::Available => "available",
            Self::Downloading => "downloading",
            Self::Installing => "installing",
            Self::Installed => "installed",
            Self::Error => "error",
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let cleaned = version.strip_prefix('v').unwrap_or(version);
    let parts: Vec<&str> = cleaned.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

#[cfg(not(target_os = "macos"))]
fn is_newer(latest: &str, current: &str) -> bool {
    let Some(latest) = parse_version(latest) else {
        return false;
    };
    let Some(current) = parse_version(current) else {
        return false;
    };
    latest > current
}

#[cfg(not(target_os = "macos"))]
fn platform_asset_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        ".msi"
    } else {
        ".tar.gz"
    }
}

#[cfg(not(target_os = "macos"))]
fn find_platform_download(assets: &[GitHubAsset]) -> Option<String> {
    let suffix = platform_asset_suffix();
    assets
        .iter()
        .find(|a| a.name.ends_with(suffix))
        .map(|a| a.browser_download_url.clone())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn release_url_for_version(version: &str) -> String {
    let tag = version.strip_prefix('v').unwrap_or(version);
    format!(
        "https://github.com/Trapezohe/companion_service/releases/tag/v{}",
        tag
    )
}

pub fn checking_update_info(current_version: &str) -> UpdateInfo {
    UpdateInfo {
        available: false,
        can_install: false,
        current_version: current_version.to_string(),
        latest_version: current_version.to_string(),
        release_url: RELEASES_PAGE_URL.to_string(),
        download_url: None,
        release_notes: None,
        checked_at_ms: now_ms(),
        status: UpdateStatus::Checking.as_str().to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        last_error: None,
    }
}

fn up_to_date_info(current_version: &str) -> UpdateInfo {
    UpdateInfo {
        status: UpdateStatus::UpToDate.as_str().to_string(),
        checked_at_ms: now_ms(),
        ..checking_update_info(current_version)
    }
}

fn with_error(mut info: UpdateInfo, message: impl Into<String>) -> UpdateInfo {
    info.status = UpdateStatus::Error.as_str().to_string();
    info.last_error = Some(message.into());
    info.can_install = false;
    info.checked_at_ms = now_ms();
    info
}

#[cfg(target_os = "macos")]
fn macos_update_info(current_version: &str, update: &tauri_plugin_updater::Update) -> UpdateInfo {
    UpdateInfo {
        available: true,
        can_install: true,
        current_version: current_version.to_string(),
        latest_version: update.version.clone(),
        release_url: release_url_for_version(&update.version),
        download_url: Some(update.download_url.to_string()),
        release_notes: update.body.clone().filter(|body| !body.trim().is_empty()),
        checked_at_ms: now_ms(),
        status: UpdateStatus::Available.as_str().to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        last_error: None,
    }
}

#[cfg(not(target_os = "macos"))]
async fn manual_check_for_update(current_version: &str) -> Result<UpdateInfo> {
    let client = Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .user_agent(format!("trapezohe-companion-tray/{}", current_version))
        .build()?;

    let response = client
        .get(GITHUB_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!("GitHub API returned status {}", response.status()));
    }

    let release: GitHubRelease = response.json().await?;
    let latest_version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    let available = is_newer(&latest_version, current_version);

    Ok(UpdateInfo {
        available,
        can_install: false,
        current_version: current_version.to_string(),
        latest_version: latest_version.clone(),
        release_url: release.html_url,
        download_url: find_platform_download(&release.assets),
        release_notes: release.body.filter(|body| !body.trim().is_empty()),
        checked_at_ms: now_ms(),
        status: if available {
            UpdateStatus::Available.as_str().to_string()
        } else {
            UpdateStatus::UpToDate.as_str().to_string()
        },
        downloaded_bytes: 0,
        total_bytes: None,
        last_error: None,
    })
}

pub async fn check_for_update(app: &AppHandle<Wry>, current_version: &str) -> Result<UpdateInfo> {
    #[cfg(target_os = "macos")]
    {
        let update = app.updater_builder().build()?.check().await?;
        return Ok(match update {
            Some(update) => macos_update_info(current_version, &update),
            None => up_to_date_info(current_version),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        manual_check_for_update(current_version).await
    }
}

pub async fn install_update(
    app: &AppHandle<Wry>,
    current_version: &str,
    emit_progress: Arc<dyn Fn(UpdateInfo) + Send + Sync>,
) -> Result<UpdateInfo> {
    #[cfg(target_os = "macos")]
    {
        let Some(update) = app.updater_builder().build()?.check().await? else {
            return Ok(up_to_date_info(current_version));
        };

        let base_info = macos_update_info(current_version, &update);
        let progress_state = Arc::new(Mutex::new((0_u64, None::<u64>)));

        emit_progress(UpdateInfo {
            status: UpdateStatus::Downloading.as_str().to_string(),
            can_install: false,
            ..base_info.clone()
        });

        let download_state = Arc::clone(&progress_state);
        let download_emit = Arc::clone(&emit_progress);
        let download_base = base_info.clone();
        let install_emit = Arc::clone(&emit_progress);
        let install_base = base_info.clone();

        update
            .download_and_install(
                move |chunk_length, content_length| {
                    if let Ok(mut guard) = download_state.lock() {
                        guard.0 = guard.0.saturating_add(chunk_length as u64);
                        if guard.1.is_none() {
                            guard.1 = content_length;
                        }

                        download_emit(UpdateInfo {
                            status: UpdateStatus::Downloading.as_str().to_string(),
                            can_install: false,
                            downloaded_bytes: guard.0,
                            total_bytes: guard.1,
                            checked_at_ms: now_ms(),
                            ..download_base.clone()
                        });
                    }
                },
                move || {
                    install_emit(UpdateInfo {
                        status: UpdateStatus::Installing.as_str().to_string(),
                        can_install: false,
                        checked_at_ms: now_ms(),
                        ..install_base.clone()
                    });
                },
            )
            .await?;

        return Ok(UpdateInfo {
            available: false,
            can_install: false,
            status: UpdateStatus::Installed.as_str().to_string(),
            checked_at_ms: now_ms(),
            ..base_info
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = emit_progress;
        Err(anyhow!(
            "In-app updates are currently only enabled for the macOS tray app"
        ))
    }
}

pub fn install_failure_info(previous: Option<UpdateInfo>, current_version: &str, error: &str) -> UpdateInfo {
    match previous {
        Some(info) => with_error(info, error),
        None => with_error(checking_update_info(current_version), error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_urls_are_tag_stable() {
        assert_eq!(
            release_url_for_version("0.1.16"),
            "https://github.com/Trapezohe/companion_service/releases/tag/v0.1.16"
        );
        assert_eq!(
            release_url_for_version("v0.1.17"),
            "https://github.com/Trapezohe/companion_service/releases/tag/v0.1.17"
        );
    }

    #[test]
    fn checking_state_exposes_non_installable_status() {
        let info = checking_update_info("0.1.16");
        assert_eq!(info.status, "checking");
        assert!(!info.can_install);
        assert!(!info.available);
    }

    #[test]
    fn install_failure_marks_state_as_error() {
        let info = install_failure_info(None, "0.1.16", "network failed");
        assert_eq!(info.status, "error");
        assert_eq!(info.last_error.as_deref(), Some("network failed"));
        assert!(!info.can_install);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn parses_valid_versions() {
        assert_eq!(parse_version("0.1.2"), Some((0, 1, 2)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("10.20.30"), Some((10, 20, 30)));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn rejects_invalid_versions() {
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version(""), None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn detects_newer_version() {
        assert!(is_newer("0.2.0", "0.1.2"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.1.3", "0.1.2"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn detects_same_or_older_version() {
        assert!(!is_newer("0.1.2", "0.1.2"));
        assert!(!is_newer("0.1.1", "0.1.2"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn finds_platform_asset() {
        let assets = vec![
            GitHubAsset {
                name: "trapezohe-companion-macos.pkg".into(),
                browser_download_url: "https://example.com/macos.pkg".into(),
            },
            GitHubAsset {
                name: "trapezohe-companion-windows.msi".into(),
                browser_download_url: "https://example.com/windows.msi".into(),
            },
            GitHubAsset {
                name: "SHA256SUMS.txt".into(),
                browser_download_url: "https://example.com/sha256".into(),
            },
        ];

        let result = find_platform_download(&assets);
        assert!(result.is_some());
        let url = result.unwrap();
        if cfg!(target_os = "windows") {
            assert!(url.contains("windows.msi"));
        } else {
            assert!(url.contains("macos.pkg") || url.contains("windows.msi"));
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn returns_none_when_no_matching_asset() {
        let assets = vec![GitHubAsset {
            name: "README.md".into(),
            browser_download_url: "https://example.com/readme".into(),
        }];
        assert!(find_platform_download(&assets).is_none());
    }
}
