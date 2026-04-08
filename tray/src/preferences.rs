use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::models::DisplayLanguage;

const CURRENT_CONFIG_DIR_NAME: &str = "GhastAICompanion";
const LEGACY_CONFIG_DIR_NAME: &str = "TrapezoheCompanion";
const PREFERENCES_FILE_NAME: &str = "tray-preferences.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrayPreferences {
    #[serde(default)]
    pub language: DisplayLanguage,
}

impl Default for TrayPreferences {
    fn default() -> Self {
        Self {
            language: DisplayLanguage::En,
        }
    }
}

fn current_preferences_path(base: &Path) -> PathBuf {
    base.join(CURRENT_CONFIG_DIR_NAME)
        .join(PREFERENCES_FILE_NAME)
}

fn legacy_preferences_path(base: &Path) -> PathBuf {
    base.join(LEGACY_CONFIG_DIR_NAME)
        .join(PREFERENCES_FILE_NAME)
}

fn read_preferences(path: &Path) -> Result<TrayPreferences> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read tray preferences from {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse tray preferences from {}", path.display()))
}

fn write_preferences(path: &Path, preferences: &TrayPreferences) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let body = format!("{}\n", serde_json::to_string_pretty(preferences)?);
    std::fs::write(path, body)
        .with_context(|| format!("Failed to write tray preferences to {}", path.display()))
}

fn cleanup_legacy_preferences(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    std::fs::remove_file(path).with_context(|| {
        format!(
            "Failed to remove legacy tray preferences at {}",
            path.display()
        )
    })?;

    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }

    Ok(())
}

fn load_preferences_with_migration(
    current_path: &Path,
    legacy_path: &Path,
) -> Result<TrayPreferences> {
    if current_path.exists() {
        return read_preferences(current_path);
    }

    if legacy_path.exists() {
        let preferences = read_preferences(legacy_path)?;
        write_preferences(current_path, &preferences)?;
        cleanup_legacy_preferences(legacy_path)?;
        return Ok(preferences);
    }

    Ok(TrayPreferences::default())
}

fn save_preferences_with_cleanup(
    current_path: &Path,
    legacy_path: &Path,
    preferences: &TrayPreferences,
) -> Result<()> {
    write_preferences(current_path, preferences)?;
    if legacy_path != current_path {
        cleanup_legacy_preferences(legacy_path)?;
    }
    Ok(())
}

pub fn load_preferences() -> Result<TrayPreferences> {
    let base = dirs::config_dir().context("Failed to resolve config directory")?;
    let current_path = current_preferences_path(&base);
    let legacy_path = legacy_preferences_path(&base);
    load_preferences_with_migration(&current_path, &legacy_path)
}

pub fn save_preferences(preferences: &TrayPreferences) -> Result<()> {
    let base = dirs::config_dir().context("Failed to resolve config directory")?;
    let current_path = current_preferences_path(&base);
    let legacy_path = legacy_preferences_path(&base);
    save_preferences_with_cleanup(&current_path, &legacy_path, preferences)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_to_english() {
        assert_eq!(TrayPreferences::default().language, DisplayLanguage::En);
    }

    #[test]
    fn migrates_legacy_preferences_into_current_directory() {
        let temp = tempdir().expect("create temp dir");
        let current_path = current_preferences_path(temp.path());
        let legacy_path = legacy_preferences_path(temp.path());
        let legacy_preferences = TrayPreferences {
            language: DisplayLanguage::Zh,
        };

        write_preferences(&legacy_path, &legacy_preferences).expect("write legacy preferences");

        let loaded = load_preferences_with_migration(&current_path, &legacy_path)
            .expect("load preferences with migration");

        assert_eq!(loaded, legacy_preferences);
        assert!(
            current_path.exists(),
            "current preferences file should be created"
        );
        assert!(
            !legacy_path.exists(),
            "legacy preferences file should be removed after migration"
        );
    }

    #[test]
    fn save_prefers_current_directory_and_cleans_up_legacy_copy() {
        let temp = tempdir().expect("create temp dir");
        let current_path = current_preferences_path(temp.path());
        let legacy_path = legacy_preferences_path(temp.path());
        let preferences = TrayPreferences {
            language: DisplayLanguage::Zh,
        };

        write_preferences(&legacy_path, &TrayPreferences::default())
            .expect("write legacy preferences");
        save_preferences_with_cleanup(&current_path, &legacy_path, &preferences)
            .expect("save preferences");

        let saved = read_preferences(&current_path).expect("read current preferences");
        assert_eq!(saved, preferences);
        assert!(
            !legacy_path.exists(),
            "legacy preferences file should be removed after save"
        );
    }
}
