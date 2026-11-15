//! Window creation and window commands. Owner: Domain 1 (after scaffold).
//! Labels match the ARCHITECTURE window table. All geometry in macOS points.
use serde::Serialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

use super::capture::RectPts;

/// Bubble window (larger than the visible circle so CSS shadows/glow/pulse are not clipped).
pub const BUBBLE_SIZE: f64 = 124.0;
/// Visible glass circle, drawn by CSS centred in the bubble window.
pub const BUBBLE_DIAMETER: f64 = 68.0;
/// Gap between the visible circle and the screen's right edge. Negative: the droplet is
/// half-merged into the edge (its centre sits 8 pt inside the screen, the bulge about 42 pt out).
pub const BUBBLE_EDGE_GAP: f64 = -26.0;
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

    // whiteboard: a frameless sheet of blurred glass (native vibrancy under a transparent webview).
    // The web content draws the whole surface, its own close button and a drag region, and places
    // the window next to the bubble from JS.
    if let Err(e) = WebviewWindowBuilder::new(app, "whiteboard", url("whiteboard"))
        .title("Pimple — Whiteboard")
        .inner_size(1120.0, 720.0)
        .min_inner_size(640.0, 420.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(true)
        .accept_first_mouse(true)
        .skip_taskbar(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::FullScreenUI)
                .state(EffectState::Active)
                .radius(30.0)
                .build(),
        )
        .center()
        .build()
    {
        log::error!("create whiteboard: {e}");
    }

    for (label, title, w, h) in [
        ("gizmo", "Pimple — Diagram", 1100.0, 820.0),
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

    // settings: THE app window. Transparent liquid glass over native vibrancy; the title bar is
    // an overlay (traffic lights kept, title hidden) so the web content draws the whole surface.
    {
        let b = WebviewWindowBuilder::new(app, "settings", url("settings"))
            .title("Pimple")
            .inner_size(760.0, 660.0)
            .min_inner_size(640.0, 560.0)
            .visible(false)
            .transparent(true)
            .accept_first_mouse(true)
            .effects(
                EffectsBuilder::new()
                    .effect(Effect::HudWindow)
                    .state(EffectState::Active)
                    .radius(26.0)
                    .build(),
            )
            .center();
        #[cfg(target_os = "macos")]
        let b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::Position::Logical(LogicalPosition { x: 20.0, y: 24.0 }));
        if let Err(e) = b.build() {
            log::error!("create settings: {e}");
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
        .title("Pimple")
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
    let circle_right = d.x + d.w - 60.0; // beside the merged droplet, toward the interior
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

/// Sheets float over the student's work and are shown without activating the app: activating an
/// accessory app raises its other windows too (a backgrounded settings window would jump forward).
fn is_sheet(label: &str) -> bool {
    matches!(label, "whiteboard" | "gizmo")
}

/// invoke("show_window", {label}) → void. Panels: orderFrontRegardless, no activation.
/// Sheets (whiteboard, gizmo) are floated and ordered front without activating the app. Other
/// windows (settings) activate the app and take focus.
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
    if label != "brain" {
        #[cfg(target_os = "macos")]
        let sheet = is_sheet(&label);
        // Normal windows (settings): unhide and activate the accessory app first, or the window
        // stays behind the frontmost app. Sheets skip this so they don't raise the app's other windows.
        #[cfg(target_os = "macos")]
        if !sheet {
            let _ = app.show();
            activate_ns_app(&app);
        }
        // The whiteboard grows out of the bubble: shrink it to a small pane on the bubble's side
        // before it shows, then animate the native frame (blur and shadow included) to full size.
        #[cfg(target_os = "macos")]
        let grow = if label == "whiteboard" && !w.is_visible().unwrap_or(true) {
            let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
            whiteboard_grow_begin(&app, slot.clone());
            Some(slot)
        } else {
            None
        };
        w.show().map_err(|e| e.to_string())?;
        let _ = w.unminimize();
        #[cfg(target_os = "macos")]
        let _ = w.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        if sheet {
            order_front_regardless(&app, &w);
        } else {
            let _ = w.set_focus();
        }
        #[cfg(not(target_os = "macos"))]
        let _ = w.set_focus();
        #[cfg(target_os = "macos")]
        if let Some(slot) = grow {
            whiteboard_grow_finish(&app, slot);
        }
        #[cfg(target_os = "macos")]
        if label == "settings" {
            // Briefly on top so it comes forward, then behave like a normal window.
            let w2 = w.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let _ = w2.set_always_on_top(false);
            });
        }
        // The window's web content listens for this to play its opening animation and report its
        // rect (a window shown without focus gets no focus event).
        let _ = app.emit("window:shown", label.clone());
    } else {
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
type GrowSlot = std::sync::Arc<std::sync::Mutex<Option<objc2_foundation::NSRect>>>;

/// Step 1 of the whiteboard's opening: remember its placed frame and collapse it to a small pane
/// at the edge nearest the bubble, level with the bubble. Queued on the main thread before the show.
#[cfg(target_os = "macos")]
fn whiteboard_grow_begin(app: &AppHandle, slot: GrowSlot) {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let Some(w) = app.get_webview_window("whiteboard") else { return };
    let bubble = app.get_webview_window("bubble");
    let _ = app.run_on_main_thread(move || {
        let Ok(ptr) = w.ns_window() else { return };
        let ns = ptr as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        let target: NSRect = unsafe { objc2::msg_send![ns, frame] };
        if target.size.width < 300.0 || target.size.height < 200.0 {
            return;
        }
        let mut on_right = true;
        let mut by = target.origin.y + target.size.height / 2.0;
        if let Some(bp) = bubble.and_then(|b| b.ns_window().ok()) {
            let bp = bp as *mut AnyObject;
            if !bp.is_null() {
                let bf: NSRect = unsafe { objc2::msg_send![bp, frame] };
                on_right = bf.origin.x + bf.size.width / 2.0 > target.origin.x + target.size.width / 2.0;
                by = bf.origin.y + bf.size.height / 2.0;
            }
        }
        let (w0, h0) = (132.0, 96.0);
        let x = if on_right { target.origin.x + target.size.width - w0 } else { target.origin.x };
        let y = (by - h0 / 2.0).clamp(target.origin.y, target.origin.y + target.size.height - h0);
        let from = NSRect::new(NSPoint::new(x, y), NSSize::new(w0, h0));
        unsafe {
            let _: () = objc2::msg_send![ns, setFrame: from, display: false];
        }
        if let Ok(mut g) = slot.lock() {
            *g = Some(target);
        }
    });
}

/// Step 2: after the show, animate the frame back to the remembered one (0.42 s, ease-out).
#[cfg(target_os = "macos")]
fn whiteboard_grow_finish(app: &AppHandle, slot: GrowSlot) {
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(w) = app.get_webview_window("whiteboard") else { return };
    let _ = app.run_on_main_thread(move || {
        let Some(target) = slot.lock().ok().and_then(|mut g| g.take()) else { return };
        let Ok(ptr) = w.ns_window() else { return };
        let ns = ptr as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        let Some(ctx_cls) = AnyClass::get(c"NSAnimationContext") else {
            unsafe {
                let _: () = objc2::msg_send![ns, setFrame: target, display: true];
            }
            return;
        };
        unsafe {
            let _: () = objc2::msg_send![ctx_cls, beginGrouping];
            let ctx: *mut AnyObject = objc2::msg_send![ctx_cls, currentContext];
            let _: () = objc2::msg_send![ctx, setDuration: 0.42f64];
            if let Some(tf_cls) = AnyClass::get(c"CAMediaTimingFunction") {
                let name = objc2_foundation::NSString::from_str("easeOut");
                let tf: *mut AnyObject = objc2::msg_send![tf_cls, functionWithName: &*name];
                let _: () = objc2::msg_send![ctx, setTimingFunction: tf];
            }
            let animator: *mut AnyObject = objc2::msg_send![ns, animator];
            let _: () = objc2::msg_send![animator, setFrame: target, display: true];
            let _: () = objc2::msg_send![ctx_cls, endGrouping];
        }
    });
}

/// Activates the NSApplication on the main thread (macOS 14+ `activate`).
#[cfg(target_os = "macos")]
fn activate_ns_app(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            ns_app.activate();
        }
    });
}

/// Orders the window to the front of its level without activating the app (like the panels do).
#[cfg(target_os = "macos")]
fn order_front_regardless(app: &AppHandle, w: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    let w = w.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(ptr) = w.ns_window() else { return };
        let ns = ptr as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        unsafe {
            let _: () = objc2::msg_send![ns, orderFrontRegardless];
        }
    });
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
    if label == "whiteboard" || label == "gizmo" {
        let _ = w.set_always_on_top(false);
    }
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
