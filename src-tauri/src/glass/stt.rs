//! C3 speech-to-text, reusing Handy's local STT pipeline. Owner: Domain 2. Stubs until wired.
//!
//! HANDY ENTRY POINTS (all managers are in Tauri state, created in lib.rs
//! `initialize_core_logic`; get them with `app.state::<Arc<T>>()`):
//!
//! Managers:
//!   crate::managers::audio::AudioRecordingManager         (mic + VAD)
//!   crate::managers::transcription::TranscriptionManager  (model load + transcribe)
//!   crate::managers::model::ModelManager                  (catalog, download)
//!
//! 1. Make sure a model is loaded (do this in stt_model_status / at startup):
//!      let tm = app.state::<Arc<TranscriptionManager>>();
//!      tm.is_model_loaded()                     -> bool
//!      tm.initiate_model_load(false)            -> bool  (async load of settings.selected_model)
//!      tm.load_model(&model_id)                 -> Result<()> (blocking)
//!    Selected model id: crate::settings::get_settings(&app).selected_model (empty = none yet).
//!    Download a missing model: commands::models::download_model(app, model_id) (async) /
//!      ModelManager::download_model(&self, model_id).await; progress events are Handy's
//!      "model-download-progress" (re-emit as stt:model). See commands/models.rs.
//!
//! 2. Start recording WITH VAD (mirrors actions.rs ~L621 TranscribeAction::start):
//!      let rm = app.state::<Arc<AudioRecordingManager>>();
//!      let readiness = rm.try_start_recording("glass", VadPolicy::Offline)?;
//!        // VadPolicy = crate::audio_toolkit::audio::sink::VadPolicy {Disabled, Offline, Streaming}
//!      readiness.wait()  -> bool  (blocks until first mic samples; call off main thread)
//!    The Handy VAD gates/trims silence frames; it does NOT end the turn by itself.
//!    For "VAD auto-ends after ~1 s silence", poll levels / rm.last_input_silent() on a
//!    thread and call stop yourself.
//!    Mic levels: crate::overlay::emit_levels(app, &levels) is called from the audio
//!    callback (~30 Hz, emits "mic-level" to window "recording_overlay", which no longer
//!    exists). Hook there to emit EV.sttLevel ("stt:level", {level}) to all windows
//!    instead (OVERLAY_ENABLED cache must be true: overlay::update_overlay_enabled_cache(true)).
//!
//! 3. Stop and get samples:
//!      let gen = rm.cancel_generation();
//!      let samples: Option<Vec<f32>> = rm.stop_recording("glass", gen);
//!    Cancel: rm.cancel_recording();
//!
//! 4. Transcribe (blocking, off main thread):
//!      let t = tm.transcribe_recording(samples)?;   // -> Transcription (see transcription.rs ~L986)
//!      or tm.transcribe(samples)? -> String        (plain batch path, used by headless CLI)
//!    The finished text is where Handy's actions.rs (~L790) would then PASTE it. We never paste
//!    (clipboard::paste is hard-disabled). Instead emit:
//!      app.emit("stt:final", serde_json::json!({"text": text}))
//!
//! Do NOT go through crate::actions / TranscriptionCoordinator: that path pastes, plays
//! feedback sounds and drives Handy's tray/overlay.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SttModelStatus {
    pub ready: bool,
    pub downloading: bool,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// invoke("stt_start") → void. Opens mic, VAD auto-ends → stt:final
#[tauri::command]
pub fn stt_start() -> Result<(), String> {
    Err(super::not_implemented("stt_start"))
}

/// invoke("stt_stop") → void. Ends the turn now → stt:final
#[tauri::command]
pub fn stt_stop() -> Result<(), String> {
    Err(super::not_implemented("stt_stop"))
}

/// invoke("stt_cancel") → void. Discard, no stt:final
#[tauri::command]
pub fn stt_cancel() -> Result<(), String> {
    Err(super::not_implemented("stt_cancel"))
}

/// invoke("stt_model_status") → SttModelStatus (starts download if missing)
#[tauri::command]
pub fn stt_model_status() -> Result<SttModelStatus, String> {
    Err(super::not_implemented("stt_model_status"))
}
