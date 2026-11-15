//! Live pixels under the bubble for the liquid lens.
//!
//! `lens_grab({x,y,w,h})` returns the screen content BELOW the bubble window (so the glass never
//! sees itself or the card) for a rect in global points, as raw bytes:
//!   [u32 LE width px][u32 LE height px][width*height*4 bytes BGRA, tight rows, top-down]
//! The bubble pulls frames at its own rate (about 30 fps while moving, a few fps at rest), which
//! keeps this stateless: no stream, no thread, nothing to stop.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager};

static BUBBLE_WINDOW_ID: AtomicU32 = AtomicU32::new(0);

#[cfg(target_os = "macos")]
mod cg {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub w: f64,
        pub h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }

    pub const ON_SCREEN_BELOW_WINDOW: u32 = 1 << 2;
    pub const IMAGE_BEST_RESOLUTION: u32 = 1 << 3;
    pub const IMAGE_NOMINAL_RESOLUTION: u32 = 1 << 4;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGWindowListCreateImage(
            rect: CGRect,
            option: u32,
            window: u32,
            image_option: u32,
        ) -> *mut c_void;
        pub fn CGImageGetWidth(i: *mut c_void) -> usize;
        pub fn CGImageGetHeight(i: *mut c_void) -> usize;
        pub fn CGImageGetBytesPerRow(i: *mut c_void) -> usize;
        pub fn CGImageGetBitsPerPixel(i: *mut c_void) -> usize;
        pub fn CGImageGetDataProvider(i: *mut c_void) -> *mut c_void;
        pub fn CGDataProviderCopyData(p: *mut c_void) -> *const c_void;
        pub fn CGImageRelease(i: *mut c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFDataGetLength(d: *const c_void) -> isize;
        pub fn CFDataGetBytePtr(d: *const c_void) -> *const u8;
        pub fn CFRelease(p: *const c_void);
    }
}

#[cfg(target_os = "macos")]
fn bubble_window_id(app: &AppHandle) -> Option<u32> {
    let cached = BUBBLE_WINDOW_ID.load(Ordering::Relaxed);
    if cached != 0 {
        return Some(cached);
    }
    let w = app.get_webview_window("bubble")?;
    let ptr = w.ns_window().ok()? as *mut objc2::runtime::AnyObject;
    if ptr.is_null() {
        return None;
    }
    let n: isize = unsafe { objc2::msg_send![ptr, windowNumber] };
    if n <= 0 {
        return None;
    }
    BUBBLE_WINDOW_ID.store(n as u32, Ordering::Relaxed);
    Some(n as u32)
}

/// CGWindowID of one of our windows by label (looked up each call: it is one cheap message).
#[cfg(target_os = "macos")]
fn window_id(app: &AppHandle, label: &str) -> Option<u32> {
    let w = app.get_webview_window(label)?;
    let ptr = w.ns_window().ok()? as *mut objc2::runtime::AnyObject;
    if ptr.is_null() {
        return None;
    }
    let n: isize = unsafe { objc2::msg_send![ptr, windowNumber] };
    if n <= 0 {
        return None;
    }
    Some(n as u32)
}

