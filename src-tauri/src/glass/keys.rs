//! Keychain-backed secrets. Owner: Domain 2. Implemented. NEVER log secret values.
//! Shells out to /usr/bin/security (no Keychain prompt for items it created).
use serde::Serialize;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::Duration;

const ACCOUNT: &str = "glass-tutor";

fn service_for(name: &str) -> Result<&'static str, String> {
    match name {
        "anthropic" => Ok("glass-tutor.anthropic-api-key"),
        "elevenlabs" => Ok("glass-tutor.elevenlabs-api-key"),
        "voice_id" => Ok("glass-tutor.elevenlabs-voice-id"),
        other => Err(format!("unknown secret name: {other}")),
    }
}

pub fn read_secret(name: &str) -> Result<Option<String>, String> {
    let service = service_for(name)?;
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("security failed to run: {e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    let v = String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string();
    Ok(if v.is_empty() { None } else { Some(v) })
}

/// invoke("get_secret", {name}) → string | null
#[tauri::command]
pub fn get_secret(name: String) -> Result<Option<String>, String> {
    read_secret(&name)
}

/// invoke("set_secret", {name, value}) → void
#[tauri::command]
pub fn set_secret(name: String, value: String) -> Result<(), String> {
    let service = service_for(&name)?;
    let value = value.trim();
    if value.is_empty() {
        return Err("empty value".into());
    }
    let out = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            ACCOUNT,
            "-w",
            value,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("security failed to run: {e}"))?;
    if out.status.success() {
        log::info!("Stored secret '{name}' in Keychain");
        Ok(())
    } else {
        Err(format!(
            "security add-generic-password failed (exit {:?})",
            out.status.code()
        ))
    }
}

/// invoke("keys_status") → Record<SecretName, boolean>
#[tauri::command]
pub fn keys_status() -> Result<HashMap<String, bool>, String> {
    let mut m = HashMap::new();
    for n in ["anthropic", "elevenlabs", "voice_id"] {
        m.insert(n.to_string(), matches!(read_secret(n), Ok(Some(_))));
    }
    Ok(m)
}

/// invoke("delete_secret", {name}) → void. A missing item counts as success.
#[tauri::command]
pub fn delete_secret(name: String) -> Result<(), String> {
    let service = service_for(&name)?;
    let out = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", service, "-a", ACCOUNT])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("security failed to run: {e}"))?;
    if out.status.success() {
        log::info!("Removed secret '{name}' from Keychain");
        return Ok(());
    }
    // Not found (or already gone): the desired end state holds.
    if matches!(read_secret(&name), Ok(None)) {
        return Ok(());
    }
    Err(format!(
        "security delete-generic-password failed (exit {:?})",
        out.status.code()
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub ok: bool,
    pub error: Option<String>,
}

fn rejected(msg: impl Into<String>) -> KeyCheck {
    KeyCheck { ok: false, error: Some(msg.into()) }
}

/// invoke("validate_key", {name, value}) → {ok, error}. One cheap authenticated GET.
/// Never logs the value: only the name and the HTTP status.
#[tauri::command]
pub async fn validate_key(name: String, value: String) -> Result<KeyCheck, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(rejected("Paste a key first"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let (label, req) = match name.as_str() {
        "anthropic" => (
            "Anthropic",
            client
                .get("https://api.anthropic.com/v1/models?limit=1")
                .header("x-api-key", &value)
                .header("anthropic-version", "2023-06-01"),
        ),
        "elevenlabs" => (
            "ElevenLabs",
            client
                .get("https://api.elevenlabs.io/v1/user")
                .header("xi-api-key", &value),
        ),
        other => return Err(format!("no validator for secret name: {other}")),
    };
    match req.send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            log::info!("validate_key: {name} → HTTP {code}");
            Ok(match code {
                200..=299 => KeyCheck { ok: true, error: None },
                401 | 403 => rejected("That key was rejected"),
                _ => rejected(format!("Unexpected response {code}")),
            })
        }
        Err(e) => {
            log::warn!("validate_key: {name} request failed: {}", e.without_url());
            Ok(rejected(format!("Couldn't reach {label}; check your connection")))
        }
    }
}

/// Why onboarding should show, or None when the Anthropic key is present.
pub fn onboarding_reason() -> Option<&'static str> {
    if std::env::var("GT_FORCE_ONBOARDING").as_deref() == Ok("1") {
        return Some("GT_FORCE_ONBOARDING=1");
    }
    match read_secret("anthropic") {
        Ok(Some(_)) => None,
        _ => Some("anthropic key missing"),
    }
}

/// invoke("onboarding_needed") → bool
#[tauri::command]
pub fn onboarding_needed() -> bool {
    onboarding_reason().is_some()
}
