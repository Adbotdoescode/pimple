//! C2 capture. Owner: Domain 2.
//! `capture`: one native-resolution screenshot of the display the bubble is on, with our own
//! panels (bubble, overlay, card) hidden for the shot. The main image is the full display,
//! downscaled to a long edge of 1568 px. For modes "region" and "lasso" with a region, `focus`
//! is a sharper crop of the padded region, cut from the native shot before any downscaling.
//! `read_debug_file`: debug helper, reads an absolute path as text.
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use tauri_nspanel::ManagerExt;

use super::windows::main_display_frame;

const PAD_FRACTION: f64 = 0.12;
pub(super) const MAX_EDGE: u32 = 1568;
const HIDE_SETTLE: Duration = Duration::from_millis(70);
const PANEL_LABELS: [&str; 3] = ["bubble", "overlay", "card"];
/// Normal windows hidden for the shot and not restored afterwards.
const WINDOW_LABELS: [&str; 2] = ["whiteboard", "gizmo"];
#[cfg(not(target_os = "windows"))]
const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
#[cfg(not(target_os = "windows"))]
const SIPS: &str = "/usr/bin/sips";

#[cfg(target_os = "windows")]
use super::windows_capture::{crop_jpeg, fit_to_edge, pixel_size, read_fixture, screencapture};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RectPts {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFocus {
    pub image_path: String,
    pub image_base64: String,
    pub image_width: u32,
    pub image_height: u32,
    /// Focus region in MAIN-image pixels [x, y, w, h].
    pub rect_in_image_px: [f64; 4],
    /// Focus region in screen points (padded 12%, clamped to the display).
    pub region_in_screen_points: RectPts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub mode: String,
    pub image_path: String,
    pub image_base64: String,
    pub image_width: u32,
    pub image_height: u32,
    pub region_in_screen_points: RectPts,
    pub display_id: u32,
    pub pixel_scale: f64,
    pub captured_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<CaptureFocus>,
}

/// invoke("capture", {mode, region?, fixture?}) → CaptureResult. Flat camelCase args.
/// `fixture` is an absolute PNG/JPEG path used instead of a real screenshot (no window hiding).
#[tauri::command]
pub async fn capture(
    app: AppHandle,
    mode: String,
    region: Option<RectPts>,
    fixture: Option<String>,
) -> Result<CaptureResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        capture_blocking(&app, &mode, region, fixture)
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
}

fn capture_blocking(
    app: &AppHandle,
    mode: &str,
    region: Option<RectPts>,
    fixture: Option<String>,
) -> Result<CaptureResult, String> {
    let total_t = Instant::now();
    let (display, display_id, display_scale) = target_display(app);
    let captured_at = now_ms();
    let dir = captures_dir(app)?;
    let native_path = dir.join(format!("cap-{captured_at}-native.jpg"));
    let main_path = dir.join(format!("cap-{captured_at}.jpg"));
    let focus_path = dir.join(format!("cap-{captured_at}-focus.jpg"));

    // The native source is the full display at native resolution. `native_region` is its frame
    // in points, `native_scale` its pixels per point, `native_px` its pixel size.
    let is_fixture = fixture.is_some();
    let (native_region, native_scale, native_px, hide_ms, shot_ms) = match fixture {
        Some(src) => {
            let src = PathBuf::from(&src);
            if !src.is_absolute() || !src.is_file() {
                return Err(format!("fixture is not an existing absolute file: {src:?}"));
            }
            read_fixture(&src, &native_path)?;
            let (iw, ih) = pixel_size(&native_path)?;
            let scale = (iw as f64 / display.w).max(ih as f64 / display.h);
            let nr = RectPts {
                x: display.x,
                y: display.y,
                w: iw as f64 / scale,
                h: ih as f64 / scale,
            };
            (nr, scale, (iw, ih), 0, 0)
        }
        None => {
            let hide_t = Instant::now();
            let hidden = hide_ours(app)?;
            std::thread::sleep(HIDE_SETTLE);
            let hide_ms = hide_t.elapsed().as_millis();

            let shot_t = Instant::now();
            let shot = screencapture(display, display_scale, &native_path);
            // Restore before anything else, even when the capture failed.
            restore_ours(app, &hidden);
            let shot_ms = shot_t.elapsed().as_millis();
            shot?;

            let (nw, nh) = pixel_size(&native_path)?;
            (display, nw as f64 / display.w, (nw, nh), hide_ms, shot_ms)
        }
    };

    // Focus: the padded region, cut from the native image before anything is downscaled.
    let focus_region = match (mode, region) {
        ("region" | "lasso", Some(r)) => Some(plan_region(display, Some(r))),
        _ => None,
    };
    let focus_t = Instant::now();
    let focus_native = match focus_region {
        Some(fr) => {
            let (nw, nh) = native_px;
            let x0 = ((fr.x - native_region.x) * native_scale).round().clamp(0.0, nw as f64 - 1.0);
            let y0 = ((fr.y - native_region.y) * native_scale).round().clamp(0.0, nh as f64 - 1.0);
            let cw = (fr.w * native_scale).round().clamp(1.0, nw as f64 - x0);
            let ch = (fr.h * native_scale).round().clamp(1.0, nh as f64 - y0);
            crop_jpeg(&native_path, &focus_path, x0 as u32, y0 as u32, cw as u32, ch as u32)?;
            let native_crop = pixel_size(&focus_path)?;
            let (fw, fh) = fit_to_edge(&focus_path)?;
            log::info!(
                "capture focus native_crop={}x{} image={}x{} took={}ms",
                native_crop.0,
                native_crop.1,
                fw,
                fh,
                focus_t.elapsed().as_millis()
            );
            Some((fr, fw, fh))
        }
        None => None,
    };

    // Main: the full display (or the fixture's full frame), downscaled to fit the model.
    let main_t = Instant::now();
    std::fs::copy(&native_path, &main_path).map_err(|e| format!("copy capture: {e}"))?;
    let (mw, mh) = fit_to_edge(&main_path)?;
    let main_scale = mw as f64 / native_region.w;
    log::info!(
        "capture main native={}x{} image={}x{} took={}ms",
        native_px.0,
        native_px.1,
        mw,
        mh,
        main_t.elapsed().as_millis()
    );
    let _ = std::fs::remove_file(&native_path);

    let focus = match focus_native {
        Some((fr, fw, fh)) => {
            let rect = [
                ((fr.x - native_region.x) * main_scale).round(),
                ((fr.y - native_region.y) * main_scale).round(),
                (fr.w * main_scale).round(),
                (fr.h * main_scale).round(),
            ];
            let bytes = std::fs::read(&focus_path).map_err(|e| format!("read focus: {e}"))?;
            Some(CaptureFocus {
                image_path: focus_path.to_string_lossy().into_owned(),
                image_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                image_width: fw,
                image_height: fh,
                rect_in_image_px: rect,
                region_in_screen_points: fr,
            })
        }
        None => None,
    };

    let bytes = std::fs::read(&main_path).map_err(|e| format!("read capture: {e}"))?;
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    log::info!(
        "capture mode={} fixture={} region=({:.0},{:.0},{:.0},{:.0}) image={}x{} focus={} hide={}ms shot={}ms total={}ms",
        mode,
        is_fixture,
        native_region.x,
        native_region.y,
        native_region.w,
        native_region.h,
        mw,
        mh,
        focus.is_some(),
        hide_ms,
        shot_ms,
        total_t.elapsed().as_millis()
    );

    Ok(CaptureResult {
        mode: mode.to_string(),
        image_path: main_path.to_string_lossy().into_owned(),
        image_base64,
        image_width: mw,
        image_height: mh,
        region_in_screen_points: native_region,
        display_id,
        pixel_scale: main_scale,
        captured_at,
        focus,
    })
}

