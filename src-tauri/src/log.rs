//! The shell's log file, which the sidecar's stderr goes to as well. Nothing may log the launch
//! message or the bootstrap URL, which hold the secrets.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// A log this large at start becomes `main.old.log` and a new one starts.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct Log {
    file: Arc<Mutex<Option<File>>>,
    path: PathBuf,
    echo: bool,
}

impl Log {
    /// Logs to `path`, or only to stderr when it can't be opened. `echo` also copies each line to
    /// stderr, for development and the smoke test.
    pub fn open(path: &Path, echo: bool) -> Log {
        rotate(path, MAX_BYTES);
        let file = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| OpenOptions::new().create(true).append(true).open(path))
            .ok();
        Log {
            echo: echo || file.is_none(),
            file: Arc::new(Mutex::new(file)),
            path: path.to_owned(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn info(&self, message: &str) {
        self.write("info", message);
    }

    pub fn warn(&self, message: &str) {
        self.write("warn", message);
    }

    fn write(&self, level: &str, message: &str) {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_secs());
        let line = format!("{seconds} {level} {message}\n");
        if self.echo {
            eprint!("{line}");
        }
        if let Ok(mut file) = self.file.lock() {
            if let Some(file) = file.as_mut() {
                let _ = file.write_all(line.as_bytes());
            }
        }
    }
}

fn rotate(path: &Path, max_bytes: u64) {
    if fs::metadata(path).is_ok_and(|meta| meta.len() > max_bytes) {
        let _ = fs::rename(path, path.with_extension("old.log"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pr-quest-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn appends_lines() {
        let dir = temp_dir("append");
        let path = dir.join("main.log");
        Log::open(&path, false).info("one");
        Log::open(&path, false).warn("two");
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("info one\n") && text.contains("warn two\n"),
            "{text}"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn starts_over_past_the_limit_and_keeps_the_old_log() {
        let dir = temp_dir("rotate");
        let path = dir.join("main.log");
        fs::write(&path, "old").unwrap();
        rotate(&path, 2);
        assert_eq!(fs::read_to_string(dir.join("main.old.log")).unwrap(), "old");
        assert!(!path.exists());
        fs::write(&path, "ok").unwrap();
        rotate(&path, 2);
        assert!(path.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
