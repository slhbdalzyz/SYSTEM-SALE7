//! Signed updates for the local edition, from the project's GitHub releases. The app only installs
//! a file signed with the project's key (its public half is in tauri.local.conf.json). The shop's
//! data is outside the app, and the server keeps a copy of the database before new tables arrive.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
}

/// Whether this build updates itself: only the local edition carries the updater's settings.
pub fn enabled(app: &AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

/// A newer version, if there is one (needs the internet; None when offline).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Available>, String> {
    if !enabled(&app) {
        return Ok(None);
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(Available { version: u.version.clone(), current: u.current_version.clone(), notes: u.body.clone() })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Downloads the new version, stops the shop's server cleanly, then runs the installer (which
/// closes the app and opens the new one).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?.ok_or("ما فيش نسخة جديدة")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("ما قدرناش ننزلوا التحديث: {e}"))?;
    if let Some(server) = app.state::<Option<crate::local::LocalServer>>().as_ref() {
        server.stop();
    }
    update.install(bytes).map_err(|e| e.to_string())
}
