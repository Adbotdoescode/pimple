//! C3 TTS synthesis: ElevenLabs with a local voice fallback, disk-cached under app_cache_dir()/tts.
//! Provider ceiling: env GT_TTS ("elevenlabs" | "say" | "off"), exported by scripts/dev.sh.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::keys::read_secret;

const ELEVEN_MODEL: &str = "eleven_flash_v2_5";
#[cfg(not(target_os = "windows"))]
const SAY_MODEL: &str = "say";
#[cfg(target_os = "windows")]
const SAY_MODEL: &str = "windows-speech";
const SAY_VOICE: &str = "default";
const DEFAULT_VOICE: &str = "SAz9YHcvj6GT2YYXdXww";
#[cfg(not(target_os = "windows"))]
const SAY_BIN: &str = "/usr/bin/say";
#[cfg(not(target_os = "windows"))]
const SAY_RATE: &str = "190";
/// 22050 Hz * 16-bit mono.
const SAY_PCM_BYTES_PER_SEC: u64 = 22_050 * 2;
const WAV_HEADER_BYTES: u64 = 44;
/// mp3_44100_128 = 128 kbps.
const MP3_BYTES_PER_SEC: u64 = 16_000;

/// Set once ElevenLabs reports quota exhaustion or an auth/payment failure; later calls skip it.
static ELEVEN_DISABLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSynthResult {
    pub path: String,
    pub provider: String,
    pub cached: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCredit {
    pub used: u64,
    pub limit: u64,
    pub provider: String,
}

/// A failed ElevenLabs attempt. `sticky` means later calls in this run should not retry it.
struct Fail {
    reason: String,
    sticky: bool,
}

impl Fail {
    fn soft(reason: String) -> Self {
        Self { reason, sticky: false }
    }
}

/// Effective provider: GT_TTS is a developer ceiling; the request may narrow it.
fn resolve_provider(requested: Option<&str>) -> String {
    let ceiling = std::env::var("GT_TTS").ok().map(|s| s.trim().to_ascii_lowercase());
    let req = requested
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let mut provider: &str = match ceiling.as_deref() {
        Some("off") => "off",
        Some("say") => {
            if req.as_deref() == Some("off") {
                "off"
            } else {
                "say"
            }
        }
        _ => match req.as_deref() {
            Some("say") => "say",
            Some("off") => "off",
            _ => "elevenlabs",
        },
    };
    if provider == "elevenlabs" && ELEVEN_DISABLED.load(Ordering::SeqCst) {
        provider = "say";
    }
    provider.to_string()
}

/// Rough duration when no audio exists: max(1200, words * 330) ms.
fn estimate_ms(text: &str) -> u64 {
    let words = text.split_whitespace().count() as u64;
    (words * 330).max(1200)
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir: {e}"))?
        .join("tts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create tts cache dir: {e}"))?;
    Ok(dir)
}

