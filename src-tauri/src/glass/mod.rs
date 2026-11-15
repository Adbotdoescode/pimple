//! Glass Tutor backend module. Command names match `CMD` in shared/contracts.ts exactly.
//! Commands are plain `#[tauri::command]`s registered through `glass_handler()`, which
//! lib.rs routes to before falling back to Handy's tauri-specta handler.
//! invoke() args are camelCase on the JS side (Tauri converts to snake_case here).

pub mod capture;
#[cfg(debug_assertions)]
pub mod debug_server;
pub mod keys;
pub mod lens;
pub mod shortcuts;
pub mod stt;
pub mod tray;
pub mod tts;
pub mod windows;

use tauri::{AppHandle, Emitter, Manager};

/// Every command this module owns. lib.rs dispatches these names to `glass_handler`.
pub const GLASS_COMMANDS: &[&str] = &[
    "capture",
    "read_debug_file",
    "stt_start",
    "stt_stop",
    "stt_cancel",
    "stt_model_status",
    "tts_synthesize",
    "tts_credit",
    "tts_voices",
    "get_secret",
    "set_secret",
    "keys_status",
    "set_session_keys",
    "bubble_display",
    "overlay_set_ignore_cursor",
    "show_window",
    "hide_window",
    "read_source_file",
    "lens_grab",
    "bubble_set_frame",
    "cursor_pos",
    "lens_grab_below",
    "validate_key",
    "delete_secret",
    "onboarding_needed",
];

pub fn is_glass_command(name: &str) -> bool {
    GLASS_COMMANDS.contains(&name)
}

pub fn glass_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        capture::capture,
        capture::read_debug_file,
        stt::stt_start,
        stt::stt_stop,
        stt::stt_cancel,
        stt::stt_model_status,
        tts::tts_synthesize,
        tts::tts_credit,
        tts::tts_voices,
        keys::get_secret,
        keys::set_secret,
        keys::keys_status,
        keys::validate_key,
        keys::delete_secret,
        keys::onboarding_needed,
        shortcuts::set_session_keys,
        windows::bubble_display,
        windows::overlay_set_ignore_cursor,
        windows::show_window,
        windows::hide_window,
        read_source_file,
        lens::lens_grab,
        lens::bubble_set_frame,
        lens::cursor_pos,
        lens::lens_grab_below,
    ]
}

pub fn not_implemented(name: &str) -> String {
    format!("not implemented: {name}")
}

/// Called from lib.rs setup (non-headless). Creates windows, tray, dev hook.
pub fn setup(app: &AppHandle) {
    windows::create_all(app);
    tray::create_tray(app);
    stt::init(app); // download/preload Parakeet V3 so the first question is fast
    shortcuts::init(app); // always-on ctrl+option+space → hotkey:activate
    #[cfg(debug_assertions)]
    debug_server::start(app.clone());

    // First run (no Anthropic key, or GT_FORCE_ONBOARDING=1): open the settings window and tell
    // the UI to start onboarding. The short delay lets the windows load their listeners.
    let first_run = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        let Some(reason) = keys::onboarding_reason() else { return };
        log::info!("onboarding: shown ({reason})");
        let app2 = first_run.clone();
        let _ = first_run.run_on_main_thread(move || {
            if let Err(e) = windows::show_window(app2.clone(), "settings".into()) {
                log::error!("onboarding: show settings failed: {e}");
            }
            if let Err(e) = app2.emit("onboarding:show", serde_json::json!({})) {
                log::error!("onboarding: emit failed: {e}");
            }
        });
    });
}

/// ({name}) → string. Reads content/sources/<name> (repo root in dev, resources in release).
#[tauri::command]
pub fn read_source_file(app: AppHandle, name: String) -> Result<String, String> {
    if name.contains("..") || name.starts_with('/') {
        return Err("invalid source name".into());
    }
    let mut candidates = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("content")
        .join("sources")
        .join(&name)];
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("content").join("sources").join(&name));
    }
    for p in candidates {
        if p.exists() {
            return std::fs::read_to_string(&p).map_err(|e| e.to_string());
        }
    }
    Err(format!("source not found: {name}"))
}
