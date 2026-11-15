//! C3 TTS synthesis (ElevenLabs / `say`). Owner: Domain 2. Stubs until implemented.
//! Provider default comes from env GT_TTS (scripts/dev.sh exports `say`).
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSynthResult {
    pub path: String,
    pub provider: String,
    pub cached: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TtsCredit {
    pub used: u64,
    pub limit: u64,
    pub provider: String,
}

/// invoke("tts_synthesize", {text, voiceId?}) → TtsSynthResult
#[tauri::command]
pub async fn tts_synthesize(text: String, voice_id: Option<String>) -> Result<TtsSynthResult, String> {
    let _ = (text, voice_id);
    Err(super::not_implemented("tts_synthesize"))
}

/// invoke("tts_credit") → {used, limit, provider}
#[tauri::command]
pub async fn tts_credit() -> Result<TtsCredit, String> {
    Err(super::not_implemented("tts_credit"))
}
