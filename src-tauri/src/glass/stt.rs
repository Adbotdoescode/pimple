//! C3 speech-to-text, wired to Handy's local STT pipeline. Owner: Domain 2.
//!
//! Pipeline: `stt_start` opens the mic through Handy's `AudioRecordingManager` with the
//! offline VAD policy. Two hooks in `AudioRecordingManager::new` feed this module:
//!   * `on_levels`   — the visualiser's spectrum buckets (~31 Hz) → `stt:level`
//!   * `on_vad_frame` — every frame the VAD lets through (speech + 450 ms hangover)
//! A monitor thread ends the turn once speech has been seen and no VAD-passed window
//! above the energy floor has arrived for `END_GAP` (≈0.9 s of trailing silence), after
//! `NO_SPEECH_TIMEOUT` with no speech at all (→ ""), or at `MAX_TURN`. The captured
//! (VAD-trimmed) samples go to `TranscriptionManager::transcribe` and the text is emitted
//! as `stt:final`. Nothing is pasted, copied or stored.
//!
//! Model: Parakeet TDT 0.6B v3 (Q8_0 GGUF from handy-computer/parakeet-tdt-0.6b-v3-gguf,
//! stored in the shared Hugging Face cache) through Handy's `ModelManager`. It is
//! fetched at startup (`init`, called from `glass::setup`) if missing, selected in
//! Glass Tutor's own settings store, pinned in memory (unload timeout Never) and
//! preloaded so the first turn transcribes immediately.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{debug, error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::audio_toolkit::audio::VadPolicy;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::model::{DownloadProgress, ModelManager};
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout};

/// Default (and only) Glass Tutor STT model: Parakeet V3. Handy's registry keys catalog
/// models as "{repository}/{default quant filename}" (catalog/mod.rs, ModelDescriptor::from);
/// the catalog id "parakeet-tdt-0.6b-v3" is only the retired ONNX model's id.
pub const MODEL_ID: &str =
    "handy-computer/parakeet-tdt-0.6b-v3-gguf/parakeet-tdt-0.6b-v3-Q8_0.gguf";
/// Recording binding id handed to Handy's recorder.
const BINDING_ID: &str = "glass";

/// Trailing silence that ends a turn, measured from the last *loud* VAD-passed frame.
/// Handy's VAD also passes 450 ms of hangover and any background audio it classes as
/// speech; those frames only count if they clear the energy floor below, so quiet
/// hangover / faint background audio no longer extends the turn.
const END_GAP: Duration = Duration::from_millis(900);
/// Energy floor for a 32 ms window to count as the student's speech: above an absolute
/// floor (≈ −44 dBFS) and within −18 dB of the turn's (slowly decaying) loudest window.
const ABS_RMS_FLOOR: f32 = 0.006;
const REL_RMS_FLOOR: f32 = 0.125;
/// Per-window decay of the loudest-window reference (halves in ≈ 4.4 s).
const PEAK_DECAY: f32 = 0.995;
const RMS_WINDOW: usize = 512;
/// Loud windows needed before the turn counts as "speech heard" (≈ 100 ms).
const MIN_LOUD_WINDOWS: u64 = 3;
/// A loud window after this much quiet starts a new speech segment (logging only).
const SEGMENT_GAP_MS: u64 = 300;
/// No speech at all within this long → end the turn with "".
const NO_SPEECH_TIMEOUT: Duration = Duration::from_secs(8);
/// Hard cap on one turn.
const MAX_TURN: Duration = Duration::from_secs(30);
const MONITOR_POLL: Duration = Duration::from_millis(30);
/// `stt:level` throttle (~30 Hz).
const LEVEL_INTERVAL_MS: u64 = 30;

pub const EV_LEVEL: &str = "stt:level";
pub const EV_FINAL: &str = "stt:final";
pub const EV_ERROR: &str = "stt:error";
pub const EV_MODEL: &str = "stt:model";

/* ─────────────────────────── payloads ─────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttModelStatus {
    pub ready: bool,
    pub downloading: bool,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttLevel {
    level: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttFinal {
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttError {
    message: String,
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    warn!("stt:error {message}");
    let _ = app.emit(EV_ERROR, SttError { message });
}

/* ─────────────────────────── turn state ─────────────────────────── */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Turn {
    Idle,
    Listening(u64),
    Transcribing(u64),
}

