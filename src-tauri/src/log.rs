//! The shell's log file, which the sidecar's stderr goes to as well. Nothing may log the launch
//! message or the bootstrap URL, which hold the secrets.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct Log {
    file: Arc<Mutex<Option<File>>>,
    echo: bool,
}

impl Log {
    /// Logs to `path`, or only to stderr when it can't be opened. `echo` also copies each line to
    /// stderr, for development and the smoke test.
    pub fn open(path: &Path, echo: bool) -> Log {
        let file = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| OpenOptions::new().create(true).append(true).open(path))
            .ok();
        Log {
            echo: echo || file.is_none(),
            file: Arc::new(Mutex::new(file)),
        }
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
