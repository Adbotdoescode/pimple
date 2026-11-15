//! Keychain-backed secrets. Owner: Domain 2. Implemented. NEVER log secret values.
//! Shells out to /usr/bin/security (no Keychain prompt for items it created).
use std::collections::HashMap;
use std::process::{Command, Stdio};

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
