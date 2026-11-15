//! C2 capture. Owner: Domain 2. Stub until implemented.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RectPts {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
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
}

/// invoke("capture", {mode, region?}) → CaptureResult. (CaptureRequest fields flattened as args.)
#[tauri::command]
pub fn capture(mode: String, region: Option<RectPts>) -> Result<CaptureResult, String> {
    let _ = (mode, region);
    Err(super::not_implemented("capture"))
}
