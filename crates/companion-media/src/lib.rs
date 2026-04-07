use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

const HEIC_MIME_TYPES: &[&str] = &["image/heic", "image/heif"];
const GENERIC_MIME_TYPES: &[&str] = &["application/octet-stream"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSupport {
    pub available: bool,
    pub engine: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeImageRequest {
    pub name: String,
    pub mime_type: String,
    pub bytes_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageNormalizationMeta {
    pub status: String,
    pub source_mime_type: String,
    pub output_mime_type: String,
    pub via: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePipelineHints {
    pub source: String,
    pub summary: String,
    pub ocr_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeImageResponse {
    pub changed: bool,
    pub name: String,
    pub mime_type: String,
    pub bytes_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalization: Option<ImageNormalizationMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_hints: Option<ImagePipelineHints>,
}

#[derive(Debug, Clone)]
pub struct ConvertRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub support: MediaSupport,
}

#[derive(Debug, Clone, Default)]
pub struct ConvertResponse {
    pub bytes: Option<Vec<u8>>,
    pub mime_type: Option<String>,
    pub name: Option<String>,
    pub engine: Option<String>,
}

#[derive(Clone, Copy)]
enum ConverterKind {
    Sips,
    Magick,
}

fn normalize_mime_type(mime_type: &str) -> Option<String> {
    mime_type
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn file_extension(file_name: &str) -> Option<&'static str> {
    let trimmed = file_name.trim().to_ascii_lowercase();
    if trimmed.ends_with(".jpg") {
        Some("image/jpeg")
    } else if trimmed.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if trimmed.ends_with(".png") {
        Some("image/png")
    } else if trimmed.ends_with(".webp") {
        Some("image/webp")
    } else if trimmed.ends_with(".gif") {
        Some("image/gif")
    } else if trimmed.ends_with(".bmp") {
        Some("image/bmp")
    } else if trimmed.ends_with(".avif") {
        Some("image/avif")
    } else if trimmed.ends_with(".pdf") {
        Some("application/pdf")
    } else if trimmed.ends_with(".heic") {
        Some("image/heic")
    } else if trimmed.ends_with(".heif") {
        Some("image/heif")
    } else {
        None
    }
}

fn resolve_source_mime_type(mime_type: &str, file_name: &str) -> Option<String> {
    let normalized = normalize_mime_type(mime_type);
    let extension_mime = file_extension(file_name).map(str::to_string);
    match normalized {
        None => extension_mime,
        Some(value) if GENERIC_MIME_TYPES.contains(&value.as_str()) => {
            extension_mime.or(Some(value))
        }
        Some(value) => Some(value),
    }
}

pub fn should_normalize_mime_type(mime_type: &str, file_name: &str) -> bool {
    resolve_source_mime_type(mime_type, file_name)
        .map(|value| HEIC_MIME_TYPES.contains(&value.as_str()))
        .unwrap_or(false)
}

fn replace_extension(name: &str, next_extension: &str) -> String {
    let trimmed = name.trim();
    let normalized = if trimmed.is_empty() {
        "attachment"
    } else {
        trimmed
    };
    if let Some(index) = normalized.rfind('.') {
        if index > 0 {
            return format!("{}{}", &normalized[..index], next_extension);
        }
    }
    format!("{normalized}{next_extension}")
}

fn run_process(command: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(command)
        .args(args)
        .output()
        .with_context(|| format!("Failed to spawn {command}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(anyhow!("{command} exited with code {}", output.status))
    } else {
        Err(anyhow!(
            "{command} exited with code {}: {stderr}",
            output.status
        ))
    }
}

fn file_exists(target: &Path) -> bool {
    target.exists()
}

pub fn probe_media_normalization_support() -> MediaSupport {
    if cfg!(target_os = "macos") && file_exists(Path::new("/usr/bin/sips")) {
        return MediaSupport {
            available: true,
            engine: Some("sips".to_string()),
            reason: None,
        };
    }
    if run_process("magick", &["--version"]).is_ok() {
        return MediaSupport {
            available: true,
            engine: Some("magick".to_string()),
            reason: None,
        };
    }
    MediaSupport {
        available: false,
        engine: None,
        reason: Some("no_supported_image_converter".to_string()),
    }
}

fn convert_with_sips(input_path: &Path, output_path: &Path) -> Result<ConvertResponse> {
    let input = input_path.to_string_lossy().to_string();
    let output = output_path.to_string_lossy().to_string();
    run_process(
        "/usr/bin/sips",
        &["-s", "format", "jpeg", &input, "--out", &output],
    )?;
    Ok(ConvertResponse {
        engine: Some("sips".to_string()),
        ..ConvertResponse::default()
    })
}

fn convert_with_magick(input_path: &Path, output_path: &Path) -> Result<ConvertResponse> {
    let input = input_path.to_string_lossy().to_string();
    let output = output_path.to_string_lossy().to_string();
    run_process("magick", &[&input, &output])?;
    Ok(ConvertResponse {
        engine: Some("magick".to_string()),
        ..ConvertResponse::default()
    })
}

fn build_image_pipeline_hints(
    source_mime_type: &str,
    output_mime_type: &str,
    engine: &str,
    status: &str,
    note: Option<&str>,
) -> ImagePipelineHints {
    let summary = match status {
        "normalized" => format!(
            "Image normalized from {source_mime_type} to {output_mime_type} via {engine}. OCR hook not enabled yet."
        ),
        "failed" => {
            let detail = note.unwrap_or_default().trim();
            if detail.is_empty() {
                format!(
                    "Image normalization failed; retained as {output_mime_type}. OCR hook not enabled yet."
                )
            } else {
                format!(
                    "Image normalization failed ({detail}); retained as {output_mime_type}. OCR hook not enabled yet."
                )
            }
        }
        _ => format!("Image retained as {output_mime_type}. OCR hook not enabled yet."),
    };
    ImagePipelineHints {
        source: "image".to_string(),
        summary,
        ocr_ready: false,
    }
}

fn build_unchanged_result(
    name: String,
    mime_type: String,
    bytes_base64: String,
    normalization: ImageNormalizationMeta,
) -> NormalizeImageResponse {
    let engine = normalization
        .engine
        .clone()
        .or_else(|| Some(normalization.via.clone()))
        .unwrap_or_else(|| "none".to_string());
    let note = normalization.note.clone();
    let status = normalization.status.clone();
    let source_mime_type = normalization.source_mime_type.clone();
    let output_mime_type = normalization.output_mime_type.clone();
    NormalizeImageResponse {
        changed: false,
        name,
        mime_type,
        bytes_base64,
        pipeline_hints: Some(build_image_pipeline_hints(
            &source_mime_type,
            &output_mime_type,
            &engine,
            &status,
            note.as_deref(),
        )),
        normalization: Some(normalization),
    }
}

fn converter_kind_for_support(support: &MediaSupport) -> Option<ConverterKind> {
    match support.engine.as_deref() {
        Some("sips") => Some(ConverterKind::Sips),
        Some("magick") => Some(ConverterKind::Magick),
        _ => None,
    }
}

pub fn normalize_image_payload(request: &NormalizeImageRequest) -> Result<NormalizeImageResponse> {
    normalize_image_payload_with::<fn(ConvertRequest) -> Result<ConvertResponse>>(
        request, None, None,
    )
}

pub fn normalize_image_payload_with<F>(
    request: &NormalizeImageRequest,
    support_override: Option<MediaSupport>,
    converter: Option<F>,
) -> Result<NormalizeImageResponse>
where
    F: FnOnce(ConvertRequest) -> Result<ConvertResponse>,
{
    let name = request.name.trim();
    let name = if name.is_empty() { "attachment" } else { name }.to_string();
    let requested_mime_type = request.mime_type.trim();
    let requested_mime_type = if requested_mime_type.is_empty() {
        "application/octet-stream"
    } else {
        requested_mime_type
    }
    .to_string();
    let bytes_base64 = request.bytes_base64.trim().to_string();
    if bytes_base64.is_empty() {
        anyhow::bail!("bytesBase64 is required.");
    }

    let source_mime_type = resolve_source_mime_type(&requested_mime_type, &name)
        .unwrap_or_else(|| requested_mime_type.clone());

    if !should_normalize_mime_type(&requested_mime_type, &name) {
        return Ok(build_unchanged_result(
            name,
            source_mime_type.clone(),
            bytes_base64,
            ImageNormalizationMeta {
                status: "unchanged".to_string(),
                source_mime_type: source_mime_type.clone(),
                output_mime_type: source_mime_type,
                via: "none".to_string(),
                engine: None,
                note: None,
            },
        ));
    }

    let support = support_override.unwrap_or_else(probe_media_normalization_support);
    let converter_kind = converter_kind_for_support(&support);
    if converter_kind.is_none() && converter.is_none() {
        return Ok(build_unchanged_result(
            name,
            source_mime_type.clone(),
            bytes_base64,
            ImageNormalizationMeta {
                status: "failed".to_string(),
                source_mime_type: source_mime_type.clone(),
                output_mime_type: source_mime_type,
                via: "companion".to_string(),
                engine: None,
                note: support
                    .reason
                    .clone()
                    .or_else(|| Some("converter_unavailable".to_string())),
            },
        ));
    }

    let temp_dir = TempDir::new().context("Failed to create media temp dir")?;
    let input_path = temp_dir.path().join(sanitize_file_name(&name));
    let output_name = replace_extension(&name, ".jpg");
    let output_path = temp_dir.path().join(sanitize_file_name(&output_name));
    let input_bytes = STANDARD
        .decode(&bytes_base64)
        .context("bytesBase64 must be valid base64.")?;
    fs::write(&input_path, &input_bytes)
        .with_context(|| format!("Failed to write source image: {}", input_path.display()))?;

    let converted = if let Some(custom_converter) = converter {
        custom_converter(ConvertRequest {
            input_path: input_path.clone(),
            output_path: output_path.clone(),
            name: name.clone(),
            mime_type: source_mime_type.clone(),
            bytes: input_bytes,
            support: support.clone(),
        })?
    } else {
        match converter_kind.expect("converter kind should exist when converter is absent") {
            ConverterKind::Sips => convert_with_sips(&input_path, &output_path)?,
            ConverterKind::Magick => convert_with_magick(&input_path, &output_path)?,
        }
    };

    let output_bytes = match converted.bytes {
        Some(bytes) => bytes,
        None => fs::read(&output_path).with_context(|| {
            format!("Failed to read normalized image: {}", output_path.display())
        })?,
    };
    let output_mime_type = converted
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("image/jpeg")
        .to_string();
    let final_name = converted
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&output_name)
        .to_string();
    let engine = converted
        .engine
        .or_else(|| support.engine.clone())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(NormalizeImageResponse {
        changed: true,
        name: final_name,
        mime_type: output_mime_type.clone(),
        bytes_base64: STANDARD.encode(output_bytes),
        normalization: Some(ImageNormalizationMeta {
            status: "normalized".to_string(),
            source_mime_type: source_mime_type.clone(),
            output_mime_type: output_mime_type.clone(),
            via: "companion".to_string(),
            engine: Some(engine.clone()),
            note: None,
        }),
        pipeline_hints: Some(build_image_pipeline_hints(
            &source_mime_type,
            &output_mime_type,
            &engine,
            "normalized",
            None,
        )),
    })
}

fn sanitize_file_name(name: &str) -> String {
    let candidate = name.trim();
    if candidate.is_empty() {
        return "attachment".to_string();
    }
    candidate
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' => '_',
            _ => ch,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_normalize_flags_heic_and_skips_other_types() {
        assert!(should_normalize_mime_type("image/heic", "photo.heic"));
        assert!(should_normalize_mime_type("image/heif", "photo.heif"));
        assert!(!should_normalize_mime_type("image/jpeg", "photo.jpg"));
        assert!(should_normalize_mime_type("", "photo.heic"));
        assert!(!should_normalize_mime_type("image/jpeg", "renamed.heic"));
    }

    #[test]
    fn normalize_rewrites_heic_payloads_to_jpeg_via_converter() {
        let payload = normalize_image_payload_with(
            &NormalizeImageRequest {
                name: "photo.heic".to_string(),
                mime_type: "image/heic".to_string(),
                bytes_base64: STANDARD.encode("heic-binary"),
            },
            None,
            Some(|input: ConvertRequest| {
                Ok(ConvertResponse {
                    bytes: Some(b"jpeg-binary".to_vec()),
                    mime_type: Some("image/jpeg".to_string()),
                    name: Some(input.name.replace(".heic", ".jpg")),
                    engine: Some("test-engine".to_string()),
                })
            }),
        )
        .unwrap();

        assert!(payload.changed);
        assert_eq!(payload.mime_type, "image/jpeg");
        assert_eq!(payload.name, "photo.jpg");
        assert_eq!(
            STANDARD.decode(payload.bytes_base64).unwrap(),
            b"jpeg-binary"
        );
        assert_eq!(
            payload.normalization,
            Some(ImageNormalizationMeta {
                status: "normalized".to_string(),
                source_mime_type: "image/heic".to_string(),
                output_mime_type: "image/jpeg".to_string(),
                via: "companion".to_string(),
                engine: Some("test-engine".to_string()),
                note: None,
            })
        );
        assert_eq!(
            payload.pipeline_hints,
            Some(ImagePipelineHints {
                source: "image".to_string(),
                summary: "Image normalized from image/heic to image/jpeg via test-engine. OCR hook not enabled yet.".to_string(),
                ocr_ready: false,
            })
        );
    }

    #[test]
    fn normalize_leaves_non_heic_payloads_unchanged() {
        let payload = normalize_image_payload(&NormalizeImageRequest {
            name: "photo.png".to_string(),
            mime_type: "image/png".to_string(),
            bytes_base64: STANDARD.encode("png-binary"),
        })
        .unwrap();

        assert!(!payload.changed);
        assert_eq!(payload.mime_type, "image/png");
        assert_eq!(payload.name, "photo.png");
        assert_eq!(
            STANDARD.decode(payload.bytes_base64).unwrap(),
            b"png-binary"
        );
        assert_eq!(
            payload.normalization.as_ref().unwrap().source_mime_type,
            "image/png"
        );
    }

    #[test]
    fn normalize_honors_heic_extension_when_mime_is_generic() {
        let payload = normalize_image_payload_with(
            &NormalizeImageRequest {
                name: "camera-roll.heic".to_string(),
                mime_type: "application/octet-stream".to_string(),
                bytes_base64: STANDARD.encode("heic-binary"),
            },
            None,
            Some(|_| {
                Ok(ConvertResponse {
                    bytes: Some(b"jpeg-binary".to_vec()),
                    mime_type: Some("image/jpeg".to_string()),
                    name: Some("camera-roll.jpg".to_string()),
                    engine: Some("test-engine".to_string()),
                })
            }),
        )
        .unwrap();

        assert!(payload.changed);
        assert_eq!(payload.name, "camera-roll.jpg");
        assert_eq!(payload.mime_type, "image/jpeg");
        assert_eq!(
            payload.normalization.as_ref().unwrap().source_mime_type,
            "image/heic"
        );
    }

    #[test]
    fn explicit_mime_type_beats_extension_fallback() {
        let payload = normalize_image_payload(&NormalizeImageRequest {
            name: "renamed.heic".to_string(),
            mime_type: "image/jpeg".to_string(),
            bytes_base64: STANDARD.encode("jpeg-binary"),
        })
        .unwrap();

        assert!(!payload.changed);
        assert_eq!(payload.mime_type, "image/jpeg");
        assert_eq!(
            payload.normalization.as_ref().unwrap().source_mime_type,
            "image/jpeg"
        );
    }

    #[test]
    fn generic_mime_resolves_common_extension() {
        let payload = normalize_image_payload(&NormalizeImageRequest {
            name: "photo.png".to_string(),
            mime_type: "application/octet-stream".to_string(),
            bytes_base64: STANDARD.encode("png-binary"),
        })
        .unwrap();

        assert!(!payload.changed);
        assert_eq!(payload.mime_type, "image/png");
        assert_eq!(
            payload.normalization.as_ref().unwrap().source_mime_type,
            "image/png"
        );
    }

    #[test]
    fn failure_hints_are_truthful_when_converter_is_unavailable() {
        let payload =
            normalize_image_payload_with::<fn(ConvertRequest) -> Result<ConvertResponse>>(
                &NormalizeImageRequest {
                    name: "photo.heic".to_string(),
                    mime_type: "image/heic".to_string(),
                    bytes_base64: STANDARD.encode("heic-binary"),
                },
                Some(MediaSupport {
                    available: false,
                    engine: None,
                    reason: Some("no_supported_image_converter".to_string()),
                }),
                None,
            )
            .unwrap();

        assert!(!payload.changed);
        assert_eq!(
            payload.normalization,
            Some(ImageNormalizationMeta {
                status: "failed".to_string(),
                source_mime_type: "image/heic".to_string(),
                output_mime_type: "image/heic".to_string(),
                via: "companion".to_string(),
                engine: None,
                note: Some("no_supported_image_converter".to_string()),
            })
        );
        assert_eq!(
            payload.pipeline_hints,
            Some(ImagePipelineHints {
                source: "image".to_string(),
                summary: "Image normalization failed (no_supported_image_converter); retained as image/heic. OCR hook not enabled yet.".to_string(),
                ocr_ready: false,
            })
        );
    }
}