#[cfg(target_os = "macos")]
fn grab(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<Vec<u8>, String> {
    let id = bubble_window_id(app).ok_or("lens_grab: no bubble window")?;
    grab_below(id, x, y, w, h)
}

/// Raw BGRA frame of the screen BELOW window `id` for a rect in global points.
#[cfg(target_os = "macos")]
fn grab_below(id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<Vec<u8>, String> {
    if ![x, y, w, h].iter().all(|v| v.is_finite()) || w < 2.0 || h < 2.0 || w > 1200.0 || h > 1200.0 {
        return Err("lens_grab: bad rect".into());
    }
    // Retina for a small lens; nominal once the rect is large, so a frame stays around 1 MB.
    let res = if w.max(h) > 330.0 { cg::IMAGE_NOMINAL_RESOLUTION } else { cg::IMAGE_BEST_RESOLUTION };
    let rect = cg::CGRect {
        origin: cg::CGPoint { x: x.round(), y: y.round() },
        size: cg::CGSize { w: w.round(), h: h.round() },
    };
    unsafe {
        let img = cg::CGWindowListCreateImage(rect, cg::ON_SCREEN_BELOW_WINDOW, id, res);
        if img.is_null() {
            return Err("lens_grab: no image (Screen Recording permission?)".into());
        }
        let iw = cg::CGImageGetWidth(img);
        let ih = cg::CGImageGetHeight(img);
        let bpr = cg::CGImageGetBytesPerRow(img);
        let bpp = cg::CGImageGetBitsPerPixel(img);
        let data = cg::CGDataProviderCopyData(cg::CGImageGetDataProvider(img));
        if data.is_null() || bpp != 32 || iw == 0 || ih == 0 {
            if !data.is_null() {
                cg::CFRelease(data);
            }
            cg::CGImageRelease(img);
            return Err("lens_grab: unexpected image format".into());
        }
        let len = cg::CFDataGetLength(data) as usize;
        let ptr = cg::CFDataGetBytePtr(data);
        let src = std::slice::from_raw_parts(ptr, len);
        let row = iw * 4;
        let mut out = Vec::with_capacity(8 + row * ih);
        out.extend_from_slice(&(iw as u32).to_le_bytes());
        out.extend_from_slice(&(ih as u32).to_le_bytes());
        for r in 0..ih {
            let a = r * bpr;
            if a + row > len {
                break;
            }
            out.extend_from_slice(&src[a..a + row]);
        }
        out.resize(8 + row * ih, 0);
        cg::CFRelease(data);
        cg::CGImageRelease(img);
        Ok(out)
    }
}

#[cfg(not(target_os = "macos"))]
fn grab(_app: &AppHandle, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<Vec<u8>, String> {
    let _ = (&BUBBLE_WINDOW_ID, Ordering::Relaxed, std::ptr::null::<c_void>());
    Err("lens_grab: macOS only".into())
}

/// ({x,y,w,h} global points) → raw BGRA frame of what is under the bubble (see module docs).
#[tauri::command(async)]
pub fn lens_grab(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<tauri::ipc::Response, String> {
    let _ = std::ptr::null::<c_void>();
    grab(&app, x, y, w, h).map(tauri::ipc::Response::new)
}

/// ({x,y,w,h} global points) → resize and move the bubble window in ONE main-thread turn, so the
/// shrink back to the small window at the screen edge lands in a single frame (no visible blink).
#[tauri::command(async)]
pub fn bubble_set_frame(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if ![x, y, w, h].iter().all(|v| v.is_finite()) || w < 1.0 || h < 1.0 {
        return Err("bubble_set_frame: bad rect".into());
    }
    let win = app.get_webview_window("bubble").ok_or("bubble_set_frame: no bubble window")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let a = win.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string());
        let b = win.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string());
        let _ = tx.send(a.and(b));
    })
    .map_err(|e| e.to_string())?;
    match rx.recv_timeout(std::time::Duration::from_millis(400)) {
        Ok(r) => r,
        Err(_) => Ok(()),
    }
}

/// () → [x, y]: the global cursor position in points (top-left origin). The bubble polls this
/// at rest so the droplet can lean toward a cursor that is NEAR it (its window gets no mouse
/// events outside its own small frame).
#[tauri::command(async)]
pub fn cursor_pos() -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreate(source: *const c_void) -> *mut c_void;
            fn CGEventGetLocation(event: *mut c_void) -> cg::CGPoint;
        }
        unsafe {
            let e = CGEventCreate(std::ptr::null());
            if e.is_null() {
                return Err("cursor_pos: no event".into());
            }
            let p = CGEventGetLocation(e);
            cg::CFRelease(e as *const c_void);
            Ok((p.x, p.y))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("cursor_pos: macOS only".into())
    }
}

/// ({label, x, y, w, h} global points) → the same raw BGRA frame as `lens_grab`, but of what is
/// BELOW the window with that label (the card uses it to refract the desktop behind itself).
#[tauri::command(async)]
pub fn lens_grab_below(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    {
        let id = window_id(&app, &label).ok_or_else(|| format!("lens_grab_below: no window '{label}'"))?;
        grab_below(id, x, y, w, h).map(tauri::ipc::Response::new)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &label, x, y, w, h);
        Err("lens_grab_below: macOS only".into())
    }
}
