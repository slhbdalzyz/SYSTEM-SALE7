//! The Windows shell around the web till. It adds what a browser cannot do: send raw bytes
//! to the receipt printer (and through it, pulse the cash drawer), and open the customer
//! display on the second monitor, and read the counter scale on a COM port.

mod printer;
mod scale;

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    printer::list()
}

#[tauri::command]
fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    if printer.is_empty() {
        return Err("اختار الطابعة من الإعدادات".into());
    }
    printer::write_raw(&printer, &data)
}

/// Network receipt printers listen for raw ESC/POS on port 9100.
#[tauri::command]
fn print_tcp(host: String, port: u16, data: Vec<u8>) -> Result<(), String> {
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("عنوان الطابعة غير صحيح")?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("ما قدرناش نوصلوا للطابعة: {e}"))?;
    s.set_write_timeout(Some(Duration::from_secs(10))).ok();
    s.write_all(&data).map_err(|e| e.to_string())?;
    s.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<scale::PortInfo>, String> {
    scale::list()
}

/// Blocking serial I/O runs off the main thread so the window stays responsive.
#[tauri::command]
async fn read_scale(port: String, baud: u32, request: Option<String>, timeout_ms: Option<u64>) -> Result<String, String> {
    if port.is_empty() {
        return Err("اختار منفذ الميزان من الإعدادات".into());
    }
    tauri::async_runtime::spawn_blocking(move || scale::read(&port, baud, request.as_deref(), Duration::from_millis(timeout_ms.unwrap_or(3000))))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens (or brings back) the customer display, full screen on the second monitor when there is one.
#[tauri::command]
fn open_display(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("display") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().ok().flatten();
    let other = monitors.into_iter().find(|m| primary.as_ref().map_or(true, |p| p.position() != m.position()));
    let mut b = WebviewWindowBuilder::new(&app, "display", WebviewUrl::App("index.html?screen=display".into())).title("شاشة الزبون");
    if let Some(m) = &other {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        b = b.position(pos.x, pos.y).fullscreen(true);
    } else {
        b = b.inner_size(800.0, 600.0);
    }
    b.build().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_printers, print_raw, print_tcp, open_display, list_serial_ports, read_scale])
        .run(tauri::generate_context!())
        .expect("error while running the till");
}