fn cache_key(provider: &str, model: &str, voice: &str, text: &str) -> String {
    let digest = Sha256::digest(format!("{provider}|{model}|{voice}|{text}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_sidecar_ms(dir: &Path, key: &str) -> Option<u64> {
    std::fs::read_to_string(dir.join(format!("{key}.ms")))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Cache hit: the audio file exists. Duration comes from the sidecar, else an estimate.
fn cache_hit(dir: &Path, key: &str, ext: &str, text: &str) -> Option<(PathBuf, u64)> {
    let path = dir.join(format!("{key}.{ext}"));
    if !path.is_file() {
        return None;
    }
    let ms = read_sidecar_ms(dir, key).unwrap_or_else(|| estimate_ms(text));
    Some((path, ms))
}

/// Move a finished temp file into the cache and record its duration.
fn finalize(dir: &Path, key: &str, ext: &str, tmp: &Path, ms: u64) -> Result<PathBuf, String> {
    let path = dir.join(format!("{key}.{ext}"));
    std::fs::rename(tmp, &path).map_err(|e| format!("commit cache file: {e}"))?;
    let _ = std::fs::write(dir.join(format!("{key}.ms")), ms.to_string());
    Ok(path)
}

fn synth_result(path: PathBuf, provider: &str, cached: bool, duration_ms: u64) -> TtsSynthResult {
    TtsSynthResult {
        path: path.to_string_lossy().into_owned(),
        provider: provider.to_string(),
        cached,
        duration_ms,
    }
}

/// Voice: explicit arg, else secret "voice_id", else the default. Must be alphanumeric (it goes in a URL path).
fn resolve_voice(voice_id: Option<String>) -> Result<String, String> {
    let voice = voice_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            read_secret("voice_id")
                .ok()
                .flatten()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_VOICE.to_string());
    if voice.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(voice)
    } else {
        Err("invalid voice id".to_string())
    }
}

async fn synth_elevenlabs(dir: &Path, text: &str, voice_id: Option<String>) -> Result<TtsSynthResult, Fail> {
    let voice = resolve_voice(voice_id).map_err(Fail::soft)?;
    let key = cache_key("elevenlabs", ELEVEN_MODEL, &voice, text);
    if let Some((path, ms)) = cache_hit(dir, &key, "mp3", text) {
        return Ok(synth_result(path, "elevenlabs", true, ms));
    }

    let api_key = read_secret("elevenlabs")
        .map_err(Fail::soft)?
        .ok_or_else(|| Fail::soft("no elevenlabs key".to_string()))?;
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream?output_format=mp3_44100_128"
    );
    let resp = reqwest::Client::new()
        .post(url.as_str())
        .header("xi-api-key", api_key.as_str())
        .header(reqwest::header::ACCEPT, "audio/mpeg")
        .json(&serde_json::json!({ "text": text, "model_id": ELEVEN_MODEL }))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| Fail::soft(format!("network: {}", e.without_url())))?;

    let status = resp.status();
    if !status.is_success() {
        // The body is read only to detect quota_exceeded; it is never logged.
        let body = resp.text().await.unwrap_or_default();
        let quota = body.contains("quota_exceeded");
        let sticky = quota || status.as_u16() == 401 || status.as_u16() == 402;
        let suffix = if quota { " quota_exceeded" } else { "" };
        return Err(Fail {
            reason: format!("elevenlabs HTTP {}{suffix}", status.as_u16()),
            sticky,
        });
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| Fail::soft(format!("read audio: {}", e.without_url())))?;
    if bytes.is_empty() {
        return Err(Fail::soft("empty audio response".to_string()));
    }
    let ms = (bytes.len() as u64).saturating_mul(1000) / MP3_BYTES_PER_SEC;
    let tmp = dir.join(format!("{key}.tmp.mp3"));
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| Fail::soft(format!("write cache: {e}")))?;
    let path = finalize(dir, &key, "mp3", &tmp, ms).map_err(Fail::soft)?;
    Ok(synth_result(path, "elevenlabs", false, ms))
}

async fn synth_say(dir: &Path, text: &str) -> Result<TtsSynthResult, String> {
    let key = cache_key("say", SAY_MODEL, SAY_VOICE, text);
    if let Some((path, ms)) = cache_hit(dir, &key, "wav", text) {
        return Ok(synth_result(path, "say", true, ms));
    }

    let tmp = dir.join(format!("{key}.tmp.wav"));
    if let Err(error) = write_local_speech(&tmp, text).await {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }

    let size = std::fs::metadata(&tmp)
        .map_err(|e| format!("stat say output: {e}"))?
        .len();
    let ms = size.saturating_sub(WAV_HEADER_BYTES) * 1000 / SAY_PCM_BYTES_PER_SEC;
    let path = finalize(dir, &key, "wav", &tmp, ms)?;
    Ok(synth_result(path, "say", false, ms))
}

#[cfg(not(target_os = "windows"))]
async fn write_local_speech(path: &Path, text: &str) -> Result<(), String> {
    let status = tokio::process::Command::new(SAY_BIN)
        .arg("-o")
        .arg(path)
        .arg("--file-format=WAVE")
        .arg("--data-format=LEI16@22050")
        .arg("-r")
        .arg(SAY_RATE)
        .arg("--")
        .arg(text)
        .status()
        .await
        .map_err(|e| format!("spawn say: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("say exited with {status}"))
    }
}

#[cfg(target_os = "windows")]
async fn write_local_speech(path: &Path, text: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    // Pass lesson text via stdin, never as a PowerShell command or argument.
    const SYNTHESIZE: &str = r#"
        $ErrorActionPreference = 'Stop'
        [Console]::InputEncoding = [System.Text.Encoding]::UTF8
        Add-Type -AssemblyName System.Speech
        $voice = [System.Speech.Synthesis.SpeechSynthesizer]::new()
        try {
            $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
                22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
                [System.Speech.AudioFormat.AudioChannel]::Mono)
            $voice.SetOutputToWaveFile($env:PIMPLE_SPEECH_WAV, $format)
            $voice.Speak([Console]::In.ReadToEnd())
        } finally {
            $voice.Dispose()
        }
    "#;

    let system_root = std::env::var_os("SystemRoot").ok_or("Windows directory unavailable")?;
    let powershell = PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = tokio::process::Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", SYNTHESIZE])
        .env("PIMPLE_SPEECH_WAV", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Start Windows speech: {e}"))?;
    let mut input = child.stdin.take().ok_or("Windows speech input unavailable")?;
    input.write_all(text.as_bytes()).await.map_err(|e| format!("Write Windows speech input: {e}"))?;
    drop(input);
    let status = child.wait().await.map_err(|e| format!("Wait for Windows speech: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Windows speech exited with {status}"))
    }
}