static TURN: Mutex<Turn> = Mutex::new(Turn::Idle);
static NEXT_TURN_ID: AtomicU64 = AtomicU64::new(0);
/// True while a turn is listening: gates the audio-thread hooks.
static LISTENING: AtomicBool = AtomicBool::new(false);
/// What the VAD let through this turn. Written by the recorder's delivery thread,
/// read by the monitor thread every 30 ms.
#[derive(Debug, Clone, Copy)]
struct SpeechStats {
    /// VAD-passed callbacks (speech, pre-roll and hangover).
    vad_frames: u64,
    /// 32 ms windows above the energy floor.
    loud_windows: u64,
    segments: u64,
    peak_rms: f32,
    last_vad_ms: u64,
    last_loud_ms: u64,
}

const EMPTY_STATS: SpeechStats = SpeechStats {
    vad_frames: 0,
    loud_windows: 0,
    segments: 0,
    peak_rms: 0.0,
    last_vad_ms: 0,
    last_loud_ms: 0,
};

static STATS: Mutex<SpeechStats> = Mutex::new(EMPTY_STATS);

fn stats() -> SpeechStats {
    *STATS.lock().unwrap_or_else(|e| e.into_inner())
}

static LAST_LEVEL_MS: AtomicU64 = AtomicU64::new(0);
static CLOCK: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn turn() -> Turn {
    *TURN.lock().unwrap_or_else(|e| e.into_inner())
}

/// Atomically moves `from` → `to`; false if the state was something else.
fn transition(from: Turn, to: Turn) -> bool {
    let mut t = TURN.lock().unwrap_or_else(|e| e.into_inner());
    if *t == from {
        *t = to;
        true
    } else {
        false
    }
}

/* ─────────────────────────── audio hooks ─────────────────────────── */

/// Called from Handy's recorder (CaptureSink → AudioRecordingManager level callback)
/// with 16 spectrum buckets in 0..1, once per 32 ms window.
pub fn on_levels(app: &AppHandle, levels: &[f32]) {
    if !LISTENING.load(Ordering::Relaxed) || levels.is_empty() {
        return;
    }
    let now = now_ms();
    let last = LAST_LEVEL_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < LEVEL_INTERVAL_MS && last != 0 {
        return;
    }
    LAST_LEVEL_MS.store(now, Ordering::Relaxed);
    let n = levels.len() as f32;
    let mean = levels.iter().copied().map(|v| v.clamp(0.0, 1.0)).sum::<f32>() / n;
    let rms = (levels.iter().map(|v| v * v).sum::<f32>() / n).sqrt();
    let level = (0.5 * mean + 0.5 * rms).clamp(0.0, 1.0);
    let _ = app.emit(EV_LEVEL, SttLevel { level });
}

/// Called from Handy's recorder for every frame the VAD keeps (speech, pre-roll and
/// hangover; the onset call carries the whole pre-roll at once). Only windows above the
/// energy floor count as the student speaking.
pub fn on_vad_frame(frame: &[f32]) {
    if frame.is_empty() || !LISTENING.load(Ordering::Relaxed) {
        return;
    }
    let now = now_ms();
    let mut s = STATS.lock().unwrap_or_else(|e| e.into_inner());
    s.vad_frames += 1;
    s.last_vad_ms = now;
    for window in frame.chunks(RMS_WINDOW) {
        let rms = (window.iter().map(|v| v * v).sum::<f32>() / window.len() as f32).sqrt();
        s.peak_rms = (s.peak_rms * PEAK_DECAY).max(rms);
        let floor = ABS_RMS_FLOOR.max(REL_RMS_FLOOR * s.peak_rms);
        if rms >= floor {
            if s.loud_windows == 0 || now.saturating_sub(s.last_loud_ms) > SEGMENT_GAP_MS {
                s.segments += 1;
            }
            s.loud_windows += 1;
            s.last_loud_ms = now;
        }
    }
}

/* ─────────────────────────── commands ─────────────────────────── */

/// invoke("stt_start") → void. Opens mic, VAD auto-ends → stt:final
#[tauri::command]
pub async fn stt_start(app: AppHandle) -> Result<(), String> {
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || start_turn(&worker))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(ref message) = result {
        emit_error(&app, message.clone());
    }
    result
}

/// invoke("stt_stop") → void. Ends the turn now → stt:final
#[tauri::command]
pub async fn stt_stop(app: AppHandle) -> Result<(), String> {
    if let Turn::Listening(id) = turn() {
        std::thread::spawn(move || finish_turn(&app, id, "stop"));
    }
    Ok(())
}

