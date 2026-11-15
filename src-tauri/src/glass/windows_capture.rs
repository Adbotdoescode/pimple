use std::{ffi::c_void, path::Path, ptr, slice};

use image::{imageops::FilterType, DynamicImage, ImageFormat, RgbImage};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC,
    ReleaseDC, SelectObject, BITMAPINFO, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};

use super::capture::{RectPts, MAX_EDGE};

pub(super) fn screencapture(region: RectPts, scale: f64, out: &Path) -> Result<(), String> {
    let x = (region.x * scale).round() as i32;
    let y = (region.y * scale).round() as i32;
    let width = (region.w * scale).round() as i32;
    let height = (region.h * scale).round() as i32;
    if width < 1 || height < 1 || width > 16_384 || height > 16_384 {
        return Err("Invalid screen capture dimensions".into());
    }

    // GetDC(None) addresses the whole virtual desktop in physical pixels on a DPI-aware app.
    let rgb = unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Could not open the desktop for capture".into());
        }
        let result = (|| {
            let memory = CreateCompatibleDC(Some(screen));
            if memory.is_invalid() {
                return Err("Could not allocate a screen capture context".into());
            }
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height; // top-down rows
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;

            let mut bits: *mut c_void = ptr::null_mut();
            let result = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0)
                .map_err(|e| format!("Could not allocate screen capture pixels: {e}"))
                .and_then(|bitmap| {
                    let old = SelectObject(memory, bitmap.into());
                    let result = if old.is_invalid() || bits.is_null() {
                        Err("Could not select the screen capture bitmap".into())
                    } else {
                        BitBlt(
                            memory,
                            0,
                            0,
                            width,
                            height,
                            Some(screen),
                            x,
                            y,
                            SRCCOPY | CAPTUREBLT,
                        )
                        .map_err(|e| format!("Desktop capture failed: {e}"))
                        .and_then(|()| {
                            if !GdiFlush().as_bool() {
                                return Err("Could not finish the desktop capture".into());
                            }
                            // The selected 32-bit DIB owns these pixels until DeleteObject.
                            let bgra = slice::from_raw_parts(
                                bits.cast::<u8>(),
                                width as usize * height as usize * 4,
                            );
                            let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
                            for pixel in bgra.chunks_exact(4) {
                                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
                            }
                            RgbImage::from_raw(width as u32, height as u32, rgb)
                                .ok_or_else(|| "Invalid screen capture buffer".into())
                        })
                    };
                    if !old.is_invalid() {
                        SelectObject(memory, old);
                    }
                    let _ = DeleteObject(bitmap.into());
                    result
                });
            let _ = DeleteDC(memory);
            result
        })();
        ReleaseDC(None, screen);
        result?
    };
    write_jpeg(DynamicImage::ImageRgb8(rgb), out)
}

pub(super) fn read_fixture(src: &Path, out: &Path) -> Result<(), String> {
    write_jpeg(open_image(src)?, out)
}

pub(super) fn crop_jpeg(
    src: &Path,
    out: &Path,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    write_jpeg(open_image(src)?.crop_imm(x, y, w, h), out)
}

pub(super) fn pixel_size(path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(path).map_err(|e| format!("Read capture dimensions: {e}"))
}

pub(super) fn fit_to_edge(path: &Path) -> Result<(u32, u32), String> {
    let (width, height) = pixel_size(path)?;
    if width.max(height) <= MAX_EDGE {
        return Ok((width, height));
    }
    let scaled = open_image(path)?.resize(MAX_EDGE, MAX_EDGE, FilterType::Triangle);
    let size = (scaled.width(), scaled.height());
    write_jpeg(scaled, path)?;
    Ok(size)
}

fn open_image(path: &Path) -> Result<DynamicImage, String> {
    image::open(path).map_err(|e| format!("Read capture image: {e}"))
}

fn write_jpeg(image: DynamicImage, path: &Path) -> Result<(), String> {
    image
        .to_rgb8()
        .save_with_format(path, ImageFormat::Jpeg)
        .map_err(|e| format!("Write capture image: {e}"))
}
