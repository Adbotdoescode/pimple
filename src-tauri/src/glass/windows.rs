//! Window creation and window commands. Owner: Domain 1 (after scaffold).
//! Labels match the ARCHITECTURE window table. All geometry in macOS points.
use serde::Serialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

use super::capture::RectPts;

/// Bubble window (larger than the visible circle so CSS shadows/glow/pulse are not clipped).
pub const BUBBLE_SIZE: f64 = 104.0;
/// Visible glass circle, drawn by CSS centred in the bubble window.
pub const BUBBLE_DIAMETER: f64 = 56.0;
/// Gap between the visible circle and the screen's right edge.
pub const BUBBLE_EDGE_GAP: f64 = 12.0;
pub const CARD_SIZE: (f64, f64) = (380.0, 260.0);

/// Panel levels: overlay sits above normal apps; bubble and card above the overlay.
const OVERLAY_LEVEL: i32 = 25; // NSStatusWindowLevel
const BUBBLE_LEVEL: i32 = 27;

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(GlassPassivePanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
    panel!(GlassKeyPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

fn url(label: &str) -> WebviewUrl {
    WebviewUrl::App(format!("src/windows/{label}/index.html").into())
}

/// Main display frame in points.
pub fn main_display_frame(app: &AppHandle) -> RectPts {
    let mon = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok().and_then(|m| m.into_iter().next()));
    match mon {
        Some(m) => {
            let s = m.scale_factor();
            RectPts {
                x: m.position().x as f64 / s,
                y: m.position().y as f64 / s,
                w: m.size().width as f64 / s,
                h: m.size().height as f64 / s,
            }
        }
        None => RectPts { x: 0.0, y: 0.0, w: 1440.0, h: 900.0 },
    }
}

pub fn create_all(app: &AppHandle) {
    let d = main_display_frame(app);
    let bubble_x = d.x + d.w - BUBBLE_EDGE_GAP - BUBBLE_DIAMETER - (BUBBLE_SIZE - BUBBLE_DIAMETER) / 2.0;
    let bubble_y = d.y + (d.h - BUBBLE_SIZE) / 2.0;

    // brain: hidden controller webview; never shown; timers + Web Audio must keep running.
    if let Err(e) = WebviewWindowBuilder::new(app, "brain", url("brain"))
        .title("Glass Tutor Brain")
        .inner_size(400.0, 300.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
    {
        log::error!("create brain: {e}");
    }

    for (label, title, w, h) in [
        ("whiteboard", "Glass Tutor — Whiteboard", 1200.0, 780.0),
        ("settings", "Glass Tutor — Settings", 560.0, 620.0),
    ] {
        if let Err(e) = WebviewWindowBuilder::new(app, label, url(label))
            .title(title)
            .inner_size(w, h)
            .visible(false)
            .center()
            .build()
        {
            log::error!("create {label}: {e}");
        }
    }

    #[cfg(target_os = "macos")]
    create_panels(app, d, bubble_x, bubble_y);
}

#[cfg(target_os = "macos")]
fn create_panels(app: &AppHandle, d: RectPts, bubble_x: f64, bubble_y: f64) {
    // overlay: full main display, click-through, never focusable.
    match PanelBuilder::<_, GlassPassivePanel>::new(app, "overlay")
        .url(url("overlay"))
        .title("Glass Tutor Overlay")
        .position(tauri::Position::Logical(LogicalPosition { x: d.x, y: d.y }))
        .size(tauri::Size::Logical(LogicalSize { width: d.w, height: d.h }))
        .level(PanelLevel::Custom(OVERLAY_LEVEL))
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .ignores_mouse_events(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .focusable(false)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(false)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => {
            panel.show();
            if let Some(w) = app.get_webview_window("overlay") {
                let _ = w.set_ignore_cursor_events(true);
            }
        }
        Err(e) => log::error!("create overlay panel: {e}"),
    }

    // bubble: small non-activating glass panel at the right edge, vertically centred.
    match PanelBuilder::<_, GlassPassivePanel>::new(app, "bubble")
        .url(url("bubble"))
        .title("Glass Tutor")
        .position(tauri::Position::Logical(LogicalPosition { x: bubble_x, y: bubble_y }))
        .size(tauri::Size::Logical(LogicalSize { width: BUBBLE_SIZE, height: BUBBLE_SIZE }))
        .level(PanelLevel::Custom(BUBBLE_LEVEL))
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(false)
                .accept_first_mouse(true)
                .always_on_top(true)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => panel.show(),
        Err(e) => log::error!("create bubble panel: {e}"),
    }

    // card: glass panel under/next to the bubble; can become key (typed-question box).
    // Card sits directly below the visible bubble circle, right-aligned with it.
    let (cw, ch) = CARD_SIZE;
    let circle_right = d.x + d.w - BUBBLE_EDGE_GAP;
    let circle_bottom = bubble_y + (BUBBLE_SIZE + BUBBLE_DIAMETER) / 2.0;
    match PanelBuilder::<_, GlassKeyPanel>::new(app, "card")
        .url(url("card"))
        .title("Glass Tutor Card")
        .position(tauri::Position::Logical(LogicalPosition {
            x: circle_right - cw,
            y: circle_bottom + 10.0,
        }))
        .size(tauri::Size::Logical(LogicalSize { width: cw, height: ch }))
        .level(PanelLevel::Custom(BUBBLE_LEVEL))
        .has_shadow(true)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .shadow(true)
                .skip_taskbar(true)
                .resizable(false)
                .accept_first_mouse(true)
                .effects(
                    EffectsBuilder::new()
                        .effect(Effect::Popover)
                        .state(EffectState::Active)
                        .radius(18.0)
                        .build(),
                )
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => panel.hide(),
        Err(e) => log::error!("create card panel: {e}"),
    }
}

