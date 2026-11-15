//! Glass Tutor tray (English only): Settings, Keys, Whiteboard, Quit.
//! Emits `tray:action` {action} and shows the relevant window.
//! Not stored as `TrayIcon` state, so Handy's tray helpers stay inert.
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub fn create_tray(app: &AppHandle) {
    let build = || -> tauri::Result<()> {
        let menu = MenuBuilder::new(app)
            .item(&MenuItemBuilder::with_id("settings", "Settings…").build(app)?)
            .item(&MenuItemBuilder::with_id("keys", "Keys…").build(app)?)
            .item(&MenuItemBuilder::with_id("whiteboard", "Whiteboard").build(app)?)
            .separator()
            .item(&MenuItemBuilder::with_id("quit", "Quit Pimple").build(app)?)
            .build()?;
        let icon_path = app
            .path()
            .resolve("resources/tray_idle.png", tauri::path::BaseDirectory::Resource)?;
        let mut b = TrayIconBuilder::with_id("glass-tutor")
            .menu(&menu)
            .tooltip("Pimple")
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| {
                let action = event.id.as_ref().to_string();
                let _ = app.emit("tray:action", serde_json::json!({ "action": action }));
                match action.as_str() {
                    "settings" | "keys" => {
                        let _ = super::windows::show_window(app.clone(), "settings".into());
                    }
                    "whiteboard" => {
                        let _ = super::windows::show_window(app.clone(), "whiteboard".into());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                }
            });
        if let Ok(img) = Image::from_path(icon_path) {
            b = b.icon(img).icon_as_template(true);
        } else if let Some(img) = app.default_window_icon() {
            b = b.icon(img.clone());
        }
        b.build(app)?;
        Ok(())
    };
    if let Err(e) = build() {
        log::error!("create tray: {e}");
    }
}
