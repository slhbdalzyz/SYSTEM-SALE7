//! Daily copies of the shop's data on the till's own disk, in Documents\POS-Backups.
//! The web page builds the file; this only writes it and keeps the folder from growing forever.

use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP: usize = 30;

/// Only names the page makes ("backup-20261025-2310.ndjson.gz"): no folders, nothing odd.
pub fn safe_name(name: &str) -> Option<String> {
    let ok = name.starts_with("backup-")
        && (name.ends_with(".ndjson.gz") || name.ends_with(".ndjson"))
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    ok.then(|| name.to_string())
}

/// Writes the file next to the older copies, then removes all but the newest `KEEP`.
pub fn save(dir: &Path, name: &str, data: &[u8]) -> Result<PathBuf, String> {
    let name = safe_name(name).ok_or("اسم الملف غير صحيح")?;
    fs::create_dir_all(dir).map_err(|e| format!("ما قدرناش ننشئوا مجلد النسخ: {e}"))?;
    let path = dir.join(&name);
    // Write to a temporary name first so a crash never leaves half a backup under the real name.
    let tmp = dir.join(format!("{name}.part"));
    fs::write(&tmp, data).map_err(|e| format!("ما قدرناش نكتبوا النسخة: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    prune(dir, KEEP);
    Ok(path)
}

fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| safe_name(n).is_some())
        .collect();
    // The names carry the date and time, so sorting by name sorts by age.
    names.sort();
    let extra = names.len().saturating_sub(keep);
    for n in &names[..extra] {
        let _ = fs::remove_file(dir.join(n));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_and_odd_names() {
        assert!(safe_name("backup-20261025-2310.ndjson.gz").is_some());
        assert!(safe_name("../backup-1.ndjson.gz").is_none());
        assert!(safe_name("backup-1\\..\\x.ndjson.gz").is_none());
        assert!(safe_name("notes.txt").is_none());
    }

    #[test]
    fn keeps_only_the_newest_copies() {
        let dir = std::env::temp_dir().join(format!("pos-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for day in 1..=33 {
            save(&dir, &format!("backup-202610{day:02}-0900.ndjson.gz"), b"x").unwrap();
        }
        fs::write(dir.join("keep-me.txt"), b"mine").unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left.len(), KEEP + 1);
        assert_eq!(left[0], "backup-20261004-0900.ndjson.gz");
        assert!(left.contains(&"keep-me.txt".to_string()));
        assert!(!left.iter().any(|n| n.ends_with(".part")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