/// Log the failure (status only, never the key) and emit tts:fallback.
/// A sticky failure emits once per run: later calls skip ElevenLabs entirely.
fn note_fallback(app: &AppHandle, fail: &Fail) {
    log::warn!("tts: elevenlabs unavailable ({}), falling back to say", fail.reason);
    if fail.sticky && ELEVEN_DISABLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("tts:fallback", serde_json::json!({ "reason": fail.reason }));
}

/// invoke("tts_synthesize", {text, voiceId?, provider?}) → TtsSynthResult
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    text: String,
    voice_id: Option<String>,
    provider: Option<String>,
) -> Result<TtsSynthResult, String> {
    let chars = text.chars().count();
    let resolved = resolve_provider(provider.as_deref());

    let result = if resolved == "off" {
        synth_result(PathBuf::new(), "off", false, estimate_ms(&text))
    } else {
        let dir = cache_dir(&app)?;
        let eleven = if resolved == "elevenlabs" {
            match synth_elevenlabs(&dir, &text, voice_id).await {
                Ok(r) => Some(r),
                Err(fail) => {
                    note_fallback(&app, &fail);
                    None
                }
            }
        } else {
            None
        };
        match eleven {
            Some(r) => r,
            None => synth_say(&dir, &text).await?,
        }
    };

    log::info!(
        "tts provider={} cached={} chars={} ms={}",
        result.provider,
        result.cached,
        chars,
        result.duration_ms
    );
    Ok(result)
}

/// invoke("tts_credit") → {used, limit, provider}
#[tauri::command]
pub async fn tts_credit() -> Result<TtsCredit, String> {
    let provider = resolve_provider(None);
    if provider != "elevenlabs" {
        return Ok(TtsCredit { used: 0, limit: 0, provider });
    }

    let api_key = read_secret("elevenlabs")?
        .ok_or_else(|| "no elevenlabs key configured".to_string())?;
    let resp = reqwest::Client::new()
        .get("https://api.elevenlabs.io/v1/user/subscription")
        .header("xi-api-key", api_key.as_str())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("subscription request failed: {}", e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("subscription HTTP {}", status.as_u16()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("subscription parse: {}", e.without_url()))?;
    let used = body
        .get("character_count")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "subscription response missing character_count".to_string())?;
    let limit = body
        .get("character_limit")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "subscription response missing character_limit".to_string())?;
    Ok(TtsCredit {
        used,
        limit,
        provider: "elevenlabs".to_string(),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    pub voice_id: String,
    pub name: String,
    pub category: Option<String>,
    pub preview_url: Option<String>,
    pub labels: std::collections::HashMap<String, String>,
}

#[derive(serde::Deserialize)]
struct RawVoicesResponse {
    #[serde(default)]
    voices: Vec<RawVoice>,
}

#[derive(serde::Deserialize)]
struct RawVoice {
    voice_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    preview_url: Option<String>,
    #[serde(default)]
    labels: std::collections::HashMap<String, serde_json::Value>,
}

const VOICES_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Voice list cache: (fetched at, voices). Ten-minute TTL.
static VOICES_CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<TtsVoice>)>> =
    std::sync::Mutex::new(None);

fn cached_voices() -> Option<Vec<TtsVoice>> {
    let guard = VOICES_CACHE.lock().ok()?;
    match guard.as_ref() {
        Some((at, voices)) if at.elapsed() < VOICES_TTL => Some(voices.clone()),
        _ => None,
    }
}

/// invoke("tts_voices") → TtsVoice[]  (GET /v1/voices, no credit cost; cached 10 min)
#[tauri::command]
pub async fn tts_voices() -> Result<Vec<TtsVoice>, String> {
    if let Some(voices) = cached_voices() {
        return Ok(voices);
    }

    let api_key = read_secret("elevenlabs")?
        .ok_or_else(|| "no elevenlabs key configured".to_string())?;
    let resp = reqwest::Client::new()
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", api_key.as_str())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("voices request failed: {}", e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("voices HTTP {}", status.as_u16()));
    }
    let raw: RawVoicesResponse = resp
        .json()
        .await
        .map_err(|e| format!("voices parse: {}", e.without_url()))?;

    let voices: Vec<TtsVoice> = raw
        .voices
        .into_iter()
        .map(|v| TtsVoice {
            voice_id: v.voice_id,
            name: v.name,
            category: v.category,
            preview_url: v.preview_url,
            labels: v
                .labels
                .into_iter()
                .filter_map(|(k, val)| match val {
                    serde_json::Value::String(s) => Some((k, s)),
                    _ => None,
                })
                .collect(),
        })
        .collect();

    if let Ok(mut guard) = VOICES_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), voices.clone()));
    }
    log::info!("tts voices fetched count={}", voices.len());
    Ok(voices)
}
