//! A second till in the shop: this computer runs no database of its own and talks to the shop's
//! main computer on the network (the one with the database and «شبكة المحل» on). The till's
//! screens still come from this app, so they open without the network, and the receipt printer,
//! the cash drawer and the scale work as on the main computer. The choice is kept in
//! C:\ProgramData\Sale7\client.json; while it is there the app starts no local server.
//!
//! The main computer is found by asking on the network (a UDP broadcast to port 7401), so when the
//! router gives it a new address the tills find it again without anyone typing it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const FIND_PORT: u16 = 7401;
const FIND_ASK: &[u8] = b"SALE7-FIND";

/// The main computer this till uses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Main {
    /// Like http://192.168.1.10:7400
    pub url: String,
    pub shop_id: String,
    pub shop_name: String,
}

fn file(root: &Path) -> PathBuf {
    root.join("client.json")
}

pub fn read(root: &Path) -> Option<Main> {
    let data = fs::read(file(root)).ok()?;
    serde_json::from_slice(&data).ok()
}

pub fn write(root: &Path, main: Option<&Main>) -> Result<(), String> {
    match main {
        Some(m) => {
            fs::create_dir_all(root).map_err(|e| e.to_string())?;
            fs::write(file(root), serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        None => match fs::remove_file(file(root)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    app: String,
    shop_id: String,
    name: String,
    port: u16,
}

/// Reads a main computer's answer; anything else on the port is ignored.
fn parse(data: &[u8], from: IpAddr) -> Option<Main> {
    let a: Answer = serde_json::from_slice(data).ok()?;
    if a.app != "sale7-pos" || a.shop_id.is_empty() {
        return None;
    }
    Some(Main { url: format!("http://{from}:{}", a.port), shop_id: a.shop_id, shop_name: a.name })
}

/// This computer's address on the network the default route goes out of (no packet is sent).
fn own_address() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("10.255.255.255:1").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(v) if !v.is_loopback() && !v.is_unspecified() => Some(v),
        _ => None,
    }
}

/// Where to ask: everyone on the network, and everyone on this computer's /24 (Windows sends the
/// plain broadcast out of one card only, so the second covers the shop's usual router).
fn targets(port: u16) -> Vec<SocketAddr> {
    let mut out = vec![SocketAddr::from((Ipv4Addr::BROADCAST, port))];
    if let Some(ip) = own_address() {
        let o = ip.octets();
        out.push(SocketAddr::from((Ipv4Addr::new(o[0], o[1], o[2], 255), port)));
    }
    out
}

/// Asks the shop's network for main computers and gathers the answers for `wait`.
pub fn find(wait: Duration) -> Vec<Main> {
    find_at(&targets(FIND_PORT), wait)
}

fn find_at(targets: &[SocketAddr], wait: Duration) -> Vec<Main> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return vec![] };
    let _ = sock.set_broadcast(true);
    let _ = sock.set_read_timeout(Some(Duration::from_millis(150)));
    let mut out: Vec<Main> = vec![];
    let start = Instant::now();
    let mut asked: u32 = 0;
    let mut buf = [0u8; 2048];
    while start.elapsed() < wait {
        // Asks again a couple of times: a UDP packet can get lost on Wi-Fi.
        if asked < 3 && start.elapsed() >= wait / 4 * asked {
            for t in targets {
                let _ = sock.send_to(FIND_ASK, t);
            }
            asked += 1;
        }
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if let Some(m) = parse(&buf[..n], from.ip()) {
                if !out.iter().any(|x| x.url == m.url) {
                    out.push(m);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_answer() {
        let ip: IpAddr = "192.168.1.10".parse().unwrap();
        let m = parse(r#"{"app":"sale7-pos","shopId":"abc","name":"بقالة الحي","port":7400}"#.as_bytes(), ip).unwrap();
        assert_eq!(m, Main { url: "http://192.168.1.10:7400".into(), shop_id: "abc".into(), shop_name: "بقالة الحي".into() });
        assert!(parse(br#"{"app":"other","shopId":"abc","name":"x","port":7400}"#, ip).is_none());
        assert!(parse(b"hello", ip).is_none());
    }

    #[test]
    fn keeps_the_choice() {
        let dir = std::env::temp_dir().join(format!("pos-client-{}", std::process::id()));
        assert_eq!(read(&dir), None);
        let m = Main { url: "http://10.0.0.5:7400".into(), shop_id: "s1".into(), shop_name: "محل".into() };
        write(&dir, Some(&m)).unwrap();
        assert_eq!(read(&dir), Some(m));
        write(&dir, None).unwrap();
        assert_eq!(read(&dir), None);
        write(&dir, None).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_a_main_computer() {
        // A stand-in main computer on this machine answers like the shop's server does.
        let main = UdpSocket::bind("127.0.0.1:0").unwrap();
        let at = main.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            if let Ok((n, from)) = main.recv_from(&mut buf) {
                if &buf[..n] == FIND_ASK {
                    let _ = main.send_to(br#"{"app":"sale7-pos","shopId":"t1","name":"shop","port":7400}"#, from);
                }
            }
        });
        let found = find_at(&[at], Duration::from_millis(800));
        assert_eq!(found, vec![Main { url: "http://127.0.0.1:7400".into(), shop_id: "t1".into(), shop_name: "shop".into() }]);
    }
}
