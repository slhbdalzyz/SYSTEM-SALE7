//! The local edition: the app starts the shop's own server (the same API as the cloud, on PGlite)
//! with the Node that ships inside it, and the till talks to it on http://127.0.0.1:7400.
//! The shop's data lives in C:\ProgramData\Sale7\data, outside the app, so reinstalling or
//! updating the app never touches it. On close the app asks the server for a clean stop, so the
//! database is never cut off in the middle of a write.

use std::collections::hash_map::RandomState;
use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const PORT: u16 = 7400;
/// A server that keeps dying is not started forever: after this many restarts the till shows the error.
const MAX_RESTARTS: u32 = 5;

pub struct LocalServer {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    token: String,
    pub data_dir: PathBuf,
    pub log_file: PathBuf,
}

/// Where the shop's data lives: shared by every Windows user of this computer.
pub fn data_root(fallback: PathBuf) -> PathBuf {
    match std::env::var_os("PROGRAMDATA") {
        Some(p) if cfg!(windows) => PathBuf::from(p).join("Sale7"),
        _ => fallback,
    }
}

fn random_token() -> String {
    let mut out = String::new();
    for _ in 0..4 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(Instant::now().elapsed().as_nanos() ^ std::process::id() as u128);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn spawn(node: &Path, script: &Path, data_dir: &Path, log_file: &Path, token: &str) -> std::io::Result<Child> {
    let log = OpenOptions::new().create(true).append(true).open(log_file)?;
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .current_dir(script.parent().unwrap_or(Path::new(".")))
        .env("POS_DATA_DIR", data_dir)
        .env("PORT", PORT.to_string())
        .env("HOST", "127.0.0.1")
        .env("POS_PARENT_PID", std::process::id().to_string())
        .env("POS_SHUTDOWN_TOKEN", token)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Starts the server when this build carries one (the local edition); other builds return None.
pub fn start(resource_dir: &Path, root: PathBuf) -> Option<LocalServer> {
    let dir = resource_dir.join("server");
    let script = dir.join("server.mjs");
    if !script.exists() {
        return None;
    }
    let bundled = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = if bundled.exists() { bundled } else { PathBuf::from("node") };
    let data_dir = root.join("data");
    let logs = root.join("logs");
    let _ = fs::create_dir_all(&data_dir);
    let _ = fs::create_dir_all(&logs);
    let log_file = logs.join("server.log");
    trim_log(&log_file);
    let token = random_token();

    let child = Arc::new(Mutex::new(spawn(&node, &script, &data_dir, &log_file, &token).ok()));
    let stopping = Arc::new(AtomicBool::new(false));

    // Watches the server and starts it again if it stops by itself.
    {
        let (child, stopping, data_dir, log_file, token) = (child.clone(), stopping.clone(), data_dir.clone(), log_file.clone(), token.clone());
        thread::spawn(move || {
            let mut restarts = 0;
            loop {
                thread::sleep(Duration::from_secs(1));
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                let mut guard = child.lock().unwrap();
                let exited = match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                    None => true,
                };
                if !exited {
                    continue;
                }
                if restarts >= MAX_RESTARTS {
                    *guard = None;
                    return;
                }
                restarts += 1;
                thread::sleep(Duration::from_millis(500));
                *guard = spawn(&node, &script, &data_dir, &log_file, &token).ok();
            }
        });
    }
    Some(LocalServer { child, stopping, token, data_dir, log_file })
}

impl LocalServer {
    /// Asks for a clean stop and waits for it; only a server that does not answer is killed.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut guard = self.child.lock().unwrap();
        let Some(child) = guard.as_mut() else { return };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = ask_shutdown(&self.token);
        let until = Instant::now() + Duration::from_secs(8);
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn ask_shutdown(token: &str) -> std::io::Result<()> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_secs(2))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    let req = format!("POST /api/local/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Shutdown-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes())?;
    let mut buf = [0u8; 256];
    let _ = s.read(&mut buf);
    Ok(())
}

/// Keeps the log from growing forever: past 5 MB the older half goes.
fn trim_log(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() < 5 * 1024 * 1024 {
        return;
    }
    if let Ok(data) = fs::read(path) {
        let _ = fs::write(path, &data[data.len() / 2..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_differ_and_are_long() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn no_server_in_other_builds() {
        let dir = std::env::temp_dir().join(format!("pos-no-server-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        assert!(start(&dir, dir.clone()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trims_a_big_log() {
        let dir = std::env::temp_dir().join(format!("pos-log-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let f = dir.join("server.log");
        fs::write(&f, vec![b'x'; 6 * 1024 * 1024]).unwrap();
        trim_log(&f);
        assert_eq!(fs::metadata(&f).unwrap().len(), 3 * 1024 * 1024);
        let _ = fs::remove_dir_all(&dir);
    }
}
