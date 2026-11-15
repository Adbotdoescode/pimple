//! Dev-only HTTP hook on 127.0.0.1:47823 (debug builds only).
//! GET /debug?capture=...&question=...&shapes=...&mode=...&tts=...
//! → emits `debug:inject` (DebugInject, URL-decoded) to all windows, replies 200 "ok".
//! GET /emit?event=<name>&payload=<url-encoded JSON> → emits `<name>` (must be in EMIT_ALLOWLIST)
//! with the JSON payload (default {}) to all windows. 400 for a bad event or invalid JSON, 500 if emit fails.
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use tauri::{AppHandle, Emitter};

/// Contract port. If it is taken (on the dev Mac a system agent already holds 47823),
/// the hook tries PORT+1..PORT+10 and writes the bound port to PORT_FILE;
/// scripts/gt-debug.sh reads that file. GT_DEBUG_PORT overrides the first choice.
pub const PORT: u16 = 47823;
pub const PORT_FILE: &str = "/tmp/glass-tutor-debug-port";

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push(h * 16 + l);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Events the headless driver (scripts/gt-emit.sh) may inject. Anything else is refused.
const EMIT_ALLOWLIST: &[&str] = &[
    "space:tap",
    "space:hold-start",
    "space:hold-end",
    "key:return",
    "key:escape",
    "hotkey:activate",
    "stt:final",
    "stt:partial",
    "stt:level",
    "stt:error",
    "ui:intent",
    "tts:fallback",
];

/// First value of `key` in a raw query string, URL-decoded.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (url_decode(k) == key).then(|| url_decode(v))
    })
}

/// GET /emit?event=...&payload=... → (status line, body).
fn emit_event(app: &AppHandle, query: &str) -> (&'static str, String) {
    let event = match query_param(query, "event") {
        Some(e) if !e.is_empty() => e,
        _ => return ("400 Bad Request", "missing event".to_string()),
    };
    if !EMIT_ALLOWLIST.contains(&event.as_str()) {
        return ("400 Bad Request", format!("event not allowed: {event}"));
    }
    let raw = query_param(query, "payload")
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "{}".to_string());
    let payload: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", format!("invalid payload JSON: {e}")),
    };
    let preview: String = raw.chars().take(200).collect();
    log::info!("emit {event} payload={preview}");
    match app.emit(&event, payload) {
        Ok(()) => ("200 OK", "ok".to_string()),
        Err(e) => ("500 Internal Server Error", format!("emit failed: {e}")),
    }
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("gt-debug-hook".into())
        .spawn(move || {
            let first = std::env::var("GT_DEBUG_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(PORT);
            let Some((listener, port)) = (first..first + 11)
                .find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok().map(|l| (l, p)))
            else {
                log::error!("debug hook: no free port in {first}..{}", first + 10);
                return;
            };
            let _ = std::fs::write(PORT_FILE, port.to_string());
            log::info!("debug hook listening on http://127.0.0.1:{port}/debug");
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut line = String::new();
                {
                    let mut reader = BufReader::new(&stream);
                    if reader.read_line(&mut line).is_err() {
                        continue;
                    }
                    // drain headers
                    let mut h = String::new();
                    while reader.read_line(&mut h).map(|n| n > 2).unwrap_or(false) {
                        h.clear();
                    }
                }
                let target = line.split_whitespace().nth(1).unwrap_or("");
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                let (status, body): (&str, String) = if path == "/debug" {
                    let mut payload = serde_json::Map::new();
                    for pair in query.split('&').filter(|p| !p.is_empty()) {
                        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                        let k = url_decode(k);
                        if matches!(k.as_str(), "capture" | "question" | "shapes" | "mode" | "tts") {
                            payload.insert(k, serde_json::Value::String(url_decode(v)));
                        }
                    }
                    log::info!("debug:inject keys={:?}", payload.keys().collect::<Vec<_>>());
                    match app.emit("debug:inject", serde_json::Value::Object(payload)) {
                        Ok(()) => ("200 OK", "ok".to_string()),
                        Err(_) => ("500 Internal Server Error", "emit failed".to_string()),
                    }
                } else if path == "/emit" {
                    emit_event(&app, query)
                } else {
                    ("404 Not Found", "not found".to_string())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        })
        .ok();
}