/// invoke("read_debug_file", {path}) → string. Debug helper; absolute paths only.
#[tauri::command]
pub fn read_debug_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err("read_debug_file needs an absolute path".into());
    }
    std::fs::read_to_string(p).map_err(|e| format!("read {path}: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn captures_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir: {e}"))?
        .join("captures");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create captures dir: {e}"))?;
    Ok(dir)
}

fn monitor_frame(m: &tauri::Monitor) -> RectPts {
    let s = m.scale_factor();
    RectPts {
        x: m.position().x as f64 / s,
        y: m.position().y as f64 / s,
        w: m.size().width as f64 / s,
        h: m.size().height as f64 / s,
    }
}

/// Frame (points) and 1-based display id of the monitor the bubble is on, matching
/// `bubble_display` and `screencapture -D`. Falls back to the primary monitor.
fn target_display(app: &AppHandle) -> (RectPts, u32, f64) {
    let current = app
        .get_webview_window("bubble")
        .and_then(|w| w.current_monitor().ok().flatten());
    let mon = current.or_else(|| app.primary_monitor().ok().flatten());
    match mon {
        Some(m) => {
            let all = app.available_monitors().unwrap_or_default();
            let id = all
                .iter()
                .position(|o| o.position() == m.position() && o.size() == m.size())
                .map(|i| i as u32 + 1)
                .unwrap_or(1);
            (monitor_frame(&m), id, m.scale_factor())
        }
        None => (main_display_frame(app), 1, 1.0),
    }
}

