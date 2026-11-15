//! Session keys (space tap/hold, Return/Esc) and the always-on ctrl+option+space hotkey.
//! Owner: Domain 2. Reuse Handy's crate::shortcut module (handy_keys / tauri global-shortcut
//! impls) for registration. Emits: space:tap, space:hold-start, space:hold-end,
//! key:return, key:escape, hotkey:activate.
//! NOTE: Handy's own dictation bindings are never initialized (we never call
//! `shortcut::init_shortcuts` / the `initialize_shortcuts` command), so nothing grabs keys.

/// invoke("set_session_keys", {space, returnEsc}) → void
#[tauri::command]
pub fn set_session_keys(space: bool, return_esc: bool) -> Result<(), String> {
    let _ = (space, return_esc);
    Err(super::not_implemented("set_session_keys"))
}
