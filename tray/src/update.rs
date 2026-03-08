use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::models::UpdateInfo;

const GITHUB_API_URL: &str =
    "https://api.github.com/repos/Trapezohe/companion_service/releases/latest";

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

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

fn is_newer(latest: &str, current: &str) -> bool {
    let Some(latest) = parse_version(latest) else {
        return false;
    };
    let Some(current) = parse_version(current) else {
        return false;
    };
    latest > current
}

fn platform_asset_suffix() -> &'static str {
    if cfg!(target_os = "macos") {
        ".pkg"
    } else if cfg!(target_os = "windows") {
        ".msi"
    } else {
        ".tar.gz"
    }
}

fn find_platform_download(assets: &[GitHubAsset]) -> Option<String> {
    let suffix = platform_asset_suffix();
    assets
        .iter()
        .find(|a| a.name.ends_with(suffix))
        .map(|a| a.browser_download_url.clone())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub async fn check_for_update(current_version: &str) -> Result<UpdateInfo> {
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .user_agent(format!(
            "trapezohe-companion-tray/{}",
            current_version
        ))
        .build()?;

    let response = client
        .get(GITHUB_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "GitHub API returned status {}",
            response.status()
        ));
    }

    let release: GitHubRelease = response.json().await?;
    let latest_version = release.tag_name.strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    let available = is_newer(&latest_version, current_version);

    Ok(UpdateInfo {
        available,
        current_version: current_version.to_string(),
        latest_version,
        release_url: release.html_url,
        download_url: find_platform_download(&release.assets),
        release_notes: release.body.filter(|b| !b.trim().is_empty()),
        checked_at_ms: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_versions() {
        assert_eq!(parse_version("0.1.2"), Some((0, 1, 2)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("10.20.30"), Some((10, 20, 30)));
    }

    #[test]
    fn rejects_invalid_versions() {
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn detects_newer_version() {
        assert!(is_newer("0.2.0", "0.1.2"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.1.3", "0.1.2"));
    }

    #[test]
    fn detects_same_or_older_version() {
        assert!(!is_newer("0.1.2", "0.1.2"));
        assert!(!is_newer("0.1.1", "0.1.2"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

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
        if cfg!(target_os = "macos") {
            assert!(url.contains("macos.pkg"));
        } else if cfg!(target_os = "windows") {
            assert!(url.contains("windows.msi"));
        }
    }

    #[test]
    fn returns_none_when_no_matching_asset() {
        let assets = vec![GitHubAsset {
            name: "README.md".into(),
            browser_download_url: "https://example.com/readme".into(),
        }];
        assert!(find_platform_download(&assets).is_none());
    }
}
