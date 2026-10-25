//! Counter scales on a serial (COM) port. Many answer a weight request ("W", ENQ…), others
//! stream the weight all the time; either way we hand back the first complete line and let
//! the web side parse it, so there is one parser for the browser and the app.

use serde::Serialize;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct PortInfo {
    pub name: String,
    pub label: String,
}

pub fn list() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let label = match &p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    format!("{} ({})", p.port_name, u.product.clone().or(u.manufacturer.clone()).unwrap_or_else(|| "USB".into()))
                }
                _ => p.port_name.clone(),
            };
            PortInfo { name: p.port_name, label }
        })
        .collect())
}

/// Reads one weight line. `request` is sent first when the scale only answers on demand.
pub fn read(port: &str, baud: u32, request: Option<&str>, timeout: Duration) -> Result<String, String> {
    let mut p = serialport::new(port, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("ما قدرناش نفتحوا {port}: {e}"))?;
    // A streaming scale has old readings waiting; we want the weight on the pan now.
    let _ = p.clear(serialport::ClearBuffer::Input);
    if let Some(r) = request.filter(|r| !r.is_empty()) {
        let bytes = r.replace("\\r", "\r").replace("\\n", "\n").replace("\\x05", "\x05");
        p.write_all(bytes.as_bytes()).map_err(|e| e.to_string())?;
    }
    let start = Instant::now();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64];
    let mut lines_seen = 0;
    while start.elapsed() < timeout {
        match p.read(&mut chunk) {
            Ok(n) if n > 0 => {
                buf.extend_from_slice(&chunk[..n]);
                // Skip the first line of a stream: it may have started mid-way.
                let complete = buf.iter().filter(|&&b| b == b'\n' || b == b'\r').count();
                if complete > lines_seen {
                    lines_seen = complete;
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if text.split(['\r', '\n']).filter(|l| l.chars().any(|c| c.is_ascii_digit())).count() >= 1 && (request.is_some() || complete >= 2) {
                        return Ok(text);
                    }
                }
                if buf.len() > 512 {
                    buf.drain(..256);
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if buf.is_empty() {
        Err("ما وصلش وزن من الميزان. تأكد من المنفذ والسرعة".into())
    } else {
        // Some scales end lines with nothing at all; give back what came.
        Ok(String::from_utf8_lossy(&buf).to_string())
    }
}

#[cfg(all(test, unix))]
mod tests {
    // Uses `socat` to make a pair of linked pseudo-terminals and plays the scale on one end.
    use super::*;
    use std::process::{Child, Command};

    fn pty_pair(tag: &str) -> Option<(Child, String, String)> {
        let a = format!("/tmp/scale-{tag}-a");
        let b = format!("/tmp/scale-{tag}-b");
        let child = Command::new("socat").args([format!("pty,raw,echo=0,link={a}"), format!("pty,raw,echo=0,link={b}")]).spawn().ok()?;
        for _ in 0..50 {
            if std::path::Path::new(&a).exists() && std::path::Path::new(&b).exists() {
                return Some((child, a, b));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    #[test]
    fn answers_a_request() {
        let Some((mut socat, ours, scale)) = pty_pair("req") else { return };
        let t = std::thread::spawn(move || {
            let mut s = serialport::new(&scale, 9600).timeout(Duration::from_secs(2)).open().unwrap();
            let mut b = [0u8; 3];
            s.read_exact(&mut b).unwrap();
            assert_eq!(&b, b"W\r\n");
            s.write_all(b"ST,GS,+  1.250kg\r\n").unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let got = read(&ours, 9600, Some("W\\r\\n"), Duration::from_secs(2)).unwrap();
        t.join().unwrap();
        socat.kill().ok();
        assert!(got.contains("1.250kg"), "{got:?}");
    }

    #[test]
    fn reads_a_streaming_scale_past_the_partial_first_line() {
        let Some((mut socat, ours, scale)) = pty_pair("stream") else { return };
        let t = std::thread::spawn(move || {
            let mut s = serialport::new(&scale, 9600).timeout(Duration::from_secs(2)).open().unwrap();
            for _ in 0..10 {
                s.write_all(b"0.730kg\r\n").unwrap();
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let got = read(&ours, 9600, None, Duration::from_secs(2)).unwrap();
        t.join().unwrap();
        socat.kill().ok();
        assert!(got.contains("0.730kg"), "{got:?}");
    }

    #[test]
    fn says_so_when_nothing_comes() {
        let Some((mut socat, ours, _scale)) = pty_pair("quiet") else { return };
        let err = read(&ours, 9600, Some("W"), Duration::from_millis(300)).unwrap_err();
        socat.kill().ok();
        assert!(err.contains("ما وصلش"));
    }
}
