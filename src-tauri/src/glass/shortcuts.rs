//! Session keys (space tap/hold, Return/Esc) and the always-on ctrl+option+space hotkey.
//! Owner: Domain 2. Emits: space:tap, space:hold-start, space:hold-end,
//! key:return, key:escape, hotkey:activate.
//!
//! Backend: tauri-plugin-global-shortcut (initialised in lib.rs). On macOS that is Carbon
//! `RegisterEventHotKey`, which swallows the key while registered and reports both
//! Pressed and Released, and needs no Accessibility permission. Session keys are only
//! registered while the frontend asks for them, so Space/Return/Esc pass through to
//! other apps otherwise.
//!
//! NOTE: Handy's own dictation bindings are never initialized (we never call
//! `shortcut::init_shortcuts` / the `initialize_shortcuts` command), so nothing else grabs keys.
//!
//! Threading: plugin handlers run on the main thread while the plugin holds its shortcut
//! map lock, so handlers here only emit events / spawn timers and never (un)register.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

const EV_SPACE_TAP: &str = "space:tap";
const EV_SPACE_HOLD_START: &str = "space:hold-start";
const EV_SPACE_HOLD_END: &str = "space:hold-end";
const EV_KEY_RETURN: &str = "key:return";
const EV_KEY_ESCAPE: &str = "key:escape";
const EV_HOTKEY_ACTIVATE: &str = "hotkey:activate";

fn space() -> Shortcut {
    Shortcut::new(None, Code::Space)
}
fn ret() -> Shortcut {
    Shortcut::new(None, Code::Enter)
}
fn esc() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}
fn activate() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Space tap/hold state machine. `gen` invalidates pending hold timers.
struct SpaceState {
    down: bool,
    held: bool,
    gen: u64,
}

static SPACE: Mutex<SpaceState> = Mutex::new(SpaceState {
    down: false,
    held: false,
    gen: 0,
});

/// Physical-down flags for Return / Esc / activate, used to ignore auto-repeat presses.
static RET_DOWN: Mutex<bool> = Mutex::new(false);
static ESC_DOWN: Mutex<bool> = Mutex::new(false);
static ACTIVATE_DOWN: Mutex<bool> = Mutex::new(false);

fn emit(app: &AppHandle, name: &str) {
    if let Err(e) = app.emit(name, serde_json::json!({})) {
        log::warn!("shortcuts: failed to emit {name}: {e}");
    }
}

/// Returns true on a fresh press (not an auto-repeat); tracks release.
fn edge(flag: &Mutex<bool>, state: ShortcutState) -> bool {
    let mut down = flag.lock().unwrap_or_else(|p| p.into_inner());
    match state {
        ShortcutState::Pressed => {
            let fresh = !*down;
            *down = true;
            fresh
        }
        ShortcutState::Released => {
            *down = false;
            false
        }
    }
}

fn on_space(app: &AppHandle, state: ShortcutState) {
    let mut s = SPACE.lock().unwrap_or_else(|p| p.into_inner());
    match state {
        ShortcutState::Pressed => {
            if s.down {
                return; // auto-repeat
            }
            s.down = true;
            s.held = false;
            s.gen = s.gen.wrapping_add(1);
            let my_gen = s.gen;
            drop(s);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(HOLD_THRESHOLD);
                let mut s = SPACE.lock().unwrap_or_else(|p| p.into_inner());
                if s.down && !s.held && s.gen == my_gen {
                    s.held = true;
                    drop(s);
                    emit(&app, EV_SPACE_HOLD_START);
                }
            });
        }
        ShortcutState::Released => {
            if !s.down {
                return;
            }
            let was_held = s.held;
            s.down = false;
            s.held = false;
            s.gen = s.gen.wrapping_add(1);
            drop(s);
            emit(
                app,
                if was_held {
                    EV_SPACE_HOLD_END
                } else {
                    EV_SPACE_TAP
                },
            );
        }
    }
}

fn reset_space_state() {
    let mut s = SPACE.lock().unwrap_or_else(|p| p.into_inner());
    if s.down {
        log::info!("shortcuts: Space unregistered while down (held={}); state reset", s.held);
    }
    s.down = false;
    s.held = false;
    s.gen = s.gen.wrapping_add(1);
}

fn register(
    app: &AppHandle,
    shortcut: Shortcut,
    label: &str,
    handler: impl Fn(&AppHandle, &Shortcut, ShortcutEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    if gs.is_registered(shortcut) {
        return Ok(());
    }
    gs.on_shortcut(shortcut, handler).map_err(|e| {
        let msg = format!(
            "Couldn't register global key {label}: {e}. Another app may already own it."
        );
        log::warn!("shortcuts: {msg}");
        msg
    })?;
    log::info!("shortcuts: registered {label}");
    Ok(())
}

fn unregister(app: &AppHandle, shortcut: Shortcut, label: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    if !gs.is_registered(shortcut) {
        return Ok(());
    }
    gs.unregister(shortcut).map_err(|e| {
        let msg = format!("Couldn't unregister global key {label}: {e}");
        log::warn!("shortcuts: {msg}");
        msg
    })?;
    log::info!("shortcuts: unregistered {label}");
    Ok(())
}

/// Installs the always-on ctrl+option+space hotkey. Called from glass::setup; never
/// unregistered. Registration hops to the main thread via the plugin, so do it off the
/// setup call stack.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = register(&app, activate(), "ctrl+option+space", |app, _s, ev| {
            if edge(&ACTIVATE_DOWN, ev.state) {
                emit(app, EV_HOTKEY_ACTIVATE);
            }
        });
    });
}

/// invoke("set_session_keys", {space, returnEsc}) → void. Idempotent.
/// Async so it runs off the main thread (the plugin blocks on a main-thread hop).
#[tauri::command]
pub async fn set_session_keys(app: AppHandle, space: bool, return_esc: bool) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    if space {
        if let Err(e) = register(&app, self::space(), "Space", |app, _s, ev| {
            on_space(app, ev.state)
        }) {
            errors.push(e);
        }
    } else {
        let was = app.global_shortcut().is_registered(self::space());
        if let Err(e) = unregister(&app, self::space(), "Space") {
            errors.push(e);
        }
        if was {
            reset_space_state();
        }
    }

    if return_esc {
        if let Err(e) = register(&app, ret(), "Return", |app, _s, ev| {
            if edge(&RET_DOWN, ev.state) {
                emit(app, EV_KEY_RETURN);
            }
        }) {
            errors.push(e);
        }
        if let Err(e) = register(&app, esc(), "Escape", |app, _s, ev| {
            if edge(&ESC_DOWN, ev.state) {
                emit(app, EV_KEY_ESCAPE);
            }
        }) {
            errors.push(e);
        }
    } else {
        for (sc, label, flag) in [(ret(), "Return", &RET_DOWN), (esc(), "Escape", &ESC_DOWN)] {
            if let Err(e) = unregister(&app, sc, label) {
                errors.push(e);
            }
            *flag.lock().unwrap_or_else(|p| p.into_inner()) = false;
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