/// invoke("stt_cancel") → void. Discard, no stt:final
#[tauri::command]
pub async fn stt_cancel(app: AppHandle) -> Result<(), String> {
    let previous = {
        let mut t = TURN.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *t, Turn::Idle)
    };
    LISTENING.store(false, Ordering::Relaxed);
    match previous {
        Turn::Listening(_) => {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                app.state::<Arc<AudioRecordingManager>>().cancel_recording();
            })
            .await;
            info!("stt: turn cancelled while listening");
        }
        Turn::Transcribing(_) => {
            app.state::<Arc<TranscriptionManager>>().cancel_transcription();
            info!("stt: turn cancelled while transcribing");
        }
        Turn::Idle => {}
    }
    Ok(())
}

/// invoke("stt_model_status") → SttModelStatus (starts download if missing)
#[tauri::command]
pub async fn stt_model_status(app: AppHandle) -> Result<SttModelStatus, String> {
    let status = model_status(&app);
    if !status.ready && !status.downloading {
        ensure_model(&app);
    }
    Ok(status)
}

/* ─────────────────────────── turn lifecycle ─────────────────────────── */

fn start_turn(app: &AppHandle) -> Result<(), String> {
    if let Turn::Listening(_) = turn() {
        debug!("stt_start: already listening");
        return Ok(());
    }

    // The model must at least be on disk; a load still in flight is awaited at
    // transcription time.
    if !model_downloaded(app) {
        ensure_model(app);
        let status = model_status(app);
        return Err(match status.error {
            Some(e) => format!("Speech model unavailable: {e}"),
            None => format!(
                "Speech model is still downloading ({:.0}%)",
                status.progress * 100.0
            ),
        });
    }
    if !model_loaded(app) {
        kick_load(app);
    }

    let id = NEXT_TURN_ID.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut t = TURN.lock().unwrap_or_else(|e| e.into_inner());
        if let Turn::Listening(_) = *t {
            return Ok(());
        }
        // A turn still transcribing is superseded: its result is dropped.
        *t = Turn::Listening(id);
    }
    *STATS.lock().unwrap_or_else(|e| e.into_inner()) = EMPTY_STATS;
    LAST_LEVEL_MS.store(0, Ordering::Relaxed);

    let rm = app.state::<Arc<AudioRecordingManager>>();
    let started = match rm.try_start_recording(BINDING_ID, VadPolicy::Offline) {
        Ok(readiness) => Ok(readiness),
        Err(e) if e.to_string().contains("Already recording") => {
            // A stale recording (e.g. a previous turn torn down mid-stop): drop it, retry once.
            warn!("stt_start: recorder busy, cancelling the stale recording and retrying");
            rm.cancel_recording();
            rm.try_start_recording(BINDING_ID, VadPolicy::Offline)
        }
        Err(e) => Err(e),
    };
    if let Err(e) = started {
        transition(Turn::Listening(id), Turn::Idle);
        error!("stt_start: could not start recording: {e:#}");
        return Err(format!("Could not open the microphone: {e:#}"));
    }

    // stt_cancel may have landed while the device was opening.
    if turn() != Turn::Listening(id) {
        rm.cancel_recording();
        return Ok(());
    }
    LISTENING.store(true, Ordering::Relaxed);
    info!("stt: turn {id} listening");

    let app = app.clone();
    std::thread::Builder::new()
        .name("glass-stt-monitor".into())
        .spawn(move || monitor_turn(&app, id))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Decides when the turn ends on its own (end of speech, no speech, hard cap).
fn monitor_turn(app: &AppHandle, id: u64) {
    let started = Instant::now();
    loop {
        std::thread::sleep(MONITOR_POLL);
        if turn() != Turn::Listening(id) {
            return;
        }
        let elapsed = started.elapsed();
        let s = stats();
        let reason = if s.loud_windows >= MIN_LOUD_WINDOWS {
            let gap = now_ms().saturating_sub(s.last_loud_ms);
            if gap >= END_GAP.as_millis() as u64 {
                Some("end of speech")
            } else if elapsed >= MAX_TURN {
                Some("max turn length")
            } else {
                None
            }
        } else if elapsed >= NO_SPEECH_TIMEOUT {
            Some("no speech")
        } else {
            None
        };
        if let Some(reason) = reason {
            finish_turn(app, id, reason);
            return;
        }
    }
}

