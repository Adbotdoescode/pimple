//! API keys backed by the operating system's credential store. Never log secret values.
use serde::Serialize;
use std::collections::HashMap;
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};
use std::time::Duration;

const ACCOUNT: &str = "glass-tutor";

#[cfg(target_os = "windows")]
mod windows_store {
    use std::{ptr, slice};
    use windows::{
        core::{HRESULT, PCWSTR, PWSTR},
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{
                CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
                CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            },
        },
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub(super) fn read(service: &str) -> Result<Option<String>, String> {
        let target = wide(service);
        let mut entry: *mut CREDENTIALW = ptr::null_mut();
        unsafe {
            match CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut entry) {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => return Ok(None),
                Err(e) => return Err(format!("Credential Manager could not read the key: {e}")),
            }
            if entry.is_null() {
                return Err("Credential Manager returned no entry".into());
            }
            let blob = &*entry;
            let value = if blob.CredentialBlobSize == 0 || blob.CredentialBlob.is_null() {
                Ok(None)
            } else {
                let bytes = slice::from_raw_parts(blob.CredentialBlob, blob.CredentialBlobSize as usize);
                std::str::from_utf8(bytes).map(|text| Some(text.to_owned()))
                    .map_err(|_| "Credential Manager returned an invalid key".to_owned())
            };
            CredFree(entry.cast());
            value
        }
    }

    pub(super) fn write(service: &str, value: &str) -> Result<(), String> {
        let mut target = wide(service);
        let mut user = wide(super::ACCOUNT);
        let mut bytes = value.as_bytes().to_vec();
        let entry = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: u32::try_from(bytes.len()).map_err(|_| "Key is too long")?,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        unsafe { CredWriteW(&entry, 0) }
            .map_err(|e| format!("Credential Manager could not save the key: {e}"))
    }

    pub(super) fn delete(service: &str) -> Result<(), String> {
        let target = wide(service);
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(e) => Err(format!("Credential Manager could not remove the key: {e}")),
        }
    }
}

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
    read_stored_secret(service)
}

#[cfg(target_os = "windows")]
use windows_store::{delete as delete_stored_secret, read as read_stored_secret, write as write_stored_secret};

#[cfg(not(target_os = "windows"))]
fn read_stored_secret(service: &str) -> Result<Option<String>, String> {
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
    write_stored_secret(service, value)
}

#[cfg(not(target_os = "windows"))]
fn write_stored_secret(service: &str, value: &str) -> Result<(), String> {
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
        log::info!("Stored secret '{service}' in Keychain");
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
    delete_stored_secret(service)
}

#[cfg(not(target_os = "windows"))]
fn delete_stored_secret(service: &str) -> Result<(), String> {
    let out = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", service, "-a", ACCOUNT])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("security failed to run: {e}"))?;
    if out.status.success() {
        log::info!("Removed secret '{service}' from Keychain");
        return Ok(());
    }
    // Not found (or already gone): the desired end state holds.
    if matches!(read_stored_secret(service), Ok(None)) {
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
