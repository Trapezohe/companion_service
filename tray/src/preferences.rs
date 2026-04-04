use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::models::DisplayLanguage;

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

fn preferences_path() -> Result<PathBuf> {
    let base = dirs::config_dir().context("Failed to resolve config directory")?;
    Ok(base
        .join("TrapezoheCompanion")
        .join("tray-preferences.json"))
}

pub fn load_preferences() -> Result<TrayPreferences> {
    let path = preferences_path()?;
    if !path.exists() {
        return Ok(TrayPreferences::default());
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read tray preferences from {}", path.display()))?;
    Ok(serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse tray preferences from {}", path.display()))?)
}

pub fn save_preferences(preferences: &TrayPreferences) -> Result<()> {
    let path = preferences_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let body = format!("{}\n", serde_json::to_string_pretty(preferences)?);
    std::fs::write(&path, body)
        .with_context(|| format!("Failed to write tray preferences to {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_english() {
        assert_eq!(TrayPreferences::default().language, DisplayLanguage::En);
    }
}