/// No target: the full display. Otherwise the target padded by 12% per side, intersected with
/// the display and rounded outward to whole points.
fn plan_region(display: RectPts, target: Option<RectPts>) -> RectPts {
    let padded = match target {
        Some(t) if t.w > 0.0 && t.h > 0.0 => RectPts {
            x: t.x - t.w * PAD_FRACTION,
            y: t.y - t.h * PAD_FRACTION,
            w: t.w * (1.0 + 2.0 * PAD_FRACTION),
            h: t.h * (1.0 + 2.0 * PAD_FRACTION),
        },
        _ => return display,
    };
    let x0 = padded.x.max(display.x);
    let y0 = padded.y.max(display.y);
    let x1 = (padded.x + padded.w).min(display.x + display.w);
    let y1 = (padded.y + padded.h).min(display.y + display.h);
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return display;
    }
    let x0 = x0.floor();
    let y0 = y0.floor();
    let x1 = x1.ceil().min(display.x + display.w);
    let y1 = y1.ceil().min(display.y + display.h);
    RectPts {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// Runs `f` on the AppKit main thread and waits for its result.
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&app2));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Panels are NSPanels on macOS (show = orderFrontRegardless, hide = orderOut; neither
/// activates the app). Falls back to the plain window for anything without a panel.
#[cfg(target_os = "macos")]
fn is_visible_label(app: &AppHandle, label: &str) -> bool {
    if let Ok(p) = app.get_webview_panel(label) {
        return p.is_visible();
    }
    app.get_webview_window(label)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn set_visible_label(app: &AppHandle, label: &str, visible: bool) {
    if let Ok(p) = app.get_webview_panel(label) {
        if visible {
            p.show();
        } else {
            p.hide();
        }
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

#[cfg(not(target_os = "macos"))]
fn is_visible_label(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn set_visible_label(app: &AppHandle, label: &str, visible: bool) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

/// Hides every visible panel and normal window of ours that could appear in the shot.
/// Returns the panel labels hidden so they can be restored. Normal windows (WINDOW_LABELS)
/// are hidden but never restored: the brain re-opens them through show_window when needed.
fn hide_ours(app: &AppHandle) -> Result<Vec<&'static str>, String> {
    on_main(app, |app| {
        let mut restore = Vec::new();
        let mut all = Vec::new();
        for label in PANEL_LABELS {
            if is_visible_label(app, label) {
                set_visible_label(app, label, false);
                restore.push(label);
                all.push(label);
            }
        }
        for label in WINDOW_LABELS {
            if is_visible_label(app, label) {
                set_visible_label(app, label, false);
                all.push(label);
            }
        }
        log::info!("capture: hid {all:?}");
        restore
    })
}

fn restore_ours(app: &AppHandle, hidden: &[&'static str]) {
    if hidden.is_empty() {
        return;
    }
    let hidden = hidden.to_vec();
    if let Err(e) = on_main(app, move |app| {
        for label in hidden {
            set_visible_label(app, label, true);
        }
    }) {
        log::error!("capture: restoring hidden windows failed: {e}");
    }
}

/// One screencapture of `region` (points) at native resolution.
#[cfg(not(target_os = "windows"))]
fn screencapture(region: RectPts, _scale: f64, out: &Path) -> Result<(), String> {
    let rect = format!(
        "{},{},{},{}",
        region.x as i64, region.y as i64, region.w as i64, region.h as i64
    );
    let status = Command::new(SCREENCAPTURE)
        .args(["-x", "-t", "jpg", "-R", &rect])
        .arg(out)
        .status()
        .map_err(|e| format!("screencapture did not start: {e}"))?;
    if !status.success() {
        return Err(format!("screencapture exited with {status}"));
    }
    if !out.is_file() {
        return Err("screencapture wrote no file; Screen Recording permission missing?".into());
    }
    Ok(())
}

/// Runs sips with `flags` and input `src`, plus `--out` when given. Errors carry sips' stderr.
#[cfg(not(target_os = "windows"))]
fn run_sips(flags: &[&str], src: &Path, out: Option<&Path>) -> Result<(), String> {
    let mut cmd = Command::new(SIPS);
    cmd.args(flags).arg(src);
    if let Some(out) = out {
        cmd.arg("--out").arg(out);
    }
    let o = cmd.output().map_err(|e| format!("sips did not start: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "sips failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn pixel_size(path: &Path) -> Result<(u32, u32), String> {
    let o = Command::new(SIPS)
        .args(["-g", "pixelWidth", "-g", "pixelHeight"])
        .arg(path)
        .output()
        .map_err(|e| format!("sips did not start: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "sips probe failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let (mut w, mut h) = (None, None);
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("pixelWidth:") {
            w = v.trim().parse::<u32>().ok();
        } else if let Some(v) = line.strip_prefix("pixelHeight:") {
            h = v.trim().parse::<u32>().ok();
        }
    }
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w, h)),
        _ => Err("could not read image size from sips".into()),
    }
}

/// Downscales in place so the long edge is at most MAX_EDGE (never upscales). Returns the
/// final pixel size.
#[cfg(not(target_os = "windows"))]
fn fit_to_edge(path: &Path) -> Result<(u32, u32), String> {
    let (w, h) = pixel_size(path)?;
    if w.max(h) <= MAX_EDGE {
        return Ok((w, h));
    }
    let max = MAX_EDGE.to_string();
    run_sips(&["-Z", max.as_str()], path, None)?;
    pixel_size(path)
}

#[cfg(not(target_os = "windows"))]
fn read_fixture(src: &Path, out: &Path) -> Result<(), String> {
    run_sips(&["-s", "format", "jpeg"], src, Some(out))
}

#[cfg(not(target_os = "windows"))]
fn crop_jpeg(src: &Path, out: &Path, x: u32, y: u32, w: u32, h: u32) -> Result<(), String> {
    run_sips(
        &["--cropOffset", &y.to_string(), &x.to_string(), "-c", &h.to_string(), &w.to_string()],
        src,
        Some(out),
    )
}