fn is_panel(label: &str) -> bool {
    matches!(label, "bubble" | "overlay" | "card")
}

/// invoke("show_window", {label}) → void. Panels: orderFrontRegardless, no activation.
#[tauri::command]
pub fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if is_panel(&label) {
        let app2 = app.clone();
        return app
            .run_on_main_thread(move || match app2.get_webview_panel(&label) {
                Ok(p) => p.show(),
                Err(_) => log::error!("show_window: no panel {label}"),
            })
            .map_err(|e| e.to_string());
    }
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window '{label}'"))?;
    w.show().map_err(|e| e.to_string())?;
    if label != "brain" {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

/// invoke("hide_window", {label}) → void
#[tauri::command]
pub fn hide_window(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if is_panel(&label) {
        let app2 = app.clone();
        return app
            .run_on_main_thread(move || match app2.get_webview_panel(&label) {
                Ok(p) => p.hide(),
                Err(_) => log::error!("hide_window: no panel {label}"),
            })
            .map_err(|e| e.to_string());
    }
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window '{label}'"))?;
    w.hide().map_err(|e| e.to_string())
}

/// invoke("overlay_set_ignore_cursor", {ignore}) → void
#[tauri::command]
pub fn overlay_set_ignore_cursor(app: AppHandle, ignore: bool) -> Result<(), String> {
    let w = app
        .get_webview_window("overlay")
        .ok_or_else(|| "no overlay window".to_string())?;
    w.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleDisplay {
    /// 1-based index into the monitor list (1 = main display), matching `screencapture -D`.
    pub display_id: u32,
    pub frame: RectPts,
}

/// invoke("bubble_display") → {displayId, frame}: the display under the bubble's centre.
#[tauri::command]
pub fn bubble_display(app: AppHandle) -> Result<BubbleDisplay, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let centre = app.get_webview_window("bubble").and_then(|w| {
        let s = w.scale_factor().ok()?;
        let p = w.outer_position().ok()?.to_logical::<f64>(s);
        let z = w.outer_size().ok()?.to_logical::<f64>(s);
        Some((p.x + z.width / 2.0, p.y + z.height / 2.0))
    });
    let frames: Vec<RectPts> = monitors
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            RectPts {
                x: m.position().x as f64 / s,
                y: m.position().y as f64 / s,
                w: m.size().width as f64 / s,
                h: m.size().height as f64 / s,
            }
        })
        .collect();
    if let Some((cx, cy)) = centre {
        for (i, f) in frames.iter().enumerate() {
            if cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h {
                return Ok(BubbleDisplay { display_id: i as u32 + 1, frame: *f });
            }
        }
    }
    Ok(BubbleDisplay { display_id: 1, frame: main_display_frame(&app) })
}