/// Stops the recording, transcribes it and emits `stt:final` (unless cancelled or
/// superseded meanwhile). Blocking; runs off the main thread.
fn finish_turn(app: &AppHandle, id: u64, reason: &str) {
    if !transition(Turn::Listening(id), Turn::Transcribing(id)) {
        return;
    }
    LISTENING.store(false, Ordering::Relaxed);
    let s = stats();
    let now = now_ms();
    // Transcribe whatever the VAD kept, even if it never cleared the energy floor
    // (stt_stop on a quiet answer).
    let heard_speech = s.vad_frames > 0;
    info!(
        "stt: turn {id} ending ({reason}): vad_frames={} loud_windows={} segments={} peak_rms={:.4} since_last_loud={}ms since_last_vad={}ms",
        s.vad_frames,
        s.loud_windows,
        s.segments,
        s.peak_rms,
        if s.loud_windows > 0 { now.saturating_sub(s.last_loud_ms) as i64 } else { -1 },
        if s.vad_frames > 0 { now.saturating_sub(s.last_vad_ms) as i64 } else { -1 },
    );

    let rm = app.state::<Arc<AudioRecordingManager>>();
    let generation = rm.cancel_generation();
    let Some(samples) = rm.stop_recording(BINDING_ID, generation) else {
        // Cancelled while stopping.
        transition(Turn::Transcribing(id), Turn::Idle);
        return;
    };
    let input_silent = rm.last_input_silent();
    info!(
        "stt: turn {id} kept {:.2}s of VAD-passed audio",
        samples.len() as f32 / 16_000.0
    );

    let result: Result<String, String> = if !heard_speech || samples.is_empty() {
        if input_silent {
            Err("The microphone delivered only silence. Check that Pimple (or the terminal running it) has Microphone access in System Settings > Privacy & Security.".into())
        } else {
            Ok(String::new())
        }
    } else {
        transcribe(app, samples)
    };

    // Only the turn that is still current may report.
    if !transition(Turn::Transcribing(id), Turn::Idle) {
        debug!("stt: turn {id} result dropped (cancelled or superseded)");
        return;
    }
    match result {
        Ok(text) => {
            let text = text.trim().to_string();
            info!("stt: turn {id} final ({} chars)", text.len());
            #[cfg(debug_assertions)]
            info!(
                "stt: turn {id} transcript: {:?}",
                text.chars().take(160).collect::<String>()
            );
            let _ = app.emit(EV_FINAL, SttFinal { text });
        }
        Err(message) => emit_error(app, message),
    }
}

fn transcribe(app: &AppHandle, samples: Vec<f32>) -> Result<String, String> {
    if !model_loaded(app) {
        info!("stt: model not loaded yet, loading before transcription");
        load_model_blocking(app)?;
    }
    let tm = app.state::<Arc<TranscriptionManager>>();
    let started = Instant::now();
    let text = tm
        .transcribe(samples)
        .map_err(|e| format!("Transcription failed: {e:#}"))?;
    debug!("stt: transcribed in {:?}", started.elapsed());
    Ok(text)
}

/* ─────────────────────────── model management ─────────────────────────── */

#[derive(Debug, Default)]
struct ModelState {
    downloading: bool,
    loading: bool,
    progress: f64,
    last_emitted_progress: f64,
    error: Option<String>,
}

static MODEL: Mutex<ModelState> = Mutex::new(ModelState {
    downloading: false,
    loading: false,
    progress: 0.0,
    last_emitted_progress: -1.0,
    error: None,
});
static LISTENER_REGISTERED: AtomicBool = AtomicBool::new(false);

fn model_state() -> std::sync::MutexGuard<'static, ModelState> {
    MODEL.lock().unwrap_or_else(|e| e.into_inner())
}

/// App startup (from glass::setup): re-emit Handy's download progress as `stt:model`,
/// then make sure Parakeet V3 is downloaded and loaded.
pub fn init(app: &AppHandle) {
    if !LISTENER_REGISTERED.swap(true, Ordering::SeqCst) {
        let handle = app.clone();
        app.listen_any("model-download-progress", move |event| {
            let Ok(p) = serde_json::from_str::<DownloadProgress>(event.payload()) else {
                return;
            };
            if p.model_id != MODEL_ID {
                return;
            }
            let progress = (p.percentage / 100.0).clamp(0.0, 1.0);
            let should_emit = {
                let mut st = model_state();
                st.progress = progress;
                if progress - st.last_emitted_progress >= 0.005 || progress >= 1.0 {
                    st.last_emitted_progress = progress;
                    true
                } else {
                    false
                }
            };
            if should_emit {
                emit_model_status(&handle);
            }
        });
    }
    let app = app.clone();
    std::thread::spawn(move || ensure_model(&app));
}

