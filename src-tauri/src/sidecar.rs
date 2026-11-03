//! The PR Quest server, which runs in the Node binary bundled next to this one, and talks to the
//! shell over stdio as src/desktop/sidecar/protocol.ts describes.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::log::Log;

const READY_PREFIX: &str = "PRQUEST_READY ";
const SMOKE_DONE_PREFIX: &str = "PRQUEST_SMOKE_DONE ";
const SMOKE_LINE_PREFIX: &str = "[smoke] ";
/// How long stopping waits for the server to close before it kills the process.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Kept for the sidecar: other `NODE_*` variables, `NODE_OPTIONS` above all, could make it load
/// code that isn't the app's.
const KEPT_NODE_VARIABLES: [&str; 1] = ["NODE_EXTRA_CA_CERTS"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub request_secret: String,
    pub bootstrap_code: String,
    pub data_key: Option<String>,
    pub preferences_file: String,
    pub show_notices: bool,
}

#[derive(Deserialize)]
pub struct Ready {
    pub port: u16,
    pub storage: String,
}

pub enum Event {
    Ready(Ready),
    SmokeLine(String),
    SmokeDone(bool),
    /// The window's smoke test report, as JSON.
    WindowReport(String),
    Exited(Option<i32>),
}

pub struct Sidecar {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: Arc<AtomicBool>,
}

impl Sidecar {
    /// Starts `node script` and writes `launch` to its stdin, never to argv or the environment,
    /// which other programs on the machine can read.
    pub fn spawn(
        node: &Path,
        script: &Path,
        launch: &Launch,
        log: &Log,
        events: Sender<Event>,
    ) -> io::Result<Sidecar> {
        let mut command = Command::new(node);
        // A signal could otherwise open the inspector, which reads every secret in the process.
        command
            .arg("--disable-sigusr1")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, _) in std::env::vars_os() {
            if is_dropped_variable(&name) {
                command.env_remove(name);
            }
        }
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let message = serde_json::to_string(launch).map_err(io::Error::other)?;
        stdin.write_all(message.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;

        let stdout_events = events.clone();
        let stdout_log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(ready) = line.strip_prefix(READY_PREFIX) {
                    match serde_json::from_str(ready) {
                        Ok(ready) => {
                            let _ = stdout_events.send(Event::Ready(ready));
                        }
                        Err(error) => stdout_log.warn(&format!("unreadable ready line: {error}")),
                    }
                } else if let Some(done) = line.strip_prefix(SMOKE_DONE_PREFIX) {
                    let ok = done.contains("\"ok\":true");
                    let _ = stdout_events.send(Event::SmokeDone(ok));
                } else if line.starts_with(SMOKE_LINE_PREFIX) {
                    let _ = stdout_events.send(Event::SmokeLine(line));
                } else {
                    stdout_log.info(&format!("sidecar: {line}"));
                }
            }
        });
        let stderr_log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                stderr_log.info(&format!("sidecar: {line}"));
            }
        });

        let child = Arc::new(Mutex::new(child));
        let watched = Arc::clone(&child);
        thread::spawn(move || loop {
            thread::sleep(POLL_INTERVAL);
            let status = match watched.lock() {
                Ok(mut child) => child.try_wait(),
                Err(_) => return,
            };
            match status {
                Ok(None) => {}
                Ok(Some(status)) => {
                    let _ = events.send(Event::Exited(status.code()));
                    return;
                }
                Err(_) => {
                    let _ = events.send(Event::Exited(None));
                    return;
                }
            }
        });

        Ok(Sidecar {
            child,
            stdin: Mutex::new(Some(stdin)),
            stopping: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Sends one more line, such as a smoke test command.
    pub fn send(&self, line: &str) -> io::Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| io::Error::other("stdin lock"))?;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| io::Error::other("the sidecar is stopping"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Closes stdin, which tells the server to close, and kills it if it hasn't within
    /// `STOP_TIMEOUT`. If the shell dies instead, the OS closes stdin and the sidecar stops itself.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match self.child.lock().map(|mut child| child.try_wait()) {
                Ok(Ok(None)) => thread::sleep(POLL_INTERVAL),
                _ => return,
            }
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn is_dropped_variable(name: &OsString) -> bool {
    name.to_str()
        .is_some_and(|name| name.starts_with("NODE_") && !KEPT_NODE_VARIABLES.contains(&name))
}