fn model_downloaded(app: &AppHandle) -> bool {
    app.state::<Arc<ModelManager>>()
        .get_model_info(MODEL_ID)
        .map(|m| m.is_downloaded)
        .unwrap_or(false)
}

fn model_loaded(app: &AppHandle) -> bool {
    let tm = app.state::<Arc<TranscriptionManager>>();
    tm.is_model_loaded() && tm.get_current_model().as_deref() == Some(MODEL_ID)
}

fn model_status(app: &AppHandle) -> SttModelStatus {
    let downloaded = model_downloaded(app);
    let ready = downloaded && model_loaded(app);
    let st = model_state();
    SttModelStatus {
        ready,
        downloading: st.downloading,
        progress: if downloaded { 1.0 } else { st.progress },
        error: if ready { None } else { st.error.clone() },
    }
}

fn emit_model_status(app: &AppHandle) {
    let _ = app.emit(EV_MODEL, model_status(app));
}

/// Non-blocking: starts the download or the load, whichever is needed.
fn ensure_model(app: &AppHandle) {
    let mm = app.state::<Arc<ModelManager>>().inner().clone();
    let Some(info) = mm.get_model_info(MODEL_ID) else {
        let similar: Vec<String> = mm
            .get_available_models()
            .into_iter()
            .map(|m| m.id)
            .filter(|id| id.contains("parakeet"))
            .collect();
        let message = format!("Model {MODEL_ID} is not in the catalog (parakeet ids: {similar:?})");
        model_state().error = Some(message.clone());
        emit_model_status(app);
        emit_error(app, message);
        return;
    };
    if info.is_downloaded {
        kick_load(app);
        return;
    }
    {
        let mut st = model_state();
        if st.downloading {
            return;
        }
        st.downloading = true;
        st.error = None;
        st.last_emitted_progress = -1.0;
    }
    info!("stt: downloading {MODEL_ID}");
    emit_model_status(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = mm.download_model(MODEL_ID).await;
        model_state().downloading = false;
        match result {
            Ok(()) if model_downloaded(&app) => {
                info!("stt: {MODEL_ID} downloaded");
                kick_load(&app);
            }
            Ok(()) => {
                model_state().error = Some("Speech model download was cancelled".into());
                emit_model_status(&app);
            }
            Err(e) => {
                let message = format!("Speech model download failed: {e:#}");
                error!("stt: {message}");
                model_state().error = Some(message.clone());
                emit_model_status(&app);
                emit_error(&app, message);
            }
        }
    });
}

/// Loads (preloads) the model on a background thread unless it is loaded or loading.
fn kick_load(app: &AppHandle) {
    if model_loaded(app) {
        emit_model_status(app);
        return;
    }
    {
        let mut st = model_state();
        if st.loading {
            return;
        }
        st.loading = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = load_model_blocking(&app);
        {
            let mut st = model_state();
            st.loading = false;
            st.error = result.as_ref().err().cloned();
        }
        if let Err(ref message) = result {
            emit_error(&app, message.clone());
        }
        emit_model_status(&app);
    });
}

/// Glass Tutor's own settings store: always Parakeet V3, kept resident, English.
fn configure_settings(app: &AppHandle) {
    let mut settings = get_settings(app);
    let mut changed = false;
    if settings.selected_model != MODEL_ID {
        settings.selected_model = MODEL_ID.to_string();
        changed = true;
    }
    if settings.model_unload_timeout != ModelUnloadTimeout::Never {
        settings.model_unload_timeout = ModelUnloadTimeout::Never;
        changed = true;
    }
    if settings.selected_language == "auto" {
        settings.selected_language = "en".to_string();
        changed = true;
    }
    if changed {
        write_settings(app, settings);
    }
}

/// Blocks until Parakeet V3 is loaded (or fails). Serialised with any other load
/// through Handy's loading guard.
fn load_model_blocking(app: &AppHandle) -> Result<(), String> {
    if !model_downloaded(app) {
        return Err("Speech model is not downloaded yet".into());
    }
    configure_settings(app);
    let tm = app.state::<Arc<TranscriptionManager>>();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if model_loaded(app) {
            return Ok(());
        }
        if let Some(guard) = tm.try_start_loading() {
            let started = Instant::now();
            let result = tm.load_model(MODEL_ID);
            drop(guard);
            return match result {
                Ok(()) => {
                    info!("stt: {MODEL_ID} loaded in {:?}", started.elapsed());
                    Ok(())
                }
                Err(e) => Err(format!("Could not load the speech model: {e:#}")),
            };
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the speech model to load".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
